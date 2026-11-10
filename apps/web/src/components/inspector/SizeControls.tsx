"use client";

import { type ReactNode, useState } from "react";
import {
  type Axis,
  SIZE_MODES,
  type SizeContext,
  type SizeMode,
  sizeContextOf,
  sizeModeOf,
  sizeModeStyles,
} from "@/design/editing/sizing";
import type { Target as Node } from "./styleEditor";
import type { MenuItem } from "../Menu";
import {
  Block,
  Choice,
  Popup,
  Row,
  RowBody,
  RowName,
  RowNote,
  StyleField,
  Toggle,
} from "./controls";
import { owns, rawOf, readOf, removal, type Scope } from "./scope";

const LIMITS = [
  ["min-width", "Min W", "Minimum width"],
  ["max-width", "Max W", "Maximum width"],
  ["min-height", "Min H", "Minimum height"],
  ["max-height", "Max H", "Maximum height"],
] as const;

type Overflow = "visible" | "clip" | "scroll";

const OVERFLOW_OF: Readonly<Record<string, Overflow>> = {
  visible: "visible",
  hidden: "clip",
  clip: "clip",
  auto: "scroll",
  scroll: "scroll",
};

const MODE_NAMES: Readonly<Record<SizeMode, string>> = { fixed: "Fixed", hug: "Hug", fill: "Fill" };

/**
 * What sizes the selection beyond its W and H: each axis's mode (Fixed,
 * Hug or Fill), min and max sizes, the aspect lock and scrolling, all
 * picked from the ▾ menu at the end of W and H, and the clip toggle for
 * the section's header. Limits and a locked ratio show as rows once set,
 * so nothing set hides behind a menu.
 */
export function useSizeOptions(scope: Scope): {
  /** The ▾ menu at the end of W or H. */
  menu: (axis: Axis) => ReactNode;
  /** The modes as two fields, for a selection whose W and H have no menu to hold them. */
  modes: ReactNode;
  /** Min and max sizes and the aspect lock, once they're set or asked for. */
  rows: ReactNode;
  /** Clip content, for the header. */
  clip: ReactNode;
} {
  const limited = LIMITS.some(([prop]) => owns(scope, prop));
  const [limits, setLimits] = useState(limited);
  const open = limits || limited;
  // A top-level frame's size is its own, and it has no parent to hug or fill.
  const contexts = scope.targets.map((t) => (t.parent === null ? null : contextOf(scope, t)));
  const sized = contexts.every((c) => c !== null);
  const modeOf = (axis: Axis): SizeMode | null => {
    const all = new Set(scope.targets.map((t, i) => sizeModeOf(axis, t.styles, contexts[i]!)));
    return all.size === 1 ? [...all][0]! : null;
  };
  const pickMode = (axis: Axis, m: SizeMode) =>
    scope.commitEach((t) => {
      const i = scope.targets.indexOf(t);
      const current = parseFloat(scope.computedOf(t.id)?.[axis] ?? "") || 0;
      return sizeModeStyles(axis, m, t.styles, contexts[i]!, current);
    });

  const ratio = readOf(scope, "aspect-ratio");
  const locked = ratio.kind === "value";
  const toggleLock = () =>
    scope.commitEach((t) => {
      const css = scope.computedOf(t.id);
      const w = Math.round(parseFloat(css?.width ?? "") || 0);
      const h = Math.round(parseFloat(css?.height ?? "") || 0);
      if (locked) {
        // Its height came from the ratio, so it keeps the one it has.
        return t.styles.height === undefined && h > 0
          ? { "aspect-ratio": null, height: `${h}px` }
          : { "aspect-ratio": null };
      }
      if (w <= 0 || h <= 0) return {};
      // The ratio sizes the height from the width, so it can't have its own.
      return t.styles.height === undefined
        ? { "aspect-ratio": `${w} / ${h}` }
        : { "aspect-ratio": `${w} / ${h}`, height: null };
    });

  const overflowReading = readOf(scope, "overflow");
  const overflow =
    overflowReading.kind === "mixed" ? null : (OVERFLOW_OF[rawOf(overflowReading) ?? ""] ?? null);
  const scrolls = overflow === "scroll";
  /** Clip content: `overflow: hidden` on or off; content that scrolls turns it off too. */
  const setOverflow = (on: "hidden" | "auto" | null) =>
    scope.commitEach((t) => {
      const changes: Record<string, string | null> = {
        overflow: on ?? removal(overflowReading, "visible"),
      };
      for (const p of ["overflow-x", "overflow-y"]) {
        if (t.styles[p] !== undefined) changes[p] = null;
      }
      return changes;
    });

  const menu = (axis: Axis) => {
    const mode = sized ? modeOf(axis) : null;
    const name = axis === "width" ? "Width" : "Height";
    const items: MenuItem[] = [
      ...(sized
        ? SIZE_MODES.map(([m, label]) => ({
            key: m,
            label,
            checked: mode === m,
            run: () => mode !== m && pickMode(axis, m),
          }))
        : []),
      ...(sized ? [{ key: "sep-modes", label: "", separator: true, run: () => {} }] : []),
      // Limits that are set stay shown, so there's nothing to hide.
      ...(limited
        ? []
        : [
            {
              key: "limits",
              label: "Min and max sizes",
              checked: open,
              run: () => setLimits(!limits),
            },
          ]),
      {
        key: "ratio",
        label: "Lock aspect ratio",
        checked: locked,
        run: ratio.kind === "mixed" ? () => {} : toggleLock,
      },
      {
        key: "scroll",
        label: "Scroll when content overflows",
        checked: scrolls,
        run: () => setOverflow(scrolls ? null : "auto"),
      },
    ];
    return (
      <Popup
        title={mode ? `${name}: ${MODE_NAMES[mode]}. Size options` : `${name} options`}
        icon="chevronDown"
        items={items}
        empty=""
      />
    );
  };

  const modes = sized && (
    <Block kind="pair">
      {(["width", "height"] as const).map((axis) => (
        <ModeChoice key={axis} axis={axis} value={modeOf(axis)} onPick={(m) => pickMode(axis, m)} />
      ))}
    </Block>
  );

  const rows = (
    <>
      {open && (
        <Block kind="pair">
          {LIMITS.map(([prop, letter, title]) => (
            <StyleField
              key={prop}
              scope={scope}
              prop={prop}
              letter={letter}
              title={title}
              empty="—"
              tokens="length"
              bareTokens
            />
          ))}
        </Block>
      )}
      {ratio.kind !== "unset" && ratio.kind !== "computed" && (
        <Row
          action={
            <Toggle
              icon="lock"
              title="Unlock aspect ratio"
              pressed
              disabled={ratio.kind === "mixed"}
              onClick={toggleLock}
            />
          }
        >
          <RowBody title="Aspect ratio: its height follows its width">
            <RowName>Aspect ratio</RowName>
            <RowNote>{ratio.kind === "mixed" ? "Mixed" : (rawOf(ratio) ?? "")}</RowNote>
          </RowBody>
        </Row>
      )}
    </>
  );

  const clip = (
    <Toggle
      icon="clip"
      title={
        scrolls
          ? "Scrolls when content overflows. Press to show it all instead"
          : overflow === "clip"
            ? "Clip content: on"
            : "Clip content"
      }
      pressed={overflow === "clip" || scrolls}
      accent={scrolls}
      onClick={() => setOverflow(overflow === "visible" || overflow === null ? "hidden" : null)}
    />
  );
  return { menu, modes, rows, clip };
}

function contextOf(scope: Scope, t: Node): SizeContext | null {
  const own = scope.computedOf(t.id);
  return own ? sizeContextOf(own, t.parent === null ? null : scope.computedOf(t.parent)) : null;
}

/** A size's mode as its own field, for a selection whose W and H have no menu. */
function ModeChoice({
  axis,
  value,
  onPick,
}: {
  axis: Axis;
  value: SizeMode | null;
  onPick: (mode: SizeMode) => void;
}) {
  return (
    <Choice
      label={axis === "width" ? "Width mode" : "Height mode"}
      lead={axis === "width" ? "W" : "H"}
      value={value}
      options={SIZE_MODES}
      onPick={(m) => onPick(m as SizeMode)}
    />
  );
}
