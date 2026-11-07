import { execFile } from "node:child_process";

const MARK = "__FINITE_PATH__";
const TIMEOUT_MS = 5_000;

/**
 * The PATH a terminal would have. An app opened from the Dock or Finder gets launchd's bare PATH,
 * so tools installed with Homebrew, npm or the Claude installer (`claude`, `pnpm`) aren't on it.
 * Asks the login shell (`$SHELL -ilc`), the way VS Code's shell-env does; on Windows, or when the
 * shell is slow or fails, keeps the current PATH.
 */
export function loginShellPath(current = process.env.PATH ?? ""): Promise<string> {
  if (process.platform === "win32") return Promise.resolve(current);
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`],
      { timeout: TIMEOUT_MS, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
      (error, stdout) => {
        const found = error ? undefined : parseShellPath(stdout);
        resolve(found ? mergePath(found, current) : current);
      },
    );
  });
}

/** The PATH between the markers, ignoring whatever the shell's startup files printed around it. */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(MARK);
  const end = output.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return undefined;
  return output.slice(start + MARK.length, end) || undefined;
}

/** `first`, then any entries of `rest` it lacks, without duplicates. */
export function mergePath(first: string, rest: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of [...first.split(":"), ...rest.split(":")]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }
  return parts.join(":");
}
