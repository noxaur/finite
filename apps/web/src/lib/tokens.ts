import type { TokenTable } from "@/design/replica";

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
  const alias = value?.match(/^\s*var\(\s*(--[\w-]+)\s*\)\s*$/);
  return alias ? resolveToken(table, alias[1]!, mode, depth + 1) : value;
}

export const isColor = (value: string | undefined): boolean =>
  value !== undefined && typeof CSS !== "undefined" && CSS.supports("color", value);
