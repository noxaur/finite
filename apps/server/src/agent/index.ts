import type { Agents, Previews, SourceEditor, Store } from "@finite/protocol";
import { unbuilt } from "../unbuilt.ts";

export type AgentsOptions = {
  store: Store;
  previews: Previews;
  source: SourceEditor;
};

export function createAgents(_options: AgentsOptions): Agents {
  return {
    send: () => unbuilt("agents.send"),
    interrupt: () => unbuilt("agents.interrupt"),
    editQueued: () => unbuilt("agents.editQueued"),
    status: () => unbuilt("agents.status"),
    close: async () => {},
  };
}
