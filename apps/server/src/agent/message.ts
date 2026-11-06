import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Canvas, FrameSource, Turn } from "@finite/protocol";

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Bigger images are listed by path only; the agent can still Read them. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The prompt for one turn: the text, then the attachments' paths and the selection so the agent
 * can Read and find them, plus each attached image as an image block.
 */
export async function userMessage(
  root: string,
  turn: Pick<Turn, "text" | "attachments" | "selection">,
  canvases: Canvas[],
): Promise<SDKUserMessage> {
  let prompt = turn.text;
  if (turn.attachments.length) {
    const lines = turn.attachments.map((a) => `- ${path.resolve(root, a)}`);
    prompt += `\n\nAttached files:\n${lines.join("\n")}`;
  }
  if (turn.selection?.length) {
    const lines = turn.selection.map(({ frameId, loc, index }) => {
      const frame = canvases.flatMap((c) => c.frames).find((f) => f.id === frameId);
      const name = frame ? `"${frame.name}"` : "a frame";
      const what = `- ${name} (frame ${frameId}`;
      if (loc === undefined)
        return `${what}${frame ? `, ${describeSource(frame.source)}` : ""}): the whole frame`;
      return `${what}): element ${loc}, instance ${index ?? 0}`;
    });
    prompt += `\n\nSelected on the canvas:\n${lines.join("\n")}`;
  }

  const content: ContentBlockParam[] = [{ type: "text", text: prompt }];
  for (const file of turn.attachments) {
    const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mediaType) continue;
    const data = await readFile(path.resolve(root, file)).catch(() => undefined);
    if (!data || data.byteLength > MAX_IMAGE_BYTES) continue;
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
    });
  }
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

function describeSource(source: FrameSource): string {
  return source.kind === "route" ? `route ${source.path}` : `file ${source.file}`;
}
