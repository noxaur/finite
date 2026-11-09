import type * as t from "@babel/types";
import { type Inline, type Loc, type Mark, type OpenDesign, Refused } from "@finite/protocol";
import { mustRead, rev } from "./files.ts";
import { checkStyles, moduleClass, type InsertStep, type Printed, VOID } from "./insert.ts";
import {
  attribute,
  attrText,
  type Element,
  isChild,
  parseTsx,
  siblings,
  tagName,
  walk,
} from "./jsx.ts";

/** Something the runs hold but can't change, as the page shows it. */
export type Keep = { id: number; kind: string; label: string; loc?: Loc | undefined };

/** A printed element; one that existed before names its original position in `orig`. */
export type Kept = Printed & { orig?: string };

/** A wrapper the text inside can change, or a child reprinted whole. */
type Source = Keep & { node: t.Node };
type Read = { content: Inline[]; sources: Map<number, Source> };

const STALE = "The file changed; try again";

/** Tags that only format the text inside, written and read as marks when they have no attributes. */
const FORMAT = new Set(["strong", "b", "em", "i", "u", "s", "del"]);
/** Inline wrappers whose text stays editable; their tag and attributes are reprinted verbatim. */
const WRAPPERS = new Set([
  ...FORMAT,
  "a",
  "abbr",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "font",
  "ins",
  "kbd",
  "mark",
  "q",
  "samp",
  "small",
  "span",
  "sub",
  "sup",
  "time",
  "tspan",
  "var",
]);
/** Children that break a line of text, so the element around them isn't one piece of text. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** The page's own structure: replacing what's inside one takes the page with it. */
const DOCUMENT = new Set(["html", "head", "body"]);
/** Components that render the route inside a layout, the same job `{children}` does. */
const SLOT_TAGS = new Set(["Outlet"]);

/** `{children}` or `{props.children}`: where a layout's page goes. */
function isSlot(node: t.Node): boolean {
  if (node.type === "Identifier") return node.name === "children";
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "props" &&
    node.property.type === "Identifier" &&
    node.property.name === "children"
  );
}

/** JSX's own whitespace: a non-breaking space is text. */
const BLANK = /^[ \t\r\n]*$/;

/** What a label may show before it's cut. */
const LABEL_MAX = 28;

/** The element's children as editable runs, under the rev its positions belong to. */
export async function readInline(
  open: OpenDesign,
  loc: Loc,
): Promise<{ rev: string; identity: string; content: Inline[]; keeps: Keep[] }> {
  const m = /^(.*):(\d+:\d+)$/.exec(loc);
  if (!m) throw new Refused(`${loc} isn't a loc (file:line:col)`, "invalid");
  const file = m[1]!;
  const code = await mustRead(open.design.root, file);
  const element = parseTsx(code, file).elements.get(m[2]!);
  if (!element) throw new Refused(STALE, "stale");
  const { content, sources } = read(element.node, code, file);
  return {
    rev: rev(code),
    identity: identityOf(element, code),
    content,
    keeps: [...sources.values()].map(({ id, kind, label, loc: at }) => ({
      id,
      kind,
      label,
      ...(at ? { loc: at } : {}),
    })),
  };
}

/** What sets an element apart from one that later sits at its line and column; not its children. */
function identityOf(element: Element, code: string): string {
  const opening = (el: t.JSXElement) =>
    code.slice(el.openingElement.start!, el.openingElement.end!);
  if (!isChild(element)) return opening(element.node);
  const around = siblings(element.parent);
  return JSON.stringify([
    element.parent.type === "JSXElement" ? opening(element.parent) : "<>",
    around.indexOf(element.node),
    around.length,
    opening(element.node),
  ]);
}

function read(el: t.JSXElement, code: string, file: string): Read {
  const name = tagName(el.openingElement.name);
  if (VOID.has(name)) throw new Refused(`<${name}> can't hold text`, "invalid");
  if (DOCUMENT.has(name))
    throw new Refused(
      `<${name}> is the page's own structure, so it can't be edited as text. Select an element inside the page, or ask the agent to change this.`,
      "invalid",
    );
  if (attribute(el, "dangerouslySetInnerHTML") || attribute(el, "children"))
    throw new Refused(
      "This element's content comes from code. Ask the agent to change this.",
      "unsupported-style",
    );
  const sources = new Map<number, Source>();
  const content: Inline[] = [];
  const add = (node: t.Node, kind: string, label: string, loc?: Loc) => {
    const id = sources.size;
    sources.set(id, { id, kind, label, node, ...(loc ? { loc } : {}) });
    return id;
  };
  const pushText = (text: string, marks: Mark[]) => {
    if (text === "") return;
    const last = content.at(-1);
    if (last?.t === "text" && sameMarks(last.marks, marks)) last.text += text;
    else content.push({ t: "text", text, marks });
  };
  const atom = (id: number, marks: Mark[]) =>
    content.push({ t: "atom", id, ...(marks.length > 0 ? { marks } : {}) });

  const visit = (children: t.JSXElement["children"], marks: Mark[]): void => {
    for (const child of children) {
      if (child.type === "JSXText") pushText(cleanText(child.value), marks);
      else if (child.type === "JSXExpressionContainer") {
        const value = stringValue(child.expression);
        if (value !== undefined) pushText(value, marks);
        else if (child.expression.type === "JSXEmptyExpression")
          atom(add(child, "comment", "comment"), marks);
        else
          atom(
            add(child, isSlot(child.expression) ? "slot" : "expression", labelOf(code, child)),
            marks,
          );
      } else if (child.type !== "JSXElement") {
        atom(add(child, "expression", labelOf(code, child)), marks);
      } else {
        const tag = tagName(child.openingElement.name);
        const bare = child.openingElement.attributes.length === 0;
        if (tag === "br" && bare) content.push({ t: "br", ...(marks.length > 0 ? { marks } : {}) });
        else if (BLOCK.has(tag)) {
          throw new Refused(
            `This text holds a <${tag}>, so it isn't one piece of text. Select the <${tag}> and edit the text inside it, or ask the agent to change this.`,
            "unsupported-style",
          );
        } else if (WRAPPERS.has(tag) && !showsNothing(child)) {
          const href = linkHref(child);
          if (bare && FORMAT.has(tag))
            visit(child.children, [...marks, { m: tag } as Extract<Mark, { m: "strong" }>]);
          else if (href !== undefined) visit(child.children, [...marks, { m: "a", href }]);
          else {
            const start = child.openingElement.loc!.start;
            const id = add(child, "wrapper", `<${tag}>`, `${file}:${start.line}:${start.column}`);
            visit(child.children, [...marks, { m: "keep", id }]);
          }
        } else if (SLOT_TAGS.has(tag)) {
          atom(add(child, "slot", `<${tag}>`), marks);
        } else {
          const kind = /^[A-Z]/.test(tag) || tag.includes(".") ? "component" : "element";
          atom(add(child, kind, `<${tag}>`), marks);
        }
      }
    }
  };
  visit(el.children, []);
  return { content, sources };
}

/** A wrapper with no visible text to edit: a run in it would be nothing, and it would vanish. */
function showsNothing(el: t.JSXElement): boolean {
  return el.children.every((child) => {
    if (child.type === "JSXText") return BLANK.test(cleanText(child.value));
    if (child.type !== "JSXExpressionContainer") return false;
    const value = stringValue(child.expression);
    return (
      child.expression.type === "JSXEmptyExpression" || (value !== undefined && BLANK.test(value))
    );
  });
}

/** An `<a>` with only a literal `href`: the one link shape the format bar can rewrite. */
function linkHref(el: t.JSXElement): string | undefined {
  const [only, ...rest] = el.openingElement.attributes;
  if (tagName(el.openingElement.name) !== "a" || !only || rest.length > 0) return undefined;
  if (only.type !== "JSXAttribute" || only.name.name !== "href") return undefined;
  return only.value?.type === "StringLiteral" ? only.value.value : undefined;
}

/** What a JSX text child renders: lines trimmed and joined by one space, as the compiler does. */
function cleanText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  const lastSolid = Math.max(
    lines.findLastIndex((line) => /[^ \t]/.test(line)),
    0,
  );
  let out = "";
  lines.forEach((line, i) => {
    let text = line.replace(/\t/g, " ");
    if (i !== 0) text = text.replace(/^ +/, "");
    if (i !== lines.length - 1) text = text.replace(/ +$/, "");
    if (text !== "") out += i === lastSolid ? text : `${text} `;
  });
  return out;
}

function stringValue(node: t.Node): string | undefined {
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
}

function labelOf(code: string, node: t.Node): string {
  const text = code.slice(node.start!, node.end!).replace(/\s+/g, " ");
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

const sameMark = (a: Mark, b: Mark) => JSON.stringify(a) === JSON.stringify(b);

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => sameMark(m, b[i]!));
}

type Step = InsertStep & { where: Map<string, string> };

/**
 * Replaces the element's children with `content`. Ids name what the source already holds, so
 * nothing on the wire can become code: text is escaped, and atoms and wrappers are the file's
 * own text. Returns every element in the new children, in document order.
 */
export function setInline(s: Step, element: Element, content: Inline[]): Kept[] {
  const el = element.node;
  const { content: held, sources } = read(el, s.code, s.file);
  if (JSON.stringify(content) === JSON.stringify(held)) return [];
  const keptIds = new Set(content.flatMap((item) => (item.t === "atom" ? [item.id] : [])));
  for (const source of sources.values()) {
    if (source.kind === "slot" && !keptIds.has(source.id))
      throw new Refused(
        `This edit would remove ${source.label}, where the page's content goes. Keep it in the text, or ask the agent to change this.`,
        "unsupported-style",
      );
  }
  const opening = el.openingElement;
  const close = el.closingElement;
  const inner = close ? s.code.slice(opening.end!, close.start!) : "";
  const blank = inner.trim() === "";
  const lead = blank ? "" : dropped(/^[ \t\r\n]*/.exec(inner)![0]);
  const trail = blank ? "" : dropped(/[ \t\r\n]*$/.exec(inner)![0]);
  const out: Kept[] = [];
  const printing: Printing = {
    s,
    sources,
    out,
    origOf: new Map([...s.where].map(([orig, cur]) => [cur, orig])),
    exposedStart: lead.includes("\n"),
    exposedEnd: trail.includes("\n"),
    classes: new Set(),
    printed: new Set(),
  };
  const whole = wrappersWhole(content);
  const body = render(printing, whole, 0, whole, 0);

  if (!close) {
    if (body === "") return out;
    let start = opening.end! - 2;
    while (/\s/.test(s.code[start - 1]!)) start--;
    s.ms.overwrite(start, opening.end!, `>${body}</${tagName(opening.name)}>`);
    return out;
  }
  const from = opening.end! + lead.length;
  const to = close.start! - trail.length;
  // Removed then added rather than overwritten, so no new element claims an old one's position.
  if (to > from) s.ms.remove(from, to);
  if (body !== "") s.ms.appendLeft(from, body);
  return out;
}

/** Edge whitespace JSX drops because it holds a line break; anything else is in the runs. */
const dropped = (space: string) => (/[\r\n]/.test(space) ? space : "");

/**
 * Moves kept wrappers outermost on the runs of any wrapper whose runs disagree on what's outside
 * it, so formatting that splits those runs nests inside one copy of the wrapper.
 */
function wrappersWhole(content: readonly Inline[]): readonly Inline[] {
  const outside = new Map<number, string>();
  const split = new Set<number>();
  for (const item of content) {
    marksOf(item).forEach((mark, i) => {
      if (mark.m !== "keep") return;
      const around = JSON.stringify(marksOf(item).slice(0, i));
      if ((outside.get(mark.id) ?? around) !== around) split.add(mark.id);
      outside.set(mark.id, around);
    });
  }
  if (split.size === 0) return content;
  return content.map((item) => {
    const marks = marksOf(item);
    if (!marks.some((m) => m.m === "keep" && split.has(m.id))) return item;
    return {
      ...item,
      marks: [...marks.filter((m) => m.m === "keep"), ...marks.filter((m) => m.m !== "keep")],
    } as Inline;
  });
}

type Printing = {
  s: Step;
  sources: Map<number, Source>;
  out: Kept[];
  /** The position map, reversed: where the elements being reprinted came from. */
  origOf: Map<string, string>;
  /** Whether the children start or end on a line of their own, where JSX drops spaces. */
  exposedStart: boolean;
  exposedEnd: boolean;
  classes: Set<string>;
  /** The kept wrappers printed so far: a second copy would repeat their attributes. */
  printed: Set<number>;
};

/** Prints `items`, grouping the neighbours that share each mark into one wrapper. */
function render(
  p: Printing,
  items: readonly Inline[],
  depth: number,
  all: readonly Inline[],
  offset: number,
): string {
  let out = "";
  for (let i = 0; i < items.length;) {
    const mark = marksOf(items[i]!)[depth];
    if (!mark) {
      out += leaf(p, items[i]!, all, offset + i);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < items.length && same(marksOf(items[j]!)[depth], mark)) j += 1;
    const open = wrapperOpen(p, mark);
    out += `${open.text}${render(p, items.slice(i, j), depth + 1, all, offset + i)}${open.close}`;
    i = j;
  }
  return out;
}

const marksOf = (item: Inline): readonly Mark[] => item.marks ?? [];
const same = (a: Mark | undefined, b: Mark) => a !== undefined && sameMark(a, b);

function wrapperOpen(p: Printing, mark: Mark): { text: string; close: string } {
  if (mark.m === "keep") {
    const source = p.sources.get(mark.id);
    if (source?.node.type !== "JSXElement" || source.kind !== "wrapper")
      throw new Refused(`There's no wrapper ${mark.id} in this text`, "invalid");
    if (p.printed.has(mark.id))
      throw new Refused(
        `This edit would repeat ${source.label} and its attributes. Keep other text out of the middle of it, or ask the agent to change this.`,
        "unsupported-style",
      );
    p.printed.add(mark.id);
    const opening = source.node.openingElement;
    keepElement(p, source.node);
    for (const attr of opening.attributes) keepEach(p, attr);
    return {
      text: p.s.code.slice(opening.start!, opening.end!),
      close: p.s.code.slice(source.node.closingElement!.start!, source.node.closingElement!.end!),
    };
  }
  if (mark.m === "a") {
    p.out.push({ key: `#${p.out.length}`, tag: "a", styles: {} });
    return { text: `<a href=${attrText(mark.href)}>`, close: "</a>" };
  }
  if (mark.m === "span") {
    checkStyles(mark.styles);
    const node = { tag: "span", styles: mark.styles };
    const cls =
      Object.keys(mark.styles).length > 0
        ? moduleClass(p.s, node, { classes: p.classes })
        : undefined;
    const key = mark.ref ?? `#${p.out.length}`;
    if (p.out.some((k) => k.key === key))
      throw new Refused(`Two new elements are both called ${key}`, "invalid");
    p.out.push({ key, tag: "span", styles: mark.styles });
    return { text: cls ? `<span className={${cls}}>` : "<span>", close: "</span>" };
  }
  p.out.push({ key: `#${p.out.length}`, tag: mark.m, styles: {} });
  return { text: `<${mark.m}>`, close: `</${mark.m}>` };
}

function keepElement(p: Printing, node: t.JSXElement): void {
  const start = node.openingElement.loc!.start;
  const orig = p.origOf.get(`${start.line}:${start.column}`);
  p.out.push({
    key: `#${p.out.length}`,
    tag: tagName(node.openingElement.name),
    styles: {},
    ...(orig ? { orig } : {}),
  });
}

/** Records the elements inside something reprinted whole, so the map finds each in its new place. */
function keepEach(p: Printing, root: t.Node): void {
  const inside: t.JSXElement[] = [];
  walk(root, (node) => {
    if (node.type === "JSXElement") inside.push(node);
  });
  inside.sort((a, b) => a.start! - b.start!);
  for (const node of inside) keepElement(p, node);
}

function leaf(p: Printing, item: Inline, all: readonly Inline[], index: number): string {
  if (item.t === "br") {
    p.out.push({ key: `#${p.out.length}`, tag: "br", styles: {} });
    return "<br />";
  }
  if (item.t === "atom") {
    const source = p.sources.get(item.id);
    if (!source || source.kind === "wrapper")
      throw new Refused(`There's no kept piece ${item.id} in this text`, "invalid");
    keepEach(p, source.node);
    return p.s.code.slice(source.node.start!, source.node.end!);
  }
  return textOf(item.text, p.exposedStart && index === 0, p.exposedEnd && index === all.length - 1);
}

const NBSP = " ";

/** Text as JSX children: bare when that's safe, else a string expression. */
function textOf(value: string, startExposed: boolean, endExposed: boolean): string {
  if (value === "") return "";
  const dropped = (startExposed && /^\s/.test(value)) || (endExposed && /\s$/.test(value));
  if (dropped || /[{}<>&\n\t\r]/.test(value))
    return `{${JSON.stringify(value).replaceAll(NBSP, "\\u00a0")}}`;
  return value.replaceAll(NBSP, "&nbsp;");
}
