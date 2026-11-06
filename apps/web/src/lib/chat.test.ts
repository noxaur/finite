import type { ThreadEvent } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { chatRows } from "./chat";
import { parseInline, parseMarkdown } from "./markdown";

const tool = (id: string, status: "running" | "done" | "error", at: number, summary = "") =>
  ({ type: "tool", id, name: "Write", summary, status, at }) as const;

describe("the messages panel's rows", () => {
  it("shows a tool call once, where it started, with its latest status", () => {
    const events: ThreadEvent[] = [
      tool("a", "running", 1, "Home.tsx"),
      tool("b", "running", 2),
      tool("a", "done", 3, "Home.tsx"),
      { type: "text", text: "Done.", at: 4 },
      tool("b", "error", 5, "failed"),
      { type: "result", usage: { inputTokens: 1, outputTokens: 1 }, at: 6 },
    ];
    expect(chatRows(events)).toEqual([
      tool("a", "done", 1, "Home.tsx"),
      tool("b", "error", 2, "failed"),
      { type: "text", text: "Done.", at: 4 },
    ]);
  });
});

describe("the agent's Markdown", () => {
  it("parses bold, italics, inline code and links", () => {
    expect(parseInline("a **b** *c* _d_ `e` [f](https://x.dev)")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "c" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "d" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "e" },
      { kind: "text", text: " " },
      { kind: "link", href: "https://x.dev", children: [{ kind: "text", text: "f" }] },
    ]);
  });

  it("keeps snake_case, lone stars, and code contents as typed", () => {
    expect(parseInline("my_var_name 2 * 3")).toEqual([{ kind: "text", text: "my_var_name 2 * 3" }]);
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });

  it("leaves script and data links as text", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[x](javascript:alert(1))" },
    ]);
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });

  it("splits paragraphs, lists, headings and code fences", () => {
    const md =
      "## Done\n\nI changed:\n- **Home**: hero\n- `Card.tsx`\n\n1. one\n2. two\n\n```tsx\n<b>x</b>\n```";
    expect(parseMarkdown(md)).toEqual([
      { kind: "heading", level: 2, inline: [{ kind: "text", text: "Done" }] },
      { kind: "p", inline: [{ kind: "text", text: "I changed:" }] },
      {
        kind: "list",
        ordered: false,
        items: [
          [
            { kind: "strong", children: [{ kind: "text", text: "Home" }] },
            { kind: "text", text: ": hero" },
          ],
          [{ kind: "code", text: "Card.tsx" }],
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
      { kind: "code", lang: "tsx", text: "<b>x</b>" },
    ]);
  });
});
