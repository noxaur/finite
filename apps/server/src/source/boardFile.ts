import { unbuilt } from "../unbuilt.ts";

/** Writes a board file for a shape drawn on the empty canvas. Filled in by the shapes work. */
export function boardFile(..._args: unknown[]): Promise<never> {
  return unbuilt("Drawing on the empty canvas");
}
