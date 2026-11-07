import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Refused,
  type Actor,
  type Canvas,
  type Design,
  type Frame,
  type Remap,
  type Route,
  type SourceEditor,
} from "@finite/protocol";
import { listComponents } from "./components.ts";
import {
  fileLocks,
  freeName,
  type Locked,
  inRoot,
  mustRead,
  posixRelative,
  readText,
  writeAtomic,
} from "./files.ts";
import { createHistory, diffPatch, stepPatches, type Patch } from "./history.ts";
import {
  cssModules,
  importCandidates,
  isRelative,
  moveImports,
  resolveSpec,
  retarget,
  sheetSpecifiers,
  specifiers,
} from "./imports.ts";
import { parseModule } from "./jsx.ts";
import { editFiles, rewrite } from "./rewrite.ts";
import type { TailwindVersion, Theme } from "./tailwind.ts";
import { configTheme, tailwind3Config } from "./tailwind3.ts";
import { hasToken, lightTheme, readTokens, tokenName, writeToken } from "./tokens.ts";

export { rewrite } from "./rewrite.ts";

export type SourceEditorOptions = {
  /** The design's routes, to find the file behind a route for `copyComponent({ route })`. */
  routes?: (design: Design) => Promise<Route[]>;
  /** The file locks to share with other writers (default: the process's `fileLocks`). */
  locks?: Locked;
};

const PROTOTYPE_DIR = ".finite/";

export function createSourceEditor(options: SourceEditorOptions = {}): SourceEditor {
  const locked = options.locks ?? fileLocks;
  const history = createHistory();
  const actorKey = (design: Design, by: Actor) => `${design.id}\u0000${by.kind}:${by.id}`;

  async function sheets(design: Design): Promise<{ file: string; css: string }[]> {
    const out: { file: string; css: string }[] = [];
    for (const file of design.css) {
      const css = await readText(inRoot(design.root, file));
      if (css !== undefined) out.push({ file, css });
    }
    return out;
  }

  /** The theme hand edits match values to: `tailwind.config.*` on v3, else the sheets' `@theme`. */
  async function tailwindTheme(
    design: Design,
  ): Promise<{ theme: Theme; tailwind: TailwindVersion }> {
    const config = await tailwind3Config(design.root);
    if (config) return { theme: await configTheme(design.root, config), tailwind: 3 };
    return { theme: lightTheme(readTokens(await sheets(design))), tailwind: 4 };
  }

  /** Reads `files`, lets `change` produce new contents, writes what changed. All under the files' locks. */
  async function transact(
    root: string,
    files: string[],
    change: (contents: Map<string, string>) => Map<string, string> | Promise<Map<string, string>>,
  ): Promise<Patch[]> {
    return locked(
      files.map((f) => inRoot(root, f)),
      async () => {
        const before = new Map<string, string>();
        for (const file of files) {
          const code = await readText(inRoot(root, file));
          if (code !== undefined) before.set(file, code);
        }
        const after = await change(before);
        const writes: { file: string; code: string; patch: Patch }[] = [];
        for (const [file, code] of after) {
          const patch = diffPatch(file, before.get(file) ?? "", code);
          if (patch) writes.push({ file, code, patch });
        }
        // Someone outside the locks (an editor, git) may have saved since the read.
        for (const { file } of writes) {
          if ((await readText(inRoot(root, file))) !== before.get(file)) {
            throw new Refused(`${file} changed while this edit ran; try again`, "stale");
          }
        }
        for (const { file, code } of writes) await writeAtomic(inRoot(root, file), code);
        return writes.map((w) => w.patch);
      },
    );
  }

  async function sourceFile(
    design: Design,
    from: { name: string } | { route: string },
  ): Promise<string> {
    if ("name" in from) {
      const all = await listComponents(design.root);
      const match =
        all.find((c) => c.name === from.name) ??
        all.find((c) => c.name.toLowerCase() === from.name.toLowerCase());
      if (!match)
        throw new Refused(
          `No exported component named ${from.name} in src/. Check components.list for the names.`,
          "not-found",
        );
      return match.file;
    }
    if (!options.routes)
      throw new Refused(
        "Finite can't look up route files here; copy the component by name instead.",
        "not-implemented",
      );
    const route = (await options.routes(design)).find((r) => r.path === from.route);
    if (!route?.file)
      throw new Refused(
        `No route ${from.route} with a file of its own. Copy its component by name instead.`,
        "not-found",
      );
    return route.file;
  }

  /** Copies `file` to a free name at `toFile` with its relative imports pointing back at the originals. */
  async function copyInto(root: string, file: string, toFile: string): Promise<string> {
    const code = await mustRead(root, file);
    const wanted = inRoot(root, toFile);
    // Choosing the name and writing it happen under the folder's lock, so two copies can't pick
    // the same free name.
    return locked([`${path.dirname(wanted)}${path.sep}`], async () => {
      const target = posixRelative(root, await freeName(wanted));
      await transact(root, [target], () => new Map([[target, moveImports(code, file, target)]]));
      return target;
    });
  }

  return {
    async apply(open, edits, by, canvas) {
      const design = open.design;
      const files = [...new Set(edits.flatMap(editFiles))];
      for (const file of files) inRoot(design.root, file);
      guardPrototype(design.root, canvas, files);

      let modules: string[] = [];
      if (design.styling === "css-modules") {
        for (const file of files) {
          const code = await mustRead(design.root, file);
          modules.push(...cssModules(parseModule(code, file), file).values());
        }
        modules = [...new Set(modules)];
        guardPrototype(design.root, canvas, modules);
      }
      const { theme, tailwind } =
        design.styling === "tailwind"
          ? await tailwindTheme(design)
          : { theme: {}, tailwind: 4 as const };

      const remap: Remap = {};
      const patches = await transact(design.root, [...files, ...modules], (contents) => {
        const out = new Map(contents);
        let extra = Object.fromEntries(
          modules.flatMap((m) => (contents.has(m) ? [[m, contents.get(m)!]] : [])),
        );
        for (const file of files) {
          const code = contents.get(file);
          if (code === undefined) throw new Refused(`${file} doesn't exist`, "not-found");
          const result = rewrite(code, file, edits, design.styling, {
            theme,
            tailwind,
            files: extra,
          });
          if (result instanceof Refused) throw result;
          out.set(file, result.code);
          Object.assign(remap, result.remap);
          extra = result.files;
        }
        for (const [file, css] of Object.entries(extra)) out.set(file, css);
        return out;
      });
      if (patches.length > 0) history.push(actorKey(design, by), patches);
      return { ok: true, remap };
    },

    undo: (open, by) => step(open.design, by, "undo"),
    redo: (open, by) => step(open.design, by, "redo"),

    async detach(open, { canvasId, file, importer }) {
      const root = open.design.root;
      if (!/^[\w-]+$/.test(canvasId)) throw new Refused(`${canvasId} isn't a canvas id`, "invalid");
      const importerCode = await mustRead(root, importer);
      const toFile = `${PROTOTYPE_DIR}boards/${canvasId}/${path.posix.basename(file)}`;
      if (retarget(importerCode, importer, file, toFile) === undefined) {
        throw new Refused(
          `${importer} doesn't import ${file} with a relative path, so there's no import to point at a copy.`,
          "invalid",
        );
      }
      const copy = await copyInto(root, file, toFile);
      await transact(root, [importer], (contents) => {
        const next = retarget(contents.get(importer) ?? "", importer, file, copy);
        if (next === undefined) throw new Refused("The file changed; try again", "stale");
        return new Map([[importer, next]]);
      });
      return { file: copy };
    },

    async tokens(design) {
      return readTokens(await sheets(design));
    },

    async setToken(design, { name, mode, value }) {
      const prop = tokenName(name);
      const all = await sheets(design);
      const config = design.styling === "tailwind" ? await tailwind3Config(design.root) : undefined;
      if (config && !all.some((s) => hasToken(s.file, s.css, prop, mode)))
        throw new Refused(
          `This design uses Tailwind v3, whose theme lives in ${path.basename(config)}, so a new token there wouldn't make a class. Add it to theme.extend in ${path.basename(config)}, or ask the agent to.`,
          "invalid",
        );
      const target =
        all.find((s) => hasToken(s.file, s.css, prop, mode)) ??
        (design.styling === "tailwind"
          ? (all.find((s) => /@theme\b/.test(s.css)) ??
            all.find((s) => /@import\s+["']tailwindcss/.test(s.css)))
          : all.find((s) => /:root\b/.test(s.css))) ??
        all[0];
      if (!target)
        throw new Refused(
          "This design has no stylesheet to keep tokens in. Add one to css in .finite/design.json.",
          "invalid",
        );
      await transact(design.root, [target.file], (contents) => {
        return new Map([
          [
            target.file,
            writeToken(
              target.file,
              contents.get(target.file) ?? "",
              prop,
              mode,
              value,
              design.styling,
            ),
          ],
        ]);
      });
      return readTokens(await sheets(design));
    },

    components: (design) => listComponents(design.root),

    async copyComponent(design, from, toFile) {
      if (!inPrototypes(design.root, toFile))
        throw new Refused(
          `Copies go inside ${PROTOTYPE_DIR}, e.g. .finite/boards/<canvasId>/Home.tsx`,
          "outside-prototype",
        );
      return { file: await copyInto(design.root, await sourceFile(design, from), toFile) };
    },

    async exportFrames(open, _canvasId, frames) {
      const { root, css } = open.design;
      const seen = new Set<string>();
      const queue: string[] = ["package.json", ...css];
      for (const frame of frames) queue.push(...(await frameFiles(open.design, frame)));
      const out: { path: string; data: Uint8Array }[] = [];
      while (queue.length > 0) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const data = await readFile(inRoot(root, file)).catch(() => undefined);
        if (!data) continue;
        out.push({ path: file, data: new Uint8Array(data) });
        for (const spec of localImports(file, data.toString("utf8"))) {
          const target = spec.startsWith("/") ? spec.slice(1) : resolveSpec(file, spec);
          if (!isInside(root, target)) continue;
          const dep = await existing(root, importCandidates(file, target));
          if (dep) queue.push(dep);
        }
      }
      return out;
    },
  };

  async function frameFiles(design: Design, frame: Frame): Promise<string[]> {
    if (frame.source.kind === "file") return [frame.source.file];
    if (!options.routes) return [];
    const route = (await options.routes(design)).find(
      (r) => r.path === (frame.source as { path: string }).path,
    );
    return route?.file ? [route.file] : [];
  }

  async function step(design: Design, by: Actor, direction: "undo" | "redo"): Promise<void> {
    await history.step(actorKey(design, by), direction, async (patches) => {
      let moved: Patch[] = [];
      await transact(design.root, [...new Set(patches.map((p) => p.file))], (contents) => {
        const result = stepPatches(contents, patches, direction);
        moved = result.patches;
        return result.contents;
      });
      return moved;
    });
  }
}

/**
 * The local files a module or stylesheet pulls in, as written: relative (or root-absolute) import
 * specifiers of a JS/TS module, `@import`, `@use`, `@forward` and `url()` of a stylesheet. Query
 * strings (`?url`) are dropped.
 */
function localImports(file: string, code: string): string[] {
  let specs: string[] = [];
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    let ast: ReturnType<typeof parseModule>;
    try {
      ast = parseModule(code, file);
    } catch {
      return [];
    }
    specs = specifiers(ast).map((lit) => lit.value);
  } else if (/\.(css|scss|sass|less)$/.test(file)) {
    specs = sheetSpecifiers(file, code);
  }
  return specs
    .map((spec) => spec.replace(/[?#].*$/, ""))
    .filter((spec) => isRelative(spec) || (spec.startsWith("/") && !spec.startsWith("//")));
}

function isInside(root: string, file: string): boolean {
  try {
    inRoot(root, file);
    return true;
  } catch {
    return false;
  }
}

function guardPrototype(root: string, canvas: Canvas, files: string[]): void {
  if (canvas.kind !== "prototype") return;
  const outside = files.find((f) => !inPrototypes(root, f));
  if (outside) {
    throw new Refused(
      `${outside} is production code. Copy ${path.posix.basename(outside)} into this prototype to edit it here.`,
      "outside-prototype",
    );
  }
}

/** `file` is under `.finite/` once `..` and `.` are resolved. Refuses paths that leave the root. */
function inPrototypes(root: string, file: string): boolean {
  return posixRelative(root, inRoot(root, file)).startsWith(PROTOTYPE_DIR);
}

async function existing(root: string, files: string[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      if ((await readText(inRoot(root, file))) !== undefined) return file;
    } catch {
      // outside the root
    }
  }
  return undefined;
}
