import type { SourceEditor } from "@finite/protocol";
import { unbuilt } from "../unbuilt.ts";

export type SourceEditorOptions = Record<string, never>;

export function createSourceEditor(_options: SourceEditorOptions = {}): SourceEditor {
  return {
    apply: () => unbuilt("source.apply"),
    undo: () => unbuilt("source.undo"),
    redo: () => unbuilt("source.redo"),
    detach: () => unbuilt("source.detach"),
    tokens: () => unbuilt("source.tokens"),
    setToken: () => unbuilt("source.setToken"),
    components: () => unbuilt("source.components"),
    copyComponent: () => unbuilt("source.copyComponent"),
    exportFrames: () => unbuilt("source.exportFrames"),
  };
}
