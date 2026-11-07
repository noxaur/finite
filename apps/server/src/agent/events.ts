import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "@finite/protocol";
import { underRoot } from "./policy.ts";

const MCP_PREFIX = "mcp__finite__";

/**
 * Turns the SDK's messages into thread events. It remembers each tool call so the `done` event
 * carries the same name and summary as the `running` one. Subagent messages are left out.
 */
export function createEventMapper(root: string, realRoot?: string) {
  const calls = new Map<string, { name: string; summary: string }>();

  return function map(message: SDKMessage, now: number, interrupted = false): ThreadEvent[] {
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return [];
    switch (message.type) {
      case "stream_event": {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          return [{ type: "text.delta", text: event.delta.text }];
        }
        return [];
      }
      case "assistant": {
        const events: ThreadEvent[] = [];
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim() !== "") {
            events.push({ type: "text", text: block.text, at: now });
          } else if (block.type === "tool_use" || block.type === "mcp_tool_use") {
            const name = block.name.startsWith(MCP_PREFIX)
              ? block.name.slice(MCP_PREFIX.length)
              : block.name;
            const summary = summarize(name, block.input, root, realRoot);
            calls.set(block.id, { name, summary });
            events.push({ type: "tool", id: block.id, name, summary, status: "running", at: now });
          }
        }
        return events;
      }
      case "user": {
        const content = message.message.content;
        if (typeof content === "string") return [];
        const events: ThreadEvent[] = [];
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const call = calls.get(block.tool_use_id);
          if (!call) continue;
          calls.delete(block.tool_use_id);
          events.push({
            type: "tool",
            id: block.tool_use_id,
            ...call,
            status: block.is_error ? "error" : "done",
            at: now,
          });
        }
        return events;
      }
      case "result": {
        const u = message.usage;
        const events: ThreadEvent[] = [
          {
            type: "result",
            usage: {
              inputTokens:
                u.input_tokens +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0),
              outputTokens: u.output_tokens,
            },
            at: now,
          },
        ];
        const failed = message.subtype !== "success" || message.is_error;
        if (failed && !interrupted) {
          const reason =
            message.subtype === "success"
              ? message.result
              : message.errors.join("\n") || message.subtype;
          events.push({ type: "error", message: reason || "The turn failed.", at: now });
        }
        return events;
      }
      default:
        return [];
    }
  };
}

/** A few words for a tool call: the file, command, pattern or URL it works on. */
export function summarize(name: string, input: unknown, root: string, realRoot?: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : undefined);
  const file = str("file_path") ?? str("notebook_path");
  if (file) {
    if (!path.isAbsolute(file)) return file;
    const rel = path.relative(root, underRoot({ root, ...(realRoot ? { realRoot } : {}) }, file));
    return rel && !rel.startsWith("..") ? rel : file;
  }
  if (name === "Bash") return clip(str("description") ?? str("command") ?? "");
  if (name === "place_frames" && Array.isArray(i.frames)) {
    const n = i.frames.length;
    return `${n} frame${n === 1 ? "" : "s"}`;
  }
  for (const key of ["pattern", "url", "query", "title", "name", "route", "prompt", "text"]) {
    const value = str(key);
    if (value) return clip(value);
  }
  return "";
}

function clip(text: string, max = 80): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
