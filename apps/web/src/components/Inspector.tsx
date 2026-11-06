"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Editor } from "@/design/editing/editor";
import { isPositioned, moveAbsolute, moveArtboards, resize } from "@/design/editing/geometry";
import {
  alignCell,
  alignStyles,
  declarations,
  type LayoutKind,
  layoutOf,
  layoutStyles,
  parseDeclarations,
  parseInput,
  readStyle,
  shown,
} from "@/design/editing/inspect";
import { nodeOf } from "@/design/editing/tree";
import type { Renderer } from "@/design/renderer";
import type { Replica, TokenTable } from "@/design/replica";
import type { Node, UserEdit } from "@/design/schema";
import { isColor, resolveToken } from "@/lib/tokens";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Icon, type IconName } from "./Icons";

type Geometry = "x" | "y" | "w" | "h";

/** What every field in one render reads and writes. */
interface Scope {
  /** The elements the fields edit: the selection, with text nodes standing for their element. */
  readonly targets: ReadonlyArray<Node>;
  /** The browser's styles on the first target, where they can be read. */
  readonly computed: CSSStyleDeclaration | null;
  readonly tokens: TokenTable;
  /** The mode the first target's artboard renders in, to resolve tokens. */
  readonly mode: string;
  readonly commit: (styles: Readonly<Record<string, string | null>>) => void;
}

/** A layer's icon, from what the document says about it. */
export function iconOf(node: Node): IconName {
  if (node.parent === null) return "artboard";
  if (node.component || node.instanceOf !== undefined) return "component";
  if (node.type === "text") return "text";
  if (node.tag === "img" || node.tag === "svg" || node.tag === "picture") return "image";
  const display = node.styles.display ?? "";
  if (display.includes("grid")) return "grid";
  if (display.includes("flex")) {
    return (node.styles["flex-direction"] ?? "").startsWith("column") ? "column" : "row";
  }
  return "box";
}

function kindOf(node: Node): string {
  if (node.parent === null) return "Artboard";
  if (node.component) return "Component";
  if (node.instanceOf !== undefined) return "Instance";
  if (node.type === "text") return "Text";
  return node.tag ?? "Element";
}

/**
 * The selection's styles, down the right side. Each field shows the inline
 * style every selected element shares, the token it uses, or, faintly,
 * what the browser draws when none of them sets one. Typing into a field
 * sets it on the whole selection as one edit, so one undo takes it back;
 * agents see it like any other change. X, Y, W and H move and resize the
 * one selected element the way dragging does.
 */
export function Inspector({
  editor,
  renderer,
  replica,
  tokens,
}: {
  editor: Editor;
  renderer: Renderer;
  replica: Replica;
  tokens: TokenTable;
  /** Changes with the design, so the fields follow every edit. */
  version: number;
}) {
  const [state, setState] = useState(editor.state);
  useEffect(() => {
    setState(editor.state);
    return editor.subscribe(() => setState(editor.state));
  }, [editor]);

  const selected = state.selection
    .map((id) => nodeOf(replica, id))
    .filter((n): n is Node => n !== undefined);
  if (selected.length === 0) {
    return (
      <p {...stylex.props(styles.empty)}>
        Select a layer on the canvas or in Layers to see and change its styles.
      </p>
    );
  }
  const targets = [
    ...new Map(
      selected
        .map((n) => (n.type === "text" && n.parent !== null ? nodeOf(replica, n.parent) : n))
        .filter((n): n is Node => n !== undefined)
        .map((n) => [n.id, n]),
    ).values(),
  ];
  const [first] = targets;
  if (!first) return null;
  const board = replica.artboardOf(first.id);
  const scope: Scope = {
    targets,
    computed: renderer.computedStyle(first.id),
    tokens,
    mode: board ? replica.modeOf(board) : "",
    commit: (changes) =>
      void editor.commit([{ kind: "setStyles", ids: targets.map((t) => t.id), styles: changes }]),
  };
  const read = (prop: string) =>
    readStyle(targets, prop, scope.computed?.getPropertyValue(prop) || null);
  const value = (prop: string) => {
    const reading = read(prop);
    return reading.kind === "value" || reading.kind === "computed" ? reading.raw : "";
  };
  const layout = layoutOf(value("display"), value("flex-direction"));
  const action = selected.length === 1 ? editor.componentAction(first.id) : null;
  const one = selected.length === 1 ? selected[0] : undefined;
  // Ids change with the selection, so every field starts fresh for a new one.
  const key = targets.map((t) => t.id).join(" ");

  return (
    <div key={key} role="group" aria-label="Inspector" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.top)}>
        <span {...stylex.props(styles.topIcon)}>
          <Icon name={one ? iconOf(one) : "box"} size={14} />
        </span>
        <span {...stylex.props(styles.topName)}>
          {one ? (one.name ?? one.text ?? one.tag ?? "Layer") : `${selected.length} layers`}
        </span>
        {one && <span {...stylex.props(styles.tag)}>{kindOf(one)}</span>}
        {action && (
          <button
            type="button"
            onClick={() => editor.toggleComponent(first.id)}
            title={action === "make" ? "Make component (⌥⌘K)" : "Detach instance (⌥⌘B)"}
            {...stylex.props(styles.componentButton)}
          >
            {action === "make" ? "Make component" : "Detach"}
          </button>
        )}
      </header>

      {one && !state.dragging && (
        <GeometryFields node={one} editor={editor} renderer={renderer} replica={replica} />
      )}

      {one && (one.parent === null || isLink(one)) && !one.id.includes("/") && (
        <Section title="Prototype">
          <PrototypeFields node={one} editor={editor} replica={replica} />
        </Section>
      )}

      <Section title="Layout">
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
        {(layout === "row" || layout === "column") && (
          <div {...stylex.props(styles.alignRow)}>
            <AlignGrid
              cell={alignCell(layout, value("justify-content"), value("align-items"))}
              onPick={(x, y) => scope.commit(alignStyles(layout, x, y))}
            />
            <div {...stylex.props(styles.stack)}>
              <StyleField scope={scope} prop="gap" label="Gap" />
              <StyleField scope={scope} prop="flex-wrap" label="Wrap" />
            </div>
          </div>
        )}
        {layout === "grid" && (
          <>
            <StyleField scope={scope} prop="grid-template-columns" label="Columns" />
            <StyleField scope={scope} prop="gap" label="Gap" />
          </>
        )}
        <StyleField scope={scope} prop="padding" label="Padding" />
      </Section>

      <Section title="Fill">
        <StyleField scope={scope} prop="background-color" label="Fill" color />
        <StyleField scope={scope} prop="opacity" label="Opacity" />
      </Section>

      <Section title="Border">
        <StyleField scope={scope} prop="border-color" label="Color" color />
        <div {...stylex.props(styles.pair)}>
          <StyleField scope={scope} prop="border-width" label="Width" />
          <StyleField scope={scope} prop="border-style" label="Style" />
        </div>
      </Section>

      <Section title="Radius">
        <StyleField scope={scope} prop="border-radius" label="Radius" />
      </Section>

      <Section title="Effects">
        <StyleField scope={scope} prop="box-shadow" label="Shadow" />
      </Section>

      <Section title="Typography">
        <StyleField scope={scope} prop="font-family" label="Font" />
        <div {...stylex.props(styles.pair)}>
          <StyleField scope={scope} prop="font-weight" label="Weight" />
          <StyleField scope={scope} prop="font-size" label="Size" />
        </div>
        <div {...stylex.props(styles.pair)}>
          <StyleField scope={scope} prop="line-height" label="Line" />
          <StyleField scope={scope} prop="letter-spacing" label="Letter" />
        </div>
        <Segments
          label="Text align"
          value={value("text-align") === "start" ? "left" : value("text-align") || null}
          options={[
            ["left", null, "Left"],
            ["center", null, "Center"],
            ["right", null, "Right"],
            ["justify", null, "Justify"],
          ]}
          onPick={(align) => scope.commit({ "text-align": align })}
        />
        <StyleField scope={scope} prop="color" label="Color" color />
      </Section>

      <Section title="CSS" closed>
        <CssField scope={scope} />
      </Section>
    </div>
  );
}

/** Whether `node` is a link, which can go to an artboard in interactive mode. */
const isLink = (node: Node) => node.tag === "a" || node.tag === "area";
const ARTBOARD_LINK = "#finite-artboard=";

/**
 * Where a link goes (`href="#finite-artboard=<id>"`), or the route an
 * artboard is on (`data-route`). Artboards on one route are one page at
 * several widths, and a link opens the one closest to its own width.
 */
function PrototypeFields({
  node,
  editor,
  replica,
}: {
  node: Node;
  editor: Editor;
  replica: Replica;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const putBack = useRef(false);
  if (node.parent !== null) {
    const href = node.attrs.href?.trim() ?? "";
    const to = href.startsWith(ARTBOARD_LINK) ? href.slice(ARTBOARD_LINK.length).trim() : "";
    const here = replica.artboardOf(node.id)?.id;
    const boards = replica.artboards().filter((b) => b.id !== here);
    return (
      <label {...stylex.props(styles.field)}>
        <span {...stylex.props(styles.fieldLabel)}>Link</span>
        <select
          aria-label="Link to artboard"
          title="The artboard this link opens in interactive mode"
          value={to}
          onChange={(e) =>
            void editor.commit([
              {
                kind: "setLink",
                ids: [node.id],
                to: e.target.value === "" ? null : e.target.value,
              },
            ])
          }
          {...stylex.props(styles.input)}
        >
          <option value="">{to === "" && href !== "" ? href : "No artboard"}</option>
          {to !== "" && !replica.get(to) && <option value={to}>Missing artboard</option>}
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name ?? "Artboard"}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const own = node.attrs["data-route"] ?? "";
  const route = replica.flow().routes.find((r) => r.screens.some((s) => s.artboard === node.id));
  const commit = () => {
    const text = typing?.trim();
    setTyping(null);
    if (putBack.current || text === undefined || text === own) {
      putBack.current = false;
      return;
    }
    void editor.commit([{ kind: "setRoute", id: node.id, route: text === "" ? null : text }]);
  };
  return (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>Route</span>
      <input
        aria-label="Route"
        spellCheck={false}
        value={typing ?? own}
        placeholder={route?.path}
        title="Artboards with the same route are one page at different widths"
        onChange={(e) => setTyping(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            putBack.current = true;
            e.currentTarget.blur();
          }
        }}
        {...stylex.props(styles.input)}
      />
    </label>
  );
}

function Section({
  title,
  closed = false,
  children,
}: {
  title: string;
  closed?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!closed);
  return (
    <section aria-label={title} {...stylex.props(styles.section)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(styles.sectionHead, !open && styles.sectionClosed)}
      >
        {title}
        <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
          <Icon name="next" size={12} />
        </span>
      </button>
      {open && children}
    </section>
  );
}

/**
 * One CSS property as a text field. Enter or leaving it sets what was
 * typed, and Escape puts the shown value back.
 */
function StyleField({
  scope,
  prop,
  label,
  color = false,
}: {
  scope: Scope;
  prop: string;
  label: string;
  color?: boolean;
}) {
  const reading = readStyle(scope.targets, prop, scope.computed?.getPropertyValue(prop) || null);
  const { text, placeholder } = shown(reading);
  const [typing, setTyping] = useState<string | null>(null);
  const putBack = useRef(false);
  const commit = () => {
    if (putBack.current || typing === null) {
      putBack.current = false;
      setTyping(null);
      return;
    }
    setTyping(null);
    const next = parseInput(prop, typing);
    const current = reading.kind === "value" ? reading.raw : null;
    if (next !== current || reading.kind === "mixed") scope.commit({ [prop]: next });
  };
  const raw = reading.kind === "value" || reading.kind === "computed" ? reading.raw : undefined;
  const token = reading.kind === "value" ? reading.token : null;
  const swatch = token ? resolveToken(scope.tokens, token, scope.mode) : raw;
  return (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>{label}</span>
      {color && (
        <span
          aria-hidden
          {...stylex.props(styles.swatch)}
          style={{ background: isColor(swatch) ? swatch : "transparent" }}
        />
      )}
      <input
        aria-label={label}
        spellCheck={false}
        value={typing ?? text}
        placeholder={placeholder}
        title={token ? `${token}: ${swatch ?? "not defined"}` : (raw ?? undefined)}
        onChange={(e) => setTyping(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            putBack.current = true;
            e.currentTarget.blur();
          }
        }}
        {...stylex.props(styles.input, token !== null && typing === null && styles.token)}
      />
    </label>
  );
}

/** Every inline style of the selection's first element, as declarations to edit. */
function CssField({ scope }: { scope: Scope }) {
  const own = scope.targets[0]?.styles ?? {};
  const text = declarations(own);
  // What's typed, and the styles it started from: saving changes only what
  // the person changed, so an agent's edit meanwhile stays.
  const [typing, setTyping] = useState<{
    text: string;
    base: Readonly<Record<string, string>>;
  } | null>(null);
  return (
    <textarea
      aria-label="Inline CSS"
      spellCheck={false}
      rows={Math.min(Math.max(text.split("\n").length + 1, 3), 16)}
      value={typing?.text ?? text}
      placeholder="color: var(--fg);"
      onChange={(e) => setTyping({ text: e.target.value, base: typing?.base ?? own })}
      onBlur={() => {
        if (typing === null) return;
        setTyping(null);
        const changes = parseDeclarations(typing.text, typing.base);
        if (Object.keys(changes).length > 0) scope.commit(changes);
      }}
      {...stylex.props(styles.input, styles.css)}
    />
  );
}

function Segments<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string | null;
  options: ReadonlyArray<readonly [T, IconName | null, string]>;
  onPick: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} {...stylex.props(styles.segments)}>
      {options.map(([option, icon, name]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          aria-label={name}
          title={name}
          onClick={() => value !== option && onPick(option)}
          {...stylex.props(styles.segment, value === option && styles.segmentOn)}
        >
          {icon ? <Icon name={icon} size={14} /> : name}
        </button>
      ))}
    </div>
  );
}

/** Where a flex container puts its children, as a 3×3 grid to click. */
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
          return (
            <button
              key={`${x}${y}`}
              type="button"
              aria-pressed={on}
              aria-label={`${["Top", "Middle", "Bottom"][y]} ${["left", "center", "right"][x]}`}
              onClick={() => onPick(x, y)}
              {...stylex.props(styles.alignCell)}
            >
              <span {...stylex.props(styles.alignDot, on && styles.alignOn)} />
            </button>
          );
        }),
      )}
    </div>
  );
}

/**
 * The selected node's position and size, in CSS pixels, to type exact
 * values into. An artboard's X and Y are its place on the canvas; a
 * positioned element's are its `left` and `top`. An element in the flow
 * is placed by its layout, so its X and Y only show where it is.
 */
function GeometryFields({
  node,
  editor,
  renderer,
  replica,
}: {
  node: Node;
  editor: Editor;
  renderer: Renderer;
  replica: Replica;
}) {
  // What the person is typing, until it's committed or put back.
  const [typing, setTyping] = useState<{ field: Geometry; text: string } | null>(null);
  // Escape blurs the field, and the blur mustn't commit what it put back.
  const putBack = useRef(false);
  const facts = renderer.measure(node.id);
  if (!facts) return null;
  const board = node.parent === null;
  const artboard = replica.artboardOf(node.id);
  const boardRect = artboard ? renderer.nodeRect(artboard.id) : null;
  const values: Record<Geometry, number> = {
    x: board
      ? (node.x ?? 0)
      : isPositioned(facts)
        ? facts.left
        : (facts.rect.left - (boardRect?.left ?? 0)) / facts.scale,
    y: board
      ? (node.y ?? 0)
      : isPositioned(facts)
        ? facts.top
        : (facts.rect.top - (boardRect?.top ?? 0)) / facts.scale,
    w: facts.rect.width / facts.scale,
    h: facts.rect.height / facts.scale,
  };
  const movable = board || isPositioned(facts);

  /** The edit that gives `field` the value `n`. */
  const editFor = (field: Geometry, n: number): UserEdit | null => {
    const d = n - values[field];
    if (!Number.isFinite(n) || Math.abs(d) < 0.5) return null;
    if (field === "w") return resize(node, facts, "e", { x: d, y: 0 });
    if (field === "h") return resize(node, facts, "s", { x: 0, y: d });
    const delta = field === "x" ? { x: d, y: 0 } : { x: 0, y: d };
    if (board) return moveArtboards([{ id: node.id, x: node.x ?? 0, y: node.y ?? 0 }], delta);
    return isPositioned(facts) ? moveAbsolute(node, facts, delta) : null;
  };
  const commit = () => {
    if (putBack.current) {
      putBack.current = false;
      return;
    }
    if (!typing) return;
    const edit = editFor(typing.field, parseFloat(typing.text));
    setTyping(null);
    if (edit) void editor.commit([edit]);
  };

  return (
    <section aria-label="Position and size" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.quad)}>
        {(["x", "y", "w", "h"] as const).map((field) => {
          const disabled = (field === "x" || field === "y") && !movable;
          return (
            <label key={field} {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel, styles.short)}>{field.toUpperCase()}</span>
              <input
                inputMode="decimal"
                aria-label={{ x: "X", y: "Y", w: "Width", h: "Height" }[field]}
                disabled={disabled}
                title={disabled ? "Its layout places it; drag it to reorder it" : undefined}
                value={typing?.field === field ? typing.text : String(Math.round(values[field]))}
                onChange={(e) => setTyping({ field, text: e.target.value })}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                  } else if (e.key === "Escape") {
                    putBack.current = true;
                    setTyping(null);
                    e.currentTarget.blur();
                  }
                }}
                {...stylex.props(styles.input)}
              />
            </label>
          );
        })}
      </div>
    </section>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  empty: {
    margin: 0,
    padding: space.ms,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "16px",
  },
  top: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.lg,
    flexShrink: 0,
    paddingInline: space.ms,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  topIcon: { color: colors.faint, display: "flex" },
  topName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
  },
  tag: {
    flexShrink: 0,
    paddingInline: space.sm,
    height: 22,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: radii.xs,
    backgroundColor: colors.sunk,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  componentButton: {
    flexShrink: 0,
    height: size.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: colors.sunk, ":hover": colors.bg },
    color: colors.component,
    font: "inherit",
    fontSize: 12,
    whiteSpace: "nowrap",
    cursor: "var(--cursor-pointer, pointer)",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.ms,
    paddingInline: space.ms,
    borderTopWidth: { default: 1, ":first-of-type": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: size.xs,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  sectionClosed: { color: colors.muted },
  chevron: {
    display: "flex",
    color: colors.faint,
    transition: `transform 200ms cubic-bezier(.23, 1, .32, 1)`,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  field: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    height: size.sm,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: { default: "none", ":hover": `inset 0 0 0 1px ${colors.border}` },
    cursor: "text",
  },
  fieldLabel: {
    flexShrink: 0,
    width: 52,
    color: colors.faint,
    fontSize: 12,
    fontWeight: 500,
  },
  short: { width: 12 },
  swatch: {
    width: 16,
    height: 16,
    flexShrink: 0,
    borderRadius: radii.xs,
    boxShadow: `inset 0 0 0 1px ${colors.borderStrong}`,
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    width: "100%",
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.text, ":disabled": colors.faint },
    fontFamily: fonts.mono,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    outline: "none",
    "::placeholder": { color: colors.faint },
  },
  token: { color: colors.brandText },
  css: {
    resize: "vertical",
    padding: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    lineHeight: "18px",
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
  },
  pair: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm },
  quad: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm },
  stack: { display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 },
  alignRow: { display: "grid", gridTemplateColumns: "64px 1fr", gap: space.sm },
  segments: {
    display: "flex",
    padding: space.px,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  segment: {
    flexGrow: 1,
    flexBasis: 0,
    display: "grid",
    placeItems: "center",
    height: size.xs,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  segmentOn: {
    backgroundColor: colors.surface,
    boxShadow: shadows.inset,
    color: colors.text,
  },
  align: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gridTemplateRows: "repeat(3, 1fr)",
    width: 64,
    height: 64,
    padding: space.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  alignCell: {
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    cursor: "var(--cursor-pointer, pointer)",
  },
  alignDot: {
    width: 3,
    height: 3,
    borderRadius: "50%",
    backgroundColor: colors.faint,
  },
  alignOn: { width: 10, height: 4, borderRadius: 1, backgroundColor: colors.brand },
});
