import type { TokenTable } from "@/design/types";
import { tokenOf } from "../design/editing/inspect";

/** A token's value in `mode`, following whole-value `var(--x)` aliases, as the browser would. */
export function resolveToken(
  table: TokenTable,
  name: string,
  mode: string,
  depth = 0,
): string | undefined {
  const values = table.tokens[name];
  if (!values || depth > 8) return undefined;
  const value = values[mode] ?? values[table.modes[0]?.id ?? ""] ?? Object.values(values)[0];
  const alias = aliasOf(value);
  return alias ? resolveToken(table, alias, mode, depth + 1) : value;
}

/**
 * The token a whole value points at: `var(--x)` is `--x`, and a Sass `$x` or Less `@x` is itself;
 * `undefined` for any other value.
 */
export function aliasOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return tokenOf(value) ?? /^\s*([$@][A-Za-z_][\w-]*)\s*$/.exec(value)?.[1];
}

/**
 * What using a token writes: `var(--x)` for a custom property, and the name itself for a Sass
 * `$x` or Less `@x`, which only a `.module.scss` or `.module.less` rule can take.
 */
export const tokenRef = (name: string): string => (name.startsWith("--") ? `var(${name})` : name);

/** Whether a token is a Sass `$x` or Less `@x`, which has one value and no dark mode. */
export const isVariable = (name: string): boolean => name.startsWith("$") || name.startsWith("@");

/** A token's name as people read it, without the leading `--`. A `$` or `@` stays. */
export const displayName = (name: string): string => name.replace(/^--/, "");

/** The four control points of an easing value, or `undefined` when it isn't one. */
export function bezierOf(value: string): readonly [number, number, number, number] | undefined {
  const named: Record<string, readonly [number, number, number, number]> = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
  };
  const trimmed = value.trim();
  if (named[trimmed]) return named[trimmed];
  const points = trimmed
    .match(/^cubic-bezier\(([^)]*)\)$/)?.[1]
    ?.split(",")
    .map(Number);
  return points?.length === 4 && points.every(Number.isFinite)
    ? (points as unknown as [number, number, number, number])
    : undefined;
}

export const isColor = (value: string | undefined): boolean =>
  value !== undefined && typeof CSS !== "undefined" && CSS.supports("color", value);

/**
 * A color as `#rrggbb`, the only form `<input type="color">` takes, and its
 * alpha. Uses a canvas to parse it, so it runs in the browser only.
 */
export function hexOf(color: string): { hex: string; alpha: number } | undefined {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  context.fillStyle = "#000000";
  context.fillStyle = color;
  const parsed = context.fillStyle;
  if (parsed.startsWith("#")) return { hex: parsed, alpha: 1 };
  const [r, g, b, a] = parsed.match(/[\d.]+/g)?.map(Number) ?? [];
  if (r === undefined || g === undefined || b === undefined) return undefined;
  const hex = `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
  return { hex, alpha: a ?? 1 };
}
