// The plugin's main thread: the part that can reach the Plugin API. It reads
// and builds layers, and hands files to and from the UI, which can't.

import { build } from "./build.ts";
import type { ToMain, ToUi } from "./messages.ts";
import { decodePayload } from "./payload.ts";
import { SEGMENT_FIELDS, readSelection, type NodeLike, type ReadEnv } from "./read.ts";
import { builtLine, savedLine } from "./summary.ts";

const env: ReadEnv = {
  exportSvg: async (node) =>
    (await (node as unknown as SceneNode).exportAsync({ format: "SVG_STRING" })) as string,
  segments: async (node) =>
    (node as unknown as TextNode).getStyledTextSegments([
      ...SEGMENT_FIELDS,
    ]) as unknown as ReadonlyArray<NodeLike & { start: number; end: number }>,
};

const send = (message: ToUi) => figma.ui.postMessage(message);
const sendSelection = () => send({ type: "selection", count: figma.currentPage.selection.length });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

figma.showUI(__html__, { width: 300, height: 190, themeColors: true });
sendSelection();
figma.on("selectionchange", sendSelection);

figma.ui.onmessage = async (message: ToMain) => {
  try {
    if (message.type === "save") {
      const saved = await readSelection(figma, env);
      if (saved.frames === 0) return send({ type: "failed", line: savedLine(saved) });
      send({ type: "saved", name: saved.name, json: saved.json, line: savedLine(saved) });
    } else {
      const report = await build(decodePayload(message.text), figma);
      send({ type: "built", line: builtLine(report) });
    }
  } catch (error) {
    send({ type: "failed", line: messageOf(error) });
  }
};
