"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { cornerOf, type Ellipse, ellipseOf, ellipseText } from "@/design/editing/appearance";
import { bare, parseInput } from "@/design/editing/inspect";
import { space } from "@/styles/tokens.stylex";
import { numberOf } from "../DraftField";
import { Block, Field, LeadIcon, Row, Section, StyleField, Toggle } from "./controls";
import { type Changes, rawOf, readOf, type Scope } from "./scope";

const CORNERS = [
  ["top-left", "Top left", 0],
  ["top-right", "Top right", 90],
  ["bottom-right", "Bottom right", 180],
  ["bottom-left", "Bottom left", 270],
] as const;

/**
 * The corner radius: one field for every corner, or one per corner. An
 * elliptical radius, like `16px / 8px`, shows each corner's horizontal and
 * vertical radius, and an edit keeps it one `border-radius`.
 */
export function RadiusSection({ scope }: { scope: Scope }) {
  const [each, setEach] = useState(false);
  const whole = readOf(scope, "border-radius");
  const own = whole.kind === "value" ? ellipseOf(whole.raw) : null;
  const corners = CORNERS.map(([corner]) => readOf(scope, `border-${corner}-radius`));
  const pairs = corners.map((r) => (r.kind === "mixed" ? null : cornerOf(rawOf(r) ?? "0")));
  // A corner whose own value has two radii makes the whole radius elliptical.
  const ellipse: Ellipse | null =
    own ??
    (corners.some((r) => r.kind === "value" && cornerOf(r.raw)[0] !== cornerOf(r.raw)[1]) &&
    pairs.every((p) => p !== null)
      ? {
          h: pairs.map((p) => p![0]) as unknown as Ellipse["h"],
          v: pairs.map((p) => p![1]) as unknown as Ellipse["v"],
        }
      : null);
  /** The styles that set corner `i`'s radius on `axis` to `value`. */
  const setCorner = (i: number, axis: "h" | "v", value: string): Changes => {
    const next = { h: [...ellipse!.h], v: [...ellipse!.v] };
    next[axis][i] = value;
    if (own) return { "border-radius": ellipseText(next as unknown as Ellipse) };
    const [h, v] = [next.h[i]!, next.v[i]!];
    return { [`border-${CORNERS[i]![0]}-radius`]: h === v ? h : `${h} ${v}` };
  };
  return (
    <Section title="Radius">
      <Row
        action={
          <Toggle
            icon="corners"
            title="Set each corner"
            pressed={each || ellipse !== null}
            disabled={ellipse !== null}
            onClick={() => setEach(!each)}
          />
        }
      >
        {ellipse ? (
          <Field
            scope={scope}
            label="Corner radius, all corners"
            title="Elliptical corners: typing a radius makes them round"
            text=""
            placeholder="Elliptical"
            toChanges={(typed) => ({ "border-radius": parseInput("border-radius", typed) })}
            lead={<LeadIcon name="radius" />}
          />
        ) : (
          <StyleField
            scope={scope}
            prop="border-radius"
            icon="radius"
            title="Corner radius"
            tokens="length"
          />
        )}
      </Row>
      {ellipse ? (
        <Block kind="pair">
          {CORNERS.map(([corner, name, turn], i) => (
            <div key={corner} title={`${name} radius`} {...stylex.props(styles.corner)}>
              <LeadIcon name="corner" size={12} turn={turn} />
              {(["h", "v"] as const).map((axis) => {
                const value = ellipse[axis][i]!;
                const n = numberOf(value);
                return (
                  <Field
                    key={axis}
                    scope={scope}
                    label={`${name} ${axis === "h" ? "horizontal" : "vertical"} radius`}
                    title={`${name}, ${axis === "h" ? "across" : "down"}`}
                    text={bare(value)}
                    toChanges={(typed) => {
                      const v = parseInput("border-radius", typed);
                      return v === null ? null : setCorner(i, axis, v);
                    }}
                    lead={axis === "h" ? "↔" : "↕"}
                    scrub={
                      n && {
                        start: n.value,
                        to: (x) => setCorner(i, axis, `${Math.max(x, 0)}${n.unit || "px"}`),
                      }
                    }
                    center
                  />
                );
              })}
            </div>
          ))}
        </Block>
      ) : (
        each && (
          <Block kind="quad">
            {CORNERS.map(([corner, name, turn]) => (
              <StyleField
                key={corner}
                scope={scope}
                prop={`border-${corner}-radius`}
                before={<LeadIcon name="corner" size={12} turn={turn} />}
                title={`${name} radius`}
                small
                center
                bareTokens
              />
            ))}
          </Block>
        )
      )}
    </Section>
  );
}

const styles = stylex.create({
  corner: { display: "flex", alignItems: "center", gap: space.xs, minWidth: 0 },
});
