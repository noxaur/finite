"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { EXPLORE_KINDS, type ExploreKind, explorePrompt } from "@/lib/composer";
import { raised } from "@/styles/raised";
import { colors, fonts, motion, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { useSelection, useSelectionRect } from "@/canvas";
import { Icon } from "./Icons";
import { useDismiss } from "./useDismiss";

/** Room the widest step of the column needs, to decide which way it opens. */
const MENU_WIDTH = 240;

type Step = { at: "root" } | { at: "kinds" } | { at: "count"; kind: ExploreKind; custom: string };

/**
 * The ✱ button just outside the selection's top-right corner, and the column of actions it
 * opens: explore directions (a kind, then how many), move to prod (Prototypes only), ask about
 * the selection, and export.
 */
export function StarMenu({
  mode,
  onExplore,
  onMoveToProd,
  onAsk,
  onExport,
}: {
  mode: "design" | "prototypes";
  onExplore: (prompt: string) => void;
  onMoveToProd: (target: string) => void;
  onAsk: () => void;
  onExport: () => void;
}) {
  const rect = useSelectionRect();
  const selection = useSelection();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ at: "root" });
  const [n, setN] = useState("5");
  const root = useRef<HTMLDivElement>(null);
  const key = selection.map((s) => `${s.frameId}:${s.loc}:${s.index}`).join("|");

  // A new selection starts closed.
  useEffect(() => {
    setOpen(false);
    setStep({ at: "root" });
  }, [key]);

  useDismiss({
    enabled: open,
    contains: (t) => !!root.current?.contains(t),
    onClose: () => {
      setOpen(false);
      setStep({ at: "root" });
    },
  });

  if (!rect || selection.length === 0) return null;
  const target =
    selection.length === 1 ? selection[0]!.name || "this element" : `${selection.length} elements`;

  const done = (run: () => void) => {
    setOpen(false);
    setStep({ at: "root" });
    run();
  };
  const explore = (count: number) => {
    if (step.at !== "count" || !(count >= 1)) return;
    const prompt = explorePrompt(step.kind, Math.min(count, 12), target, step.custom);
    done(() => onExplore(prompt));
  };

  // Near the window's right edge the column opens leftward, under the ✱.
  const flip = rect.x + rect.width + MENU_WIDTH > window.innerWidth;
  const left = Math.min(rect.x + rect.width + 6, window.innerWidth - 30);
  const top = Math.max(rect.y, 48);

  const pill = (label: string, run: () => void, opts: { more?: boolean; back?: boolean } = {}) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      onClick={run}
      {...stylex.props(raised.brand, styles.pill)}
    >
      {opts.back && <Icon name="previous" size={12} />}
      {label}
      {opts.more && <Icon name="play" size={8} />}
    </button>
  );

  return (
    <div
      ref={root}
      data-camera-ignore
      style={flip ? { right: window.innerWidth - left - 24, top } : { left, top }}
      {...stylex.props(styles.root, flip && styles.flipped)}
    >
      <button
        type="button"
        aria-label="Actions for the selection"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Explore, ask, export"
        onClick={() => {
          setOpen((o) => !o);
          setStep({ at: "root" });
        }}
        {...stylex.props(raised.brand, styles.star)}
      >
        <Icon name="spark" size={12} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Selection actions"
          {...stylex.props(styles.column, flip && styles.flipped)}
        >
          {step.at === "root" && (
            <>
              {pill("Explore directions", () => setStep({ at: "kinds" }), { more: true })}
              {mode === "prototypes" &&
                pill("Move to prod", () => done(() => onMoveToProd(target)))}
              {pill("Ask about this", () => done(onAsk))}
              {pill("Export", () => done(onExport))}
            </>
          )}
          {step.at === "kinds" && (
            <>
              {pill("Explore directions", () => setStep({ at: "root" }), { back: true })}
              {EXPLORE_KINDS.map(([kind, label]) =>
                kind === "custom" ? (
                  <input
                    key={kind}
                    aria-label="Custom direction"
                    placeholder="Custom…"
                    onKeyDown={(e) => {
                      const value = e.currentTarget.value.trim();
                      if (e.key === "Enter" && value) setStep({ at: "count", kind, custom: value });
                    }}
                    {...stylex.props(styles.field, styles.customField)}
                  />
                ) : (
                  pill(label, () => setStep({ at: "count", kind, custom: "" }))
                ),
              )}
            </>
          )}
          {step.at === "count" && (
            <>
              {pill(
                step.kind === "custom"
                  ? step.custom
                  : (EXPLORE_KINDS.find(([k]) => k === step.kind)?.[1] ?? ""),
                () => setStep({ at: "kinds" }),
                { back: true },
              )}
              <div role="group" aria-label="How many directions" {...stylex.props(styles.counts)}>
                {[1, 2, 3, 4].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => explore(c)}
                    {...stylex.props(raised.brand, styles.count)}
                  >
                    {c}
                  </button>
                ))}
                <input
                  aria-label="Number of directions"
                  inputMode="numeric"
                  value={n}
                  onChange={(e) => setN(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") explore(Number(n));
                  }}
                  {...stylex.props(styles.field, styles.countField)}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const pop = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-3px) scale(0.98)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  root: {
    position: "fixed",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.sm,
    fontFamily: fonts.sans,
  },
  star: {
    display: "grid",
    placeItems: "center",
    width: size.xs,
    height: size.xs,
    padding: 0,
    borderRadius: radii.md,
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.sm,
    animationName: pop,
    animationDuration: motion.fast,
    animationTimingFunction: motion.out,
    transformOrigin: "top left",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    paddingInline: space.md,
    borderRadius: 14,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: "nowrap",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  flipped: { alignItems: "flex-end", transformOrigin: "top right" },
  counts: { display: "flex", alignItems: "center", gap: space.xs },
  count: {
    display: "grid",
    placeItems: "center",
    width: size.sm,
    height: size.sm,
    padding: 0,
    borderRadius: "50%",
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: 600,
    cursor: "var(--cursor-pointer, pointer)",
  },
  field: {
    height: size.sm,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: 14,
    backgroundColor: colors.sunk,
    boxShadow: `${shadows.field}, ${shadows.raised}`,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
    "::placeholder": { color: colors.muted },
  },
  customField: { width: 150 },
  countField: { width: 48, textAlign: "center", paddingInline: space.sm },
});
