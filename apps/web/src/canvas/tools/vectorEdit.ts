import type { CommandDef } from "./commands";

/** Point editing on a selected path. Filled in by the vector work. */
export const vectorCommands: readonly CommandDef[] = [
  {
    id: "enterVector",
    keys: [{ key: "enter" }],
    enabled: false,
    when: (env) => !env.vector,
    run: (host) => host.say("Editing points isn't built yet."),
  },
];
