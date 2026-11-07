import { describe, expect, it } from "vite-plus/test";
import { editClasses } from "./tailwind.ts";

const theme = {
  "--color-primary": "#95ced7",
  "--color-surface": "var(--surface)",
  "--spacing-card": "312px",
  "--font-display": "Inter Tight, sans-serif",
  "--radius-card": "10px",
  "--shadow-card": "0 1px 2px rgb(0 0 0 / 0.1)",
};

const cases: [string, string, string][] = [
  ["width", "312px", "w-card"],
  ["width", "100%", "w-full"],
  ["width", "13px", "w-3.25"],
  ["width", "13.5px", "w-[13.5px]"],
  ["height", "100vh", "h-screen"],
  ["min-width", "0", "min-w-0"],
  ["max-width", "28rem", "max-w-md"],
  ["max-height", "none", "max-h-none"],
  ["padding", "8px 16px", "p-[8px_16px]"],
  ["padding-top", "1px", "pt-px"],
  ["padding-inline", "10px", "px-2.5"],
  ["margin-left", "auto", "ml-auto"],
  ["margin-bottom", "-8px", "-mb-2"],
  ["gap", "12px", "gap-3"],
  ["row-gap", "6px", "gap-y-1.5"],
  ["top", "0", "top-0"],
  ["inset", "3.3px", "inset-[3.3px]"],
  ["display", "none", "hidden"],
  ["display", "inline-flex", "inline-flex"],
  ["flex-direction", "column", "flex-col"],
  ["flex-wrap", "wrap", "flex-wrap"],
  ["justify-content", "space-between", "justify-between"],
  ["align-items", "flex-start", "items-start"],
  ["align-self", "center", "self-center"],
  ["flex-shrink", "0", "shrink-0"],
  ["position", "absolute", "absolute"],
  ["z-index", "10", "z-10"],
  ["border-width", "1px", "border"],
  ["border-width", "2px", "border-2"],
  ["border-top-width", "0.5px", "border-t-[0.5px]"],
  ["border-color", "#95CED7", "border-primary"],
  ["border-style", "dashed", "border-dashed"],
  ["border-radius", "10px", "rounded-card"],
  ["border-radius", "8px", "rounded-lg"],
  ["border-radius", "9999px", "rounded-full"],
  ["border-top-left-radius", "3px", "rounded-tl-[3px]"],
  ["background-color", "#95ced7", "bg-primary"],
  ["background-color", "var(--color-surface)", "bg-surface"],
  ["background-color", "rgb(1, 2, 3)", "bg-[rgb(1,2,3)]"],
  ["background-color", "transparent", "bg-transparent"],
  ["color", "#fff", "text-white"],
  ["font-size", "14px", "text-sm"],
  ["font-size", "15px", "text-[15px]"],
  ["font-weight", "700", "font-bold"],
  ["font-weight", "450", "font-[450]"],
  ["font-family", "Inter Tight, sans-serif", "font-display"],
  ["font-family", "Georgia, serif", "font-[family-name:Georgia,serif]"],
  ["line-height", "1.5", "leading-normal"],
  ["line-height", "24px", "leading-6"],
  ["line-height", "1", "leading-none"],
  ["letter-spacing", "0.025em", "tracking-wide"],
  ["letter-spacing", "0.3px", "tracking-[0.3px]"],
  ["text-align", "center", "text-center"],
  ["opacity", "0.4", "opacity-40"],
  ["opacity", "0.375", "opacity-[0.375]"],
  ["box-shadow", "0 1px 2px rgb(0 0 0 / 0.1)", "shadow-card"],
  ["box-shadow", "0 0 4px red", "shadow-[0_0_4px_red]"],
  ["box-shadow", "none", "shadow-none"],
  ["overflow", "hidden", "overflow-hidden"],
  ["overflow-y", "auto", "overflow-y-auto"],
];

describe("editClasses", () => {
  it.each(cases)("%s: %s → %s", (prop, value, cls) => {
    expect(editClasses("", { [prop]: value }, theme)).toBe(cls);
  });

  it("replaces conflicting classes, including the project's theme names", () => {
    expect(editClasses("w-card flex p-4", { width: "8px", padding: "2px" }, theme)).toBe(
      "flex w-2 p-0.5",
    );
    expect(editClasses("text-sm text-primary", { color: "#000" }, theme)).toBe(
      "text-sm text-black",
    );
    expect(editClasses("font-bold font-display", { fontFamily: "Georgia" }, theme)).toBe(
      "font-bold font-[family-name:Georgia]",
    );
  });

  it("removes a property's classes for null and accepts camelCase names", () => {
    expect(
      editClasses(
        "flex rounded-lg bg-primary",
        { borderRadius: null, backgroundColor: null },
        theme,
      ),
    ).toBe("flex");
  });

  it("refuses properties it has no class for", () => {
    expect(() => editClasses("", { transform: "rotate(3deg)" }, theme)).toThrow("Ask the agent");
  });
});
