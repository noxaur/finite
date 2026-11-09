import { Refused } from "@finite/protocol";
import { unbuilt } from "../unbuilt.ts";

/** Reading an element's children as editable runs. Filled in by the rich-text work. */
export function readInline(..._args: unknown[]): Promise<never> {
  return unbuilt("Rich text editing");
}

export function setInline(): never {
  throw new Refused(
    "Rich text editing isn't built yet. Ask the agent to change this text.",
    "not-implemented",
  );
}
