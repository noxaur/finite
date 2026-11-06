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
  createLocks,
  freeName,
  inRoot,
  mustRead,
  posixRelative,
  readText,
  writeAtomic,
} from "./files.ts";
import { createHistory, diffPatch, stepPatches, type Patch } from "./history.ts";
import {
  candidates,
  cssModules,
  isRelative,
  moveImports,
  resolveSpec,
  retarget,
  specifiers,
} from "./imports.ts";
import { parseModule } from "./jsx.ts";
import { editFiles, rewrite } from "./rewrite.ts";
import { hasToken, lightTheme, readTokens, tokenName, writeToken } from "./tokens.ts";

export { rewrite } from "./rewrite.ts";

export type SourceEditorOptions = {
  /** The design's routes, to find the file behind a route for `copyComponent({ route })`. */
  routes?: (design: Design) => Promise<Route[]>;
};

const PROTOTYPE_DIR = ".finite/";

export function createSourceEditor(options: SourceEditorOptions = {}): SourceEditor {
  const locked = createLocks();
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
        const patches: Patch[] = [];
        for (const [file, code] of after) {
          const patch = diffPatch(file, before.get(file) ?? "", code);
          if (!patch) continue;
          await writeAtomic(inRoot(root, file), code);
          patches.push(patch);
        }
        return patches;
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
    const target = posixRelative(root, await freeName(inRoot(root, toFile)));
    await transact(root, [target], () => new Map([[target, moveImports(code, file, target)]]));
    return target;
  }

  return {
    async apply(open, edits, by, canvas) {
      const design = open.design;
      const files = [...new Set(edits.flatMap(editFiles))];
      for (const file of files) inRoot(design.root, file);
      guardPrototype(canvas, files);

      let modules: string[] = [];
      if (design.styling === "css-modules") {
        for (const file of files) {
          const code = await mustRead(design.root, file);
          modules.push(...cssModules(parseModule(code, file), file).values());
        }
        modules = [...new Set(modules)];
        guardPrototype(canvas, modules);
      }
      const theme =
        design.styling === "tailwind"
          ? lightTheme(readTokens((await sheets(design)).map((s) => s.css)))
          : {};

      const remap: Remap = {};
      const patches = await transact(design.root, [...files, ...modules], (contents) => {
        const out = new Map(contents);
        let extra = Object.fromEntries(
          modules.flatMap((m) => (contents.has(m) ? [[m, contents.get(m)!]] : [])),
        );
        for (const file of files) {
          const code = contents.get(file);
          if (code === undefined) throw new Refused(`${file} doesn't exist`, "not-found");
          const result = rewrite(code, file, edits, design.styling, { theme, files: extra });
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
      return readTokens((await sheets(design)).map((s) => s.css));
    },

    async setToken(design, { name, mode, value }) {
      const prop = tokenName(name);
      const all = await sheets(design);
      const target =
        all.find((s) => hasToken(s.css, prop, mode)) ??
        all.find((s) => /@theme\b/.test(s.css)) ??
        all.find((s) => /@import\s+["']tailwindcss/.test(s.css)) ??
        all[0];
      if (!target)
        throw new Refused(
          "This design has no stylesheet to keep tokens in. Add one to css in .finite/design.json.",
          "invalid",
        );
      await transact(design.root, [target.file], (contents) => {
        return new Map([
          [target.file, writeToken(contents.get(target.file) ?? "", prop, mode, value)],
        ]);
      });
      return readTokens((await sheets(design)).map((s) => s.css));
    },

    components: (design) => listComponents(design.root),

    async copyComponent(design, from, toFile) {
      if (!toFile.startsWith(PROTOTYPE_DIR))
        throw new Refused(
          `Copies go inside ${PROTOTYPE_DIR}, e.g. .finite/boards/<canvasId>/Home.tsx`,
          "outside-prototype",
        );
      inRoot(design.root, toFile);
      return { file: await copyInto(design.root, await sourceFile(design, from), toFile) };
    },

    async exportFrames(open, _canvasId, frames) {
      const root = open.design.root;
      const seen = new Set<string>();
      const queue: string[] = [];
      for (const frame of frames) queue.push(...(await frameFiles(open.design, frame)));
      const out: { path: string; data: Uint8Array }[] = [];
      while (queue.length > 0) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const abs = inRoot(root, file);
        const data = await readFile(abs).catch(() => undefined);
        if (!data) continue;
        out.push({ path: file, data: new Uint8Array(data) });
        if (!/\.[jt]sx?$/.test(file)) continue;
        for (const lit of specifiers(parseModule(data.toString("utf8"), file))) {
          if (!isRelative(lit.value)) continue;
          const dep = await existing(root, candidates(resolveSpec(file, lit.value)));
          if (dep?.startsWith(PROTOTYPE_DIR)) queue.push(dep);
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

function guardPrototype(canvas: Canvas, files: string[]): void {
  if (canvas.kind !== "prototype") return;
  const outside = files.find((f) => !f.startsWith(PROTOTYPE_DIR));
  if (outside) {
    throw new Refused(
      `${outside} is production code. Copy ${path.posix.basename(outside)} into this prototype to edit it here.`,
      "outside-prototype",
    );
  }
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
