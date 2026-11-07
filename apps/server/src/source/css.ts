import postcss, { type Container, type Rule } from "postcss";
import { kebab } from "./tailwind.ts";

/** Sets (or with `null`, removes) declarations in the top-level `.className` rule; adds the rule if missing. */
export function editRule(
  css: string,
  className: string,
  styles: Record<string, string | null>,
): string {
  const root = postcss.parse(css);
  const selector = `.${className}`;
  let rule = root.nodes.find((n): n is Rule => n.type === "rule" && n.selector.trim() === selector);
  if (!rule) {
    if (Object.values(styles).every((v) => v === null)) return css;
    rule = postcss.rule({
      selector,
      raws: { ...BLOCK, before: root.nodes.length > 0 ? "\n\n" : "" },
    });
    root.append(rule);
  }
  setDecls(rule, styles);
  return root.toString();
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
    const like = container.nodes?.find((n) => n.type === "decl");
    const raws = {
      before: like?.raws.before ?? "\n  ",
      between: (like as { raws: { between?: string } } | undefined)?.raws.between ?? ": ",
    };
    container.raws.semicolon = true;
    container.append(postcss.decl({ prop, value, raws }));
  }
}

/** Raws for a new block, so it prints `sel {` … `}` on its own lines. */
export const BLOCK = { between: " ", after: "\n", semicolon: true };
