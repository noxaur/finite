import type { Previews } from "@finite/protocol";
import { unbuilt } from "../unbuilt.ts";

export type PreviewsOptions = {
  /** The host each design's Vite dev server binds, the same one Finite listens on. */
  host: string;
};

export function createPreviews(_options: PreviewsOptions): Previews {
  return {
    ensure: () => unbuilt("previews.ensure"),
    state: () => ({ status: "stopped" }),
    routes: () => unbuilt("previews.routes"),
    frameUrl: () => {
      throw new Error("previews.frameUrl isn't built yet");
    },
    stop: async () => {},
    on: () => () => {},
    reportError: () => {},
    errors: () => [],
    close: async () => {},
  };
}
