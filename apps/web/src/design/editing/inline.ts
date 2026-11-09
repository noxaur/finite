import type { Inline, Mark } from "@finite/protocol";

export type Format = "bold" | "italic" | "underline" | "strike";

/** The tags that mean each format, the one written first. */
const FORMAT_TAGS: Record<Format, readonly Mark["m"][]> = {
  bold: ["strong", "b"],
  italic: ["em", "i"],
  underline: ["u"],
  strike: ["s", "del"],
};

type Kept = { id: number; label: string };

/** How much of the offset space an item takes: a chip and a line break count as one. */
export const lengthOf = (item: Inline): number => (item.t === "text" ? item.text.length : 1);

export const lengthAll = (content: readonly Inline[]): number =>
  content.reduce((n, item) => n + lengthOf(item), 0);

const marksOf = (item: Inline): readonly Mark[] => item.marks ?? [];

/** `item` with `marks`, leaving a mark-less chip or break without the field. */
function withMarks(item: Inline, marks: Mark[]): Inline {
  if (item.t === "text") return { ...item, marks };
  const { marks: _old, ...bare } = item;
  return marks.length > 0 ? { ...bare, marks } : bare;
}

/** Applies `change` to the runs between two offsets, splitting the runs that straddle them. */
function inRange(
  content: readonly Inline[],
  start: number,
  end: number,
  change: (item: Inline) => Inline,
): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const item of content) {
    const len = lengthOf(item);
    const from = Math.max(start - at, 0);
    const to = Math.min(end - at, len);
    if (from >= to) out.push(item);
    else if (item.t !== "text") out.push(change(item));
    else {
      if (from > 0) out.push({ ...item, text: item.text.slice(0, from) });
      out.push(change({ ...item, text: item.text.slice(from, to) }));
      if (to < len) out.push({ ...item, text: item.text.slice(to) });
    }
    at += len;
  }
  return normalize(out);
}

/** The items between two offsets. Line breaks don't count: they can't be bold. */
function itemsIn(content: readonly Inline[], start: number, end: number): Inline[] {
  let at = 0;
  return content.filter((item) => {
    const from = at;
    at += lengthOf(item);
    return item.t !== "br" && at > start && from < end;
  });
}

export function isFormatted(
  content: readonly Inline[],
  start: number,
  end: number,
  format: Format,
): boolean {
  const items = itemsIn(content, start, end);
  const tags = FORMAT_TAGS[format];
  return items.length > 0 && items.every((i) => marksOf(i).some((m) => tags.includes(m.m)));
}

/** Makes the range bold, or plain when it's all bold already. */
export function toggleFormat(
  content: readonly Inline[],
  start: number,
  end: number,
  format: Format,
): Inline[] {
  const tags = FORMAT_TAGS[format];
  const off = isFormatted(content, start, end, format);
  return inRange(content, start, end, (item) => {
    const marks = marksOf(item).filter((m) => !tags.includes(m.m));
    return withMarks(item, off ? marks : [...marks, { m: tags[0]! } as Mark]);
  });
}

/** Sets a CSS property on the range, in the span it already has or in a new one. */
export function setRunStyle(
  content: readonly Inline[],
  start: number,
  end: number,
  prop: string,
  value: string,
): Inline[] {
  return inRange(content, start, end, (item) => {
    const marks = [...marksOf(item)];
    const i = marks.findLastIndex((m) => m.m === "span");
    if (i === -1) return withMarks(item, [...marks, { m: "span", styles: { [prop]: value } }]);
    const span = marks[i] as Extract<Mark, { m: "span" }>;
    marks[i] = { ...span, styles: { ...span.styles, [prop]: value } };
    return withMarks(item, marks);
  });
}

const isLink = (m: Mark, keeps: readonly Kept[]) =>
  m.m === "a" || (m.m === "keep" && keeps.find((k) => k.id === m.id)?.label === "<a>");

/** The href the range links to, `""` for a link Finite can only remove, `null` for no link. */
export function linkIn(
  content: readonly Inline[],
  start: number,
  end: number,
  keeps: readonly Kept[],
): string | null {
  for (const item of itemsIn(content, start, end)) {
    for (const m of marksOf(item)) if (isLink(m, keeps)) return m.m === "a" ? m.href : "";
  }
  return null;
}

/** Points the range at `href`, or takes its links away when `href` is `null`. */
export function setLink(
  content: readonly Inline[],
  start: number,
  end: number,
  href: string | null,
  keeps: readonly Kept[],
): Inline[] {
  return inRange(content, start, end, (item) => {
    const marks = marksOf(item).filter((m) => !isLink(m, keeps));
    return withMarks(item, href === null ? marks : [...marks, { m: "a", href }]);
  });
}

const sameMark = (a: Mark, b: Mark) => JSON.stringify(a) === JSON.stringify(b);

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => sameMark(m, b[i]!));
}

/** Drops empty runs and merges neighbours formatted alike, so equal text compares equal. */
export function normalize(content: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const item of content) {
    if (item.t === "text" && item.text === "") continue;
    const last = out.at(-1);
    if (item.t === "text" && last?.t === "text" && sameMarks(last.marks, item.marks)) {
      out[out.length - 1] = { ...last, text: last.text + item.text };
    } else out.push(item);
  }
  return out;
}

export function sameContent(a: readonly Inline[], b: readonly Inline[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether the content is one run of unformatted text, or nothing. */
export function isPlain(content: readonly Inline[]): boolean {
  return content.every((item) => item.t === "text" && item.marks.length === 0);
}

/** The content as one line of plain text. */
export function plainText(content: readonly Inline[]): string {
  return content.map((item) => (item.t === "text" ? item.text : " ")).join("");
}

/** A line of `content` a person can see or a chip they can act on; else there's no text here. */
export function hasText(content: readonly Inline[]): boolean {
  return content.some((item) => item.t !== "text" || item.text.trim() !== "");
}
