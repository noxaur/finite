"use client";

import * as stylex from "@stylexjs/stylex";
import { distanceBetween, type Distance, type Measurement, SPEC } from "@finite/protocol";
import { type ReactNode, useMemo } from "react";
import type { CanvasEditor, MeasureState } from "@/canvas/editor";
import { colors, fonts, radii, size, space } from "@/styles/tokens.stylex";
import { comparedPair, drawingsOf, useZoomStep } from "./MeasureLayer";

/** Computed values that mean a property was left alone, per `SPEC` prop. */
const INITIAL: Readonly<Record<string, readonly string[]>> = {
  display: ["inline"],
  flexDirection: ["row"],
  flexWrap: ["nowrap"],
  justifyContent: ["normal"],
  alignItems: ["normal"],
  gap: ["normal"],
  gridTemplateColumns: ["none"],
  gridTemplateRows: ["none"],
  position: ["static"],
  overflow: ["visible"],
  minWidth: ["auto", "0px"],
  maxWidth: ["none"],
  boxSizing: ["content-box"],
  zIndex: ["auto"],
  fontWeight: ["400"],
  lineHeight: ["normal"],
  letterSpacing: ["normal"],
  backgroundColor: ["rgba(0, 0, 0, 0)"],
  backgroundImage: ["none"],
  boxShadow: ["none"],
  opacity: ["1"],
};

const num = (n: number) => String(Math.round(n * 100) / 100);

function hexOf(value: string) {
  const parts = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
  if (!parts) return value;
  const hex = parts
    .slice(1, 4)
    .map((c) => Number(c).toString(16).padStart(2, "0"))
    .join("");
  return parts[4] === undefined ? `#${hex}` : `#${hex} ${Math.round(Number(parts[4]) * 100)}%`;
}

function shownValue(value: string, kind: "color" | "font" | undefined) {
  if (kind === "color") return hexOf(value);
  if (kind === "font")
    return value
      .split(",")[0]!
      .trim()
      .replace(/^["']|["']$/g, "");
  return value;
}

/** `SPEC` as this element fills it: rows at their CSS initial value and empty sections are gone. */
export function specRows(m: Measurement) {
  const bordered = Object.values(m.border).some((w) => w > 0);
  return SPEC.map(({ title, rows }) => ({
    title,
    rows: rows.flatMap(({ label, prop, kind }) => {
      const raw = m.style[prop];
      if (!raw || INITIAL[prop]?.includes(raw)) return [];
      // Without a border, the border's color is only the text color again.
      if (prop === "borderTopColor" && !bordered) return [];
      return [{ label, prop, kind, raw, value: shownValue(raw, kind) }];
    }),
  })).filter((section) => section.rows.length > 0);
}

/** The measured gaps as chips: equal ones once, with a count. Touching children have none. */
export function gapChips(gaps: Measurement["gaps"]) {
  const chips = new Map<string, { axis: "x" | "y"; size: number; cause: string; count: number }>();
  for (const { axis, size: gap, cause } of gaps) {
    if (gap < 1) continue;
    const key = `${axis}|${gap}|${cause}`;
    const chip = chips.get(key);
    if (chip) chip.count++;
    else chips.set(key, { axis, size: gap, cause, count: 1 });
  }
  return [...chips.values()];
}

/** How the card reads a distance: a word for the relation, and one number per line. */
export function distanceText({ relation, lines }: Distance) {
  const glyph = { top: "↑", right: "→", bottom: "↓", left: "←" };
  const word = relation === "apart" ? "Distance" : relation === "inside" ? "Inside" : "Overlaps";
  return { word, values: lines.map((l) => `${glyph[l.side]} ${num(l.size)}`) };
}

/**
 * The measure tool's readout, docked under the pill at the top right of the canvas viewport: the
 * pinned element, else the one under the pointer. It stays put, so it never covers what's measured.
 */
export function MeasureCard({ editor, measure }: { editor: CanvasEditor; measure: MeasureState }) {
  const zoom = useZoomStep(editor);
  const hidden = useMemo(
    () => drawingsOf(measure, zoom).reduce((n, d) => n + d.hidden, 0),
    [measure, zoom],
  );
  const shown = measure.pin ?? measure.hover;
  const shell = { "data-canvas-ui": "", "data-camera-ignore": "", "data-measure-card": "" };
  if (!shown) {
    return (
      <aside {...shell} aria-label="Measure" {...stylex.props(styles.card)}>
        <p {...stylex.props(styles.empty)}>Hover an element to measure it.</p>
      </aside>
    );
  }
  const { m } = shown;
  const pair = comparedPair(measure);
  const distance = pair && distanceText(distanceBetween(pair[0].m.box, pair[1].m.box));
  const chips = gapChips(m.gaps);
  return (
    <aside {...shell} aria-label="Measure" {...stylex.props(styles.card)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleRow)}>
          <span title={m.name} {...stylex.props(styles.name)}>
            {m.name}
          </span>
          {m.tag !== m.name && <span {...stylex.props(styles.tag)}>{m.tag}</span>}
          {m.count > 1 && (
            <span {...stylex.props(styles.tag)}>
              {m.index + 1}/{m.count}
            </span>
          )}
          {measure.pin && <span {...stylex.props(styles.pinned)}>Pinned</span>}
        </div>
        <div {...stylex.props(styles.loc)}>{m.loc ?? "Rendered by a library"}</div>
      </header>
      {distance && pair && (
        <Section>
          <div {...stylex.props(styles.distance)}>
            <span>
              {distance.word} <span {...stylex.props(styles.faint)}>to</span>{" "}
              <span>{pair[1].m.name}</span>
            </span>
            <span {...stylex.props(styles.values)}>{distance.values.join("  ")}</span>
          </div>
        </Section>
      )}
      <Section>
        <BoxModel m={m} />
        {hidden > 0 && (
          <p {...stylex.props(styles.hint)}>
            {hidden} more {hidden === 1 ? "label" : "labels"} at higher zoom
          </p>
        )}
      </Section>
      {chips.length > 0 && (
        <Section title="Gaps">
          <div {...stylex.props(styles.chips)}>
            {chips.map((c) => (
              <span key={`${c.axis}${c.size}${c.cause}`} {...stylex.props(styles.chip)}>
                {c.axis === "x" ? "↔" : "↕"} {num(c.size)} {c.cause}
                {c.count > 1 && ` ×${c.count}`}
              </span>
            ))}
          </div>
        </Section>
      )}
      {specRows(m).map(({ title, rows }) => (
        <Section key={title} title={title}>
          {rows.map(({ label, prop, kind, raw, value }) => (
            <div key={prop} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.label)}>{label}</span>
              <span title={raw} {...stylex.props(styles.value)}>
                {kind === "color" && <span {...stylex.props(styles.swatch(raw))} />}
                <span {...stylex.props(styles.ellipsis)}>{value}</span>
              </span>
            </div>
          ))}
        </Section>
      ))}
    </aside>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section {...stylex.props(styles.section)}>
      {title && <h3 {...stylex.props(styles.heading)}>{title}</h3>}
      {children}
    </section>
  );
}

/** The DevTools box model: margin around border around padding around the content's size. */
function BoxModel({ m }: { m: Measurement }) {
  const { box, border: b, padding: p } = m;
  const width = box.width - b.left - b.right - p.left - p.right;
  const height = box.height - b.top - b.bottom - p.top - p.bottom;
  return (
    <div {...stylex.props(styles.boxModel)}>
      <BoxLayer name="margin" edges={m.margin} tone={styles.margin}>
        <BoxLayer name="border" edges={b} tone={styles.border}>
          <BoxLayer name="padding" edges={p} tone={styles.padding}>
            <div {...stylex.props(styles.content)}>
              {num(width)} × {num(height)}
            </div>
          </BoxLayer>
        </BoxLayer>
      </BoxLayer>
    </div>
  );
}

function BoxLayer({
  name,
  edges,
  tone,
  children,
}: {
  name: string;
  edges: Measurement["padding"];
  tone: stylex.StyleXStyles;
  children: ReactNode;
}) {
  const edge = (side: keyof typeof edges, spot: stylex.StyleXStyles) => (
    <span {...stylex.props(styles.edge, spot, edges[side] === 0 && styles.faint)}>
      {num(edges[side])}
    </span>
  );
  return (
    <div {...stylex.props(styles.layer, tone)}>
      <span {...stylex.props(styles.layerName)}>{name}</span>
      {edge("top", styles.top)}
      {edge("left", styles.left)}
      <div {...stylex.props(styles.inner)}>{children}</div>
      {edge("right", styles.right)}
      {edge("bottom", styles.bottom)}
    </div>
  );
}

const styles = stylex.create({
  // Under the pill's row, however wide the pill's note gets.
  card: {
    position: "absolute",
    top: `calc(${size.lg} + ${space.xs})`,
    right: space.sm,
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    width: 270,
    maxWidth: `calc(100% - ${space.md})`,
    maxHeight: `calc(100% - ${size.lg} - ${space.xs} - ${space.sm})`,
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarWidth: "thin",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "15px",
    userSelect: "text",
    cursor: "default",
  },
  empty: {
    margin: 0,
    padding: space.ms,
    color: colors.muted,
  },
  header: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: space.xs,
    padding: space.ms,
  },
  titleRow: {
    display: "flex",
    alignItems: "baseline",
    gap: space.sm,
    minWidth: 0,
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tag: {
    flexShrink: 0,
    maxWidth: "50%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.faint,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  pinned: {
    flexShrink: 0,
    marginLeft: "auto",
    paddingInline: space.xs,
    borderRadius: radii.xs,
    backgroundColor: colors.measure,
    color: colors.halo,
    fontSize: 11,
  },
  loc: {
    color: colors.faint,
    fontFamily: fonts.mono,
    fontSize: 11,
    overflowWrap: "anywhere",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: space.xs,
    padding: space.ms,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  heading: {
    margin: 0,
    marginBottom: space.xs,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 500,
  },
  distance: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: space.sm,
    overflowWrap: "anywhere",
  },
  values: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "pre",
  },
  faint: { color: colors.faint },
  hint: {
    margin: 0,
    marginTop: space.xs,
    color: colors.faint,
    fontSize: 11,
  },
  boxModel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
  },
  layer: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(21px, auto) minmax(0, 1fr) minmax(21px, auto)",
    gridTemplateRows: "15px auto 15px",
    borderWidth: 1,
    borderColor: colors.measure,
  },
  layerName: {
    position: "absolute",
    top: 1,
    left: space.xs,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    lineHeight: "12px",
  },
  margin: {
    borderStyle: "dashed",
    backgroundColor: `color-mix(in srgb, ${colors.measure} 10%, transparent)`,
  },
  border: { borderStyle: "solid" },
  padding: {
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: `color-mix(in srgb, ${colors.measure} 18%, transparent)`,
  },
  edge: { textAlign: "center", whiteSpace: "nowrap", paddingInline: space.xs },
  top: { gridColumn: "2", gridRow: "1" },
  left: { gridColumn: "1", gridRow: "2", alignSelf: "center" },
  right: { gridColumn: "3", gridRow: "2", alignSelf: "center" },
  bottom: { gridColumn: "2", gridRow: "3" },
  inner: { gridColumn: "2", gridRow: "2", minWidth: 0 },
  content: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
    backgroundColor: colors.measure,
    color: colors.halo,
    textAlign: "center",
    overflowWrap: "anywhere",
  },
  chips: { display: "flex", flexWrap: "wrap", gap: space.xs },
  chip: {
    paddingInline: space.sm,
    borderRadius: radii.xs,
    backgroundColor: `color-mix(in srgb, ${colors.measure} 12%, transparent)`,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "81px minmax(0, 1fr)",
    columnGap: space.sm,
  },
  label: { color: colors.muted },
  value: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
  },
  ellipsis: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  swatch: (color: string) => ({
    flexShrink: 0,
    width: 9,
    height: 9,
    borderRadius: radii.xs,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    backgroundColor: color,
  }),
});
