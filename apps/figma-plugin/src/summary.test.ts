import { expect, it } from "vite-plus/test";
import { builtLine, savedLine } from "./summary.ts";

it("says what was saved and what was skipped", () => {
  const saved = { frames: 2, layers: 41, images: 3, skipped: 1, warnings: [] };
  expect(savedLine(saved as never)).toBe(
    "Saved 2 frames (41 layers, 3 images). Skipped 1 selected layer that isn't a frame.",
  );
  expect(savedLine({ ...saved, frames: 0 } as never)).toBe("Select at least one frame first.");
});

it("says what was built and which fonts were replaced", () => {
  expect(
    builtLine({
      frames: 1,
      layers: 12,
      images: 0,
      fontsReplaced: ["Foo Bold → Inter Bold"],
      warnings: [],
    }),
  ).toBe("Built 1 frame (12 layers). Fonts replaced: Foo Bold → Inter Bold.");
});
