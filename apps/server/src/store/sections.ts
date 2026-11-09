import { Refused } from "@finite/protocol";

/** Section and slice patches. Filled in by the canvas-objects work. */
export function refuseSections(): never {
  throw new Refused("Sections and slices aren't built yet.", "not-implemented");
}
