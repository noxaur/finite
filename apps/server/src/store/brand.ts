import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Actor, Canvas, Design, Frame, OpenDesign } from "@finite/protocol";
import { readText, writeAtomic } from "../source/files.ts";

export const BRAND_PAGE = "Brand";
/** The board the Brand page shows: every file in the brand folder, and the design's tokens. */
export const BRAND_BOARD = ".finite/boards/brand/BrandAssets.tsx";
const MARKER = "// Finite writes this file and keeps it up to date. Edit a copy instead.";
const BOARD_WIDTH = 1040;

/**
 * Makes sure the Brand page exists and shows the assets board. The board is (re)written while it
 * still carries Finite's marker, and put on the page when it's first written, as a frame that hugs
 * its content. It finds the files itself with `import.meta.glob`, so a file copied into the brand
 * folder shows up through HMR without touching the page.
 */
export async function ensureBrandBoard(open: OpenDesign, by: Actor): Promise<Canvas> {
  const design = open.design;
  const all = (await open.canvases()).filter((c) => !c.removedAt);
  const page =
    all.find((c) => c.kind === "page" && c.name === BRAND_PAGE) ??
    (await open.createCanvas({ kind: "page", name: BRAND_PAGE }, by));
  const file = path.join(design.root, BRAND_BOARD);
  const existing = await readText(file);
  const code = brandBoard(design);
  if (existing === undefined || (existing.startsWith(MARKER) && existing !== code)) {
    await writeAtomic(file, code);
  }
  const shown = page.frames.some((f) => f.source.kind === "file" && f.source.file === BRAND_BOARD);
  if (existing !== undefined || shown) return page;
  const frame: Frame = {
    id: randomUUID(),
    name: "Brand assets",
    x: 0,
    y: 0,
    width: BOARD_WIDTH,
    height: 640,
    hug: true,
    source: { kind: "file", file: BRAND_BOARD },
  };
  await open.patchCanvas(page.id, { op: "addFrames", frames: [frame] }, by);
  return page;
}

/** The board's TSX. Globs are written relative to the board, so they work whatever Vite's root is. */
export function brandBoard(design: Pick<Design, "brandDir" | "css">): string {
  const fromBoard = (file: string) =>
    path.posix.relative(path.posix.dirname(BRAND_BOARD), path.posix.normalize(file));
  const brand = `${fromBoard(design.brandDir.replace(/\/+$/, ""))}/**/*`;
  const sheets = design.css.map(fromBoard);
  return `${MARKER}
// Shows every file in ${design.brandDir}/ and the colors and fonts in the design's CSS.
import type { CSSProperties, ReactNode } from "react";

const files = import.meta.glob(${JSON.stringify(brand)}, {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const sheets = import.meta.glob(${JSON.stringify(sheets.length ? sheets : ["./none.css"])}, {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const IMAGE = /\\.(svg|png|jpe?g|webp|gif|avif|ico)$/i;
const FONT = /\\.(woff2?|ttf|otf)$/i;

type Asset = { name: string; url: string };
const assets: Asset[] = Object.entries(files)
  .map(([file, url]) => ({ name: file.split("/").pop() ?? file, url }))
  .filter((a) => !a.name.startsWith("."))
  .sort((a, b) => a.name.localeCompare(b.name));
const images = assets.filter((a) => IMAGE.test(a.name));
const fonts = assets.filter((a) => FONT.test(a.name));
const others = assets.filter((a) => !IMAGE.test(a.name) && !FONT.test(a.name));

/** Custom properties declared in the design's stylesheets, first value wins. */
function tokens(): { name: string; value: string }[] {
  const out = new Map<string, string>();
  for (const css of Object.values(sheets)) {
    const plain = css.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    for (const m of plain.matchAll(/(--[\\w-]+)\\s*:\\s*([^;{}]+)/g)) {
      const value = m[2]!.trim();
      if (!out.has(m[1]!) && value !== "initial") out.set(m[1]!, value);
    }
  }
  return [...out].map(([name, value]) => ({ name, value }));
}
const all = tokens();
const isColor = (t: { name: string; value: string }) =>
  t.name.startsWith("--color") ||
  (typeof CSS !== "undefined" && !t.value.includes("var(") && CSS.supports("color", t.value));
const colors = all.filter(isColor);
const typefaces = all.filter((t) => t.name.startsWith("--font") && !t.name.includes("weight"));

const ink = "#15191c";
const muted = "#5d6872";
const rule = "#d3d9de";
const tile = "#eceff1";
const s = {
  board: {
    width: ${BOARD_WIDTH},
    boxSizing: "border-box",
    padding: 40,
    background: "#f7f9fa",
    color: ink,
    fontFamily: '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif',
    fontSize: 13,
    lineHeight: 1.4,
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    borderBottom: \`2px solid \${ink}\`,
    paddingBottom: 12,
    marginBottom: 32,
  },
  title: { margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em" },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, color: muted },
  section: { marginBottom: 36 },
  label: {
    display: "flex",
    justifyContent: "space-between",
    margin: "0 0 12px",
    paddingBottom: 6,
    borderBottom: \`1px solid \${rule}\`,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 },
  tile: {
    height: 150,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
    background: tile,
  },
  image: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
  name: { marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  swatches: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 16 },
  chip: { height: 56, border: \`1px solid \${rule}\` },
  font: { display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, padding: "12px 0" },
  empty: { padding: 24, border: \`1px dashed \${rule}\`, color: muted },
} satisfies Record<string, CSSProperties>;

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section style={s.section}>
      <h2 style={s.label}>
        <span>{title}</span>
        <span style={{ ...s.mono, fontWeight: 400 }}>{count}</span>
      </h2>
      {children}
    </section>
  );
}

export default function BrandAssets() {
  const faces = fonts.map((f, i) => ({ ...f, family: \`brand-font-\${i}\` }));
  return (
    <div style={s.board}>
      <style>
        {faces.map((f) => \`@font-face { font-family: "\${f.family}"; src: url("\${f.url}"); }\`).join("\\n")}
      </style>
      <header style={s.head}>
        <h1 style={s.title}>Brand</h1>
        <span style={s.mono}>${design.brandDir}/</span>
      </header>
      <Section title="Logos and images" count={images.length}>
        {images.length ? (
          <div style={s.grid}>
            {images.map((a) => (
              <figure key={a.url} style={{ margin: 0 }}>
                <div style={s.tile}>
                  <img src={a.url} alt={a.name} style={s.image} />
                </div>
                <figcaption style={{ ...s.mono, ...s.name }}>{a.name}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p style={s.empty}>No logos or images yet. Add them to ${design.brandDir}/.</p>
        )}
      </Section>
      {faces.length + typefaces.length > 0 && (
        <Section title="Type" count={faces.length + typefaces.length}>
          {[
            ...faces.map((f) => ({ key: f.url, name: f.name, family: \`"\${f.family}"\` })),
            ...typefaces.map((t) => ({ key: t.name, name: t.name, family: \`var(\${t.name}, \${t.value})\` })),
          ].map((f) => (
            <div key={f.key} style={{ ...s.font, borderBottom: \`1px solid \${rule}\` }}>
              <span style={s.mono}>{f.name}</span>
              <div style={{ fontFamily: f.family }}>
                <div style={{ fontSize: 36, lineHeight: 1.1 }}>Aa Bb Cc 0123</div>
                <div style={{ fontSize: 15, color: muted }}>The quick brown fox jumps over the lazy dog</div>
              </div>
            </div>
          ))}
        </Section>
      )}
      {colors.length > 0 && (
        <Section title="Color" count={colors.length}>
          <div style={s.swatches}>
            {colors.map((t) => (
              <div key={t.name}>
                <div style={{ ...s.chip, background: \`var(\${t.name}, \${t.value})\` }} />
                <div style={{ ...s.name, fontSize: 12 }}>{t.name.replace(/^--(color-)?/, "")}</div>
                <div style={{ ...s.mono, ...s.name }}>{t.value}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {others.length > 0 && (
        <Section title="Other files" count={others.length}>
          {others.map((a) => (
            <div key={a.url} style={{ ...s.mono, padding: "4px 0" }}>
              <a href={a.url} style={{ color: ink }}>{a.name}</a>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
`;
}
