import { Refused } from "@finite/protocol";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * CSS custom properties from the project's `@theme`, e.g. `{ "--color-primary": "#95ced7" }`. A
 * Tailwind v3 theme is flattened into the same names (`tailwind3.ts`), with a few more
 * namespaces (`--width`, `--z-index`, …) for scales v4 replaced with any number.
 */
export type Theme = Record<string, string>;

/** v3 classes come only from the config's scales; v4 adds its defaults and `--spacing` steps. */
export type TailwindVersion = 3 | 4;

/** The parts of Tailwind v4's default theme a hand edit can land on exactly. */
const DEFAULTS: Theme = {
  "--spacing": "0.25rem",
  ...scale("--text", {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
    "5xl": "3rem",
    "6xl": "3.75rem",
    "7xl": "4.5rem",
    "8xl": "6rem",
    "9xl": "8rem",
  }),
  ...scale("--font-weight", {
    thin: "100",
    extralight: "200",
    light: "300",
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
    extrabold: "800",
    black: "900",
  }),
  ...scale("--leading", {
    tight: "1.25",
    snug: "1.375",
    normal: "1.5",
    relaxed: "1.625",
    loose: "2",
  }),
  ...scale("--tracking", {
    tighter: "-0.05em",
    tight: "-0.025em",
    normal: "0em",
    wide: "0.025em",
    wider: "0.05em",
    widest: "0.1em",
  }),
  ...scale("--radius", {
    xs: "0.125rem",
    sm: "0.25rem",
    md: "0.375rem",
    lg: "0.5rem",
    xl: "0.75rem",
    "2xl": "1rem",
    "3xl": "1.5rem",
    "4xl": "2rem",
  }),
  ...scale("--container", {
    "3xs": "16rem",
    "2xs": "18rem",
    xs: "20rem",
    sm: "24rem",
    md: "28rem",
    lg: "32rem",
    xl: "36rem",
    "2xl": "42rem",
    "3xl": "48rem",
    "4xl": "56rem",
    "5xl": "64rem",
    "6xl": "72rem",
    "7xl": "80rem",
  }),
};

function scale(namespace: string, values: Record<string, string>): Theme {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`${namespace}-${k}`, v]));
}

type ToClass = (value: string, theme: Theme, v3: boolean) => string;

/** Turns a CSS value into the closest class: a theme name when one matches exactly, else an arbitrary value. */
const PROPS: Record<string, { toClass: ToClass; sample: string }> = {
  width: size("w", true, "--width"),
  height: size("h", false, "--height"),
  "min-width": size("min-w", true, "--min-width"),
  "max-width": size("max-w", true, "--container"),
  "min-height": size("min-h", false, "--min-height"),
  "max-height": size("max-h", false, "--max-height"),
  padding: spacing("p"),
  "padding-top": spacing("pt"),
  "padding-right": spacing("pr"),
  "padding-bottom": spacing("pb"),
  "padding-left": spacing("pl"),
  "padding-inline": spacing("px"),
  "padding-block": spacing("py"),
  margin: spacing("m", true),
  "margin-top": spacing("mt", true),
  "margin-right": spacing("mr", true),
  "margin-bottom": spacing("mb", true),
  "margin-left": spacing("ml", true),
  "margin-inline": spacing("mx", true),
  "margin-block": spacing("my", true),
  gap: spacing("gap"),
  "row-gap": spacing("gap-y"),
  "column-gap": spacing("gap-x"),
  top: spacing("top", true, "--inset"),
  right: spacing("right", true, "--inset"),
  bottom: spacing("bottom", true, "--inset"),
  left: spacing("left", true, "--inset"),
  inset: spacing("inset", true, "--inset"),
  display: keywords({
    block: "block",
    "inline-block": "inline-block",
    inline: "inline",
    flex: "flex",
    "inline-flex": "inline-flex",
    grid: "grid",
    "inline-grid": "inline-grid",
    contents: "contents",
    "flow-root": "flow-root",
    table: "table",
    none: "hidden",
  }),
  "flex-direction": keywords({
    row: "flex-row",
    "row-reverse": "flex-row-reverse",
    column: "flex-col",
    "column-reverse": "flex-col-reverse",
  }),
  "flex-wrap": keywords({
    wrap: "flex-wrap",
    nowrap: "flex-nowrap",
    "wrap-reverse": "flex-wrap-reverse",
  }),
  "flex-grow": keywords({ "0": "grow-0", "1": "grow" }, "grow"),
  "flex-shrink": keywords({ "0": "shrink-0", "1": "shrink" }, "shrink"),
  "justify-content": keywords({
    "flex-start": "justify-start",
    start: "justify-start",
    "flex-end": "justify-end",
    end: "justify-end",
    center: "justify-center",
    "space-between": "justify-between",
    "space-around": "justify-around",
    "space-evenly": "justify-evenly",
    stretch: "justify-stretch",
    normal: "justify-normal",
  }),
  "align-items": keywords({
    "flex-start": "items-start",
    start: "items-start",
    "flex-end": "items-end",
    end: "items-end",
    center: "items-center",
    baseline: "items-baseline",
    stretch: "items-stretch",
  }),
  "align-content": keywords({
    "flex-start": "content-start",
    start: "content-start",
    "flex-end": "content-end",
    end: "content-end",
    center: "content-center",
    "space-between": "content-between",
    "space-around": "content-around",
    "space-evenly": "content-evenly",
    stretch: "content-stretch",
    normal: "content-normal",
  }),
  "align-self": keywords({
    auto: "self-auto",
    "flex-start": "self-start",
    start: "self-start",
    "flex-end": "self-end",
    end: "self-end",
    center: "self-center",
    baseline: "self-baseline",
    stretch: "self-stretch",
  }),
  position: keywords({
    static: "static",
    relative: "relative",
    absolute: "absolute",
    fixed: "fixed",
    sticky: "sticky",
  }),
  "z-index": {
    sample: "1",
    toClass(v, theme, v3) {
      if (v === "auto") return "z-auto";
      const negative = v.startsWith("-");
      const abs = negative ? v.slice(1) : v;
      // v4 takes any integer; v3 only its zIndex scale.
      const name = v3 ? themeName(theme, "--z-index", abs) : /^\d+$/.test(abs) ? abs : undefined;
      if (name === undefined) return `z-${arbitrary(v)}`;
      return negative ? `-z-${name}` : `z-${name}`;
    },
  },
  "border-width": borderWidth("border"),
  "border-top-width": borderWidth("border-t"),
  "border-right-width": borderWidth("border-r"),
  "border-bottom-width": borderWidth("border-b"),
  "border-left-width": borderWidth("border-l"),
  "border-color": color("border"),
  "border-style": keywords({
    solid: "border-solid",
    dashed: "border-dashed",
    dotted: "border-dotted",
    double: "border-double",
    hidden: "border-hidden",
    none: "border-none",
  }),
  "border-radius": radius("rounded"),
  "border-top-left-radius": radius("rounded-tl"),
  "border-top-right-radius": radius("rounded-tr"),
  "border-bottom-right-radius": radius("rounded-br"),
  "border-bottom-left-radius": radius("rounded-bl"),
  "background-color": color("bg"),
  color: color("text"),
  "font-size": themed("text", "--text", "1px", arbitrary),
  "font-weight": themed("font", "--font-weight", "100", arbitrary),
  "font-family": themed(
    "font",
    "--font",
    "x",
    (v) => `[family-name:${v.replace(/\s*,\s*/g, ",").replace(/\s+/g, "_")}]`,
  ),
  "line-height": {
    sample: "1px",
    toClass(v, theme, v3) {
      if (v === "1") return "leading-none";
      return themed("leading", "--leading", "1px", (x) =>
        v3 ? arbitrary(x) : (spacingStep(x, theme) ?? arbitrary(x)),
      ).toClass(v, theme, v3);
    },
  },
  "letter-spacing": themed("tracking", "--tracking", "1px", arbitrary),
  "text-align": keywords({
    left: "text-left",
    center: "text-center",
    right: "text-right",
    justify: "text-justify",
    start: "text-start",
    end: "text-end",
  }),
  opacity: {
    sample: "0.5",
    toClass(v, theme, v3) {
      const n = v.endsWith("%") ? Number(v.slice(0, -1)) : Number(v) * 100;
      // v4 takes any percent; v3 only its opacity scale.
      const name = v3
        ? themeName(theme, "--opacity", v.endsWith("%") ? String(n / 100) : v)
        : Number.isInteger(n) && n >= 0 && n <= 100
          ? String(n)
          : undefined;
      return name === undefined ? `opacity-${arbitrary(v)}` : `opacity-${name}`;
    },
  },
  "box-shadow": {
    sample: "none",
    toClass: (v, theme, v3) =>
      v === "none"
        ? "shadow-none"
        : themed("shadow", "--shadow", "none", arbitrary).toClass(v, theme, v3),
  },
  overflow: keywords(overflow("overflow")),
  "overflow-x": keywords(overflow("overflow-x")),
  "overflow-y": keywords(overflow("overflow-y")),
};

/**
 * Edits a class list so it sets `styles`: each value becomes a class, and classes it conflicts
 * with go (tailwind-merge). A `null` value removes that property's classes.
 */
export function editClasses(
  classes: string,
  styles: Record<string, string | null>,
  theme: Theme,
  version: TailwindVersion = 4,
): string {
  const merge = merger(theme);
  const all = full(theme, version);
  const v3 = version === 3;
  let out = classes;
  for (const [prop, value] of Object.entries(styles)) {
    const spec = propSpec(prop);
    out =
      value === null
        ? without(merge, out, spec.toClass(spec.sample, all, v3))
        : merge(out, spec.toClass(value.trim(), all, v3));
  }
  return out;
}

/** Drops the classes in `classes` that conflict with what `styles` sets, without adding any. */
export function stripClasses(
  classes: string,
  styles: Record<string, string | null>,
  theme: Theme,
  version: TailwindVersion = 4,
): string {
  const merge = merger(theme);
  const all = full(theme, version);
  let out = classes;
  for (const [prop, value] of Object.entries(styles)) {
    const spec = propSpec(prop);
    out = without(merge, out, spec.toClass(value?.trim() ?? spec.sample, all, version === 3));
  }
  return out;
}

function propSpec(prop: string) {
  const spec = PROPS[kebab(prop)];
  if (!spec)
    throw new Refused(
      `Finite can't write ${prop} as a Tailwind class. Ask the agent to change this.`,
      "unsupported-style",
    );
  return spec;
}

function without(merge: (...c: string[]) => string, classes: string, cls: string): string {
  const had = classes.split(/\s+/).includes(cls);
  const merged = merge(classes, cls).split(" ");
  if (!had) merged.splice(merged.lastIndexOf(cls), 1);
  return merged.filter((c) => c !== "" && (had || c !== cls)).join(" ");
}

const mergers = new Map<string, (...classes: string[]) => string>();

/** tailwind-merge that knows the project's theme names, so `w-card` conflicts with `w-4`. */
function merger(theme: Theme): (...classes: string[]) => string {
  const key = Object.keys(theme).sort().join(",");
  let merge = mergers.get(key);
  if (!merge) {
    const names = (ns: string) =>
      Object.keys(theme)
        .filter(
          (k) =>
            k.startsWith(`${ns}-`) &&
            !k.includes("--", 2) &&
            k !== `${ns}-DEFAULT` &&
            !(ns === "--font" && k.startsWith("--font-weight-")),
        )
        .map((k) => k.slice(ns.length + 1));
    // v3's size scales (`w-card` from `theme.extend.width`) join spacing, which every size
    // group reads.
    const sizes = [
      "--spacing",
      "--width",
      "--height",
      "--min-width",
      "--min-height",
      "--max-height",
      "--inset",
    ];
    merge = extendTailwindMerge({
      extend: {
        classGroups: {
          z: [{ z: names("--z-index") }],
          opacity: [{ opacity: names("--opacity") }],
        },
        theme: {
          color: names("--color"),
          spacing: [...new Set(sizes.flatMap(names))],
          container: names("--container"),
          text: names("--text"),
          font: names("--font"),
          "font-weight": names("--font-weight"),
          leading: names("--leading"),
          tracking: names("--tracking"),
          radius: names("--radius"),
          shadow: names("--shadow"),
        },
      },
    });
    mergers.set(key, merge);
  }
  return merge;
}

export function kebab(prop: string): string {
  return prop.startsWith("--") ? prop : prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function full(theme: Theme, version: TailwindVersion): Theme {
  return version === 3 ? theme : { ...DEFAULTS, ...theme };
}

/** `rounded-lg`, or the bare `rounded` for a v3 `DEFAULT`. */
function named(prefix: string, name: string): string {
  return name === "DEFAULT" ? prefix : `${prefix}-${name}`;
}

function arbitrary(value: string): string {
  return `[${value
    .trim()
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, "_")}]`;
}

/** A length in px, or undefined when it isn't a plain px/rem/0 length. */
function px(value: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === "rem") return n * 16;
  if (m[2] === undefined && n !== 0) return undefined;
  return n;
}

function same(a: string, b: string): boolean {
  const pa = px(a);
  const pb = px(b);
  if (pa !== undefined || pb !== undefined) return pa === pb;
  return normalize(a) === normalize(b);
}

function normalize(value: string): string {
  let v = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",");
  const hex = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(v);
  if (hex)
    v = `#${hex
      .slice(1)
      .filter(Boolean)
      .map((c) => c + c)
      .join("")}`;
  if (/^-?\d*\.?\d+$/.test(v)) v = String(Number(v));
  if (/^-?\d*\.?\d+em$/.test(v)) v = `${Number(v.slice(0, -2))}em`;
  return v;
}

/** The theme name in `namespace` whose value equals `value`, e.g. `primary` for `--color-primary`. */
function themeName(theme: Theme, namespace: string, value: string): string | undefined {
  for (const [key, v] of Object.entries(theme)) {
    if (!key.startsWith(`${namespace}-`)) continue;
    const name = key.slice(namespace.length + 1);
    if (name.includes("--")) continue; // `--text-sm--line-height` and friends
    if (namespace === "--font" && name.startsWith("weight-")) continue;
    if (same(v, value)) return name;
  }
  const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (ref && ref[1]!.startsWith(`${namespace}-`) && ref[1]! in theme)
    return ref[1]!.slice(namespace.length + 1);
  return undefined;
}

/** `n` steps of `--spacing`, when `value` lands on a quarter step. */
function spacingStep(value: string, theme: Theme): string | undefined {
  const n = px(value);
  const step = px(theme["--spacing"] ?? "0.25rem");
  if (n === undefined || !step) return undefined;
  const steps = n / step;
  return Number.isInteger(steps * 4) ? String(steps) : undefined;
}

/**
 * v4 spacing is `--spacing` names, then any quarter step of `--spacing` (`p-13`). v3 has no
 * multiplier: only the scale's names, in `ns` (`--inset` for `top`), with `-` for negatives.
 */
function spacing(
  prefix: string,
  negative = false,
  ns = "--spacing",
  extra: Record<string, string> = {},
) {
  const keys: Record<string, string> = { auto: "auto", "1px": "px", ...extra };
  return {
    sample: "1px",
    toClass(value: string, theme: Theme, v3: boolean): string {
      const v = value.trim();
      if (keys[v]) return `${prefix}-${keys[v]}`;
      if (v3) {
        const name = themeName(theme, ns, v);
        if (name) return `${prefix}-${name}`;
        const abs = negative && v.startsWith("-") ? themeName(theme, ns, v.slice(1)) : undefined;
        return abs && abs !== "0" ? `-${prefix}-${abs}` : `${prefix}-${arbitrary(v)}`;
      }
      const name = themeName(theme, "--spacing", v);
      if (name) return `${prefix}-${name}`;
      const steps = spacingStep(v, theme);
      if (steps !== undefined) {
        if (steps.startsWith("-"))
          return negative ? `-${prefix}-${steps.slice(1)}` : `${prefix}-${arbitrary(v)}`;
        return `${prefix}-${steps}`;
      }
      return `${prefix}-${arbitrary(v)}`;
    },
  };
}

/** v4 sizes are spacing plus keywords; v3 sizes are the property's own scale (`theme.width`). */
function size(prefix: string, horizontal: boolean, ns: string) {
  const base = spacing(prefix, false, "--spacing", {
    "100%": "full",
    "50%": "1/2",
    "25%": "1/4",
    "75%": "3/4",
    [horizontal ? "100vw" : "100vh"]: "screen",
    "100dvh": "dvh",
    "fit-content": "fit",
    "min-content": "min",
    "max-content": "max",
    none: "none",
  });
  return {
    sample: base.sample,
    toClass(value: string, theme: Theme, v3: boolean): string {
      if (v3 || prefix === "max-w") {
        const name = themeName(theme, ns, value);
        if (name) return `${prefix}-${name}`;
        if (v3) return `${prefix}-${arbitrary(value)}`;
      }
      return base.toClass(value, theme, v3);
    },
  };
}

function color(prefix: string) {
  const keys: Record<string, string> = {
    transparent: "transparent",
    currentcolor: "current",
    inherit: "inherit",
    black: "black",
    "#000000": "black",
    white: "white",
    "#ffffff": "white",
  };
  return {
    sample: "#000001",
    toClass(value: string, theme: Theme): string {
      const name = themeName(theme, "--color", value);
      if (name) return `${prefix}-${name}`;
      const key = keys[normalize(value)];
      return key ? `${prefix}-${key}` : `${prefix}-${arbitrary(value)}`;
    },
  };
}

function themed(
  prefix: string,
  namespace: string,
  sample: string,
  fallback: (v: string) => string,
) {
  return {
    sample,
    toClass(value: string, theme: Theme, _v3?: boolean): string {
      const name = themeName(theme, namespace, value);
      return named(prefix, name ?? fallback(value));
    },
  };
}

function radius(prefix: string) {
  return {
    sample: "1px",
    toClass(value: string, theme: Theme): string {
      const n = px(value);
      if (n === 0) return `${prefix}-none`;
      if ((n !== undefined && n >= 9999) || value.trim() === "50%") return `${prefix}-full`;
      return themed(prefix, "--radius", "1px", arbitrary).toClass(value, theme);
    },
  };
}

function borderWidth(prefix: string) {
  return {
    sample: "3px",
    toClass(value: string, theme: Theme, v3: boolean): string {
      if (v3) {
        // v3 only has its borderWidth scale; `DEFAULT` (1px) is the bare `border`.
        const name = themeName(theme, "--border-width", value);
        return name ? named(prefix, name) : `${prefix}-${arbitrary(value)}`;
      }
      const n = px(value);
      if (n === 1) return prefix;
      if (n !== undefined && Number.isInteger(n) && n >= 0) return `${prefix}-${n}`;
      return `${prefix}-${arbitrary(value)}`;
    },
  };
}

function keywords(map: Record<string, string>, arbitraryPrefix?: string) {
  const sample = Object.keys(map)[0]!;
  return {
    sample,
    toClass(value: string): string {
      const cls = map[value.trim()];
      if (cls) return cls;
      if (arbitraryPrefix) return `${arbitraryPrefix}-${arbitrary(value)}`;
      throw new Refused(
        `Tailwind has no class for "${value}" here. Pick one of: ${Object.keys(map).join(", ")}.`,
        "invalid",
      );
    },
  };
}

function overflow(prefix: string): Record<string, string> {
  return Object.fromEntries(
    ["auto", "hidden", "clip", "visible", "scroll"].map((v) => [v, `${prefix}-${v}`]),
  );
}
