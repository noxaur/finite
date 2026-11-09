import type { CommandDef } from "./commands";

/** Wrapping the selection in a layout. Filled in by the auto-layout work. */
export const autoLayoutCommands: readonly CommandDef[] = [
  {
    id: "autoLayout",
    keys: [{ key: "a", shift: true }],
    enabled: false,
    run: (host) => host.say("Auto layout isn't built yet."),
  },
  {
    id: "unwrap",
    keys: [{ key: "a", shift: true, alt: true }],
    enabled: false,
    run: (host) => host.say("Removing a layout isn't built yet."),
  },
];
