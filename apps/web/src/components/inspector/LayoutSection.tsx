"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { StyleEditor as Editor } from "./styleEditor";
import { alignCell, alignStyles, bare } from "@/design/editing/inspect";
import { type LayoutKind, layoutOf, layoutStyles } from "@/design/editing/layout";
import { parseTrack, trackLabel, tracksOf, tracksValue } from "@/design/editing/tracks";
import { raised } from "@/styles/raised";
import { colors, face, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { useDraftField } from "../DraftField";
import { Icon } from "../Icons";
import {
  inField,
  Actions,
  Block,
  CustomChip,
  Field,
  GeometryField,
  Labeled,
  LeadIcon,
  Row,
  Section,
  Segments,
  StyleField,
  Toggle,
} from "./controls";
import type { GeometryFacts } from "./geometry";
import { PlacementRows, PositionMenu, RotationField, TurnStrip } from "./PositionControls";
import { useSizeOptions } from "./SizeControls";
import { type Changes, pairOf, rawOf, readOf, removal, type Scope } from "./scope";

/**
 * Where the element is, how big, and how it lays out its children. Two
 * full-width rows lead: X, Y and rotation, then W and H with their mode
 * menus and the rotate and flip strip. What pins a placed element, its
 * limits and its aspect lock follow when they apply. Then flow, column,
 * row or grid, with align, gaps, padding and margin. The header holds the
 * position menu and clip content, and adds a margin when there's none.
 */
export function LayoutSection({
  scope,
  editor,
  geometry,
}: {
  scope: Scope;
  editor: Editor;
  geometry: GeometryFacts | null;
}) {
  const read = (prop: string) => readOf(scope, prop);
  const value = (prop: string) => rawOf(read(prop)) ?? "";
  const layout = layoutOf(value("display"), value("flex-direction"));
  const flex = layout === "row" || layout === "column";
  const wrap = read("flex-wrap");
  const wraps = rawOf(wrap)?.startsWith("wrap") ?? false;
  // An artboard is a frame on the canvas, with nothing around it to keep a margin from.
  const board = scope.targets.every((t) => t.parent === null);
  const sizing = useSizeOptions(scope);
  const [eachPadding, setEachPadding] = useState(() => uneven(scope, "padding"));
  const [eachMargin, setEachMargin] = useState(() => uneven(scope, "margin"));
  // A margin is only a row when the element has one, or it's added from the header.
  const [addedMargin, setAddedMargin] = useState(false);
  const withMargin = !board && (addedMargin || hasMargin(scope));
  const padding = <Axes scope={scope} box="padding" each={eachPadding} onEach={setEachPadding} />;
  const margin = <Axes scope={scope} box="margin" each={eachMargin} onEach={setEachMargin} />;
  // A grid, or a row that wraps, has a gap between columns and one between rows.
  const twoGaps = layout === "grid" || (flex && wraps);
  const gaps = twoGaps ? (
    <>
      <StyleField
        scope={scope}
        prop="column-gap"
        icon="gap"
        title="Gap between columns"
        small
        chip
      />
      <StyleField
        scope={scope}
        prop="row-gap"
        before={<LeadIcon name="gap" turn={90} />}
        title="Gap between rows"
        small
        chip
      />
    </>
  ) : (
    <StyleField scope={scope} prop="gap" icon="gap" title="Gap between items" small chip />
  );
  // The gaps take a column each, of the frame's three or of the two beside the align grid.
  const gapped = (apart: boolean, columns: stylex.StyleXStyles) => (
    <Labeled caption={twoGaps ? "Gap: columns, rows" : "Gap"} apart={apart}>
      <div {...stylex.props(columns)}>{gaps}</div>
    </Labeled>
  );
  // A hidden layer, or more than one, has no one box to measure.
  const many = scope.targets.length > 1;
  const unmeasured = (letter: string, label: string) => (
    <Field
      scope={scope}
      label={label}
      text=""
      placeholder={many ? "Mixed" : "—"}
      toChanges={() => null}
      lead={letter}
      disabled
    />
  );
  return (
    <Section
      title="Layout"
      action={
        <Actions>
          {!board && !withMargin && (
            <Toggle icon="margin" title="Add margin" onClick={() => setAddedMargin(true)} />
          )}
          {!board && <PositionMenu scope={scope} />}
          {sizing.clip}
        </Actions>
      }
    >
      {/* X, Y and rotation over W, H and the turns: full width, past the rows' gutter. */}
      <div {...stylex.props(styles.frame)}>
        {geometry ? (
          <>
            <GeometryField field="x" editor={editor} geometry={geometry} />
            <GeometryField field="y" editor={editor} geometry={geometry} />
          </>
        ) : (
          <>
            {unmeasured("X", "X position")}
            {unmeasured("Y", "Y position")}
          </>
        )}
        {board ? <span /> : <RotationField scope={scope} />}
        {geometry ? (
          <>
            <GeometryField
              field="w"
              editor={editor}
              geometry={geometry}
              after={sizing.menu("width")}
            />
            <GeometryField
              field="h"
              editor={editor}
              geometry={geometry}
              after={sizing.menu("height")}
            />
          </>
        ) : (
          <>
            <StyleField scope={scope} prop="width" letter="W" title="Width" />
            <StyleField scope={scope} prop="height" letter="H" title="Height" />
          </>
        )}
        {board ? <span /> : <TurnStrip scope={scope} />}
      </div>
      {!board && <PlacementRows scope={scope} />}
      {!geometry && sizing.modes}
      {sizing.rows}
      {/* On the frame's columns: the kinds across the first two, wrap in the third. */}
      <div {...stylex.props(styles.frame)}>
        <div {...stylex.props(styles.twoThirds)}>
          <Segments
            label="Layout"
            value={read("display").kind === "mixed" ? null : layout}
            options={[
              ["block", "box", "Block"],
              ["column", "column", "Column"],
              ["row", "row", "Row"],
              ["grid", "grid", "Grid"],
            ]}
            onPick={(kind: LayoutKind) => scope.commit(layoutStyles(kind))}
          />
        </div>
        {flex && (
          <span {...stylex.props(styles.third)}>
            <Toggle
              icon="wrap"
              title="Wrap"
              pressed={wraps}
              onClick={() =>
                scope.commit({
                  "flex-wrap": wraps ? removal(wrap, "nowrap") : "wrap",
                })
              }
            />
          </span>
        )}
      </div>
      {flex ? (
        // On the frame's columns: the align grid in the first, the gaps in the other two.
        <div {...stylex.props(styles.frame)}>
          <AlignGrid
            cell={alignCell(layout, value("justify-content"), value("align-items"))}
            onPick={(x, y) => scope.commit(alignStyles(layout, x, y))}
          />
          <div {...stylex.props(styles.lastTwo)}>{gapped(false, styles.halves)}</div>
        </div>
      ) : (
        <>
          {layout === "grid" && (
            <Block kind="stackLoose">
              <TrackList scope={scope} prop="grid-template-columns" letter="C" title="Columns" />
              <TrackList scope={scope} prop="grid-template-rows" letter="R" title="Rows" />
            </Block>
          )}
          {layout === "grid" && gapped(true, styles.frame)}
        </>
      )}
      {padding}
      {eachPadding && <Sides scope={scope} box="padding" />}
      {withMargin && margin}
      {eachMargin && withMargin && <Sides scope={scope} box="margin" />}
    </Section>
  );
}

const SIDES = [
  ["top", "Top", 0],
  ["right", "Right", 90],
  ["bottom", "Bottom", 180],
  ["left", "Left", 270],
] as const;

/** Whether a box's left and right, or top and bottom, differ, so its per-side fields start open. */
function uneven(scope: Scope, box: string): boolean {
  return (["left-right", "top-bottom"] as const).some(
    (axis) => pairOf(scope, axisProps(box, axis)).kind === "mixed",
  );
}

/** Whether any target has a margin: set inline, or drawn by a stylesheet or the browser's defaults. */
function hasMargin(scope: Scope): boolean {
  return scope.targets.some(
    (t) =>
      t.styles.margin !== undefined ||
      SIDES.some(([side]) => {
        if (t.styles[`margin-${side}`] !== undefined) return true;
        const drawn = scope.computedOf(t.id)?.getPropertyValue(`margin-${side}`);
        return drawn !== undefined && drawn !== "" && drawn !== "0px";
      }),
  );
}

const axisProps = (box: string, axis: "left-right" | "top-bottom"): [string, string] =>
  axis === "left-right" ? [`${box}-left`, `${box}-right`] : [`${box}-top`, `${box}-bottom`];

/**
 * A box's padding or margin as two fields: horizontal writes left and
 * right, vertical top and bottom. Each shows Mixed when its two sides
 * differ. The button at the row's end opens a field for each side.
 */
function Axes({
  scope,
  box,
  each,
  onEach,
}: {
  scope: Scope;
  box: "padding" | "margin";
  each: boolean;
  onEach: (on: boolean) => void;
}) {
  // The browser's margins can come out fractional, like an `auto` one.
  const show =
    box === "margin"
      ? (raw: string) => bare(raw).replace(/\d+\.\d+/g, (n) => String(Math.round(Number(n))))
      : undefined;
  // On the frame's columns: horizontal and vertical in the first two, the toggle in the third.
  return (
    <div {...stylex.props(styles.frame)}>
      {(["left-right", "top-bottom"] as const).map((axis) => {
        const horizontal = axis === "left-right";
        const props = axisProps(box, axis);
        return (
          <StyleField
            key={axis}
            scope={scope}
            prop={props[0]}
            axis={props}
            icon={`${box}${horizontal ? "X" : "Y"}`}
            title={`${horizontal ? "Horizontal" : "Vertical"} ${box}`}
            tokens="length"
            {...(show ? { show } : {})}
            {...(box === "margin" ? { empty: "0" } : {})}
            small
            grow
            chip
          />
        );
      })}
      <span {...stylex.props(styles.third)}>
        <Toggle
          icon="sides"
          title={`Set each side's ${box}`}
          pressed={each}
          onClick={() => onEach(!each)}
        />
      </span>
    </div>
  );
}

/** One field for each side of `box`, top first, across the frame's whole width. */
function Sides({ scope, box }: { scope: Scope; box: "padding" | "margin" }) {
  return (
    <div {...stylex.props(styles.quarters)}>
      {SIDES.map(([side, name, turn]) => (
        <StyleField
          key={side}
          scope={scope}
          prop={`${box}-${side}`}
          before={<LeadIcon name="inset" size={12} turn={turn} />}
          title={`${name} ${box}`}
          small
          center
          bareTokens
        />
      ))}
    </div>
  );
}

/**
 * A grid's columns or rows as chips, one per track: `1fr`, `200`, `auto`.
 * Equal tracks show as one chip and a count. Typing into a chip changes
 * that track (or every equal one), and emptying it takes it out; "+" adds
 * one like the last, "−" takes the last off.
 */
function TrackList({
  scope,
  prop,
  letter,
  title,
}: {
  scope: Scope;
  prop: string;
  letter: string;
  title: string;
}) {
  const reading = readOf(scope, prop);
  const raw = rawOf(reading);
  const own = reading.kind === "value";
  const tracks = reading.kind === "mixed" ? null : tracksOf(raw ?? "");
  const write = (next: ReadonlyArray<string>): Changes => ({ [prop]: tracksValue(next) });
  // Tracks a stylesheet sets read back as pixels; new ones share the room instead.
  const count = (n: number): Changes => ({
    [prop]: n > 0 ? `repeat(${n}, minmax(0, 1fr))` : removal(reading, "none"),
  });
  const add = () => {
    if (!tracks) return;
    if (!own) return scope.commit(count(tracks.length + 1));
    scope.commit(write([...tracks, tracks.at(-1) ?? "1fr"]));
  };
  const drop = () => {
    if (!tracks || tracks.length === 0) return;
    scope.commit(own ? write(tracks.slice(0, -1)) : count(tracks.length - 1));
  };
  const [first] = tracks ?? [];
  const equal = tracks !== null && tracks.length > 1 && tracks.every((t) => t === first);
  return (
    <Row
      action={
        <Toggle
          icon="minus"
          title={`Remove the last ${title.toLowerCase().slice(0, -1)}`}
          disabled={!tracks || tracks.length === 0}
          onClick={drop}
        />
      }
    >
      <div role="group" aria-label={title} title={title} {...stylex.props(styles.tracks)}>
        <span {...stylex.props(styles.trackLead)}>{letter}</span>
        {reading.kind === "mixed" ? (
          <span {...stylex.props(styles.trackNote)}>Mixed</span>
        ) : tracks === null ? (
          <CustomChip
            title="Tracks that repeat to fill the room, or have named lines"
            onReset={() => scope.commit({ [prop]: null })}
          />
        ) : tracks.length === 0 ? (
          <span {...stylex.props(styles.trackNote)}>Auto</span>
        ) : equal ? (
          <>
            <TrackChip
              scope={scope}
              track={first!}
              faint={!own}
              toChanges={(t) => (t === null ? count(0) : write(tracks.map(() => t)))}
            />
            <span {...stylex.props(styles.trackNote)}>× {tracks.length}</span>
          </>
        ) : (
          tracks.map((track, i) => (
            <TrackChip
              // Tracks have no identity but their place.
              // oxlint-disable-next-line no-array-index-key
              key={i}
              scope={scope}
              track={track}
              faint={!own}
              toChanges={(t) =>
                write(t === null ? tracks.filter((_, j) => j !== i) : tracks.with(i, t))
              }
            />
          ))
        )}
        <button
          type="button"
          title={`Add a ${title.toLowerCase().slice(0, -1)}`}
          aria-label={`Add a ${title.toLowerCase().slice(0, -1)}`}
          disabled={!tracks}
          onClick={add}
          {...stylex.props(
            raised.control,
            styles.trackAdd,
            inField.square,
            !tracks && raised.disabled,
          )}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
    </Row>
  );
}

/** One track, typed into; it shows on the canvas as it's typed. */
function TrackChip({
  scope,
  track,
  faint,
  toChanges,
}: {
  scope: Scope;
  track: string;
  faint: boolean;
  toChanges: (track: string | null) => Changes;
}) {
  const field = useDraftField(scope.editor, faint ? "" : trackLabel(track), (text) =>
    scope.edits(toChanges(parseTrack(text))),
  );
  return (
    <input
      aria-label="Track size"
      placeholder={faint ? trackLabel(track) : ""}
      {...field.props}
      {...stylex.props(styles.trackChip, inField.height)}
    />
  );
}

/**
 * Where a flex container puts its children, as a 3×3 grid to click. Each
 * cell draws two bars where the children would sit, against the edges
 * they'd hug.
 */
function AlignGrid({
  cell,
  onPick,
}: {
  cell: { x: number; y: number } | null;
  onPick: (x: number, y: number) => void;
}) {
  return (
    <div role="group" aria-label="Align" {...stylex.props(styles.align)}>
      {[0, 1, 2].flatMap((y) =>
        [0, 1, 2].map((x) => {
          const on = cell?.x === x && cell.y === y;
          const name = `${["Top", "Middle", "Bottom"][y]} ${["left", "center", "right"][x]}`;
          return (
            <button
              key={`${x}${y}`}
              type="button"
              aria-pressed={on}
              aria-label={name}
              title={name}
              onClick={() => onPick(x, y)}
              {...stylex.props(styles.alignCell)}
            >
              <span
                {...stylex.props(
                  styles.alignBox,
                  on && styles.alignBoxOn,
                  y === 0 && styles.edgeTop,
                  y === 2 && styles.edgeBottom,
                  x === 0 && styles.edgeLeft,
                  x === 2 && styles.edgeRight,
                  x === 1 && y === 1 && styles.edgeAll,
                )}
                style={{
                  alignItems: ["flex-start", "center", "flex-end"][x],
                  justifyContent: ["flex-start", "center", "flex-end"][y],
                }}
              >
                <span {...stylex.props(styles.alignBar, styles.alignBarLong)} />
                <span {...stylex.props(styles.alignBar, styles.alignBarShort)} />
              </span>
            </button>
          );
        }),
      )}
    </div>
  );
}

const styles = stylex.create({
  /** Three equal columns over two rows, across the whole width: the gutter's room goes to them. */
  frame: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.sm,
  },
  /** The first two of the frame's columns, for a strip. */
  twoThirds: { gridColumn: "1 / 3", display: "flex", minWidth: 0 },
  /** The frame's third column, holding a toggle for the row, at its start. */
  third: { gridColumn: 3, display: "flex", alignItems: "center" },
  /** The frame's last two columns, holding two of their own. */
  lastTwo: { gridColumn: "2 / 4", minWidth: 0 },
  halves: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.sm },
  quarters: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: space.sm },
  tracks: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.xs,
    minHeight: size.xs,
    paddingBlock: space.px,
    paddingInline: space.sm,
    // The items inside sit 3px in, at 3px radius, so the corners stay concentric.
    borderRadius: radii.md,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
  },
  trackLead: {
    minWidth: 12,
    color: colors.faint,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
  },
  trackNote: { color: colors.faint, fontFamily: fonts.sans, fontSize: 12 },
  trackChip: {
    width: 39,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundImage: `linear-gradient(180deg, ${face.top}, ${face.bottom})`,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 11,
    textAlign: "center",
    outline: "none",
    boxShadow: {
      default: shadows.control,
      ":hover": shadows.controlHover,
      ":focus": `${shadows.control}, 0 0 0 1px ${colors.brand}`,
    },
    "::placeholder": { color: colors.faint },
  },
  trackAdd: {
    display: "grid",
    placeItems: "center",
    marginLeft: "auto",
    padding: 0,
    borderRadius: radii.xs,
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  align: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gridTemplateRows: "repeat(3, 1fr)",
    // Three 27px rows, a field's height each, in the 3px padding.
    minHeight: `calc(3 * ${size.sm} + 2 * ${space.xs})`,
    padding: space.xs,
    // The items inside sit 3px in, at 3px radius, so the corners stay concentric.
    borderRadius: radii.md,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
  },
  alignCell: {
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    // Bare in the well; it rises on hover and sinks when pressed, like a raised control.
    backgroundImage: {
      default: "none",
      ":hover": `linear-gradient(180deg, ${face.hoverTop}, ${face.hoverBottom})`,
      ":active": `linear-gradient(180deg, ${face.pressedTop}, ${face.pressed})`,
    },
    boxShadow: {
      default: "none",
      ":hover": shadows.controlHover,
      ":active": shadows.controlPressed,
    },
    color: colors.faint,
    cursor: "var(--cursor-pointer, pointer)",
  },
  alignBox: {
    display: "flex",
    flexDirection: "column",
    gap: 1.5,
    width: 15,
    height: 15,
    padding: 1.5,
    boxSizing: "border-box",
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "color-mix(in srgb, currentColor 45%, transparent)",
    opacity: 0.55,
  },
  alignBoxOn: { color: colors.text, opacity: 1 },
  edgeTop: { borderTopWidth: 1 },
  edgeBottom: { borderBottomWidth: 1 },
  edgeLeft: { borderLeftWidth: 1 },
  edgeRight: { borderRightWidth: 1 },
  edgeAll: { borderWidth: 1, borderRadius: radii.xs },
  alignBar: {
    flexShrink: 0,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: "currentColor",
  },
  alignBarLong: { width: 9 },
  alignBarShort: { width: 6 },
});
