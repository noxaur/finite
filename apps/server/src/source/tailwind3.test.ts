import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { editClasses } from "./tailwind.ts";
import { configTheme, tailwind3Config, v3Theme } from "./tailwind3.ts";

const spacing = { 0: "0px", 2: "0.5rem", 4: "1rem", px: "1px", "0.5": "0.125rem", card: "312px" };

/** A slice of a resolved v3 theme (`resolveConfig(config).theme`) with a few extensions. */
const theme = v3Theme({
  colors: {
    white: "#fff",
    brand: { DEFAULT: "#95ced7", dark: "#2f4f55" },
    slate: { 50: "#f8fafc" },
  },
  spacing,
  padding: spacing,
  margin: { ...spacing, auto: "auto" },
  gap: spacing,
  inset: { 0: "0px", 2: "0.5rem", auto: "auto", "1/2": "50%" },
  width: { 4: "1rem", card: "312px", full: "100%", "1/2": "50%", screen: "100vw" },
  maxWidth: { md: "28rem", prose: "65ch", none: "none" },
  fontSize: { sm: ["0.875rem", { lineHeight: "1.25rem" }], base: ["1rem", "1.5rem"] },
  fontFamily: {
    sans: [["Inter", "sans-serif"], { fontFeatureSettings: '"cv11"' }],
    mono: ["Menlo", "monospace"],
  },
  fontWeight: { bold: "700" },
  lineHeight: { none: "1", 6: "1.5rem", normal: "1.5" },
  borderRadius: {
    none: "0px",
    sm: "0.125rem",
    DEFAULT: "0.25rem",
    lg: "0.5rem",
    card: "10px",
    full: "9999px",
  },
  borderWidth: { 0: "0px", 2: "2px", DEFAULT: "1px", heavy: "6px" },
  boxShadow: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1)",
    none: "none",
  },
  zIndex: { 10: "10", modal: "100", auto: "auto" },
  opacity: { 40: "0.4", 50: "0.5" },
});

describe("v3Theme", () => {
  it("flattens nested colors, keeps top-level DEFAULT, and takes sizes and families from arrays", () => {
    expect(theme).toMatchObject({
      "--color-brand": "#95ced7",
      "--color-brand-dark": "#2f4f55",
      "--color-slate-50": "#f8fafc",
      "--radius-DEFAULT": "0.25rem",
      "--text-sm": "0.875rem",
      "--text-base": "1rem",
      "--font-sans": "Inter, sans-serif",
      "--font-mono": "Menlo, monospace",
      "--container-prose": "65ch",
    });
  });
});

const cases: [string, string, string][] = [
  ["background-color", "#95ced7", "bg-brand"],
  ["background-color", "#2f4f55", "bg-brand-dark"],
  ["padding", "312px", "p-card"],
  ["padding", "16px", "p-4"],
  ["padding", "13px", "p-[13px]"],
  ["padding-top", "1px", "pt-px"],
  ["margin-bottom", "-8px", "-mb-2"],
  ["margin-bottom", "-13px", "mb-[-13px]"],
  ["gap", "52px", "gap-[52px]"],
  ["top", "50%", "top-1/2"],
  ["width", "312px", "w-card"],
  ["width", "100%", "w-full"],
  ["width", "8px", "w-[8px]"],
  ["max-width", "28rem", "max-w-md"],
  ["max-width", "20rem", "max-w-[20rem]"],
  ["border-radius", "4px", "rounded"],
  ["border-radius", "2px", "rounded-sm"],
  ["border-radius", "10px", "rounded-card"],
  ["border-radius", "6px", "rounded-[6px]"],
  ["border-top-left-radius", "4px", "rounded-tl"],
  ["box-shadow", "0 1px 3px 0 rgb(0 0 0 / 0.1)", "shadow"],
  ["box-shadow", "0 1px 2px 0 rgb(0 0 0 / 0.05)", "shadow-sm"],
  ["border-width", "1px", "border"],
  ["border-width", "2px", "border-2"],
  ["border-width", "3px", "border-[3px]"],
  ["font-size", "14px", "text-sm"],
  ["font-size", "18px", "text-[18px]"],
  ["font-family", "Inter, sans-serif", "font-sans"],
  ["line-height", "24px", "leading-6"],
  ["line-height", "28px", "leading-[28px]"],
  ["z-index", "100", "z-modal"],
  ["z-index", "-10", "-z-10"],
  ["z-index", "15", "z-[15]"],
  ["opacity", "0.4", "opacity-40"],
  ["opacity", "0.37", "opacity-[0.37]"],
  ["letter-spacing", "0.025em", "tracking-[0.025em]"],
];

describe("editClasses on Tailwind v3", () => {
  it.each(cases)("%s: %s → %s", (prop, value, cls) => {
    expect(editClasses("", { [prop]: value }, theme, 3)).toBe(cls);
  });

  it("resolves conflicts with v3 names, DEFAULT keys and custom scales", () => {
    expect(editClasses("rounded flex", { borderRadius: "8px" }, theme, 3)).toBe("flex rounded-lg");
    expect(editClasses("rounded-lg", { borderRadius: "4px" }, theme, 3)).toBe("rounded");
    expect(editClasses("w-card p-4", { width: "100%" }, theme, 3)).toBe("p-4 w-full");
    expect(editClasses("z-modal shadow", { zIndex: "10", boxShadow: null }, theme, 3)).toBe("z-10");
  });

  it("maps padding, margin and gap against their own scales", () => {
    const own = v3Theme({
      spacing,
      padding: { ...spacing, 4: "3rem" },
      margin: { ...spacing, 4: "2rem" },
      gap: { ...spacing, 4: "5rem" },
    });
    expect(editClasses("", { padding: "16px", gap: "16px" }, own, 3)).toBe("p-[16px] gap-[16px]");
    expect(editClasses("", { padding: "48px", gap: "80px" }, own, 3)).toBe("p-4 gap-4");
    expect(editClasses("", { marginTop: "-32px" }, own, 3)).toBe("-mt-4");
  });

  it("replaces custom border widths, on every side", () => {
    expect(editClasses("border-heavy", { borderWidth: "1px" }, theme, 3)).toBe("border");
    expect(editClasses("border-t-heavy", { borderTopWidth: "2px" }, theme, 3)).toBe("border-t-2");
    expect(editClasses("border-x-heavy", { borderLeftWidth: "1px" }, theme, 3)).toBe(
      "border-x-heavy border-l",
    );
  });

  it("writes a keyword name only when a replaced scale still has it", () => {
    const bare = v3Theme({ colors: { brand: "#95ced7" }, borderRadius: { card: "10px" } });
    expect(editClasses("", { backgroundColor: "#fff" }, bare, 3)).toBe("bg-[#fff]");
    expect(editClasses("", { color: "transparent" }, bare, 3)).toBe("text-[transparent]");
    expect(editClasses("", { borderRadius: "0" }, bare, 3)).toBe("rounded-[0]");
    expect(editClasses("", { borderRadius: "9999px" }, bare, 3)).toBe("rounded-[9999px]");
    expect(editClasses("", { padding: "1px", margin: "auto" }, bare, 3)).toBe("p-[1px] m-[auto]");
    expect(editClasses("", { lineHeight: "1", boxShadow: "none" }, bare, 3)).toBe(
      "leading-[1] shadow-[none]",
    );
    expect(editClasses("", { lineHeight: "1", boxShadow: "none" }, theme, 3)).toBe(
      "leading-none shadow-none",
    );
    expect(editClasses("", { lineHeight: "1", boxShadow: "none" }, {}, 4)).toBe(
      "leading-none shadow-none",
    );
    expect(editClasses("", { backgroundColor: "#fff", borderRadius: "0" }, theme, 3)).toBe(
      "bg-white rounded-none",
    );
  });

  it("keeps v4's defaults out of v3 output", () => {
    // v4 has rounded-sm at 0.25rem, text-sm by default and `--spacing` steps.
    expect(editClasses("", { fontSize: "14px" }, {}, 3)).toBe("text-[14px]");
    expect(editClasses("", { padding: "52px" }, {}, 3)).toBe("p-[52px]");
    expect(editClasses("", { borderRadius: "4px" }, {}, 4)).toBe("rounded-sm");
    expect(editClasses("", { padding: "52px" }, {}, 4)).toBe("p-13");
  });
});

describe("a real v3 config", () => {
  let root: string;
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finite-tailwind3-")));
    fs.writeFileSync(path.join(root, "package.json"), `{ "name": "t", "private": true }\n`);
    await promisify(execFile)(
      "pnpm",
      ["add", "tailwindcss@3.4.19", "--prefer-offline", "--ignore-workspace", "--reporter=silent"],
      { cwd: root, timeout: 180_000 },
    );
    fs.writeFileSync(
      path.join(root, "tailwind.config.ts"),
      `import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.tsx"],
  theme: {
    extend: {
      colors: { brand: { DEFAULT: "#95ced7", ink: "#1d2a2e" } },
      spacing: { card: "312px" },
      borderRadius: { card: "10px" },
    },
  },
} satisfies Config;
`,
    );
  }, 240_000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads the theme in a child and writes v3 classes", async () => {
    const config = await tailwind3Config(root, []);
    expect(config).toBe(path.join(root, "tailwind.config.ts"));
    const resolved = await configTheme(root, config!);
    const edit = (styles: Record<string, string>) => editClasses("", styles, resolved, 3);
    expect(edit({ backgroundColor: "#95ced7" })).toBe("bg-brand");
    expect(edit({ color: "#1d2a2e" })).toBe("text-brand-ink");
    expect(edit({ padding: "312px" })).toBe("p-card");
    expect(edit({ padding: "12px" })).toBe("p-3");
    expect(edit({ padding: "13px" })).toBe("p-[13px]");
    expect(edit({ borderRadius: "10px" })).toBe("rounded-card");
    expect(edit({ borderRadius: "4px" })).toBe("rounded");
    expect(edit({ borderRadius: "2px" })).toBe("rounded-sm");
    expect(edit({ fontSize: "14px" })).toBe("text-sm");
    expect(edit({ backgroundColor: "#f8fafc" })).toBe("bg-slate-50");
    expect(editClasses("rounded-card p-card", { borderRadius: "4px" }, resolved, 3)).toBe(
      "p-card rounded",
    );
  }, 30_000);

  it("finds the config a sheet names with @config before the root one", async () => {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/tailwind.cjs"), `module.exports = { content: [] };\n`);
    const sheets = [
      { file: "src/plain.css", css: "body { margin: 0; }\n" },
      { file: "src/index.css", css: `@config "../config/tailwind.cjs";\n@tailwind base;\n` },
    ];
    expect(await tailwind3Config(root, sheets)).toBe(path.join(root, "config/tailwind.cjs"));
    // A named config that isn't there falls back to the root lookup.
    expect(
      await tailwind3Config(root, [{ file: "src/index.css", css: `@config "./gone.js";\n` }]),
    ).toBe(path.join(root, "tailwind.config.ts"));
  });

  it("ignores what the config prints to stdout", async () => {
    const chatty = path.join(root, "tailwind.config.mjs");
    fs.writeFileSync(
      chatty,
      `console.log("hello {");\nexport default { content: [], theme: { extend: { colors: { brand: "#95ced7" } } } };\n`,
    );
    expect(editClasses("", { color: "#95ced7" }, await configTheme(root, chatty), 3)).toBe(
      "text-brand",
    );
  }, 30_000);

  it("falls back to an empty theme when the config throws", async () => {
    const broken = path.join(root, "tailwind.config.cjs");
    fs.writeFileSync(broken, `throw new Error("nope");\n`);
    expect(await configTheme(root, broken)).toEqual({});
  }, 30_000);
});
