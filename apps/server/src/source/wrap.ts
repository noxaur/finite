import { Refused } from "@finite/protocol";

/** Wrapping elements in a new parent. Filled in by the auto-layout work. */
export function wrap(): never {
  throw new Refused(
    "Wrapping elements in a new layer isn't built yet. Ask the agent to add the wrapper.",
    "not-implemented",
  );
}

export function unwrap(): never {
  throw new Refused(
    "Removing a wrapper by hand isn't built yet. Ask the agent to remove it.",
    "not-implemented",
  );
}
