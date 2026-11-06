import path from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/** Built-in tools that write files, and the input field holding the path. */
const WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export type PolicyContext = {
  root: string;
  /** The root with symlinks resolved, which is how Claude Code may spell it (macOS `/private/var`). */
  realRoot?: string;
  brandDir: string;
  /** The current turn called move_to_prod. */
  prodWrite: boolean;
};

/**
 * What an agent may do: read and run anything, write only prototypes (`.finite/`) and brand
 * assets (`brandDir`), and production too during a turn that called move_to_prod.
 */
export function policy(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext,
): PermissionResult {
  if (toolName === "AskUserQuestion") {
    return deny(
      "Nobody can answer this dialog. Ask in one line of chat, or leave a comment on the canvas, and end the turn.",
    );
  }
  const field = WRITE_TOOLS[toolName];
  if (field === undefined) return { behavior: "allow", updatedInput: input };

  const raw = input[field];
  if (typeof raw !== "string" || raw === "") return deny(`${toolName} needs a ${field}.`);
  const file = underRoot(ctx, path.resolve(ctx.root, raw));
  const brand = ctx.brandDir.replace(/\/+$/, "");
  if (!inside(ctx.root, file)) {
    return deny(`${raw} is outside this project. Write files under ${ctx.root}.`);
  }
  if (inside(path.join(ctx.root, ".finite"), file) || inside(path.join(ctx.root, brand), file)) {
    return { behavior: "allow", updatedInput: input };
  }
  if (ctx.prodWrite) return { behavior: "allow", updatedInput: input };
  return deny(
    `Production code is read-only here. Write prototypes under .finite/boards/<canvasId>/ and brand ` +
      `assets under ${brand}/. To change ${path.relative(ctx.root, file)}, the person has to ask ` +
      `you to move it to prod: then call move_to_prod first.`,
  );
}

/** `file` spelled under `root` when it's spelled under the real root. */
export function underRoot(ctx: Pick<PolicyContext, "root" | "realRoot">, file: string): string {
  if (ctx.realRoot && ctx.realRoot !== ctx.root && inside(ctx.realRoot, file)) {
    return path.join(ctx.root, path.relative(ctx.realRoot, file));
  }
  return file;
}

function deny(message: string): PermissionResult {
  return { behavior: "deny", message };
}

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
