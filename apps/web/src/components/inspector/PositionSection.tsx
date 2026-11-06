"use client";

import { useState } from "react";
import {
  degreesOf,
  POSITIONS,
  type PositionKind,
  positionKindOf,
  positionStyles,
} from "@/design/editing/position";
import { withRotation } from "@/design/editing/transform";
import { numberOf } from "../DraftField";
import { Block, Choice, Field, LeadIcon, Section, StyleField, Toggle } from "./controls";
import { owns, perTarget, rawOf, readOf, readRotation, type Scope, transformSheet } from "./scope";

/** Each inset, with the turn of the edge icon that shows which side it pins. */
const PINS = [
  ["top", "top", 0],
  ["right", "right", 90],
  ["bottom", "bottom", 180],
  ["left", "left", 270],
] as const;

/**
 * How the element is placed: its type and rotation on one row, then the
 * insets (pins) when it isn't in the flow. Its stacking order (Z) waits
 * behind the header's "+" until it's set.
 */
export function PositionSection({ scope }: { scope: Scope }) {
  const reading = readOf(scope, "position");
  const kind = reading.kind === "mixed" ? null : positionKindOf(rawOf(reading));
  const [opened, setOpened] = useState(false);
  const stacked = opened || owns(scope, "z-index");
  if (scope.targets.every((t) => t.parent === null)) return null;
  // Rotation reads and writes through the same helpers Transform uses, so a
  // rotate() inside an agent's transform shows here too.
  const rotation = readRotation(scope);
  const rotating = perTarget(scope, (t, changes) =>
    withRotation(t.styles, Number(changes.deg), transformSheet(scope, t)),
  );
  return (
    <Section
      title="Position"
      action={
        !stacked && (
          <Toggle icon="plus" title="Add stacking order" onClick={() => setOpened(true)} />
        )
      }
    >
      <Block kind="pair">
        <Choice
          label="Position"
          title="How it's placed: in the flow, or by its insets"
          value={kind}
          options={POSITIONS}
          onPick={(k) =>
            scope.commitEach((t) =>
              positionStyles(k as PositionKind, t.styles, scope.computedOf(t.id)?.position),
            )
          }
        />
        <Field
          scope={rotating}
          label="Rotation"
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
          lead="Rotate"
          scrub={{
            start: typeof rotation === "number" ? rotation : rotation === "mixed" ? null : 0,
            to: (v) => ({ deg: String(Math.round(v)) }),
          }}
          unit="°"
        />
      </Block>
      {kind !== null && kind !== "static" && (
        <Block kind="quad">
          {PINS.map(([prop, edge, turn]) => (
            <StyleField
              key={prop}
              scope={scope}
              prop={prop}
              before={<LeadIcon name="inset" size={12} turn={turn} />}
              title={`Inset from the ${edge} edge of what contains it`}
              small
              center
            />
          ))}
        </Block>
      )}
      {stacked && (
        <Block kind="pair">
          <StyleField
            scope={scope}
            prop="z-index"
            icon="stack"
            title="Stacking order: higher sits in front"
            empty="Auto"
          />
        </Block>
      )}
    </Section>
  );
}
