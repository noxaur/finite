import { unbuilt } from "../unbuilt.ts";

/** Renders a slice to a PNG. Filled in by the canvas-objects work. */
export function exportSlice(..._args: unknown[]): Promise<never> {
  return unbuilt("Slice export");
}
