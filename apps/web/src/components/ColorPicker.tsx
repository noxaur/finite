"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { paintedHex, setAlpha } from "@/design/editing/colors";
import { type Hsv, hexOfHsv, hsvOf, hueHex, parseHex, typedHex } from "@/design/editing/hsv";
import { displayName } from "@/lib/tokens";
import { colors, fonts, motion, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { EyeDropperButton } from "./inspector/controls";
import { popupHost, targetNode } from "./portal";

/**
 * A color the picker sends: `#rrggbb` and its opacity as a percentage.
 * `part` says what moved, so a caller can change only the opacity of a
 * color written another way, like a token, and keep its name.
 */
export interface ColorPick {
  readonly hex: string;
  readonly alpha: number;
  readonly part: "color" | "alpha";
}

/**
 * How the picker edits. Each gesture (a drag, a held arrow key, a value
 * typed) is `preview` as it changes, then one `commit`, so it lands as one
 * undo step; `cancel` takes back the gesture's previews, as Escape does.
 */
export interface ColorEdit {
  preview(pick: ColorPick): void;
  commit(pick: ColorPick): void;
  cancel(): void;
}

/** The area's and sliders' width: the panel's 246px less its 6px padding on each side. */
const WIDTH = 234;
const AREA_HEIGHT = 150;
/** Thumbs are 12px squares; a slider's thumb travels inside its track. */
const THUMB = 12;
const TRAVEL = WIDTH - THUMB;
/** How far the panel sits from its sidebar, and from the window's edges. */
const GAP = 6;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

type Part = "area" | "hue" | "alpha";

/**
 * The color picker: a saturation and brightness area, hue and opacity
 * sliders, hex and opacity fields, the eyedropper, and the design's color
 * tokens when there are any. It opens beside the sidebar that holds
 * `anchor`, level with it; Escape or a press outside closes it, and Escape
 * puts the focus back on `anchor`.
 */
export function ColorPicker({
  anchor,
  title,
  color,
  alpha,
  hasAlpha = true,
  edit,
  tokens,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  /** The color shown, as CSS: its hex is read the way the browser paints it. */
  color: string | undefined;
  /** Its opacity, 0 to 100. */
  alpha: number;
  hasAlpha?: boolean;
  edit: ColorEdit;
  /** The design's color tokens, [name, value], to use one; `current` is the one in use. */
  tokens?: {
    readonly list: ReadonlyArray<readonly [string, string]>;
    readonly current: string | null;
    readonly onPick: (name: string) => void;
  };
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number; origin: string } | null>(null);

  const propHex = paintedHex(color) ?? "#000000";
  const [hsv, setHsvState] = useState<Hsv>(() => hsvOf(propHex) ?? { h: 0, s: 0, v: 0 });
  const [a, setAState] = useState(alpha);
  // The latest values, for handlers that run between renders.
  const now = useRef({ hsv, alpha: a });
  const setHsv = (next: Hsv) => {
    now.current = { ...now.current, hsv: next };
    setHsvState(next);
  };
  const setA = (next: number) => {
    now.current = { ...now.current, alpha: next };
    setAState(next);
  };
  const latest = useRef({ edit, onClose, anchor });
  latest.current = { edit, onClose, anchor };

  /** The gesture under way, with what it started from, so Escape can put it back. */
  const gesture = useRef<{ hsv: Hsv; alpha: number; pick: ColorPick | null } | null>(null);
  const begin = () => {
    gesture.current ??= { ...now.current, pick: null };
  };
  const show = (next: { hsv?: Hsv; alpha?: number }, part: ColorPick["part"]) => {
    begin();
    if (next.hsv) setHsv(next.hsv);
    if (next.alpha !== undefined) setA(next.alpha);
    const pick = { hex: hexOfHsv(now.current.hsv), alpha: now.current.alpha, part };
    const last = gesture.current!.pick;
    if (last && last.hex === pick.hex && last.alpha === pick.alpha) return;
    gesture.current!.pick = pick;
    latest.current.edit.preview(pick);
  };
  const finish = () => {
    const open = gesture.current;
    gesture.current = null;
    if (open?.pick) latest.current.edit.commit(open.pick);
  };
  const cancel = () => {
    const open = gesture.current;
    gesture.current = null;
    if (!open) return;
    setHsv(open.hsv);
    setA(open.alpha);
    if (open.pick) latest.current.edit.cancel();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // The color changed from outside, like an undo: show it, unless it's what this picker sent.
  useEffect(() => {
    if (gesture.current) return;
    if (propHex !== hexOfHsv(now.current.hsv))
      setHsv(hsvOf(propHex, now.current.hsv) ?? now.current.hsv);
    if (alpha !== now.current.alpha) setA(alpha);
  }, [propHex, alpha]);

  // A gesture still open when the picker goes keeps what it showed.
  useEffect(() => () => finishRef.current(), []);

  useLayoutEffect(() => {
    const place = () => {
      const el = panel.current;
      if (!el) return;
      const row = (anchor.parentElement?.closest("div") ?? anchor).getBoundingClientRect();
      const side = anchor.closest("aside")?.getBoundingClientRect() ?? row;
      const { offsetWidth: w, offsetHeight: h } = el;
      // Beside the sidebar, on the side with the canvas.
      const left = side.left + side.width / 2 > window.innerWidth / 2;
      setAt({
        top: Math.max(GAP, Math.min(row.top, window.innerHeight - h - GAP)),
        left: left ? side.left - GAP - w : side.right + GAP,
        origin: left ? "right top" : "left top",
      });
    };
    place();
    const resize = new ResizeObserver(place);
    if (panel.current) resize.observe(panel.current);
    window.addEventListener("resize", place);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  // Focus moves into the picker once it's placed: a hidden element can't take it.
  const placed = at !== null;
  useEffect(() => {
    if (placed) area.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = targetNode(e.target);
      if (!panel.current?.contains(target) && !latest.current.anchor.contains(target)) {
        latest.current.onClose();
      }
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);

  const [typing, setTyping] = useState<{ hex: string | null; alpha: string | null }>({
    hex: null,
    alpha: null,
  });
  const typingRef = useRef(typing);
  typingRef.current = typing;

  // Escape takes back a gesture, then what's typed, then closes, and the focus goes back to the swatch.
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      const typed = typingRef.current.hex !== null || typingRef.current.alpha !== null;
      if (gesture.current || typed) {
        cancelRef.current();
        setTyping({ hex: null, alpha: null });
        return;
      }
      latest.current.onClose();
      latest.current.anchor.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  /** A pointer held on the area or a slider: it follows each frame, and letting go keeps it. */
  const press = (part: Part) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    let frame = 0;
    let at = { x: e.clientX, y: e.clientY };
    const apply = () => {
      frame = 0;
      if (part === "area") {
        const s = clamp01((at.x - rect.left) / rect.width);
        const v = 1 - clamp01((at.y - rect.top) / rect.height);
        show({ hsv: { ...now.current.hsv, s, v } }, "color");
      } else {
        // The thumb's center travels from half a thumb in to half a thumb from the end.
        const t = clamp01((at.x - rect.left - THUMB / 2) / (rect.width - THUMB));
        if (part === "hue") show({ hsv: { ...now.current.hsv, h: t * 360 } }, "color");
        else show({ alpha: Math.round(t * 100) }, "alpha");
      }
    };
    apply();
    const stop = new AbortController();
    const { signal } = stop;
    const end = (keep: boolean) => {
      stop.abort();
      cancelAnimationFrame(frame);
      if (!gesture.current) return;
      if (keep) {
        apply();
        finish();
      } else cancel();
    };
    el.addEventListener(
      "pointermove",
      (m: PointerEvent) => {
        at = { x: m.clientX, y: m.clientY };
        frame ||= requestAnimationFrame(apply);
      },
      { signal },
    );
    el.addEventListener("pointerup", () => end(true), { signal });
    el.addEventListener("pointercancel", () => end(false), { signal });
    el.addEventListener("lostpointercapture", () => end(true), { signal });
  };

  /** Arrow keys step a slider by 1, Shift by 10; a held key is one undo step, kept when it's let go. */
  const keys =
    (part: Part) =>
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const by = e.shiftKey ? 10 : 1;
      const { hsv: c, alpha: al } = now.current;
      const step: Record<string, number> = {
        ArrowRight: by,
        ArrowUp: by,
        ArrowLeft: -by,
        ArrowDown: -by,
        PageUp: 10,
        PageDown: -10,
      };
      if (part === "area") {
        const ds = { ArrowRight: by, ArrowLeft: -by }[e.key];
        const dv = { ArrowUp: by, ArrowDown: -by }[e.key];
        if (ds === undefined && dv === undefined) return;
        e.preventDefault();
        show(
          {
            hsv: {
              ...c,
              s: clamp01(round(c.s * 100 + (ds ?? 0)) / 100),
              v: clamp01(round(c.v * 100 + (dv ?? 0)) / 100),
            },
          },
          "color",
        );
        return;
      }
      const max = part === "hue" ? 360 : 100;
      const value = part === "hue" ? c.h : al;
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? max
            : step[e.key] === undefined
              ? null
              : value + step[e.key]!;
      if (next === null) return;
      e.preventDefault();
      const n = Math.min(max, Math.max(0, Math.round(next)));
      if (part === "hue") show({ hsv: { ...c, h: n } }, "color");
      else show({ alpha: n }, "alpha");
    };
  const release = () => finish();

  const hex = hexOfHsv(hsv);
  const hue = hueHex(hsv.h);

  // Hex and opacity as they're typed: each valid value shows at once, Enter or leaving keeps it.
  /** Shows a typed hex: whole ones as they're typed, and short ones too once `done`. */
  const typeHex = (text: string, done = false) => {
    if (!done) setTyping((t) => ({ ...t, hex: text }));
    const parsed = typedHex(text, done);
    if (!parsed) {
      // Not a hex (yet): the color goes back to what it was, and stays there if it's left that way.
      const open = gesture.current;
      if (done) cancel();
      else if (open) show({ hsv: open.hsv, alpha: open.alpha }, "color");
      return;
    }
    begin();
    // Hex without an alpha keeps the one the color had, whatever a shorter hex typed on the way said.
    const keep = gesture.current!.alpha;
    show(
      {
        hsv: hsvOf(parsed.hex, now.current.hsv) ?? now.current.hsv,
        alpha: parsed.alpha !== null && hasAlpha ? parsed.alpha : keep,
      },
      "color",
    );
  };
  const typeAlpha = (text: string) => {
    setTyping((t) => ({ ...t, alpha: text }));
    const n = parseFloat(text);
    if (Number.isFinite(n)) show({ alpha: Math.min(100, Math.max(0, Math.round(n))) }, "alpha");
  };
  const done = (field: "hex" | "alpha") => {
    const typed = typingRef.current[field];
    if (field === "hex" && typed !== null) typeHex(typed, true);
    typingRef.current = { ...typingRef.current, [field]: null };
    setTyping((t) => ({ ...t, [field]: null }));
    finish();
  };
  const fieldKeys = (field: "hex" | "alpha") => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      done(field);
      e.currentTarget.select();
    } else if (field === "alpha" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const by = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
      typeAlpha(String(Math.min(100, Math.max(0, now.current.alpha + by))));
    }
  };

  const thumbAt = (x: number, y = 0) => ({ transform: `translate(${x}px, ${y}px)` });

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={title}
      data-camera-ignore
      style={
        at
          ? { top: at.top, left: at.left, transformOrigin: at.origin }
          : { top: 0, left: 0, visibility: "hidden" }
      }
      // The canvas's keys, like the arrows that nudge the selection or Delete, stay out of the picker; ⌘Z still undoes.
      onKeyDown={(e) => {
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
      }}
      {...stylex.props(styles.panel)}
    >
      <div
        ref={area}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onPointerDown={press("area")}
        onKeyDown={keys("area")}
        onKeyUp={release}
        onBlur={release}
        {...stylex.props(styles.area)}
        style={{ backgroundColor: hue }}
      >
        <span
          {...stylex.props(styles.thumb)}
          style={thumbAt(hsv.s * WIDTH - THUMB / 2, (1 - hsv.v) * AREA_HEIGHT - THUMB / 2)}
        />
      </div>

      <div {...stylex.props(styles.sliders)}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          aria-valuetext={`${Math.round(hsv.h)}°`}
          onPointerDown={press("hue")}
          onKeyDown={keys("hue")}
          onKeyUp={release}
          onBlur={release}
          {...stylex.props(styles.slider, styles.hue)}
        >
          <span {...stylex.props(styles.thumb)} style={thumbAt((hsv.h / 360) * TRAVEL)} />
        </div>
        {hasAlpha && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Opacity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={a}
            aria-valuetext={`${a}%`}
            onPointerDown={press("alpha")}
            onKeyDown={keys("alpha")}
            onKeyUp={release}
            onBlur={release}
            {...stylex.props(styles.slider)}
            style={{
              background: `linear-gradient(90deg, ${setAlpha(hex, 0)} ${THUMB / 2}px, ${hex} calc(100% - ${THUMB / 2}px)), ${CHECKER}`,
            }}
          >
            <span {...stylex.props(styles.thumb)} style={thumbAt((a / 100) * TRAVEL)} />
          </div>
        )}
      </div>

      <div {...stylex.props(styles.row)}>
        <label {...stylex.props(styles.field, styles.hexField)}>
          <span {...stylex.props(styles.lead)}>#</span>
          <input
            aria-label="Hex"
            spellCheck={false}
            value={typing.hex ?? hex.slice(1)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => typeHex(e.target.value)}
            onBlur={() => done("hex")}
            onKeyDown={fieldKeys("hex")}
            {...stylex.props(styles.input)}
          />
        </label>
        {hasAlpha && (
          <label {...stylex.props(styles.field, styles.alphaField)}>
            <input
              aria-label="Opacity %"
              spellCheck={false}
              value={typing.alpha ?? String(a)}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => typeAlpha(e.target.value)}
              onBlur={() => done("alpha")}
              onKeyDown={fieldKeys("alpha")}
              {...stylex.props(styles.input)}
            />
            <span {...stylex.props(styles.unit)}>%</span>
          </label>
        )}
        <EyeDropperButton
          standalone
          onPick={(picked) => {
            const parsed = parseHex(picked);
            if (!parsed) return;
            show({ hsv: hsvOf(parsed.hex, now.current.hsv) ?? now.current.hsv }, "color");
            finish();
          }}
        />
      </div>

      {tokens && tokens.list.length > 0 && (
        <TokenSwatches tokens={tokens} onPick={(name) => tokens.onPick(name)} />
      )}
    </div>,
    popupHost(anchor),
  );
}

/** The design's color tokens as raised swatches; pressing one uses the token. */
function TokenSwatches({
  tokens,
  onPick,
}: {
  tokens: {
    readonly list: ReadonlyArray<readonly [string, string]>;
    readonly current: string | null;
  };
  onPick: (name: string) => void;
}): ReactNode {
  // The swatch under the pointer or focus names itself; otherwise the token in use does.
  const [pointed, setPointed] = useState<string | null>(null);
  const named = pointed ?? tokens.current;
  return (
    <div role="group" aria-label="Tokens" {...stylex.props(styles.tokens)}>
      <div {...stylex.props(styles.tokensHead)}>
        <span {...stylex.props(styles.label)}>Tokens</span>
        {named && (
          <span {...stylex.props(styles.tokenName, named === tokens.current && styles.tokenNameOn)}>
            {displayName(named)}
          </span>
        )}
      </div>
      <div
        {...stylex.props(styles.grid)}
        onPointerLeave={() => setPointed(null)}
        onBlur={() => setPointed(null)}
      >
        {tokens.list.map(([name, value]) => {
          const on = name === tokens.current;
          return (
            <button
              key={name}
              type="button"
              title={`${displayName(name)}: ${value}`}
              aria-label={`Use ${displayName(name)}`}
              aria-pressed={on}
              onClick={() => onPick(name)}
              onPointerEnter={() => setPointed(name)}
              onFocus={() => setPointed(name)}
              {...stylex.props(styles.swatch, on && styles.swatchOn)}
              style={{ background: `linear-gradient(${value}, ${value}), ${CHECKER}` }}
            />
          );
        })}
      </div>
    </div>
  );
}

const pop = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.97)" },
  to: { opacity: 1, transform: "scale(1)" },
});
const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

/** The checkerboard behind a color's opacity: 6px squares, light in either theme, as transparency always reads. */
const CHECKER = `repeating-conic-gradient(${colors.halo} 0 25%, color-mix(in srgb, ${colors.ink} 13%, ${colors.halo}) 0 50%) 0 0 / 12px 12px`;
/** The hairline round a color, inset, so it reads on the panel in either theme. */
const HAIRLINE = `inset 0 0 0 1px color-mix(in srgb, ${colors.ink} 16%, transparent)`;

const styles = stylex.create({
  panel: {
    position: "fixed",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: 246,
    padding: space.sm,
    // Items are 3px round with 6px padding, so the panel is 9px.
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    // The outline is a shadow, so it takes no room and the corners stay concentric.
    boxShadow: `0 0 0 1px ${colors.border}, ${shadows.raised}`,
    color: colors.text,
    fontFamily: fonts.sans,
    animationName: { default: pop, "@media (prefers-reduced-motion: reduce)": fadeIn },
    animationDuration: motion.fast,
    animationTimingFunction: motion.out,
  },
  area: {
    position: "relative",
    flexShrink: 0,
    width: WIDTH,
    height: AREA_HEIGHT,
    borderRadius: radii.xs,
    // Black over white over the hue: the colors themselves, so the white and black here are the picked ones, not the UI's.
    backgroundImage:
      "linear-gradient(0deg, rgb(0 0 0), rgb(0 0 0 / 0)), linear-gradient(90deg, rgb(255 255 255), rgb(255 255 255 / 0))",
    boxShadow: HAIRLINE,
    cursor: "var(--cursor-crosshair, crosshair)",
    touchAction: "none",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  sliders: { display: "flex", flexDirection: "column", gap: space.sm, paddingBlock: space.xs },
  slider: {
    position: "relative",
    flexShrink: 0,
    width: WIDTH,
    height: THUMB,
    borderRadius: radii.xs,
    boxShadow: HAIRLINE,
    cursor: "var(--cursor-pointer, pointer)",
    touchAction: "none",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
    // The track is 12px; the press reaches 3px past it on each side, so the gap between two is all target.
    "::before": { content: '""', position: "absolute", top: -3, right: 0, bottom: -3, left: 0 },
  },
  hue: {
    // The hues at every 60°, laid along the thumb's travel, half a thumb in from each end.
    backgroundImage:
      "linear-gradient(90deg, #ff0000 calc(6px + (100% - 12px) * 0/6), #ffff00 calc(6px + (100% - 12px) * 1/6), #00ff00 calc(6px + (100% - 12px) * 2/6), #00ffff calc(6px + (100% - 12px) * 3/6), #0000ff calc(6px + (100% - 12px) * 4/6), #ff00ff calc(6px + (100% - 12px) * 5/6), #ff0000 calc(6px + (100% - 12px) * 6/6))",
  },
  thumb: {
    position: "absolute",
    top: 0,
    left: 0,
    width: THUMB,
    height: THUMB,
    // Inside a 3px-round, 12px track with no padding: the same 3px.
    borderRadius: radii.xs,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: colors.halo,
    // Ink on both sides of the halo, so it reads on any color under it.
    boxShadow: `0 0 0 1px color-mix(in srgb, ${colors.ink} 55%, transparent), inset 0 0 0 1px color-mix(in srgb, ${colors.ink} 40%, transparent), 0 1px 3px color-mix(in srgb, ${colors.ink} 30%, transparent)`,
    pointerEvents: "none",
  },
  row: { display: "flex", gap: space.sm, height: size.sm },
  field: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    minWidth: 0,
    height: size.sm,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: {
      default: shadows.field,
      ":hover": `inset 0 0 0 1px ${colors.border}, ${shadows.field}`,
      ":focus-within": `inset 0 0 0 1px ${colors.brand}, ${shadows.field}`,
    },
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    cursor: "text",
  },
  hexField: { flexGrow: 1, flexBasis: 0 },
  alphaField: { flexShrink: 0, width: 63 },
  lead: { flexShrink: 0, color: colors.faint, fontFamily: fonts.mono, fontSize: 12 },
  unit: {
    flexShrink: 0,
    color: colors.faint,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    width: "100%",
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    outline: "none",
  },
  tokens: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    // A rule across the whole panel, edge to edge, between the color and the tokens.
    marginInline: `calc(-1 * ${space.sm})`,
    paddingInline: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  tokensHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.sm,
  },
  label: { flexShrink: 0, color: colors.muted, fontSize: 12, fontWeight: 500, lineHeight: "15px" },
  tokenName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.faint,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: "15px",
  },
  /** The token the color uses. */
  tokenNameOn: { color: colors.brandText },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(10, 18px)",
    gap: space.sm,
    // Three rows show; more scroll. The padding, taken back by the margin, is room for the focus ring.
    maxHeight: 3 * 18 + 2 * 6 + 2 * 3,
    overflowY: "auto",
    scrollbarWidth: "none",
    padding: space.xs,
    margin: `calc(-1 * ${space.xs})`,
  },
  swatch: {
    position: "relative",
    width: 18,
    height: 18,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    boxShadow: {
      default: shadows.control,
      ":hover": shadows.controlHover,
      ":active": shadows.controlPressed,
    },
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  swatchOn: {
    outline: `1px solid ${colors.brand}`,
    outlineOffset: 1,
    boxShadow: { default: shadows.controlPressed, ":hover": shadows.controlPressed },
  },
});
