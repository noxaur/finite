import { parts } from "./lists";

/** The names of the 3×3 grid's columns and rows, in order. */
export const CELL_X = ["left", "center", "right"] as const;
export const CELL_Y = ["top", "center", "bottom"] as const;

interface Part {
  readonly axis: "x" | "y" | null;
  readonly at: number;
}

function partOf(word: string): Part | null {
  const x = CELL_X.indexOf(word as (typeof CELL_X)[number]);
  if (x !== -1 && word !== "center") return { axis: "x", at: x };
  const y = CELL_Y.indexOf(word as (typeof CELL_Y)[number]);
  if (y !== -1 && word !== "center") return { axis: "y", at: y };
  if (word === "center") return { axis: null, at: 1 };
  const at = { "0": 0, "0%": 0, "50%": 1, "100%": 2 }[word];
  return at === undefined ? null : { axis: null, at };
}

/**
 * Which cell of a 3×3 grid a CSS position (`background-position`,
 * `transform-origin`) names; `null` when it's between cells. Keywords
 * may come either way round, `top left`; numbers are x then y.
 */
export function cellOf(position: string): { x: number; y: number } | null {
  const read = parts(position.toLowerCase()).map(partOf);
  if (read.length === 0 || read.length > 2 || read.some((r) => r === null)) return null;
  const [a, b = { axis: null, at: 1 }] = read as Part[];
  const [x, y] = a!.axis === "y" || b.axis === "x" ? [b, a!] : [a!, b];
  if (x.axis === "y" || y.axis === "x") return null;
  return { x: x.at, y: y.at };
}
