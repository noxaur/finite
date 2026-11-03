// The one-line results the UI shows, in plain words.

import type { Report } from "./build.ts";
import type { Saved } from "./read.ts";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "Saved 2 frames (41 layers, 3 images)." and what was left out. */
export function savedLine(saved: Saved): string {
  if (saved.frames === 0) return "Select at least one frame first.";
  const parts = [`${plural(saved.layers, "layer")}`];
  if (saved.images > 0) parts.push(plural(saved.images, "image"));
  const lines = [`Saved ${plural(saved.frames, "frame")} (${parts.join(", ")}).`];
  if (saved.skipped > 0)
    lines.push(`Skipped ${plural(saved.skipped, "selected layer")} that isn't a frame.`);
  if (saved.warnings.length > 0)
    lines.push(`${plural(saved.warnings.length, "warning")}: ${saved.warnings[0]}`);
  return lines.join(" ");
}

/** "Built 2 frames (41 layers). Fonts replaced: Foo Bold → Inter Bold." */
export function builtLine(report: Report): string {
  const lines = [`Built ${plural(report.frames, "frame")} (${plural(report.layers, "layer")}).`];
  if (report.fontsReplaced.length > 0) {
    lines.push(`Fonts replaced: ${report.fontsReplaced.join(", ")}.`);
  }
  if (report.warnings.length > 0) {
    lines.push(`${plural(report.warnings.length, "warning")}: ${report.warnings[0]}`);
  }
  return lines.join(" ");
}
