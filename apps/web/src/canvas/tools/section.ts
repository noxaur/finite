import type { Section } from "@finite/protocol";
import { localUser } from "../../client/finite";
import { boxBetween, freeName } from "../objects";
import type { ToolDef, ToolHost } from "./host";

/** The size a click makes a section, in canvas units. */
const CLICK_SIZE = { width: 480, height: 320 };

/** Draws a named rectangle that frames inside it move with. */
export const section = {
  id: "section",
  group: "frame",
  label: "Section",
  keys: { key: "s", shift: true },
  icon: "section",
  cursor: "crosshair",
  enabled: true,
  down(host, p) {
    const place = (box: Pick<Section, "x" | "y" | "width" | "height">) => addSection(host, box);
    return {
      click: () =>
        place({
          x: Math.round(p.world.x),
          y: Math.round(p.world.y),
          ...CLICK_SIZE,
        }),
      begin: async () => {
        let box: ReturnType<typeof boxBetween> | null = null;
        return {
          move: (_screen, world) => {
            box = boxBetween(p.world, world);
            host.setGhost({ box });
          },
          end: async (commit) => {
            host.setGhost(null);
            if (commit && box && box.width > 0 && box.height > 0) await place(box);
          },
        };
      },
    };
  },
} as const satisfies ToolDef<"section">;

/** Adds a section named "Section N" and selects it. */
async function addSection(host: ToolHost, box: Pick<Section, "x" | "y" | "width" | "height">) {
  const { id, name } = localUser();
  const made: Section = {
    id: crypto.randomUUID(),
    name: freeName(
      host.sections.map((s) => s.name),
      "Section",
    ),
    ...box,
    author: { kind: "person", id, name },
  };
  await host.patch({ op: "setSection", section: made });
  host.selectObject({ kind: "section", id: made.id });
}
