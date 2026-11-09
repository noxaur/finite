import type { DropNode, InsertPlace, Loc, Rect, Rev } from "@finite/protocol";

export type InsertPlan = {
  anchor: { loc: Loc; rev: Rev; tag: string; place: InsertPlace };
  styles: Record<string, string>;
  /** The container, when it needs `position: relative` for an absolute child. */
  makeRelative?: { loc: Loc; rev: Rev; tag: string };
  instances: number;
  /** "Adds to Card.tsx · used in 3 places", when the new element lands somewhere it repeats. */
  label?: string;
};

const fileOf = (loc: Loc) => loc.replace(/:\d+:\d+$/, "");
const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/**
 * Elements that can't hold a drawn element: void, replaced, phrasing-only (a `div` there is
 * invalid), table parts (the parser moves a `div` out, a hydration mismatch), or inside an SVG.
 */
const NO_CHILDREN = new Set([
  "abbr",
  "area",
  "audio",
  "b",
  "base",
  "br",
  "button",
  "canvas",
  "cite",
  "code",
  "col",
  "colgroup",
  "dfn",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "kbd",
  "label",
  "link",
  "mark",
  "meta",
  "object",
  "p",
  "param",
  "pre",
  "q",
  "s",
  "samp",
  "select",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "textarea",
  "tfoot",
  "thead",
  "time",
  "tr",
  "track",
  "u",
  "var",
  "video",
  "wbr",
]);
const SVG_INSIDE = new Set([
  "circle",
  "clippath",
  "defs",
  "ellipse",
  "g",
  "line",
  "lineargradient",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "symbol",
  "text",
  "textpath",
  "tspan",
  "use",
]);

function accepts(tag: string, nodeTag: string): boolean {
  const name = tag.toLowerCase();
  if (NO_CHILDREN.has(name) || SVG_INSIDE.has(name)) return false;
  return name === "svg" ? nodeTag === "path" : true;
}

/**
 * Where a drawn element goes, given what's stamped under the drop point (nearest first) and its
 * box in the frame's CSS pixels. The frame's own file wins: a shared component's container is
 * skipped unless the caller put a child there, which anchors the new element beside that child
 * in the caller's file. `deep` (⌘) takes the nearest container whatever its file. A flex or grid
 * container gets a flow child in its slot, anything else an absolute one; `alt` inverts that.
 */
export function planInsert(
  drop: readonly DropNode[],
  ownFile: string | undefined,
  box: Rect,
  opts: { deep: boolean; alt: boolean; nodeTag: string },
): InsertPlan | { refuse: string } {
  const own = (loc: Loc) => ownFile === undefined || fileOf(loc) === ownFile;
  for (const [i, node] of drop.entries()) {
    if (!accepts(node.tag, opts.nodeTag)) continue;
    if (opts.deep || own(node.loc)) return place(node, null, box, opts.alt, own(node.loc));
    const kid = node.children.findLast((c) => own(c.loc));
    if (!kid) continue;
    // With the file's elements above it, the kid sits in its JSX, so a sibling can go beside it.
    if (drop.slice(i + 1).some((up) => own(up.loc))) return place(node, kid, box, opts.alt, false);
    // Else it's the file's root, as when a layout renders the route: it can only be gone into.
    if (accepts(kid.tag, opts.nodeTag))
      return place({ ...kid, children: [] }, null, box, opts.alt, true);
  }
  return {
    refuse:
      "Nothing here can hold a new element. Draw inside a container like a div, or ask the agent to add one.",
  };
}

function place(
  node: DropNode,
  ownKid: DropNode["children"][number] | null,
  box: Rect,
  alt: boolean,
  inOwnFile: boolean,
): InsertPlan {
  const container = { loc: node.loc, rev: node.rev, tag: node.tag };
  const flowing = node.display.includes("flex") || node.display.includes("grid");
  const flow = alt ? !flowing : flowing;
  const size = { width: `${Math.round(box.width)}px`, height: `${Math.round(box.height)}px` };
  const file = fileOf((ownKid ?? node).loc);
  const siblings = node.children.filter((c) => fileOf(c.loc) === file);

  let anchor: InsertPlan["anchor"];
  if (flow) {
    const axis = node.display.includes("flex") && node.flexDirection.startsWith("row") ? "x" : "y";
    const mid = (r: Rect) => (axis === "x" ? r.x + r.width / 2 : r.y + r.height / 2);
    const at = axis === "x" ? box.x + box.width / 2 : box.y + box.height / 2;
    const next = siblings.find((c) => at < mid(c.rect));
    anchor = next
      ? { loc: next.loc, rev: next.rev, tag: next.tag, place: "before" }
      : ownKid
        ? { loc: ownKid.loc, rev: ownKid.rev, tag: ownKid.tag, place: "after" }
        : { ...container, place: "end" };
  } else {
    anchor = ownKid
      ? { loc: ownKid.loc, rev: ownKid.rev, tag: ownKid.tag, place: "after" }
      : { ...container, place: "end" };
  }

  const styles: Record<string, string> = flow
    ? { ...size, "flex-shrink": "0" }
    : {
        position: "absolute",
        left: `${Math.round(box.x - node.rect.x - node.borderLeft + node.scrollLeft)}px`,
        top: `${Math.round(box.y - node.rect.y - node.borderTop + node.scrollTop)}px`,
        ...size,
      };
  const label =
    !inOwnFile || node.count > 1
      ? `Adds to ${baseName(fileOf(node.loc))}${node.count > 1 ? ` · used in ${node.count} places` : ""}`
      : undefined;
  return {
    anchor,
    styles,
    ...(!flow && node.position === "static" ? { makeRelative: container } : {}),
    instances: node.count,
    ...(label ? { label } : {}),
  };
}
