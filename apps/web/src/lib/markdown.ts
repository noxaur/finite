/**
 * The small Markdown the agent writes in replies, parsed into a tree React renders as elements,
 * so no reply text ever becomes HTML. Blocks: paragraphs, headings, `-`/`*`/`1.` lists and ```
 * fences. Inline: `code`, **bold**, *italic* or _italic_, and [links](https://…). Anything else
 * stays as typed.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong" | "em"; readonly children: ReadonlyArray<Inline> }
  | { readonly kind: "link"; readonly href: string; readonly children: ReadonlyArray<Inline> }
  | { readonly kind: "br" };

export type Block =
  | { readonly kind: "p"; readonly inline: ReadonlyArray<Inline> }
  | { readonly kind: "heading"; readonly level: number; readonly inline: ReadonlyArray<Inline> }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: ReadonlyArray<ReadonlyArray<Inline>>;
    }
  | { readonly kind: "code"; readonly lang: string; readonly text: string };

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i]!);
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, inline: parseInline(heading[2]!) });
      continue;
    }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      flush();
      const ordered = !BULLET.test(line);
      const items: Inline[][] = [];
      let current = item[1]!;
      // An item runs on over indented lines that aren't items themselves.
      while (++i < lines.length) {
        const next = lines[i]!;
        const more = ordered ? NUMBERED.exec(next) : BULLET.exec(next);
        if (more) {
          items.push(parseInline(current));
          current = more[1]!;
        } else if (/^\s+\S/.test(next) && !FENCE.test(next)) current += `\n${next.trim()}`;
        else break;
      }
      items.push(parseInline(current));
      blocks.push({ kind: "list", ordered, items });
      i--;
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line);
  }
  flush();
  return blocks;
}

/** Only web and mail links are followed; anything else stays text. */
export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

const WORD = /[\p{L}\p{N}]/u;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const push = (node: Inline) => {
    if (text) out.push({ kind: "text", text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") {
      push({ kind: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        push({ kind: "code", text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (source.startsWith("**", i) || source.startsWith("__", i)) {
      const mark = source.slice(i, i + 2);
      const end = source.indexOf(mark, i + 2);
      if (end > i + 2 && source[i + 2] !== " ") {
        push({ kind: "strong", children: parseInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && source[i + 1] !== " " && source[i + 1] !== c) {
      // `_` only opens at a word's start, so snake_case stays as typed.
      const opens = c === "*" || !WORD.test(source[i - 1] ?? "");
      const end = opens ? closing(source, c, i + 1) : -1;
      if (end > i + 1) {
        push({ kind: "em", children: parseInline(source.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(source.slice(i));
      const href = link && safeHref(link[2]!);
      if (link && href) {
        push({ kind: "link", href, children: parseInline(link[1]!) });
        i += link[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  if (text) out.push({ kind: "text", text });
  return out;
}

/** Where a single `*` or `_` emphasis that opened before `from` closes, or -1. */
function closing(source: string, mark: string, from: number): number {
  for (let j = from; j < source.length; j++) {
    if (source[j] === "\n") return -1;
    if (source[j] !== mark || source[j - 1] === " ") continue;
    if (source[j + 1] === mark) {
      j++;
      continue;
    }
    if (mark === "_" && WORD.test(source[j + 1] ?? "")) continue;
    return j;
  }
  return -1;
}
