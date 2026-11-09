import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  Refused,
  type Actor,
  type Canvas,
  type Design,
  type Frame,
  type Loc,
  type Remap,
  type Route,
  type SourceEditor,
  type Token,
} from "@finite/protocol";
import { addAsset } from "./assets.ts";
import { boardFile } from "./boardFile.ts";
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
import { readInline } from "./inline.ts";
import { parseModule } from "./jsx.ts";
import { editFiles, editStyles, rewrite } from "./rewrite.ts";
import { exportSlice, type SliceRenderer } from "./sliceExport.ts";
import { isStylexVar, mentionsVar, readVars, writeVar } from "./stylex.ts";
import type { TailwindVersion, Theme } from "./tailwind.ts";
import { configTheme, tailwind3Config } from "./tailwind3.ts";
import {
  hasToken,
  isVariable,
  lightTheme,
  readTokens,
  type Sheet,
  tokenName,
  variableHome,
  variableRefs,
  variableSheets,
  writeToken,
} from "./tokens.ts";

export { rewrite } from "./rewrite.ts";

export type SourceEditorOptions = {
  /** The design's routes, to find the file behind a route for `copyComponent({ route })`. */
  routes?: (design: Design) => Promise<Route[]>;
  /** The file locks to share with other writers (default: the process's `fileLocks`). */
  locks?: Locked;
  /** The preview and Chrome that `exportSlice` renders with; without them it refuses. */
  render?: SliceRenderer;
};

const PROTOTYPE_DIR = ".finite/";

export function createSourceEditor(options: SourceEditorOptions = {}): SourceEditor {
  const locked = options.locks ?? fileLocks;
  const history = createHistory();
  const actorKey = (design: Design, by: Actor) => `${design.id}\u0000${by.kind}:${by.id}`;

  /**
   * The design's global sheets, then the local `.scss` partials they load with `@use`, `@forward`
   * or `@import`, followed all the way down, which hold Sass variable tokens.
   */
  async function sheets(design: Design): Promise<Sheet[]> {
    const out: Sheet[] = [];
    const seen = new Set(design.css);
    const queue = design.css.map((file) => ({ file, partial: false }));
    while (queue.length > 0) {
      const { file, partial } = queue.shift()!;
      const css = await readText(inRoot(design.root, file));
      if (css === undefined) continue;
      out.push(partial ? { file, css, partial } : { file, css });
      if (path.posix.extname(file) !== ".scss") continue;
      for (const { spec, rule } of localImports(file, css)) {
        if (rule === "url") continue;
        const target = spec.startsWith("/") ? spec.slice(1) : resolveSpec(file, spec);
        if (!isInside(design.root, target)) continue;
        const dep = await existing(design.root, importCandidates(file, target, rule === "import"));
        if (dep?.endsWith(".scss") && !seen.has(dep)) {
          seen.add(dep);
          queue.push({ file: dep, partial: true });
        }
      }
    }
    return out;
  }

  /** The theme hand edits match values to: `tailwind.config.*` on v3, else the sheets' `@theme`. */
  async function tailwindTheme(
    design: Design,
  ): Promise<{ theme: Theme; tailwind: TailwindVersion }> {
    const all = await sheets(design);
    const config = await tailwind3Config(design.root, all);
    if (config) return { theme: await configTheme(design.root, config), tailwind: 3 };
    return { theme: lightTheme(readTokens(all)), tailwind: 4 };
  }

  /**
   * A StyleX design's `defineVars` tokens, from its `*.stylex.ts` (or `.js`, `.tsx`…) files under
   * `src/` and `app/`, with the file that defines each token and each group. The first file to
   * define a group wins.
   */
  async function stylexVars(design: Design): Promise<{
    tokens: Token[];
    homes: Record<string, string>;
    groups: Map<string, string>;
  }> {
    const tokens: Token[] = [];
    const homes: Record<string, string> = {};
    const groups = new Map<string, string>();
    if (design.styling !== "stylex") return { tokens, homes, groups };
    for (const dir of ["src", "app"]) {
      const entries = await readdir(inRoot(design.root, dir), { recursive: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
        const file = `${dir}/${entry.split(path.sep).join("/")}`;
        if (!/\.stylex\.[cm]?[jt]sx?$/.test(file) || file.includes("node_modules/")) continue;
        let read: ReturnType<typeof readVars>;
        try {
          read = readVars(file, (await readText(inRoot(design.root, file))) ?? "");
        } catch {
          continue; // a file that doesn't parse has no tokens to show
        }
        for (const group of read.groups) if (!groups.has(group)) groups.set(group, file);
        for (const token of read.tokens) {
          if (groups.get(token.name.split(".")[0]!) !== file) continue;
          homes[token.name] = file;
          tokens.push(token);
        }
      }
    }
    return { tokens, homes, groups };
  }

  async function allTokens(design: Design): Promise<Token[]> {
    return [...readTokens(await sheets(design)), ...(await stylexVars(design)).tokens];
  }

  /**
   * Reads `files`, lets `change` produce new contents, writes what changed. All under the files'
   * locks. A file in `deleteEmpty` that ends up empty is deleted instead.
   */
  async function transact(
    root: string,
    files: string[],
    change: (contents: Map<string, string>) => Map<string, string> | Promise<Map<string, string>>,
    deleteEmpty: ReadonlySet<string> = new Set(),
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
        for (const { file, code } of writes) {
          if (code === "" && deleteEmpty.has(file)) await rm(inRoot(root, file), { force: true });
          else await writeAtomic(inRoot(root, file), code);
        }
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
      const styles = edits.flatMap(editStyles);
      const variables = styles.some((s) => variableRefs(s).length > 0)
        ? variableSheets(await sheets(design))
        : {};
      const stylex = styles.some(mentionsVar) ? (await stylexVars(design)).homes : {};

      const remap: Remap = {};
      const created: Record<string, Loc> = {};
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
            variables,
            stylexVars: stylex,
          });
          if (result instanceof Refused) throw result;
          out.set(file, result.code);
          Object.assign(remap, result.remap);
          Object.assign(created, result.created);
          extra = result.files;
        }
        for (const [file, css] of Object.entries(extra)) out.set(file, css);
        return out;
      });
      if (patches.length > 0) history.push(actorKey(design, by), patches);
      return { ok: true, remap, created };
    },

    async write(open, file, content, by) {
      let created = false;
      const patches = await transact(open.design.root, [file], (contents) => {
        created = !contents.has(file);
        return new Map([[file, content]]);
      });
      if (patches.length > 0) {
        history.push(
          actorKey(open.design, by),
          patches.map((p) => ({ ...p, created })),
        );
      }
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

    inline: (open, loc) => readInline(open, loc),
    draw: (open, input, by) => boardFile(open, input, by),
    addAsset: (open, attachment) => addAsset(open, attachment),
    exportSlice: (open, input) => exportSlice(options.render, open, input),

    tokens: allTokens,

    async setToken(design, { name, mode, value }) {
      const prop = tokenName(name);
      if (isStylexVar(prop)) {
        const [group, key] = prop.split(".") as [string, string];
        const { groups } = await stylexVars(design);
        const file = groups.get(group);
        if (!file)
          throw new Refused(
            design.styling !== "stylex"
              ? `${prop} is a StyleX token, but this design isn't styled with StyleX. Use a CSS custom property (--${key}) instead.`
              : groups.size === 0
                ? `${prop} is a StyleX token, but this design has no stylex.defineVars yet. Add a src/tokens.stylex.ts with export const ${group} = stylex.defineVars({ … }), or ask the agent.`
                : `This design has no defineVars named ${group}. Add it to ${[...groups.keys()].map((g) => `${g}.${key}`).join(" or ")}, or ask the agent to add a ${group} group.`,
            "invalid",
          );
        await transact(design.root, [file], (contents) => {
          return new Map([[file, writeVar(file, contents.get(file) ?? "", prop, mode, value)]]);
        });
        return allTokens(design);
      }
      const all = await sheets(design);
      const config =
        design.styling === "tailwind" ? await tailwind3Config(design.root, all) : undefined;
      if (config && !isVariable(prop) && !all.some((s) => hasToken(s.file, s.css, prop, mode)))
        throw new Refused(
          `This design uses Tailwind v3, whose theme lives in ${path.basename(config)}, so a new token there wouldn't make a class. Add it to theme.extend in ${path.basename(config)}, or ask the agent to.`,
          "invalid",
        );
      const globals = all.filter((s) => !s.partial);
      const target = isVariable(prop)
        ? variableHome(prop, all)
        : (globals.find((s) => hasToken(s.file, s.css, prop, mode)) ??
          (design.styling === "tailwind"
            ? (globals.find((s) => /@theme\b/.test(s.css)) ??
              globals.find((s) => /@import\s+["']tailwindcss/.test(s.css)))
            : globals.find((s) => /:root\b/.test(s.css))) ??
          globals[0]);
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
      return allTokens(design);
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
        for (const { spec, rule } of localImports(file, data.toString("utf8"))) {
          const target = spec.startsWith("/") ? spec.slice(1) : resolveSpec(file, spec);
          if (!isInside(root, target)) continue;
          const dep = await existing(root, importCandidates(file, target, rule === "import"));
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
      const created = new Set(patches.filter((p) => p.created).map((p) => p.file));
      await transact(
        design.root,
        [...new Set(patches.map((p) => p.file))],
        (contents) => {
          for (const file of created) {
            if (direction === "redo" && contents.has(file)) {
              throw new Refused(
                `${file} exists again since, so Finite can't redo making it. It was skipped; redo again to go further back.`,
                "stale",
              );
            }
          }
          // A redo of a deleted file starts from nothing.
          const seeded = new Map(contents);
          for (const file of created) if (!seeded.has(file)) seeded.set(file, "");
          const result = stepPatches(seeded, patches, direction);
          moved = result.patches;
          return result.contents;
        },
        created,
      );
      return moved;
    });
  }
}

/**
 * The local files a module or stylesheet pulls in, as written: relative (or root-absolute) import
 * specifiers of a JS/TS module, `@import`, `@use`, `@forward` and `url()` of a stylesheet, with
 * the rule that names each. Query strings (`?url`) are dropped.
 */
function localImports(file: string, code: string): { spec: string; rule?: string }[] {
  let specs: { spec: string; rule?: string }[] = [];
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    let ast: ReturnType<typeof parseModule>;
    try {
      ast = parseModule(code, file);
    } catch {
      return [];
    }
    specs = specifiers(ast).map((lit) => ({ spec: lit.value }));
  } else if (/\.(css|scss|sass|less)$/.test(file)) {
    specs = sheetSpecifiers(file, code);
  }
  return specs
    .map((s) => ({ ...s, spec: s.spec.replace(/[?#].*$/, "") }))
    .filter(({ spec }) => isRelative(spec) || (spec.startsWith("/") && !spec.startsWith("//")));
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
