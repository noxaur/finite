import type { Frame, Hit, HitElement, Inline, Rect } from "@finite/protocol";
import { hasText, isPlain, plainText } from "../../design/editing/inline";
import type { TextTarget } from "../editor";
import { chainOf, fileOf } from "../gestures";
import { keyOf, selectionStore } from "../selection";
import type { Down, ToolDef, ToolHost } from "./host";
import { boxGesture } from "./shapes";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long a new element may take to reach the frame, in milliseconds. */
const LANDING_MS = 4000;
const LANDING_STEP_MS = 150;

/** Inline tags: pressing text inside one edits the text around it. */
const INLINE_TAGS = new Set([
  "a",
  "b",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);
/** Elements that are text even with nothing in them yet. */
const TEXT_TAGS = new Set([
  "a",
  "button",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "li",
  "p",
  "span",
]);
/** SVG text takes plain text: no wrapper and no break means anything to it. */
const PLAIN_TAGS = new Set(["text", "textPath", "tspan"]);
/** What a Text press has no element to read its look from. */
const DEFAULT_FONT = { fontSize: "16px" };

/** What a person's press on `hit` edits: the text around an inline wrapper in the same file. */
export function textRootOf(hit: Hit): HitElement {
  const chain = chainOf(hit);
  let i = chain.length - 1;
  while (i > 0 && INLINE_TAGS.has(chain[i]!.tag) && fileOf(chain[i - 1]!.loc) === fileOf(hit.loc))
    i -= 1;
  return chain[i]!;
}

type Read = Awaited<ReturnType<ToolHost["readInline"]>>;

/**
 * Opens the rich text editor on the text under `hit`. Returns whether it opened; a quiet caller
 * has something else to do when it can't, and everyone else hears why.
 */
export async function editText(
  host: ToolHost,
  frame: Frame,
  hit: Hit,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  const bridge = host.bridge(frame.id);
  if (!bridge) return false;
  const root = textRootOf(hit);
  const candidates: HitElement[] = root.loc === hit.loc ? [root] : [root, hit];
  let read: { element: HitElement; value: Read } | null = null;
  for (const element of candidates) {
    try {
      read = { element, value: await host.readInline(element.loc) };
      break;
    } catch (e) {
      if (element === candidates.at(-1)) {
        if (!opts.quiet) host.say(errorText(e));
        return false;
      }
    }
  }
  if (!read) return false;
  const { element, value } = read;
  if (value.rev !== element.rev) {
    if (!opts.quiet) host.say("The file changed; try again");
    return false;
  }
  if (
    !hasText(value.content) &&
    !value.keeps.some((k) => k.kind === "expression") &&
    !(value.content.length === 0 && TEXT_TAGS.has(element.tag))
  ) {
    return false;
  }
  const index = element.loc === hit.loc ? hit.index : 0;
  const inspection = await bridge.inspect(element.loc, index).catch(() => null);
  if (!inspection) return false;
  const rects = await bridge.rects([element.loc]).catch(() => null);
  const box = host.boxOf(frame);
  const rect = rects?.[element.loc]?.[index] ?? hit.rect;
  const keepStyles: Record<number, Record<string, string>> = {};
  await Promise.all(
    value.keeps.map(async (keep) => {
      if (!keep.loc) return;
      const seen = await bridge.inspect(keep.loc, 0).catch(() => null);
      if (seen) keepStyles[keep.id] = seen.computed;
    }),
  );
  host.update({
    editingText: {
      rect: { ...rect, x: box.x + rect.x, y: box.y + rect.y },
      font: inspection.computed,
      content: value.content,
      keeps: value.keeps,
      keepStyles,
      plain: PLAIN_TAGS.has(element.tag),
      target: {
        kind: "element",
        frameId: frame.id,
        loc: element.loc,
        tag: element.tag,
        rev: value.rev,
        chain: chainOf(hit),
      },
    },
  });
  return true;
}

/** Opens an empty editor for text that isn't in the file until the person keeps it. */
async function openNew(host: ToolHost, p: Down, box: Rect, fixed: boolean) {
  const frame = host.frameAt({ x: box.x, y: box.y });
  let font: Record<string, string> = DEFAULT_FONT;
  if (frame) {
    const at = host.local(frame, box);
    const bridge = host.bridge(frame.id);
    const hit = await bridge?.hit(at.x, at.y).catch(() => null);
    const inspection = hit ? await bridge?.inspect(hit.loc, hit.index).catch(() => null) : null;
    if (inspection) font = { ...inspection.computed, ...DEFAULT_FONT };
  }
  host.update({
    editingText: {
      rect: fixed ? { ...box, height: 0 } : { ...box, width: 0, height: 0 },
      font,
      content: [],
      keeps: [],
      keepStyles: {},
      plain: false,
      target: { kind: "new", box, deep: p.deep, alt: p.alt, fixed },
    },
  });
}

/** Writes new text where its box landed, as one element in the design's own convention. */
export async function placeText(
  host: ToolHost,
  target: Extract<TextTarget, { kind: "new" }>,
  content: Inline[],
) {
  const placed = await host.draw({
    box: target.box,
    node: { tag: "p", name: "Text", text: plainText(content), styles: NEW_TEXT },
    deep: target.deep,
    alt: target.alt,
    hug: target.fixed ? ["height"] : ["width", "height"],
  });
  if (!placed?.loc || isPlain(content)) return;
  // The insert wrote the words; the formatting is a second edit on what landed.
  try {
    const { rev } = await host.readInline(placed.loc);
    await host.edit([
      { kind: "inline", loc: placed.loc, tag: "p", content, revs: { [fileOf(placed.loc)]: rev } },
    ]);
  } catch (e) {
    host.say(errorText(e));
  }
}

const NEW_TEXT = { margin: "0", "font-size": "16px" };

export const text = {
  id: "text",
  group: "text",
  label: "Text",
  keys: { key: "t" },
  icon: "text",
  cursor: "var(--cursor-text, text)",
  enabled: true,
  down(host, p) {
    return {
      click: () => clickText(host, p),
      begin: async () =>
        boxGesture(host, p.world, false, async (box) => {
          await openNew(host, p, box, true);
        }),
    };
  },
} as const satisfies ToolDef<"text">;

/** A click on existing text edits it; anywhere else starts new text at the click. */
async function clickText(host: ToolHost, p: Down) {
  const point = { x: Math.round(p.world.x), y: Math.round(p.world.y), width: 1, height: 1 };
  if (p.frame) {
    const at = host.local(p.frame, p.world);
    const hit = await host
      .bridge(p.frame.id)
      ?.hit(at.x, at.y)
      .catch(() => null);
    if (hit && (await editText(host, p.frame, hit, { quiet: true }))) return;
  }
  await openNew(host, p, point, false);
}

export const textOnPath = {
  id: "textOnPath",
  group: "text",
  label: "Text on path",
  keys: null,
  icon: "textOnPath",
  cursor: "var(--cursor-text, text)",
  enabled: true,
  sticky: true,
  activate(host) {
    const [item, ...rest] = selectionStore.get();
    if (!item?.loc || rest.length > 0) return;
    const facts = host.facts.get(keyOf(item));
    const frame = host.frame(item.frameId);
    if (facts?.tag === "path" && frame)
      void onPath(host, frame, { loc: item.loc, tag: facts.tag, rev: facts.rev }, item.index ?? 0);
  },
  down(host, p) {
    if (!p.frame) return "pass";
    const frame = p.frame;
    return {
      begin: async () => null,
      click: async () => {
        const at = host.local(frame, p.world);
        const hit = await host
          .bridge(frame.id)
          ?.hit(at.x, at.y)
          .catch(() => null);
        if (hit?.tag === "path") await onPath(host, frame, hit, hit.index);
        else host.say("Click a path to put text on it, or select one first.");
      },
    };
  },
} as const satisfies ToolDef<"textOnPath">;

/** Puts text along a `<path>`: a sibling `<text>` whose `<textPath>` points at the path's id. */
async function onPath(host: ToolHost, frame: Frame, path: HitElement, index: number) {
  host.setTool("select");
  const bridge = host.bridge(frame.id);
  const info = await bridge?.vector(path.loc, index).catch(() => null);
  if (!bridge || !info) return host.say("That path isn't in the frame any more.");
  const id = info.id ?? `path-${Math.random().toString(16).slice(2, 8)}`;
  const revs = { [fileOf(path.loc)]: path.rev };
  const done = await host.edit([
    ...(info.id ? [] : [{ kind: "attr" as const, loc: path.loc, name: "id", value: id, revs }]),
    {
      kind: "insert",
      loc: path.loc,
      tag: path.tag,
      place: "after",
      node: {
        tag: "text",
        name: "Text on path",
        styles: { fill: "currentColor", "font-size": "16px" },
        children: [{ tag: "textPath", ref: "text", attrs: { href: `#${id}` }, text: "Text" }],
      },
      revs,
    },
  ]);
  const loc = done ? done.created.text : undefined;
  if (!loc) return;
  for (const end = performance.now() + LANDING_MS; performance.now() < end;) {
    const rects = await bridge.rects([loc]).catch(() => null);
    if (rects?.[loc]?.length) break;
    await new Promise((resolve) => setTimeout(resolve, LANDING_STEP_MS));
  }
  const inspection = await bridge.inspect(loc, 0).catch(() => null);
  if (!inspection) return;
  host.select([{ frameId: frame.id, loc, index: 0, name: "Text on path" }]);
  const rect = (await bridge.rects([loc]).catch(() => null))?.[loc]?.[0];
  if (rect)
    await editText(host, frame, {
      loc,
      rev: inspection.rev,
      tag: inspection.tag,
      rect,
      index: 0,
      count: 1,
      path: [],
    });
}
