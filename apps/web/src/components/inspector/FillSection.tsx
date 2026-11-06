"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { cellOf } from "@/design/editing/cells";
import { alphaOf, opaque, resolveVars, setAlpha } from "@/design/editing/colors";
import {
  backgroundOf,
  barText,
  COLOR_STASH,
  cellPosition,
  colorAt,
  type Empties,
  FILL_NAMES,
  FILL_PROPS,
  FITS,
  type Fill,
  type FillLayer,
  type FillType,
  fitOf,
  type Gradient,
  gradientAlpha,
  layerOf,
  newFill,
  ownBackground,
  previewText,
  readFills,
  switchFill,
  withGradientAlpha,
  withStops,
  writeFills,
} from "@/design/editing/fills";
import { tokenOf } from "@/design/editing/inspect";
import { moveEntry, stashOf } from "@/design/editing/lists";
import { roundTo } from "@/design/editing/units";
import type { Node } from "@/design/schema";
import { colors, outlines, radii, shadows, size, space } from "@/styles/tokens.stylex";
import type { IconName } from "@/lib/icons";
import {
  AlphaChip,
  CellGrid,
  ColorField,
  CustomChip,
  DragList,
  Field,
  LeadIcon,
  Popover,
  Row,
  RowBody,
  RowName,
  Section,
  Segments,
  Toggle,
  EyeToggle,
  MixedRow,
} from "./controls";
import { whenNumber } from "../DraftField";
import { type Changes, isPainted, resolve, type Scope, swatchOf } from "./scope";

/** The mockup's row of fill types. Conic is one level down, in a gradient's editor. */
const TYPES: ReadonlyArray<readonly [FillType, IconName, string]> = [
  ["solid", "fillSolid", FILL_NAMES.solid],
  ["linear", "fillLinear", FILL_NAMES.linear],
  ["radial", "fillRadial", FILL_NAMES.radial],
  ["image", "image", FILL_NAMES.image],
];

/** What a gradient can be turned into inside its editor, conic included. */
const GRADIENTS: ReadonlyArray<readonly [FillType, null, string]> = [
  ["linear", null, "Linear"],
  ["radial", null, "Radial"],
  ["conic", null, "Conic"],
];

/** A target's background as it sets it inline, the stashes included, to compare targets by. */
function ownOf(target: Node): Record<string, string> {
  const own = ownBackground(target.styles);
  const out: Record<string, string> = {};
  for (const prop of [...FILL_PROPS, COLOR_STASH, stashOf("background-image")]) {
    const v = own[prop] ?? target.styles[prop];
    if (v !== undefined) out[prop] = v;
  }
  return out;
}

/**
 * One target's fill layers, top first, from what it sets inline and,
 * under that, what the browser draws on it; and what taking its image or
 * color off writes, so a class's background is covered rather than left
 * showing.
 */
function targetFills(scope: Scope, target: Node) {
  const own = ownOf(target);
  const style = scope.computedOf(target.id);
  const computed = (prop: string) => style?.getPropertyValue(prop) || undefined;
  const empties: Empties = {
    image:
      own["background-image"] === undefined && isPainted(computed("background-image"), "none")
        ? "none"
        : null,
    color:
      own["background-color"] === undefined && isPainted(computed("background-color"), "none")
        ? "transparent"
        : null,
  };
  const layers = readFills(
    target.styles,
    backgroundOf((p) => own[p] ?? computed(p)),
  );
  return { layers, empties, drawn: !FILL_PROPS.some((p) => own[p] !== undefined) };
}

/**
 * The selection's fill layers, or `null` when the targets show different
 * ones, each read from its own styles; and each target's own reading, so
 * an edit writes each one's own layers and covers its own class.
 */
function fillsOf(scope: Scope) {
  const each = new Map(scope.targets.map((t) => [t.id, targetFills(scope, t)]));
  const all = [...each.values()];
  const same = all.every((f) => JSON.stringify(f.layers) === JSON.stringify(all[0]?.layers));
  const of = (t: Node) => each.get(t.id) ?? targetFills(scope, t);
  return {
    layers: same && all[0] ? all[0].layers : null,
    drawn: all.every((f) => f.drawn),
    of,
  };
}

/** The color a fill carries over to a new type: its own, or its first stop's. */
const colorOf = (fill: Fill | undefined): string =>
  fill?.type === "solid" ? fill.color : fill && "stops" in fill ? fill.stops[0]!.color : "#d9d9d9";

/**
 * The fills, as the mockup draws them: a row of fill types for the
 * selected fill with its eye in the gutter, then one row per layer, top
 * first, with its swatch, color or type name, its opacity and "−".
 * "+" adds a layer on top every time; clicking a row selects it, and
 * dragging a row reorders the layers. A solid's swatch opens the color
 * picker; a gradient's or image's opens its editor, with its stops and
 * angle or its URL, fit and position.
 */
export function FillSection({ scope }: { scope: Scope }) {
  const { layers: read, drawn, of } = fillsOf(scope);
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [picked, setPicked] = useState(0);
  // A new image waits for its URL before it writes anything. It's asked for
  // over the layers shown then, so any change to them, an undo included, wins.
  const [pending, setPending] = useState<{ index: number; over: string; insert: boolean } | null>(
    null,
  );
  const seen = JSON.stringify(read);
  const draft = read && pending?.over === seen ? pending : null;
  const layers = read && draft ? withPending(read, draft) : read;
  const selected = layers ? Math.min(picked, layers.length - 1) : 0;
  /** The layers to write from the ones shown: an image still waiting for its URL isn't one. */
  const settle = (all: ReadonlyArray<FillLayer>): FillLayer[] =>
    all.flatMap((l, j) =>
      draft && j === draft.index && l.fill.type === "image" && l.fill.url === ""
        ? draft.insert
          ? []
          : [read![draft.index]!]
        : [l],
    );
  const commitLayers = (next: ReadonlyArray<FillLayer>) => {
    setPending(null);
    scope.commitEach((t) => writeFills(t.styles, settle(next), of(t).empties));
  };
  /** The styles that make the first target show `next`, for previews. */
  const changesOf = (next: ReadonlyArray<FillLayer>): Changes => {
    const [first] = scope.targets;
    return first ? writeFills(first.styles, settle(next), of(first).empties) : {};
  };

  /** Another solid layer on top, in the color of the one that's there. */
  const add = () => {
    setOpen(null);
    setPicked(0);
    const top = (mine: ReadonlyArray<FillLayer>) =>
      layerOf(newFill("solid", colorOf(mine[0]?.fill)));
    if (!read) {
      // Each target keeps its own layers and takes the new one on top.
      scope.commitEach((t) => {
        const { layers: mine, empties } = of(t);
        return writeFills(t.styles, [top(mine), ...mine], empties);
      });
      return;
    }
    commitLayers([top(read), ...read]);
  };
  const replace = (i: number, next: FillLayer | null) => {
    const all = [...(layers ?? [])];
    if (next === null) all.splice(i, 1);
    else all[i] = next;
    return all;
  };
  const current = layers?.[selected];

  return (
    <Section title="Fill" action={<Toggle icon="plus" title="Add fill" onClick={add} />}>
      {layers === null ? (
        <MixedRow
          what="fills"
          onRemove={() => scope.commitEach((t) => writeFills(t.styles, [], of(t).empties))}
        />
      ) : (
        layers.length > 0 &&
        current && (
          <>
            <Row
              action={
                <EyeToggle
                  hidden={current.hidden}
                  onClick={() =>
                    commitLayers(replace(selected, { ...current, hidden: !current.hidden }))
                  }
                />
              }
            >
              <Segments
                label="Fill type"
                value={current.fill.type === "custom" ? null : current.fill.type}
                options={TYPES}
                onPick={(type) => {
                  setOpen(null);
                  if (type === "image") setPending({ index: selected, over: seen, insert: false });
                  else
                    commitLayers(
                      replace(selected, {
                        ...current,
                        fill: switchFill(current.fill, type),
                      }),
                    );
                }}
              />
            </Row>
            <DragList
              count={layers.length}
              onMove={(from, to) => {
                if (draft) return;
                setPicked(to);
                setOpen(null);
                commitLayers(moveEntry(layers, from, to));
              }}
            >
              {(i, drag) => (
                <FillRow
                  scope={scope}
                  layer={layers[i]!}
                  drawn={drawn}
                  drag={drag}
                  selected={layers.length > 1 && i === selected}
                  open={open?.index === i}
                  waiting={draft?.index === i && open === null}
                  onSelect={() => {
                    if (i === selected) return;
                    setPicked(i);
                    setOpen(null);
                  }}
                  onOpen={(anchor) => {
                    setPicked(i);
                    setOpen(open?.index === i ? null : { index: i, anchor });
                  }}
                  set={(next) => changesOf(replace(i, next))}
                  commit={(next) => commitLayers(replace(i, next))}
                />
              )}
            </DragList>
          </>
        )
      )}
      {layers && open && layers[open.index] && (
        <Popover
          anchor={open.anchor}
          title="Fill"
          onClose={() => {
            setOpen(null);
            setPending(null);
          }}
        >
          <FillPopover
            scope={scope}
            layer={layers[open.index]!}
            pick={(type) => {
              const i = open.index;
              commitLayers(replace(i, { ...layers[i]!, fill: switchFill(layers[i]!.fill, type) }));
            }}
            set={(next) => changesOf(replace(open.index, next))}
          />
        </Popover>
      )}
    </Section>
  );
}

/** The layers with an image that has no URL yet in `draft`'s place. */
function withPending(
  layers: ReadonlyArray<FillLayer>,
  draft: { index: number; insert: boolean },
): FillLayer[] {
  const out = [...layers];
  const image = layerOf({ type: "image", url: "" });
  if (draft.insert) out.splice(draft.index, 0, image);
  else out[draft.index] = { ...image, hidden: out[draft.index]?.hidden ?? false };
  return out;
}

/** A color as the swatches draw it: its token resolved, its opacity kept. */
function painter(scope: Scope) {
  return (color: string) => {
    // Tokens inside a color, like a mix's, resolve too.
    const base = swatchOf(
      scope,
      resolveVars(opaque(color), (n) => resolve(scope, n)),
    );
    return base ? setAlpha(base, alphaOf(color)) : "transparent";
  };
}

/**
 * One layer's row. `set` gives the styles that put `next` in its place
 * (`null` takes it out), for previews; `commit` keeps them.
 */
function FillRow({
  scope,
  layer,
  drawn,
  drag,
  selected,
  open,
  waiting,
  onSelect,
  onOpen,
  set,
  commit,
}: {
  scope: Scope;
  layer: FillLayer;
  drawn: boolean;
  drag: (e: React.PointerEvent) => void;
  /** Marked as the one the type row edits, when there's more than one layer. */
  selected: boolean;
  open: boolean;
  /** An image that waits for its URL, so its editor opens to ask for one. */
  waiting: boolean;
  onSelect: () => void;
  onOpen: (anchor: HTMLElement) => void;
  set: (next: FillLayer | null) => Changes;
  commit: (next: FillLayer | null) => void;
}) {
  const { fill } = layer;
  const paint = painter(scope);
  const name = FILL_NAMES[fill.type];
  const row = useRef<HTMLDivElement>(null);
  const ask = useRef(onOpen);
  ask.current = onOpen;
  useEffect(() => {
    if (waiting && row.current) ask.current(row.current);
  }, [waiting]);
  const opener = (e: React.MouseEvent) =>
    onOpen((e.currentTarget as HTMLElement).closest<HTMLElement>("[data-fill-row]")!);
  const remove = (
    <Toggle
      icon="minus"
      title={`Remove ${fill.type === "solid" ? "fill" : name.toLowerCase()}`}
      onClick={() => commit(null)}
    />
  );
  const shell = {
    ref: row,
    "data-fill-row": "",
    onPointerDown: drag,
    onClickCapture: onSelect,
    onFocusCapture: onSelect,
  };
  const look = stylex.props(styles.row, layer.hidden && styles.hidden, selected && styles.selected);

  if (fill.type === "solid") {
    return (
      <div {...shell} {...look}>
        <Row action={remove}>
          <ColorField
            scope={scope}
            label="Fill color"
            reading={
              drawn
                ? { kind: "computed", raw: fill.color }
                : { kind: "value", raw: fill.color, token: tokenOf(fill.color) }
            }
            toChanges={(c) =>
              set(c === null ? null : { ...layer, fill: { type: "solid", color: c } })
            }
          />
        </Row>
      </div>
    );
  }
  const gradient = "stops" in fill ? fill : null;
  const swatch = (background: string) => (
    <button
      type="button"
      title="Edit fill"
      aria-label="Edit fill"
      aria-expanded={open}
      onClick={opener}
      {...stylex.props(styles.swatch, open && styles.swatchOpen)}
      style={{ background }}
    />
  );
  return (
    <div {...shell} {...look}>
      <Row action={remove}>
        <RowBody
          open={open}
          hidden={layer.hidden}
          title={fill.type === "custom" ? fill.why : undefined}
        >
          {fill.type === "image" ? (
            <button
              type="button"
              title="Edit image"
              aria-label="Edit image"
              aria-expanded={open}
              onClick={opener}
              {...stylex.props(styles.swatch, styles.thumb, open && styles.swatchOpen)}
              style={{ backgroundImage: fill.url ? previewText(fill, paint) : undefined }}
            />
          ) : (
            swatch(fill.type === "custom" ? "transparent" : previewText(fill, paint))
          )}
          <RowName>{fill.type === "custom" ? "Fill" : name}</RowName>
          {gradient && (
            <AlphaChip
              scope={scope}
              alpha={gradientAlpha(gradient)}
              toChanges={(a) => set({ ...layer, fill: withGradientAlpha(gradient, a) })}
            />
          )}
          {fill.type === "custom" && <CustomChip title={fill.why} />}
        </RowBody>
      </Row>
    </div>
  );
}

/** What a gradient's or image's swatch opens: the controls for that type. */
function FillPopover({
  scope,
  layer,
  pick,
  set,
}: {
  scope: Scope;
  layer: FillLayer;
  pick: (type: FillType) => void;
  set: (next: FillLayer) => Changes;
}) {
  const { fill } = layer;
  const commit = (next: FillLayer) => scope.commit(set(next));
  return (
    <>
      {"stops" in fill && (
        <div {...stylex.props(styles.line)}>
          <Segments label="Gradient type" value={fill.type} options={GRADIENTS} onPick={pick} />
        </div>
      )}
      {"stops" in fill && (
        <GradientControls scope={scope} fill={fill} set={(next) => set({ ...layer, fill: next })} />
      )}
      {fill.type === "image" && (
        <ImageControls scope={scope} layer={layer} set={set} commit={commit} />
      )}
      {fill.type === "custom" && (
        <div {...stylex.props(styles.line)}>
          <RowName>{fill.why}</RowName>
          <CustomChip title={fill.why} />
        </div>
      )}
    </>
  );
}

/** A gradient's bar with its stops, its angle or shape and center, and the list of stops. */
function GradientControls({
  scope,
  fill,
  set,
}: {
  scope: Scope;
  fill: Gradient;
  set: (next: Gradient) => Changes;
}) {
  const paint = painter(scope);
  const bar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const percentAt = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round(Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100)));
  };
  const moved = (i: number, at: number) =>
    withStops(
      fill,
      fill.stops.map((s, j) => (j === i ? { ...s, at } : s)),
    );
  return (
    <>
      <div
        ref={bar}
        title="Click to add a stop; drag a stop to move it"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget || e.button !== 0) return;
          const at = percentAt(e.clientX);
          const next = withStops(fill, [...fill.stops, { color: colorAt(fill, at), at }]);
          setSelected(next.stops.findIndex((s) => s.at === at));
          scope.commit(set(next));
        }}
        {...stylex.props(styles.bar)}
        style={{ backgroundImage: barText(fill, paint) }}
      >
        {fill.stops.map((s, i) => (
          <button
            // Stops can share a color and a place, so their order names them.
            key={i}
            type="button"
            title={`Stop at ${Math.round(s.at)}%`}
            aria-label={`Stop at ${Math.round(s.at)}%`}
            aria-pressed={selected === i}
            onPointerDown={(e) => {
              setSelected(i);
              // Held from the press, so a quick drag off the small handle still moves it.
              e.currentTarget.setPointerCapture(e.pointerId);
              scope.editor.drive(e.nativeEvent, e.currentTarget, {
                move: (p) => scope.edits(set(moved(i, percentAt(p.x)))),
              });
            }}
            {...stylex.props(styles.stop, selected === i && styles.stopOn)}
            style={{ left: `${s.at}%`, background: paint(s.color) }}
          />
        ))}
      </div>
      {fill.type === "radial" ? (
        <div {...stylex.props(styles.line)}>
          <div {...stylex.props(styles.column)}>
            <Segments
              label="Shape"
              value={fill.shape}
              options={[
                ["circle", null, "Circle"],
                ["ellipse", null, "Ellipse"],
              ]}
              onPick={(shape) => scope.commit(set({ ...fill, shape }))}
            />
          </div>
          <CellGrid
            label="Center"
            cell={cellOf(fill.at)}
            onPick={(x, y) => scope.commit(set({ ...fill, at: cellPosition(x, y) }))}
          />
        </div>
      ) : (
        <div {...stylex.props(styles.line)}>
          <Field
            scope={scope}
            label="Angle"
            title="Angle"
            text={String(fill.angle)}
            toChanges={(typed) => whenNumber(typed, (n) => set(withAngle(fill, n)))}
            lead={<LeadIcon name="rotate" />}
            scrub={{ start: fill.angle, to: (n) => set(withAngle(fill, n)) }}
            unit="°"
          />
        </div>
      )}
      <div {...stylex.props(styles.label)}>Stops</div>
      {fill.stops.map((s, i) => (
        <div
          // Stops can share a color and a place, so their order names them.
          key={i}
          onFocus={() => setSelected(i)}
          {...stylex.props(styles.line)}
        >
          <ColorField
            scope={scope}
            label={`Stop ${i + 1} color`}
            dropper={false}
            reading={{ kind: "value", raw: s.color, token: tokenOf(s.color) }}
            toChanges={(c) =>
              set(
                withStops(
                  fill,
                  fill.stops.map((t, j) => (j === i ? { ...t, color: c ?? "transparent" } : t)),
                  false,
                ),
              )
            }
          />
          <Field
            scope={scope}
            label={`Stop ${i + 1} position`}
            title="Position"
            text={String(roundTo(s.at, 1))}
            toChanges={(typed) =>
              whenNumber(typed, (n) => set(moved(i, Math.min(100, Math.max(0, n)))))
            }
            min={0}
            max={100}
            unit="%"
            short
          />
          <Toggle
            icon="minus"
            title={fill.stops.length > 2 ? "Remove stop" : "A gradient needs two stops"}
            disabled={fill.stops.length <= 2}
            onClick={() => {
              setSelected(0);
              scope.commit(
                set(
                  withStops(
                    fill,
                    fill.stops.filter((_, j) => j !== i),
                  ),
                ),
              );
            }}
          />
        </div>
      ))}
    </>
  );
}

/** A linear or conic gradient turned to `angle`; a linear one drops the side it named. */
const withAngle = (fill: Extract<Gradient, { angle: number }>, angle: number): Gradient =>
  fill.type === "linear" ? { ...fill, angle, side: null } : { ...fill, angle };

/** An image layer's URL, how it fills the layer, and where it sits. */
function ImageControls({
  scope,
  layer,
  set,
  commit,
}: {
  scope: Scope;
  layer: FillLayer;
  set: (next: FillLayer) => Changes;
  commit: (next: FillLayer) => void;
}) {
  const url = layer.fill.type === "image" ? layer.fill.url : "";
  return (
    <>
      <div {...stylex.props(styles.line)}>
        <Field
          scope={scope}
          label="Image URL"
          title="Image URL"
          text={url}
          placeholder="https://…"
          toChanges={(typed) =>
            typed.trim() === ""
              ? null
              : set({ ...layer, fill: { type: "image", url: typed.trim() } })
          }
          lead={<LeadIcon name="image" />}
        />
      </div>
      <div {...stylex.props(styles.line)}>
        <Segments
          label="Fit"
          value={fitOf(layer.size, layer.repeat)}
          options={[
            ["fill", null, "Fill"],
            ["fit", null, "Fit"],
            ["stretch", null, "Stretch"],
            ["tile", null, "Tile"],
          ]}
          onPick={(fit) => url && commit({ ...layer, ...FITS[fit] })}
        />
      </div>
      <div {...stylex.props(styles.line)}>
        <span {...stylex.props(styles.label, styles.grow)}>Position</span>
        <CellGrid
          label="Image position"
          cell={cellOf(layer.position)}
          onPick={(x, y) => url && commit({ ...layer, position: cellPosition(x, y) })}
        />
      </div>
    </>
  );
}

const styles = stylex.create({
  row: { display: "flex", flexDirection: "column" },
  hidden: { opacity: 0.5 },
  /** A bar in the margin beside the layer the type row edits. */
  selected: {
    position: "relative",
    "::before": {
      content: "''",
      position: "absolute",
      top: 6,
      bottom: 6,
      left: -6,
      width: 3,
      borderRadius: 1.5,
      backgroundColor: colors.brand,
    },
  },
  swatch: {
    position: "relative",
    flexShrink: 0,
    width: 12,
    height: 12,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    boxShadow: shadows.edge,
    cursor: "var(--cursor-pointer, pointer)",
  },
  swatchOpen: { outline: outlines.focus, outlineOffset: 1 },
  thumb: { backgroundColor: colors.surface, backgroundSize: "cover", backgroundPosition: "center" },
  line: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 },
  column: { flexGrow: 1, display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 },
  grow: { flexGrow: 1 },
  label: { color: colors.muted, fontSize: 12, lineHeight: "16px", fontWeight: 500 },
  bar: {
    position: "relative",
    height: size.xs,
    marginInline: 6,
    borderRadius: radii.xs,
    boxShadow: `${shadows.field}, inset 0 0 0 1px ${colors.border}`,
    cursor: "copy",
  },
  stop: {
    position: "absolute",
    top: "50%",
    width: 12,
    height: 21,
    padding: 0,
    translate: "-50% -50%",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: colors.surface,
    borderRadius: radii.xs,
    boxShadow: {
      default: shadows.control,
      ":hover": shadows.controlHover,
      ":active": shadows.controlPressed,
    },
    cursor: "ew-resize",
  },
  stopOn: {
    borderColor: colors.brand,
    boxShadow: { default: shadows.controlBrand, ":active": shadows.controlBrandPressed },
  },
});
