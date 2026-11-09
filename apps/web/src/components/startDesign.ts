import type { DesignEntry } from "@finite/protocol";
import { finite } from "@/client/finite";

const BRAND_PROMPT =
  "Import this design's brand assets onto the Brand page: logos, images and fonts from the code " +
  "or the source, and its colors, type and spacing as tokens. Say what you found and what's missing.";

const importPrompt = (source: string, files: number) =>
  `Rebuild this design in TSX${source ? ` from ${source}` : ""}${
    files ? `${source ? ", and" : " from"} the attached ${files === 1 ? "file" : "files"}` : ""
  }. Put each screen on a page as a route, split shared parts into components, and set the ` +
  "colors, fonts and spacing as tokens first.";

/** Where the design opens: its page, with the thread that was started in it, if any. */
const href = (design: DesignEntry, threadId: string | null) => {
  const q = new URLSearchParams({ id: design.id });
  if (threadId) q.set("thread", threadId);
  return `/design/?${q.toString()}`;
};

async function startThread(designId: string, text: string, attachments: string[] = []) {
  const settings = await finite.request("settings.get", {});
  const { threadId } = await finite.request("thread.send", {
    designId,
    new: {},
    text,
    attachments,
    model: settings.model,
    effort: settings.effort,
    fast: settings.fast,
    mode: "steer",
  });
  return threadId;
}

async function upload(designId: string, files: ReadonlyArray<File>) {
  const paths: string[] = [];
  for (const file of files) {
    const body = new FormData();
    body.append("file", file, file.name);
    const res = await fetch(`/api/designs/${encodeURIComponent(designId)}/attachments`, {
      method: "POST",
      body,
    });
    const json = (await res.json()) as { path?: string; reason?: string };
    if (!res.ok || !json.path) throw new Error(json.reason ?? `Couldn't upload ${file.name}`);
    paths.push(json.path);
  }
  return paths;
}

/** A connected or cloned codebase gets a thread that imports its brand assets. */
async function withBrand(design: DesignEntry, threadId: string | null = null) {
  const brand = await startThread(design.id, BRAND_PROMPT);
  return href(design, threadId ?? brand);
}

/** A blank React + Tailwind project. */
export async function createBlank(name: string) {
  const design = await finite.request("design.create", {
    name: name.trim() || "Untitled",
    kind: "blank",
  });
  return href(design, null);
}

/** A design rebuilt from a link and/or files, then its brand assets. */
export async function createImport(source: string, files: ReadonlyArray<File>) {
  const design = await finite.request("design.create", {
    name: "Imported design",
    kind: "import",
    ...(source.trim() ? { source: source.trim() } : {}),
  });
  const attachments = await upload(design.id, files);
  const threadId = await startThread(
    design.id,
    importPrompt(source.trim(), files.length),
    attachments,
  );
  return withBrand(design, threadId);
}

/** A folder on this machine, connected as it is. */
export async function connectFolder(path: string) {
  return withBrand(await finite.request("design.connect", { path }));
}

/** A GitHub repo cloned to `path`, then connected. */
export async function cloneRepo(url: string, path: string) {
  return withBrand(await finite.request("design.clone", { url, path }));
}
