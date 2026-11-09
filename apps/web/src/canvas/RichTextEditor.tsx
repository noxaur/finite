"use client";

import * as stylex from "@stylexjs/stylex";
import type { Inline, Mark } from "@finite/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@/components/Button";
import {
  type Format,
  isFormatted,
  lengthAll,
  linkIn,
  normalize,
  setLink,
  setRunStyle,
  toggleFormat,
} from "@/design/editing/inline";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import type { CanvasEditor, TextEdit } from "./editor";

/** What hides the element's own text while the overlay shows it, on HTML and on SVG. */
const HIDDEN = {
  color: "transparent",
  "-webkit-text-fill-color": "transparent",
  "text-decoration-color": "transparent",
  fill: "transparent",
};
/** How far a text's natural width may stray from its box and still count as hugging it. */
const HUG_SLOP = 2;

const FORMATS: ReadonlyArray<
  readonly [Format, "bold" | "italic" | "underline" | "strike", string]
> = [
  ["bold", "bold", "Bold"],
  ["italic", "italic", "Italic"],
  ["underline", "underline", "Underline"],
  ["strike", "strike", "Strikethrough"],
];
const FORMAT_KEYS: Record<string, Format> = { b: "bold", i: "italic", u: "underline" };

type Range = readonly [number, number];
/** The marks each painted run carries, by the index in its `data-marks`. */
type Palette = Mark[][];

function markStyles(marks: readonly Mark[], edit: TextEdit): Record<string, string> {
  const out: Record<string, string> = {};
  const lines: string[] = [];
  for (const mark of marks) {
    if (mark.m === "strong" || mark.m === "b") out["font-weight"] = "bold";
    else if (mark.m === "em" || mark.m === "i") out["font-style"] = "italic";
    else if (mark.m === "u" || mark.m === "a") lines.push("underline");
    else if (mark.m === "s" || mark.m === "del") lines.push("line-through");
    else if (mark.m === "span") Object.assign(out, mark.styles);
    else if (mark.m === "keep") Object.assign(out, keptStyles(edit.keepStyles[mark.id]));
  }
  if (lines.length > 0) out["text-decoration-line"] = lines.join(" ");
  return out;
}

/** What a kept wrapper's text looks like in the overlay, read from the frame. */
function keptStyles(computed: Record<string, string> | undefined): Record<string, string> {
  if (!computed) return {};
  const out: Record<string, string> = {
    color: computed.color ?? "",
    "font-family": computed.fontFamily ?? "",
    "font-size": computed.fontSize ?? "",
    "font-weight": computed.fontWeight ?? "",
    "font-style": computed.fontStyle ?? "",
  };
  if (computed.textDecorationLine && computed.textDecorationLine !== "none")
    out["text-decoration-line"] = computed.textDecorationLine;
  return out;
}

/** Draws `content` into the editable box. The marks stay in a side table, not in the DOM. */
function paint(root: HTMLElement, content: readonly Inline[], edit: TextEdit, palette: Palette) {
  const nodes = content.map((item) => {
    const marks = item.marks ?? [];
    palette.push([...marks]);
    const mark = (el: HTMLElement) => {
      el.dataset.marks = String(palette.length - 1);
      for (const [name, value] of Object.entries(markStyles(marks, edit)))
        el.style.setProperty(name, value);
      return el;
    };
    if (item.t === "br") return mark(document.createElement("br"));
    const span = document.createElement("span");
    if (item.t === "atom") {
      span.dataset.atom = String(item.id);
      span.contentEditable = "false";
      span.textContent = edit.keeps.find((k) => k.id === item.id)?.label ?? "";
      span.className = stylex.props(styles.chip).className ?? "";
    } else span.textContent = item.text;
    return mark(span);
  });
  // A line ending in a break needs a second one for the caret to reach the next line.
  if (content.at(-1)?.t === "br") nodes.push(document.createElement("br"));
  root.replaceChildren(...nodes);
}

/** Reads the editable box back into runs; a trailing break only holds the caret. */
function readBox(root: HTMLElement, palette: Palette): Inline[] {
  const out: Inline[] = [];
  const visit = (node: Node, marks: Mark[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push({ t: "text", text: node.nodeValue ?? "", marks });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const own = node.dataset.marks === undefined ? marks : palette[Number(node.dataset.marks)]!;
    const decorated = own.length > 0 ? { marks: own } : {};
    if (node.tagName === "BR") out.push({ t: "br", ...decorated });
    else if (node.dataset.atom !== undefined)
      out.push({ t: "atom", id: Number(node.dataset.atom), ...decorated });
    else node.childNodes.forEach((child) => visit(child, own));
  };
  root.childNodes.forEach((child) => visit(child, []));
  if (out.at(-1)?.t === "br") out.pop();
  return normalize(out);
}

/** The length of everything before `node` inside the editable box: a chip or a break counts one. */
function offsetOf(root: Node, target: Node, targetOffset: number): number {
  let offset = 0;
  let found = false;
  const walk = (node: Node) => {
    if (found) return;
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) offset += targetOffset;
      else
        for (let i = 0; i < targetOffset && i < node.childNodes.length; i++)
          walk(node.childNodes[i]!);
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) offset += node.nodeValue?.length ?? 0;
    else if (
      node instanceof HTMLElement &&
      (node.tagName === "BR" || node.dataset.atom !== undefined)
    )
      offset += 1;
    else node.childNodes.forEach(walk);
  };
  walk(root);
  return offset;
}

function selectionIn(root: HTMLElement): Range | null {
  const selection = getSelection();
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  return [
    offsetOf(root, range.startContainer, range.startOffset),
    offsetOf(root, range.endContainer, range.endOffset),
  ];
}

/** The DOM point at an offset, the way `offsetOf` counts. */
function pointAt(root: HTMLElement, target: number): [Node, number] {
  let at = 0;
  let found: [Node, number] | null = null;
  const visit = (node: Node) => {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue?.length ?? 0;
      if (target <= at + len) found = [node, target - at];
      at += len;
    } else if (
      node instanceof HTMLElement &&
      (node.tagName === "BR" || node.dataset.atom !== undefined)
    ) {
      if (target <= at)
        found = [node.parentNode!, Array.from(node.parentNode!.childNodes).indexOf(node)];
      at += 1;
    } else node.childNodes.forEach(visit);
  };
  visit(root);
  return found ?? [root, root.childNodes.length];
}

/** Puts the selection back between two offsets after a repaint. */
function select(root: HTMLElement, [start, end]: Range) {
  const range = document.createRange();
  range.setStart(...pointAt(root, start));
  range.setEnd(...pointAt(root, end));
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}

/**
 * Typing an element's text in place: an editable box over it with its font, while the element's
 * own text is hidden through the bridge. Runs are data, read back from the box on the way out:
 * chips are the code the text holds, and they come back as ids. Enter keeps it, Shift-Enter breaks
 * the line, Escape puts it back.
 */
export function RichTextEditor({ editor, editing }: { editor: CanvasEditor; editing: TextEdit }) {
  const shell = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const palette = useRef<Palette>([]);
  const range = useRef<Range | null>(null);
  const done = useRef(false);
  const [active, setActive] = useState({
    formats: new Set<Format>(),
    link: null as string | null,
    some: false,
  });
  const target = editing.target;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    paint(el, editing.content, editing, palette.current);
    el.focus();
    const all = lengthAll(editing.content);
    select(el, [0, all]);
    range.current = [0, all];
    if (target.kind === "element") {
      const bridge = editor.bridge(target.frameId);
      bridge?.preview(target.loc, HIDDEN);
      for (const keep of editing.keeps) if (keep.loc) bridge?.preview(keep.loc, HIDDEN);
      // The box hugs its text only when the element does; otherwise it holds the element's width.
      el.style.width = "max-content";
      const hugs = Math.abs(el.offsetWidth - editing.rect.width) <= HUG_SLOP;
      if (!hugs) el.style.width = `${editing.rect.width}px`;
    }
  }, [editing, editor, target]);

  useEffect(() => {
    const onChange = () => {
      const el = box.current;
      const now = el && selectionIn(el);
      if (!el || !now) return;
      range.current = now;
      const content = readBox(el, palette.current);
      setActive({
        formats: new Set(
          FORMATS.flatMap(([f]) => (isFormatted(content, now[0], now[1], f) ? [f] : [])),
        ),
        link: linkIn(content, now[0], now[1], editing.keeps),
        some: now[0] !== now[1],
      });
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [editing.keeps]);

  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const el = box.current;
    if (target.kind === "element") {
      const bridge = editor.bridge(target.frameId);
      for (const k of editing.keeps) if (k.loc) bridge?.preview(k.loc, null);
    }
    void editor.finishText(keep && el ? readBox(el, palette.current) : null);
  };

  /** Applies a change to the selected runs, then puts the box and the selection back. */
  const apply = (change: (content: Inline[], start: number, end: number) => Inline[]) => {
    const el = box.current;
    const at = range.current;
    if (!el || !at || at[0] === at[1]) return;
    const next = change(readBox(el, palette.current), at[0], at[1]);
    paint(el, next, editing, palette.current);
    el.focus();
    select(el, at);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const key = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    const format = mod && !e.shiftKey && !editing.plain ? FORMAT_KEYS[key] : undefined;
    if (e.key === "Escape") finish(false);
    else if (format) {
      e.preventDefault();
      apply((c, s, n) => toggleFormat(c, s, n, format));
    } else if (mod && key === "k" && !editing.plain) {
      e.preventDefault();
      shell.current?.querySelector<HTMLInputElement>('input[aria-label="Link"]')?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey && !editing.plain) document.execCommand("insertLineBreak");
      else finish(true);
    }
  };

  const f = editing.font;
  const fixedNew = target.kind === "new" && target.fixed;
  return (
    <div
      ref={shell}
      data-canvas-ui=""
      data-camera-ignore=""
      onBlur={(e) => {
        if (!shell.current?.contains(e.relatedTarget as Node | null)) finish(true);
      }}
      {...stylex.props(styles.shell(editing.rect.x, editing.rect.y))}
    >
      {!editing.plain && (
        <FormatBar
          active={active}
          onFormat={(format) => apply((c, s, n) => toggleFormat(c, s, n, format))}
          onStyle={(prop, value) => apply((c, s, n) => setRunStyle(c, s, n, prop, value))}
          onLink={(href) => apply((c, s, n) => setLink(c, s, n, href, editing.keeps))}
          onBack={() => box.current?.focus()}
        />
      )}
      <div
        ref={box}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Text"
        aria-multiline
        onKeyDown={onKey}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        onDrop={(e) => e.preventDefault()}
        {...stylex.props(styles.box)}
        style={{
          minWidth: fixedNew ? undefined : editing.rect.width || 2,
          width: fixedNew ? editing.rect.width : undefined,
          minHeight: editing.rect.height || "1lh",
          fontFamily: f.fontFamily,
          fontSize: f.fontSize,
          fontWeight: f.fontWeight,
          fontStyle: f.fontStyle,
          lineHeight: f.lineHeight,
          letterSpacing: f.letterSpacing,
          color: f.color,
          textAlign: f.textAlign as React.CSSProperties["textAlign"],
          textTransform: f.textTransform as React.CSSProperties["textTransform"],
          paddingTop: f.paddingTop,
          paddingRight: f.paddingRight,
          paddingBottom: f.paddingBottom,
          paddingLeft: f.paddingLeft,
        }}
      />
    </div>
  );
}

/** The floating bar over text being edited. Its fields keep the selection the text had. */
function FormatBar({
  active,
  onFormat,
  onStyle,
  onLink,
  onBack,
}: {
  active: { formats: ReadonlySet<Format>; link: string | null; some: boolean };
  onFormat: (format: Format) => void;
  onStyle: (prop: string, value: string) => void;
  onLink: (href: string | null) => void;
  onBack: () => void;
}) {
  const hold = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();
  return (
    <div role="toolbar" aria-label="Text format" {...stylex.props(styles.bar)}>
      {FORMATS.map(([format, icon, label]) => (
        <IconButton
          key={format}
          icon={icon}
          label={label}
          size="small"
          pressed={active.formats.has(format)}
          disabled={!active.some}
          onMouseDown={hold}
          onClick={() => onFormat(format)}
        />
      ))}
      <BarField
        label="Size"
        placeholder="16"
        width={36}
        onBack={onBack}
        onDone={(v) => v !== "" && onStyle("font-size", /\d$/.test(v) ? `${v}px` : v)}
      />
      <BarField
        label="Color"
        placeholder="#000000"
        width={68}
        onBack={onBack}
        onDone={(v) => v !== "" && onStyle("color", v)}
      />
      <BarField
        label="Link"
        key={active.link ?? ""}
        initial={active.link ?? ""}
        placeholder="https://"
        width={120}
        onBack={onBack}
        onDone={(v) => onLink(v === "" ? null : v)}
      />
    </div>
  );
}

function BarField({
  label,
  initial = "",
  placeholder,
  width,
  onDone,
  onBack,
}: {
  label: string;
  initial?: string;
  placeholder: string;
  width: number;
  onDone: (value: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState(initial);
  // What's already applied, so leaving the field after Enter doesn't apply it twice.
  const applied = useRef(initial);
  const commit = () => {
    const typed = value.trim();
    if (typed === applied.current) return;
    applied.current = typed;
    onDone(typed);
  };
  return (
    <input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          onBack();
        } else if (e.key === "Escape") {
          applied.current = value.trim();
          onBack();
        }
      }}
      {...stylex.props(styles.field(width))}
    />
  );
}

const styles = stylex.create({
  shell: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    // The world has no width, so anything shrink-to-fit in it would wrap at every word.
    width: "max-content",
  }),
  box: {
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
    caretColor: colors.hover,
    cursor: "text",
    userSelect: "text",
  },
  bar: {
    position: "absolute",
    left: 0,
    top: 0,
    transform: "scale(var(--inv-zoom, 1)) translateY(calc(-100% - 9px))",
    transformOrigin: "0 0",
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    padding: space.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    whiteSpace: "nowrap",
  },
  field: (width: number) => ({
    width,
    height: 24,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 12,
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  }),
  chip: {
    display: "inline-block",
    paddingInline: "0.3em",
    borderRadius: radii.sm,
    backgroundColor: "rgba(149, 206, 215, 0.25)",
    color: colors.brand,
    fontSize: "0.85em",
    fontFamily: fonts.mono,
    lineHeight: 1.3,
    userSelect: "none",
  },
});
