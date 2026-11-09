import type { LayerNode, Loc, Rect, SourceEdit } from "@finite/protocol";
import {
  type AutoLayout,
  autoLayoutStyles,
  boundsOf,
  FLOW_STYLES,
  inferAutoLayout,
  movesAbsolutely,
  NO_FLEX,
  wrapperTagFor,
} from "../../design/editing/autoLayout";
import { childrenIn, layerNameAt } from "../layers";
import { fileOf, revsOf } from "../gestures";
import { keyOf, type SelectionItem, selectionStore } from "../selection";
import type { CommandDef } from "./commands";
import type { ToolHost } from "./host";

const WRAPPER = "Auto layout";
const REF = "w";

type El = { loc: Loc; rev: string; tag: string; index: number };
type Read = El & { rect: Rect; computed: Record<string, string> };

const num = (v: string | undefined) => parseFloat(v ?? "") || 0;

/** Each element's box and computed style, or `null` when the frame can't say. */
async function measure(
  host: ToolHost,
  frameId: string,
  els: readonly El[],
): Promise<Read[] | null> {
  const bridge = host.bridge(frameId);
  if (!bridge) return null;
  const locs = [...new Set(els.map((e) => e.loc))];
  const rects = await bridge.rects(locs).catch(() => ({}) as Record<Loc, Rect[]>);
  const out = await Promise.all(
    els.map(async (e): Promise<Read | null> => {
      const rect = rects[e.loc]?.[e.index];
      const inspection = await bridge.inspect(e.loc, e.index).catch(() => null);
      return rect && inspection ? { ...e, rect, computed: inspection.computed } : null;
    }),
  );
  return out.every((r) => r !== null) ? (out as Read[]) : null;
}

const styleEdit = (el: El, styles: Record<string, string | null>): SourceEdit => ({
  kind: "style",
  locs: [el.loc],
  tag: el.tag,
  styles,
  revs: revsOf([el]),
});

const onlyFloating = (kids: readonly Read[]) =>
  kids.filter((k) => movesAbsolutely(k.computed.position));

/** The largest margin along the direction: spacing the gap shouldn't double. */
function marginAlong(kids: readonly Read[], direction: AutoLayout["direction"]) {
  const sides = direction === "row" ? ["marginLeft", "marginRight"] : ["marginTop", "marginBottom"];
  return Math.max(0, ...kids.flatMap((k) => sides.map((s) => num(k.computed[s]))));
}

function inferred(kids: readonly Read[], parent: Rect): AutoLayout {
  const layout = inferAutoLayout(
    kids.map((k) => k.rect),
    parent,
  );
  return { ...layout, gap: Math.max(0, layout.gap - marginAlong(kids, layout.direction)) };
}

/** One element per loc, in selection order. */
function distinct(items: readonly (SelectionItem & { loc: Loc })[]) {
  const seen = new Set<Loc>();
  return items.filter((i) => !seen.has(i.loc) && seen.add(i.loc));
}

/** What the command acts on: the selected elements of one frame, or why it can't. */
function selectedElements(host: ToolHost) {
  const all = selectionStore.get();
  const items = all.filter((s): s is SelectionItem & { loc: Loc } => s.loc !== undefined);
  if (items.length === 0) {
    host.say(
      all.length > 0
        ? "Auto layout works on elements. Select one or more inside this frame."
        : "Select an element first.",
    );
    return null;
  }
  const frameId = items[0]!.frameId;
  if (items.length !== all.length || items.some((i) => i.frameId !== frameId)) {
    host.say("Select elements in one frame to give them auto layout.");
    return null;
  }
  const els = distinct(items).map((item) => {
    const facts = host.facts.get(keyOf(item));
    return facts ? { item, facts } : null;
  });
  if (els.some((e) => e === null)) return null;
  return { frameId, els: els as NonNullable<(typeof els)[number]>[] };
}

/** Shift+A: wraps the selected siblings in a flex container, or gives a lone container flex. */
export async function addAutoLayout(host: ToolHost) {
  const picked = selectedElements(host);
  if (!picked) return;
  const { frameId, els } = picked;
  const bridge = host.bridge(frameId);
  if (!bridge) return;
  const [first] = els;
  if (els.length === 1) {
    const { item, facts } = first!;
    const inspection = await bridge.inspect(item.loc, item.index ?? 0).catch(() => null);
    if (inspection?.computed.display?.includes("flex"))
      return host.say("This already has auto layout.");
    const layers = await bridge.layers().catch(() => [] as LayerNode[]);
    const kids = childrenIn(layers, { loc: item.loc, index: item.index ?? 0 }) ?? [];
    if (kids.length > 0) {
      const el = { loc: item.loc, rev: facts.rev, tag: facts.tag, index: item.index ?? 0 };
      return flexContainer(host, frameId, el, kids);
    }
  }
  const parentLoc = first!.facts.path[0]?.loc;
  if (els.some((e) => e.facts.path[0]?.loc !== parentLoc)) {
    return host.say("Select elements side by side in one parent to wrap them.");
  }
  const tag = wrapperTagFor(first!.facts.path[0]?.tag);
  if (!tag) {
    return host.say(
      `<${first!.facts.path[0]!.tag}> can't hold a layout element between it and its children. Ask the agent to change this.`,
    );
  }
  const read = await measure(
    host,
    frameId,
    els.map(({ item, facts }) => ({
      loc: item.loc,
      rev: facts.rev,
      tag: facts.tag,
      index: item.index ?? 0,
    })),
  );
  if (!read) return host.say("This frame hasn't loaded yet. Try again in a moment.");
  const bounds = boundsOf(read.map((r) => r.rect));
  const layout = inferred(read, bounds);
  const floating = onlyFloating(read);
  const allFloating = floating.length === read.length;
  const anchor = read[0]!;
  const done = await host.edit([
    {
      kind: "wrap",
      locs: layout.order.map((i) => read[i]!.loc),
      wrapper: {
        tag,
        ref: REF,
        name: WRAPPER,
        styles: {
          ...autoLayoutStyles(layout),
          // The children's offsets are from the same containing block the wrapper's will be from.
          ...(allFloating
            ? {
                position: anchor.computed.position!,
                left: `${Math.round(num(anchor.computed.left) + bounds.x - anchor.rect.x)}px`,
                top: `${Math.round(num(anchor.computed.top) + bounds.y - anchor.rect.y)}px`,
              }
            : {}),
        },
      },
      revs: revsOf(read),
    },
    ...floating.map((k) => styleEdit(k, FLOW_STYLES)),
  ]);
  if (!done) return;
  const loc = done.created[REF];
  if (loc) host.select([{ frameId, loc, index: anchor.index, name: WRAPPER }]);
}

/** Gives a container flex in place, its children arranged as they are now. */
async function flexContainer(host: ToolHost, frameId: string, el: El, kids: readonly LayerNode[]) {
  const [own, children] = await Promise.all([
    measure(host, frameId, [el]),
    measure(host, frameId, kids),
  ]);
  if (!own || !children) return host.say("This frame hasn't loaded yet. Try again in a moment.");
  const { rect, computed } = own[0]!;
  const inner = {
    x: rect.x + num(computed.borderLeftWidth),
    y: rect.y + num(computed.borderTopWidth),
    width: rect.width - num(computed.borderLeftWidth) - num(computed.borderRightWidth),
    height: rect.height - num(computed.borderTopWidth) - num(computed.borderBottomWidth),
  };
  const layout = inferred(children, inner);
  const unique = new Set(children.map((c) => c.loc)).size === children.length;
  const oneFile = new Set(children.map((c) => fileOf(c.loc))).size === 1;
  const reorder: SourceEdit[] =
    unique && oneFile
      ? layout.order
          .slice(0, -1)
          .map((at, i) => ({ at, next: layout.order[i + 1]! }))
          .reverse()
          .map(({ at, next }) => ({
            kind: "reorder",
            loc: children[at]!.loc,
            tag: children[at]!.tag,
            before: children[next]!.loc,
            revs: revsOf(children),
          }))
      : [];
  await host.edit([
    styleEdit(el, autoLayoutStyles(layout)),
    ...reorder,
    ...onlyFloating(children).map((k) => styleEdit(k, FLOW_STYLES)),
  ]);
}

const sizeOf = (kid: Read): Record<string, string> => ({
  ...(kid.computed.sizedWidth === "fixed" ? {} : { width: `${Math.round(kid.rect.width)}px` }),
  ...(kid.computed.sizedHeight === "fixed" ? {} : { height: `${Math.round(kid.rect.height)}px` }),
});

/** The insets that put `kid` where it's measured, in the containing block whose origin is `at`. */
const placed = (kid: Read, at: { x: number; y: number }, position: string) => ({
  position,
  left: `${Math.round(kid.rect.x - at.x)}px`,
  top: `${Math.round(kid.rect.y - at.y)}px`,
  ...sizeOf(kid),
});

/**
 * Shift+Alt+A: takes auto layout off the selected element and keeps the children where they are.
 * A wrapper that Shift+A made is removed. Any other flex element stays, its children positioned
 * absolutely inside it. A removed wrapper that sat in the flow leaves its children in the flow.
 */
export async function removeAutoLayout(host: ToolHost) {
  const picked = selectedElements(host);
  if (!picked) return;
  if (picked.els.length !== 1) return host.say("Select one auto layout element to remove it.");
  const { frameId } = picked;
  const { item, facts } = picked.els[0]!;
  const bridge = host.bridge(frameId);
  if (!bridge) return;
  const index = item.index ?? 0;
  const el = { loc: item.loc, rev: facts.rev, tag: facts.tag, index };
  const [own] = (await measure(host, frameId, [el])) ?? [];
  if (!own?.computed.display?.includes("flex")) {
    return host.say("This doesn't have auto layout to remove.");
  }
  const layers = await bridge.layers().catch(() => [] as LayerNode[]);
  const nodes = childrenIn(layers, { loc: item.loc, index }) ?? [];
  const kids = (await measure(host, frameId, nodes)) ?? [];
  const unique = new Set(kids.map((k) => k.loc)).size === kids.length;
  if (layerNameAt(layers, item.loc, index) === WRAPPER) {
    const floating = movesAbsolutely(own.computed.position);
    const origin = {
      x: own.rect.x - num(own.computed.left),
      y: own.rect.y - num(own.computed.top),
    };
    const before = selectionStore.get();
    const children = kids.map((k) => host.selectHit(frameId, k, k.index, facts.path));
    selectionStore.set(children);
    const ok = await host.edit(
      [
        { kind: "unwrap", loc: el.loc, tag: el.tag, revs: revsOf([el]) },
        ...(floating && unique
          ? kids.map((k) => styleEdit(k, placed(k, origin, own.computed.position!)))
          : []),
      ],
      [...facts.path].reverse(),
    );
    if (!ok) selectionStore.set(before);
    return;
  }
  const inner = {
    x: own.rect.x + num(own.computed.borderLeftWidth),
    y: own.rect.y + num(own.computed.borderTopWidth),
  };
  await host.edit([
    styleEdit(el, {
      ...NO_FLEX,
      ...(unique && own.computed.position === "static" ? { position: "relative" } : {}),
    }),
    ...(unique ? kids.map((k) => styleEdit(k, placed(k, inner, "absolute"))) : []),
  ]);
}

export const autoLayoutCommands: readonly CommandDef[] = [
  {
    id: "autoLayout",
    keys: [{ key: "a", shift: true }],
    enabled: true,
    run: (host) => void addAutoLayout(host),
  },
  {
    id: "unwrap",
    // By the key's position: Alt+A types å on a Mac, so `key` never reads "a".
    keys: [{ code: "KeyA", shift: true, alt: true }],
    enabled: true,
    run: (host) => void removeAutoLayout(host),
  },
];
