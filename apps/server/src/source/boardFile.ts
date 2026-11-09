import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type Actor,
  type Canvas,
  type Frame,
  type Loc,
  type NewNode,
  type OpenDesign,
  type Rect,
  Refused,
  type SourceEdit,
} from "@finite/protocol";
import MagicString from "magic-string";
import { freeName, inRoot, type Locked, posixRelative, rev, writeAtomic } from "./files.ts";
import { printRoot } from "./insert.ts";
import { parseTsx } from "./jsx.ts";
import { rewrite } from "./rewrite.ts";
import type { TailwindVersion, Theme } from "./tailwind.ts";

type BoardContext = { theme: Theme; tailwind: TailwindVersion; locked: Locked };

/** The root fills the iframe, so resizing the frame resizes the shape. */
const FILL_FRAME = {
  position: "absolute",
  left: "0",
  top: "0",
  width: "100%",
  height: "100vh",
} as const;

/**
 * Writes `.finite/boards/<canvasId>/<Name>.tsx`, whose default export renders `node`, and adds a
 * frame for it. Undoing the frame leaves the file, as removing a frame does, so redo brings it back.
 */
export async function boardFile(
  open: OpenDesign,
  input: { canvasId: string; box: Rect; name: string; node: NewNode },
  by: Actor,
  ctx: BoardContext,
): Promise<{ canvas: Canvas; frameId: string; file: string; created: Record<string, Loc> }> {
  const { canvasId, box, name, node } = input;
  if (!/^[\w-]+$/.test(canvasId)) throw new Refused(`${canvasId} isn't a canvas id`, "invalid");
  if (!(await open.canvases()).some((c) => c.id === canvasId))
    throw new Refused(`There's no canvas ${canvasId}. Reload the page.`, "not-found");
  const root = open.design.root;
  const stem = componentName(name);
  const wanted = inRoot(root, `.finite/boards/${canvasId}/${stem}.tsx`);
  const { file, created } = await ctx.locked([`${path.dirname(wanted)}${path.sep}`], async () => {
    const target = await freeName(wanted);
    const file = posixRelative(root, target);
    const { code, created } = boardCode(open, file, node, ctx);
    await writeAtomic(target, code);
    return { file, created };
  });
  const number = /-(\d+)\.tsx$/.exec(file)?.[1];
  const frame: Frame = {
    id: randomUUID(),
    name: number ? `${name} ${number}` : name,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    source: { kind: "file", file },
  };
  const canvas = await open.patchCanvas(canvasId, { op: "addFrames", frames: [frame] }, by);
  return { canvas, frameId: frame.id, file, created };
}

/** The file's code, with every printed node dressed the way an inspector edit would be. */
function boardCode(
  open: OpenDesign,
  file: string,
  node: NewNode,
  ctx: BoardContext,
): { code: string; created: Record<string, Loc> } {
  const { styling: convention, router } = open.design;
  const stem = path.posix.basename(file, ".tsx").replaceAll("-", "");
  const blank = `export default function ${stem}() {\n  return null;\n}\n`;
  const root: NewNode = {
    ...node,
    styles: { ...FILL_FRAME, ...(node.tag === "div" ? {} : { display: "block" }), ...node.styles },
  };
  const ms = new MagicString(blank);
  const printed = printRoot(
    { ms, code: blank, file, parsed: parseTsx(blank, file), files: {}, convention, router },
    root,
    "  ",
  );
  ms.overwrite(blank.indexOf("null"), blank.indexOf("null") + 4, printed.text);
  const seed = ms.toString();

  // The printed elements are the only ones in the file, so document order pairs them up.
  const keys = [...parseTsx(seed, file).elements.keys()].sort((a, b) => {
    const [al, ac] = a.split(":").map(Number) as [number, number];
    const [bl, bc] = b.split(":").map(Number) as [number, number];
    return al - bl || ac - bc;
  });
  const locOf = (key: string): Loc => `${file}:${key}`;
  const revs = { [file]: rev(seed) };
  const edits: SourceEdit[] = printed.nodes.flatMap((p, i) =>
    Object.keys(p.styles).length === 0
      ? []
      : [{ kind: "style", locs: [locOf(keys[i]!)], tag: p.tag, styles: p.styles, revs }],
  );
  const result = rewrite(seed, file, edits, convention, {
    theme: ctx.theme,
    tailwind: ctx.tailwind,
    router,
    files: {},
  });
  if (result instanceof Refused) throw result;
  const created: Record<string, Loc> = {};
  printed.nodes.forEach((p, i) => {
    if (p.key.startsWith("#")) return;
    const seedLoc = locOf(keys[i]!);
    created[p.key] = result.remap[seedLoc] ?? seedLoc;
  });
  return { code: result.code, created };
}

/** A layer name as a component's name and a file's: `hero shot` → `HeroShot`. */
function componentName(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return joined === "" ? "Board" : /^\d/.test(joined) ? `Board${joined}` : joined;
}
