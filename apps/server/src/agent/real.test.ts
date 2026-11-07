import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Design, Previews, SourceEditor, Store, Turn } from "@finite/protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import { openDesign } from "../store/open.ts";
import { createAgents, startThread } from "./index.ts";

/** Uses the person's Claude subscription: runs only with FINITE_REAL_AGENT=1 and a logged-in `claude`. */
function loggedIn(): boolean {
  try {
    const out = execFileSync("claude", ["auth", "status", "--json"], { encoding: "utf8" });
    return JSON.parse(out).loggedIn === true;
  } catch {
    return false;
  }
}
const enabled = process.env.FINITE_REAL_AGENT === "1" && loggedIn();

describe.skipIf(!enabled)("a real Claude Code session", () => {
  it("writes a board file and places it on the canvas", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "finite-real-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "tiny", private: true, type: "module" }),
    );
    await writeFile(
      path.join(root, "src/App.tsx"),
      "export default function App() {\n  return <h1 className='text-xl'>Tiny</h1>;\n}\n",
    );
    const design: Design = {
      id: "real",
      name: "Tiny",
      root,
      origin: "blank",
      router: "none",
      styling: "tailwind",
      css: [],
      brandDir: "src/assets/brand",
    };
    const open = await openDesign(design);
    const agents = createAgents({
      store: {} as Store,
      previews: { errors: () => [] } as unknown as Previews,
      source: {} as SourceEditor,
    });
    try {
      const person = { kind: "person" as const, id: "u1", name: "Tester" };
      const canvas = await open.createCanvas({ kind: "prototype", name: "Real" }, person);
      const turn: Turn = {
        text:
          `Quick test, don't read any files. 1) With the Write tool, write src/Prod.tsx containing ` +
          `"x" (it may be refused; that's fine). 2) With the Write tool, write ` +
          `.finite/boards/${canvas.id}/Hello.tsx (once, don't retry): a default-exported component returning <h1>Hello</h1>. ` +
          `3) Call place_frames once with canvasId ${canvas.id}, file Hello.tsx, name Hello, title Hello, ` +
          `why Test. Skip screenshots. Reply "done".`,
        attachments: [],
        model: "haiku",
        fast: false,
        by: person,
      };
      const thread = await startThread(open, { canvasId: canvas.id }, turn);
      await agents.send(open, thread.id, turn, "steer");
      await vi.waitFor(
        async () => {
          const meta = (await open.threads()).find((t) => t.id === thread.id)!;
          expect(meta.running).toBe(false);
        },
        { timeout: 220_000, interval: 500 },
      );

      const history = await open.history(thread.id);
      const errors = history.filter((e) => e.type === "error");
      expect(errors).toEqual([]);
      await expect(stat(path.join(root, "src/Prod.tsx"))).rejects.toThrow();
      // The fence let the board file through on the first try (the root may be a symlink).
      const board = `.finite/boards/${canvas.id}/Hello.tsx`;
      const writes = history.filter((e) => e.type === "tool" && e.name === "Write");
      expect(
        writes
          .filter((e) => e.type === "tool" && e.summary === board)
          .map((e) => e.type === "tool" && e.status),
      ).toEqual(["running", "done"]);
      const file = path.join(root, ".finite/boards", canvas.id, "Hello.tsx");
      expect((await stat(file)).isFile()).toBe(true);
      expect(await readFile(file, "utf8")).toContain("Hello");
      const placed = (await open.canvases()).find((c) => c.id === canvas.id)!;
      expect(placed.frames.map((f) => f.source)).toEqual([
        { kind: "file", file: `.finite/boards/${canvas.id}/Hello.tsx` },
      ]);
      expect(placed.texts[0]?.title).toBe("Hello");
      const meta = (await open.threads()).find((t) => t.id === thread.id)!;
      expect(meta.sessionId).toBeTruthy();
      console.log(
        "real agent tools:",
        history
          .filter((e) => e.type === "tool")
          .map((e) => e.type === "tool" && `${e.name}:${e.status}`),
      );
    } finally {
      await agents.close();
      open.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
