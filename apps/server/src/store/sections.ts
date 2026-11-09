import { type Canvas, type CanvasPatch, Refused } from "@finite/protocol";

type SectionPatch = Extract<
  CanvasPatch,
  { op: "setSection" | "removeSection" | "setSlice" | "removeSlice" | "moveSection" }
>;

/** The canvas after a section or slice patch. Refuses (`not-found`, `invalid`) instead of half-applying it. */
export function applySectionPatch(canvas: Canvas, patch: SectionPatch): Canvas {
  switch (patch.op) {
    case "setSection": {
      named(patch.section.name, "section");
      const exists = canvas.sections.some((s) => s.id === patch.section.id);
      return {
        ...canvas,
        sections: exists
          ? canvas.sections.map((s) => (s.id === patch.section.id ? patch.section : s))
          : [...canvas.sections, patch.section],
      };
    }
    case "removeSection": {
      sectionOf(canvas, patch.sectionId);
      return { ...canvas, sections: canvas.sections.filter((s) => s.id !== patch.sectionId) };
    }
    case "moveSection": {
      sectionOf(canvas, patch.sectionId);
      const frames = new Map(patch.frames.map((f) => [f.id, f]));
      const texts = new Map(patch.texts.map((t) => [t.id, t]));
      for (const id of frames.keys()) {
        if (!canvas.frames.some((f) => f.id === id)) {
          throw new Refused(
            `no frame ${id} on canvas ${canvas.name}; it may have been removed`,
            "not-found",
          );
        }
      }
      for (const id of texts.keys()) {
        if (!canvas.texts.some((t) => t.id === id)) {
          throw new Refused(
            `no text ${id} on canvas ${canvas.name}; it may have been removed`,
            "not-found",
          );
        }
      }
      return {
        ...canvas,
        sections: canvas.sections.map((s) =>
          s.id === patch.sectionId ? { ...s, x: patch.x, y: patch.y } : s,
        ),
        frames: canvas.frames.map((f) => {
          const to = frames.get(f.id);
          return to ? { ...f, x: to.x, y: to.y } : f;
        }),
        texts: canvas.texts.map((t) => {
          const to = texts.get(t.id);
          return to ? { ...t, x: to.x, y: to.y } : t;
        }),
      };
    }
    case "setSlice": {
      named(patch.slice.name, "slice");
      if (!canvas.frames.some((f) => f.id === patch.slice.frameId)) {
        throw new Refused(
          `no frame ${patch.slice.frameId} on canvas ${canvas.name}; a slice sits inside a frame`,
          "not-found",
        );
      }
      const exists = canvas.slices.some((s) => s.id === patch.slice.id);
      return {
        ...canvas,
        slices: exists
          ? canvas.slices.map((s) => (s.id === patch.slice.id ? patch.slice : s))
          : [...canvas.slices, patch.slice],
      };
    }
    case "removeSlice": {
      if (!canvas.slices.some((s) => s.id === patch.sliceId)) {
        throw new Refused(`no slice ${patch.sliceId} on canvas ${canvas.name}`, "not-found");
      }
      return { ...canvas, slices: canvas.slices.filter((s) => s.id !== patch.sliceId) };
    }
  }
}

/** The patch that takes `patch` back, given the canvas before it was applied. */
export function inverseSectionPatch(before: Canvas, patch: SectionPatch): CanvasPatch {
  switch (patch.op) {
    case "setSection": {
      const old = before.sections.find((s) => s.id === patch.section.id);
      return old
        ? { op: "setSection", section: old }
        : { op: "removeSection", sectionId: patch.section.id };
    }
    case "removeSection":
      return { op: "setSection", section: sectionOf(before, patch.sectionId) };
    case "moveSection": {
      const old = sectionOf(before, patch.sectionId);
      return {
        op: "moveSection",
        sectionId: old.id,
        x: old.x,
        y: old.y,
        frames: patch.frames.map(({ id }) => {
          const f = before.frames.find((x) => x.id === id)!;
          return { id, x: f.x, y: f.y };
        }),
        texts: patch.texts.map(({ id }) => {
          const t = before.texts.find((x) => x.id === id)!;
          return { id, x: t.x, y: t.y };
        }),
      };
    }
    case "setSlice": {
      const old = before.slices.find((s) => s.id === patch.slice.id);
      return old ? { op: "setSlice", slice: old } : { op: "removeSlice", sliceId: patch.slice.id };
    }
    case "removeSlice":
      return {
        op: "setSlice",
        slice: before.slices.find((s) => s.id === patch.sliceId)!,
      };
  }
}

function sectionOf(canvas: Canvas, id: string) {
  const found = canvas.sections.find((s) => s.id === id);
  if (!found) throw new Refused(`no section ${id} on canvas ${canvas.name}`, "not-found");
  return found;
}

function named(name: string, what: string): void {
  if (name.trim() === "") throw new Refused(`a ${what} needs a name`, "invalid");
}
