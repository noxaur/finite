import { parts } from "./lists";

type Read = (prop: string) => string | undefined;
type Styles = Readonly<Record<string, string>>;
type Changes = Record<string, string | null>;

/**
 * Takes `prop` back to `none`: off the element when it sets it inline,
 * or covered with `none` when only a class or the browser draws it.
 */
function reset(own: Styles, read: Read, prop: string, none: string, out: Changes) {
  if (own[prop] !== undefined) out[prop] = null;
  else {
    const drawn = read(prop);
    if (drawn !== undefined && drawn !== "" && drawn !== none) out[prop] = none;
  }
}

export type WrapMode = "wrap" | "nowrap" | "truncate" | "balance";

/** How the text wraps, from `white-space`, `text-overflow` and `text-wrap`. */
export function wrapOf(read: Read): WrapMode {
  const nowrap = read("white-space") === "nowrap" || read("text-wrap-mode") === "nowrap";
  if (nowrap && read("text-overflow") === "ellipsis") return "truncate";
  if (nowrap) return "nowrap";
  const wrap = read("text-wrap-style") ?? read("text-wrap") ?? "";
  return wrap.includes("balance") ? "balance" : "wrap";
}

/**
 * The styles that make text wrap as `mode`. Truncate is one line cut off
 * with an ellipsis: `white-space`, `overflow` and `text-overflow` together.
 * Leaving it takes off the `overflow` it wrote.
 */
export function wrapStyles(own: Styles, read: Read, mode: WrapMode): Changes {
  const out: Changes = {};
  const was = wrapOf(read);
  if (mode === "nowrap" || mode === "truncate") out["white-space"] = "nowrap";
  else reset(own, read, "white-space", "normal", out);
  if (mode === "truncate") {
    out.overflow = "hidden";
    out["text-overflow"] = "ellipsis";
  } else {
    reset(own, read, "text-overflow", "clip", out);
    if (was === "truncate" && own.overflow === "hidden") out.overflow = null;
  }
  if (mode === "balance") out["text-wrap"] = "balance";
  else if (own["text-wrap"] !== undefined) out["text-wrap"] = null;
  // A class that balances wins unless it's covered.
  else if (was === "balance") out["text-wrap"] = "wrap";
  return out;
}

const LINES = new Set(["none", "underline", "overline", "line-through", "blink"]);

/** The lines a `text-decoration` shorthand draws, or `undefined` when it names none. */
function linesIn(shorthand: string | undefined): string | undefined {
  const lines = parts(shorthand ?? "").filter((p) => LINES.has(p));
  return lines.length > 0 ? lines.join(" ") : shorthand === undefined ? undefined : "none";
}

/** The text's decoration lines: its own longhand, its shorthand's lines, or what's drawn. */
export function decorationOf(own: Styles, read: Read): string {
  return (
    own["text-decoration-line"] ??
    linesIn(own["text-decoration"]) ??
    read("text-decoration-line") ??
    "none"
  );
}

/**
 * The styles that draw `line` (`none`, `underline` or `line-through`): into
 * the `text-decoration` shorthand the element already has, keeping its
 * color and style, or as `text-decoration-line`.
 */
export function decorationStyles(own: Styles, read: Read, line: string): Changes {
  const out: Changes = {};
  const shorthand = own["text-decoration"];
  if (own["text-decoration-line"] === undefined && shorthand !== undefined) {
    const kept = parts(shorthand).filter((p) => !LINES.has(p));
    out["text-decoration"] =
      line === "none" && kept.length === 0 ? null : [line, ...kept].join(" ");
    return out;
  }
  if (line === "none") reset(own, read, "text-decoration-line", "none", out);
  else out["text-decoration-line"] = line;
  return out;
}

/** How many lines the text stops at, or `null` for no limit. */
export function maxLinesOf(own: Styles, read: Read): number | null {
  const v = own["-webkit-line-clamp"] ?? own["line-clamp"] ?? read("-webkit-line-clamp");
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The styles that stop text at `n` lines with an ellipsis: `line-clamp`,
 * and the `-webkit-` box browsers still need for it. `null` takes them off,
 * with the `display` and `overflow` they brought.
 */
export function maxLinesStyles(own: Styles, n: number | null): Changes {
  if (n !== null && n > 0) {
    const lines = String(Math.round(n));
    return {
      "line-clamp": lines,
      "-webkit-line-clamp": lines,
      "-webkit-box-orient": "vertical",
      display: "-webkit-box",
      overflow: "hidden",
    };
  }
  const out: Changes = {};
  for (const prop of ["line-clamp", "-webkit-line-clamp", "-webkit-box-orient"]) {
    if (own[prop] !== undefined) out[prop] = null;
  }
  if (own.display === "-webkit-box") {
    out.display = null;
    if (own.overflow === "hidden") out.overflow = null;
  }
  return out;
}

/** Parts of a `text-decoration` that aren't its color: lines, styles and thicknesses. */
const NOT_COLOR =
  /^(none|underline|overline|line-through|blink|solid|double|dotted|dashed|wavy|auto|from-font|-?\d*\.?\d+[a-z%]*)$/i;

/** The color part of a `text-decoration` shorthand, if it names one. */
function colorIn(shorthand: string | undefined): string | undefined {
  return parts(shorthand ?? "").find((p) => !NOT_COLOR.test(p));
}

/** The decoration's color: its own longhand, its shorthand's color, or what's drawn. */
export function decorationColorOf(own: Styles, read: Read): string | undefined {
  return (
    own["text-decoration-color"] ??
    colorIn(own["text-decoration"]) ??
    (own["text-decoration"] === undefined ? read("text-decoration-color") : undefined) ??
    read("color")
  );
}

/**
 * The styles that color the decoration `color` (`null` takes it off): into
 * the `text-decoration` shorthand the element has, or as
 * `text-decoration-color`.
 */
export function decorationColorStyles(own: Styles, color: string | null): Changes {
  const shorthand = own["text-decoration"];
  if (own["text-decoration-color"] === undefined && shorthand !== undefined) {
    const kept = parts(shorthand).filter((p) => NOT_COLOR.test(p));
    return { "text-decoration": [...kept, ...(color ? [color] : [])].join(" ") || null };
  }
  return { "text-decoration-color": color };
}

/**
 * What typing into Line height sets: a bare number is pixels, `150%` a
 * percentage, `1.5x` (or `×`) a multiple of the font size, `auto` the
 * browser's `normal`, and a token name its `var()`.
 */
export function lineHeightInput(typed: string): string | null {
  const v = typed.trim().toLowerCase();
  if (v === "") return null;
  if (v === "auto" || v === "normal") return "normal";
  if (/^--[\w-]+$/.test(typed.trim())) return `var(${typed.trim()})`;
  const m = v.match(/^(\d*\.?\d+)\s*(px|%|x|×|em|rem)?$/);
  if (!m) return null;
  const unit = m[2] ?? "px";
  return unit === "x" || unit === "×" ? m[1]! : `${m[1]}${unit}`;
}

/**
 * A line height as the field shows it, and the unit scrubbing keeps:
 * `24px` is 24, `1.5` is 1.5×, `normal` is Auto. `null` when it's
 * something else, like a `calc()`.
 */
export function lineHeightShown(
  raw: string,
): { text: string; value: number | null; unit: string } | null {
  const v = raw.trim();
  if (v === "normal") return { text: "Auto", value: null, unit: "px" };
  const m = v.match(/^(\d*\.?\d+)(px|%|em|rem)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === undefined) return { text: `${m[1]}×`, value: n, unit: "" };
  return { text: m[2] === "px" ? m[1]! : `${m[1]}${m[2]}`, value: n, unit: m[2] };
}

/** Inline properties that make an element a text layer of its own, even with other children. */
export const TEXT_PROPS = [
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "text-decoration-line",
  "white-space",
  "text-overflow",
  "text-wrap",
  "-webkit-line-clamp",
  "line-clamp",
] as const;
