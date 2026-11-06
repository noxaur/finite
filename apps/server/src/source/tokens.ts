import { Refused, type Token, type TokenMode } from "@finite/protocol";
import postcss, {
  type AtRule,
  type Container,
  type Declaration,
  type Node,
  type Root,
  type Rule,
} from "postcss";
import { BLOCK, setDecls } from "./css.ts";

/**
 * Tokens are CSS custom properties. Light values come from `@theme` blocks (and `:root`/`html`,
 * where shadcn-style themes keep them); dark values from `.dark` rules,
 * `@media (prefers-color-scheme: dark)`, and `@variant dark` blocks, the three ways a Tailwind v4
 * stylesheet writes dark mode. New dark tokens go in a `.dark` rule.
 */
export function readTokens(sheets: string[]): Token[] {
  const tokens = new Map<string, Token>();
  for (const css of sheets) {
    postcss.parse(css).walkDecls((decl) => {
      const mode = modeOf(decl);
      if (!mode || !decl.prop.startsWith("--")) return;
      const token = tokens.get(decl.prop) ?? { name: decl.prop };
      token[mode] = decl.value;
      tokens.set(decl.prop, token);
    });
  }
  return [...tokens.values()];
}

/** Light values with `var(--x)` references followed, for matching hand-edited values to theme names. */
export function lightTheme(tokens: Token[]): Record<string, string> {
  const raw = new Map(
    tokens.flatMap((t) => (t.light === undefined ? [] : [[t.name, t.light] as const])),
  );
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
    const next = ref ? raw.get(ref[1]!) : undefined;
    return next === undefined || depth > 8 ? value : resolve(next, depth + 1);
  };
  return Object.fromEntries([...raw].map(([k, v]) => [k, resolve(v)]));
}

export function hasToken(css: string, name: string, mode: TokenMode): boolean {
  return find(postcss.parse(css), name, mode) !== undefined;
}

/** Sets (or with `null`, removes) one token in one mode. */
export function writeToken(
  css: string,
  name: string,
  mode: TokenMode,
  value: string | null,
): string {
  const root = postcss.parse(css);
  const existing = find(root, name, mode);
  if (existing) {
    setDecls(existing.parent as Container, { [name]: value });
    return root.toString();
  }
  if (value === null) return css;
  setDecls(mode === "light" ? themeBlock(root) : darkBlock(root), { [name]: value });
  return root.toString();
}

export function tokenName(name: string): string {
  const n = name.trim();
  if (!/^(--)?[A-Za-z_][\w-]*$/.test(n))
    throw new Refused(`${name} isn't a CSS custom property name`, "invalid");
  return n.startsWith("--") ? n : `--${n}`;
}

function find(root: Root, name: string, mode: TokenMode): Declaration | undefined {
  let found: Declaration | undefined;
  root.walkDecls(name, (decl) => {
    if (modeOf(decl) === mode) found = decl;
  });
  return found;
}

function modeOf(decl: Declaration): TokenMode | undefined {
  let light = false;
  for (
    let node: Node | undefined = decl.parent as Node | undefined;
    node && node.type !== "root";
    node = node.parent as Node | undefined
  ) {
    if (node.type === "rule" && isDarkSelector((node as Rule).selector)) return "dark";
    if (node.type === "atrule") {
      const at = node as AtRule;
      if (at.name === "media" && /prefers-color-scheme:\s*dark/.test(at.params)) return "dark";
      if (at.name === "variant" && at.params.trim() === "dark") return "dark";
      if (at.name === "theme") light = true;
    }
    if (node.type === "rule" && /^(:root|html)$/.test((node as Rule).selector.trim())) light = true;
  }
  return light ? "light" : undefined;
}

function isDarkSelector(selector: string): boolean {
  return selector
    .split(",")
    .some((s) => /^(:root|html)?(\.dark|\[data-theme=["']?dark["']?\])$/.test(s.trim()));
}

/** The first `@theme` block, added after the imports when there's none. */
function themeBlock(root: Root): Container {
  let theme: AtRule | undefined;
  root.walkAtRules("theme", (at) => {
    theme ??= at;
  });
  if (theme) return theme;
  const block = postcss.atRule({
    name: "theme",
    params: "",
    raws: { ...BLOCK, afterName: "", before: "\n\n" },
  });
  const imports = root.nodes.filter((n) => n.type === "atrule" && n.name === "import");
  const last = imports.at(-1);
  if (last) last.after(block);
  else root.prepend(block);
  return block;
}

/** The first dark-mode block, or a new `.dark` rule at the end. */
function darkBlock(root: Root): Container {
  let dark: Container | undefined;
  root.walk((node) => {
    if (dark) return;
    if (node.type === "rule" && isDarkSelector(node.selector)) dark = node;
    else if (node.type === "atrule" && node.name === "variant" && node.params.trim() === "dark")
      dark = node;
    else if (
      node.type === "rule" &&
      /^(:root|html)$/.test(node.selector.trim()) &&
      node.parent?.type === "atrule"
    ) {
      const parent = node.parent as AtRule;
      if (parent.name === "media" && /prefers-color-scheme:\s*dark/.test(parent.params))
        dark = node;
    }
  });
  if (dark) return dark;
  const rule = postcss.rule({ selector: ".dark", raws: { ...BLOCK, before: "\n\n" } });
  root.append(rule);
  return rule;
}
