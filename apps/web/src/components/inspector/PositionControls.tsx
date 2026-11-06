"use client";

import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";
import {
  type Constraint,
  type ConstraintAxis,
  constraintOf,
  constraintStyles,
  CONSTRAINTS,
  containersFor,
  degreesOf,
  POSITIONS,
  type PositionKind,
  positionKindOf,
  positionStyles,
  STICKY_EDGES,
  type StickyEdge,
  stickyEdgeOf,
  stickyEdgeStyles,
} from "@/design/editing/position";
import {
  flipsOf,
  flipStyles,
  rotationOf,
  turned,
  withRotation,
  withSheet,
} from "@/design/editing/transform";
import type { Node, UserEdit } from "@/design/schema";
import { IconButton, Strip, StripAction } from "../Button";
import { numberOf } from "../DraftField";
import type { IconName } from "../Icons";
import { Menu } from "../Menu";
import { Block, Choice, Field, LeadIcon, StyleField } from "./controls";
import { perTarget, rawOf, readOf, readRotation, type Scope, transformSheet } from "./scope";

/** What every target agrees on, or `null` when they differ. */
function agreed<T>(all: ReadonlyArray<T>): T | null {
  const set = new Set(all);
  return set.size === 1 ? ([...set][0] as T) : null;
}

/**
 * How the selection is placed, as a button in the Layout header: in the
 * flow, absolute, fixed or sticky. It shows pressed when the element is
 * placed by its insets. An element that goes absolute inside a static
 * parent makes that parent `relative` in the same edit, so its X and Y
 * measure from the parent. A `relative` element reads as in the flow.
 */
export function PositionMenu({ scope }: { scope: Scope }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const reading = readOf(scope, "position");
  const raw = reading.kind === "mixed" ? null : positionKindOf(rawOf(reading));
  const kind = raw === "relative" ? "static" : raw;
  const name =
    POSITIONS.find(([k]) => k === kind)?.[1] ?? (reading.kind === "mixed" ? "Mixed" : "Custom");
  const pick = (next: PositionKind) => {
    const edits: UserEdit[] = scope.editsEach((t) =>
      positionStyles(next, t.styles, scope.computedOf(t.id)?.position),
    );
    const parents = containersFor(next, scope.targets, (id) => scope.computedOf(id)?.position);
    if (parents.length > 0) {
      edits.push({ kind: "setStyles", ids: parents, styles: { position: "relative" } });
    }
    void scope.editor.commit(edits);
  };
  const title = `Position: ${name}`;
  return (
    <>
      <IconButton
        ref={button}
        icon="inset"
        label={title}
        variant="ghost"
        size="small"
        expanded={open}
        // Pressed in while placed by its insets, which its label names, so it isn't a toggle too.
        pressed={kind !== null && kind !== "static"}
        aria-pressed={undefined}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      />
      {open && button.current && (
        <Menu
          title="Position"
          items={POSITIONS.map(([k, label]) => ({
            key: k,
            label,
            checked: kind === k,
            run: () => kind !== k && pick(k),
          }))}
          anchor={button.current}
          trigger={button.current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The kind every target is drawn with, from the browser, or `null` when they differ. */
function drawnKind(scope: Scope): PositionKind | null {
  return agreed(scope.targets.map((t) => positionKindOf(scope.computedOf(t.id)?.position)));
}

/**
 * What pins a placed element: an absolute or fixed one's constraints on
 * each axis, or the edge a sticky one sticks by and how far from it.
 * Nothing for an element in the flow.
 */
export function PlacementRows({ scope }: { scope: Scope }) {
  const kind = drawnKind(scope);
  if (kind === "absolute" || kind === "fixed") return <Constraints scope={scope} />;
  if (kind === "sticky") return <Sticky scope={scope} />;
  return null;
}

const AXIS_NAMES: Readonly<Record<ConstraintAxis, string>> = {
  x: "Horizontal constraint: which edges of its container it keeps its distance from",
  y: "Vertical constraint: which edges of its container it keeps its distance from",
};

function Constraints({ scope }: { scope: Scope }) {
  const boxOf = (t: Node, axis: ConstraintAxis) => {
    const css = scope.computedOf(t.id);
    const n = (p: string) => parseFloat(css?.getPropertyValue(p) ?? "") || 0;
    return axis === "x"
      ? { near: n("left"), far: n("right"), size: n("width") }
      : { near: n("top"), far: n("bottom"), size: n("height") };
  };
  return (
    <Block kind="pair">
      {(["x", "y"] as const).map((axis) => {
        const value = agreed(scope.targets.map((t) => constraintOf(t.styles, axis)));
        return (
          <Choice
            key={axis}
            label={axis === "x" ? "Horizontal constraint" : "Vertical constraint"}
            title={AXIS_NAMES[axis]}
            value={value}
            options={CONSTRAINTS[axis]}
            onPick={(c) =>
              scope.commitEach((t) =>
                constraintStyles(
                  axis,
                  c as Constraint,
                  t.styles,
                  boxOf(t, axis),
                  boxOf(t, axis === "x" ? "y" : "x"),
                ),
              )
            }
          />
        );
      })}
    </Block>
  );
}

const EDGE_TURN: Readonly<Record<StickyEdge, number>> = {
  top: 0,
  right: 90,
  bottom: 180,
  left: 270,
};

function Sticky({ scope }: { scope: Scope }) {
  const edge = agreed(scope.targets.map((t) => stickyEdgeOf(t.styles)));
  return (
    <Block kind="pair">
      <Choice
        label="Sticks to"
        title="The edge of the scrolling container it sticks to"
        value={edge}
        options={STICKY_EDGES}
        onPick={(to) =>
          scope.commitEach((t) =>
            stickyEdgeStyles(stickyEdgeOf(t.styles), to as StickyEdge, t.styles),
          )
        }
      />
      {edge && (
        <StyleField
          scope={scope}
          prop={edge}
          before={<LeadIcon name="inset" size={12} turn={EDGE_TURN[edge]} />}
          title={`Distance from the ${edge} edge it sticks to`}
        />
      )}
    </Block>
  );
}

/**
 * The selection's rotation in degrees, typed, stepped or scrubbed. It reads
 * and writes through the helpers Transform uses, so a rotate() inside an
 * agent's transform shows here too.
 */
export function RotationField({ scope }: { scope: Scope }) {
  const rotation = readRotation(scope);
  const rotating = perTarget(scope, (t, changes) =>
    withRotation(t.styles, Number(changes.deg), transformSheet(scope, t)),
  );
  return (
    <Field
      scope={rotating}
      label="Rotation"
      title="Rotation"
      text={typeof rotation === "number" ? String(rotation) : ""}
      placeholder={rotation === "mixed" ? "Mixed" : "0"}
      custom={
        rotation === null
          ? {
              title: "Rotation about another axis",
              onReset: () => scope.commit({ rotate: null }),
            }
          : undefined
      }
      toChanges={(typed) => {
        if (typed.trim() === "") return { deg: "0" };
        const n = numberOf(typed.replace(/°$/, ""));
        const deg = n && degreesOf(`${n.value}${n.unit || "deg"}`);
        return deg === null || deg === undefined ? null : { deg: String(deg) };
      }}
      lead={<LeadIcon name="angle" />}
      scrub={{
        start: typeof rotation === "number" ? rotation : rotation === "mixed" ? null : 0,
        to: (v) => ({ deg: String(Math.round(v)) }),
      }}
      unit="°"
    />
  );
}

/**
 * Rotate 90° clockwise, flip horizontally and flip vertically, as one strip
 * as wide as a field. They're actions: each looks pressed only while it's
 * held, and a flip that's on shows picked.
 */
export function TurnStrip({ scope }: { scope: Scope }) {
  const sheetOf = (t: Node) => transformSheet(scope, t);
  const flips = scope.targets.map((t) => flipsOf(withSheet(t.styles, sheetOf(t))));
  const flipped = (axis: "x" | "y") => flips.every((f) => f?.[axis]);
  const turnable = readRotation(scope) !== null;
  const turn = () =>
    scope.commitEach((t) => {
      const r = rotationOf(withSheet(t.styles, sheetOf(t)));
      return r === null ? {} : withRotation(t.styles, turned(r, 90), sheetOf(t));
    });
  const flip = (axis: "x" | "y") => scope.commitEach((t) => flipStyles(t.styles, axis, sheetOf(t)));
  const item = (
    icon: IconName,
    title: string,
    onClick: () => void,
    picked = false,
    off = false,
  ) => (
    <StripAction
      icon={icon}
      label={title}
      grow
      picked={picked}
      aria-pressed={picked || undefined}
      aria-disabled={off || undefined}
      onClick={off ? undefined : onClick}
      style={off && styles.off}
    />
  );
  return (
    <Strip role="group" aria-label="Rotate and flip">
      {item("rotate", "Rotate 90° clockwise", turn, false, !turnable)}
      {item("flipH", "Flip horizontally", () => flip("x"), flipped("x"))}
      {item("flipV", "Flip vertically", () => flip("y"), flipped("y"))}
    </Strip>
  );
}

const styles = stylex.create({
  off: { opacity: 0.4, cursor: "default" },
});
