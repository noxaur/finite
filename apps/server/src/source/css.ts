import path from "node:path";
import { Refused } from "@finite/protocol";
import postcss, {
  type AtRule,
  type Container,
  type ChildNode,
  type Root,
  type Rule,
  type Syntax,
} from "postcss";
import * as less from "postcss-less";
import * as scss from "postcss-scss";
import { kebab } from "./tailwind.ts";

const PLAIN: Syntax = { parse: postcss.parse, stringify: postcss.stringify };

/**
 * The PostCSS syntax for a stylesheet, by extension. Parse and print with the same one: the default
 * stringifier drops Sass's `//` comments and Less's mixins. Indented Sass has no round-trip parser.
 */
export function syntaxFor(file: string): Syntax {
  switch (path.posix.extname(file)) {
    case ".scss":
      return scss;
    case ".less":
      return less;
    case ".sass":
      throw new Refused(
        `${file} is indented Sass (.sass), which Finite can't edit without breaking its layout. Ask the agent to change this, or convert the file to .scss.`,
        "unsupported-style",
      );
    default:
      return PLAIN;
  }
}

export function parseCss(file: string, css: string): Root {
  return syntaxFor(file).parse!(css) as Root;
}

export function printCss(file: string, root: Root): string {
  return root.toString(syntaxFor(file));
}

/**
 * Sets (or with `null`, removes) declarations in the top-level `.className` rule; adds the rule if
 * the class appears nowhere in the sheet. A class that appears only inside other selectors
 * (`.list .card`, `&__title`, `.card.on`) is refused: a new top-level rule wouldn't win.
 */
export function editRule(
  file: string,
  css: string,
  className: string,
  styles: Record<string, string | null>,
): string {
  const root = parseCss(file, css);
  const selector = `.${className}`;
  let rule = root.nodes.find((n): n is Rule => n.type === "rule" && n.selector.trim() === selector);
  if (!rule) {
    if (appearsInSelectors(root, className)) {
      throw new Refused(
        `.${className} is only defined inside other selectors in ${file} (like ".list .card" or "&__title"), so a rule added for it wouldn't take effect. Ask the agent to change this.`,
        "unsupported-style",
      );
    }
    if (Object.values(styles).every((v) => v === null)) return css;
    rule = postcss.rule({
      selector,
      raws: { ...BLOCK, before: root.nodes.length > 0 ? "\n\n" : "" },
    });
    root.append(rule);
  }
  setDecls(rule, styles);
  return printCss(file, root);
}

/** Whether `.className` is in any rule's selector once nesting is resolved, other than as a bare `.className`. */
function appearsInSelectors(root: Root, className: string): boolean {
  const token = new RegExp(`\\.${className.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![\\w-])`);
  let found = false;
  root.walkRules((rule) => {
    if (found || (rule as RuleLike).mixin) return;
    const inRule = enclosingRule(rule) !== undefined;
    found = resolved(rule).some((s) => token.test(s) && (inRule || s !== `.${className}`));
  });
  return found;
}

function enclosingRule(rule: Rule): Rule | undefined {
  let up = rule.parent;
  while (up && up.type !== "rule" && up.type !== "root") up = up.parent;
  return up?.type === "rule" ? up : undefined;
}

/** A rule's selectors with the enclosing rules' folded in: `&` replaced, else the parent as an ancestor. */
function resolved(rule: Rule): string[] {
  const outer = enclosingRule(rule);
  const parents = outer && resolved(outer);
  return rule.selectors.flatMap((own) =>
    parents
      ? parents.map((p) => (own.includes("&") ? own.replaceAll("&", p) : `${p} ${own}`).trim())
      : [own.trim()],
  );
}

/** Sets each property on the container's last declaration of it, dropping duplicates. */
export function setDecls(container: Container, styles: Record<string, string | null>): void {
  for (const [name, value] of Object.entries(styles)) {
    const prop = kebab(name);
    const decls = (container.nodes ?? []).filter((n) => n.type === "decl" && n.prop === prop);
    if (value === null) {
      for (const d of decls) d.remove();
      continue;
    }
    const last = decls.pop();
    for (const d of decls) d.remove();
    if (last && last.type === "decl") {
      last.value = value;
      continue;
    }
    const nodes = container.nodes ?? [];
    const like = nodes.findLast((n) => n.type === "decl");
    const raws = {
      before: like?.raws.before ?? "\n  ",
      between: (like as { raws: { between?: string } } | undefined)?.raws.between ?? ": ",
    };
    container.raws.semicolon = true;
    const decl = postcss.decl({ prop, value, raws });
    // After the other declarations and mixin calls, so it wins, but before the nested rules: older
    // Sass warns about a declaration after one (mixed-decls). A mixin call after a nested rule can
    // override it, so then it goes after the last declaration or mixin call.
    let nested: ChildNode | undefined = nodes.find(
      (n) => n.type === "rule" && !(n as RuleLike).mixin,
    );
    if (nested && nodes.slice(nodes.indexOf(nested)).some(isMixinCall)) {
      nodes.findLast((n) => n.type === "decl" || isMixinCall(n))!.after(decl);
      continue;
    }
    while (nested?.prev()?.type === "comment" && nested.prev()!.raws.before?.includes("\n"))
      nested = nested.prev();
    if (nested) nested.before(decl);
    else container.append(decl);
  }
}

type RuleLike = { mixin?: boolean };

/** A Sass `@include` or a Less mixin call such as `.pill(8px);`. */
function isMixinCall(node: ChildNode): boolean {
  return (
    (node.type === "atrule" && (node as AtRule).name === "include") ||
    (node as RuleLike).mixin === true
  );
}

/** Raws for a new block, so it prints `sel {` … `}` on its own lines. */
export const BLOCK = { between: " ", after: "\n", semicolon: true };
