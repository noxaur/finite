import { realpathSync } from "node:fs";
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
  /**
   * The workspace root holding `finite.json`, when the design has one: the agent's working
   * directory, and where move_to_prod may write (shared packages included). Default: the root.
   */
  workspace?: string;
  /** In a setup thread, the `finite.json` it may write. */
  configFile?: string;
};

/**
 * What an agent may do: read and run anything, write only prototypes (`.finite/`) and brand
 * assets (`brandDir`) in the app's root, production anywhere in the workspace during a turn that
 * called move_to_prod, and `finite.json` in a setup thread. Relative paths are from the workspace.
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
  const project = ctx.workspace ?? ctx.root;
  // Symlinks resolved, so a link under .finite/ can't point the write at src/ or outside.
  const realRoot = ctx.realRoot ?? realFile(ctx.root);
  const realProject = ctx.workspace === undefined ? realRoot : realFile(ctx.workspace);
  const file = realFile(path.resolve(project, raw));
  const brand = ctx.brandDir.replace(/\/+$/, "");
  if (ctx.configFile !== undefined && file === realFile(ctx.configFile)) {
    return { behavior: "allow", updatedInput: input };
  }
  if (!inside(realProject, file)) {
    return deny(`${raw} is outside this project. Write files under ${project}.`);
  }
  if (inside(path.join(realRoot, ".finite"), file) || inside(path.join(realRoot, brand), file)) {
    return { behavior: "allow", updatedInput: input };
  }
  if (ctx.prodWrite) return { behavior: "allow", updatedInput: input };
  if (ctx.configFile !== undefined) {
    return deny(
      `A setup thread writes only ${ctx.configFile}. Put commands in its setup instead of changing ${path.relative(realProject, file)}.`,
    );
  }
  // From the workspace, the app's own folders are under its path.
  const app = path.relative(project, ctx.root);
  const at = (dir: string) => (app ? `${app}/${dir}` : dir);
  return deny(
    `Production code is read-only here. Write prototypes under ${at(".finite/boards/<canvasId>/")} and brand ` +
      `assets under ${at(brand)}/. To change ${path.relative(realProject, file)}, the person has to ask ` +
      `you to move it to prod: then call move_to_prod first.`,
  );
}

/** `abs` with symlinks resolved; for a file that doesn't exist yet, its nearest existing folder's. */
export function realFile(abs: string): string {
  const rest: string[] = [];
  let at = abs;
  while (true) {
    try {
      return path.join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return abs;
      rest.push(path.basename(at));
      at = up;
    }
  }
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
