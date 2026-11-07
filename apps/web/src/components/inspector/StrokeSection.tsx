"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { bare, ownStyle } from "@/design/editing/inspect";
import { parts } from "@/design/editing/lists";
import {
  centerOffset,
  hasBorder,
  isPaintedStyle,
  moveStroke,
  outlinePart,
  outlinePosition,
  removeStroke,
  SIDES,
  type StrokePosition,
  sideStyle,
  strokeProp,
} from "@/design/editing/stroke";
import type { Target as Node } from "./styleEditor";
import { numberOf } from "../DraftField";
import {
  Block,
  Choice,
  Field,
  Labeled,
  LeadIcon,
  Row,
  Section,
  Segments,
  StyleField,
  Toggle,
} from "./controls";
import { type Changes, rawOf, readOf, type Scope } from "./scope";

const STYLES = ["solid", "dashed", "dotted", "double"].map(
  (s) => [s, s[0]!.toUpperCase() + s.slice(1)] as const,
);

/** [value, icon, tooltip, the word on the segment]. */
const POSITIONS = [
  ["inside", null, "Inside: within the layer's edge", "Inside"],
  ["center", null, "Center: straddling the edge", "Center"],
  ["outside", null, "Outside: beyond the edge", "Outside"],
] as const;

type Reader = (prop: string) => string | undefined;

/** What one target sets inline, an `outline` shorthand's parts included, or the browser draws on it. */
function readerOf(scope: Scope, t: Node): Reader {
  const style = scope.computedOf(t.id);
  return (p) =>
    ownStyle(t.styles, p) ?? outlinePart(t.styles, p) ?? (style?.getPropertyValue(p) || undefined);
}

/**
 * The border and the outline, as two strokes, since a layer can have
 * both. A border sits inside the edge; an outline is the same on every
 * side and sits centered on it or outside it. Either moves to the other's
 * place, unless the layer already has the other one there, which the
 * position says instead of replacing it.
 */
export function StrokeSection({ scope }: { scope: Scope }) {
  const readers = scope.targets.map((t) => readerOf(scope, t));
  const border = readers.some(hasBorder);
  const outline = readers.some((r) => outlinePosition(r) !== null);
  const add = !border
    ? {
        title: "Add border",
        styles: { "border-width": "1px", "border-style": "solid", "border-color": "#000000" },
      }
    : !outline
      ? {
          title: "Add outline",
          styles: {
            "outline-width": "1px",
            "outline-style": "solid",
            "outline-color": "#000000",
            "outline-offset": "0px",
          },
        }
      : null;
  return (
    <Section
      title="Border"
      action={
        add && <Toggle icon="plus" title={add.title} onClick={() => scope.commit(add.styles)} />
      }
    >
      {border && <BorderStroke scope={scope} outline={outline} />}
      {/* The section's title names the first stroke; a second one is told apart by a caption. */}
      {outline &&
        (border ? (
          <Labeled caption="Outline" apart>
            <OutlineStroke scope={scope} border={border} />
          </Labeled>
        ) : (
          <OutlineStroke scope={scope} border={border} />
        ))}
    </Section>
  );
}

/**
 * Moves each target's stroke at `from` to `to`, with that target's own
 * color, width and style; a target without one, or whose parts can't be
 * read, is left as it is.
 */
function moveEach(scope: Scope, from: (r: Reader) => StrokePosition | null, to: StrokePosition) {
  scope.commitEach((t) => {
    const own = readerOf(scope, t);
    const at = from(own);
    if (!at || at === to) return {};
    const side = SIDES.find((s) => isPaintedStyle(sideStyle(own, s))) ?? "top";
    const prop = (key: "width" | "style" | "color") =>
      at === "inside" ? `border-${side}-${key}` : strokeProp(at, key);
    // A border set per side moves as its first drawn side.
    const [width, style, color] = (["width", "style", "color"] as const).map(
      (key) => parts(own(prop(key)) ?? "")[0],
    );
    if (!width || !style || !color) return {};
    const out = moveStroke(t.styles, at, to, { width, style, color });
    // The longhands carry everything an `outline` shorthand said, so it goes.
    if (t.styles.outline !== undefined) out.outline = null;
    return out;
  });
}

/**
 * The border: its color with opacity, width, style and position. A
 * border on some sides only, like a divider's bottom line, sets the sides
 * it draws: the width and style go to those, and a width typed for a
 * side without a line gives it one.
 */
function BorderStroke({ scope, outline }: { scope: Scope; outline: boolean }) {
  const read = (prop: string) => rawOf(readOf(scope, prop));
  const mixed = readOf(scope, "border-style").kind === "mixed";
  const drawn = SIDES.filter((side) => isPaintedStyle(sideStyle(read, side)));
  const widths = SIDES.map((side) => JSON.stringify(readOf(scope, `border-${side}-width`)));
  // Every side drawn the same, so one field says it all.
  const uniform = mixed || (drawn.length === 4 && new Set(widths).size === 1);
  const [each, setEach] = useState(!uniform);
  const first = drawn[0] ?? "top";
  const style = readOf(scope, uniform ? "border-style" : `border-${first}-style`);
  const width = readOf(scope, "border-width");
  /** The styles that set `part` on the sides that draw a line, or on the whole border. */
  const onDrawn = (part: "width" | "style", value: string | null): Changes =>
    uniform || drawn.length === 0
      ? { [`border-${part}`]: value }
      : Object.fromEntries(drawn.map((side) => [`border-${side}-${part}`, value]));
  const firstWidth = read(`border-${first}-width`) ?? "";
  const sameWidth =
    width.kind !== "mixed" && drawn.every((s) => read(`border-${s}-width`) === firstWidth);
  return (
    <>
      <Row
        action={
          <Toggle
            icon="sides"
            title="Set each side"
            pressed={each}
            onClick={() => setEach(!each)}
          />
        }
      >
        {uniform ? (
          <StyleField scope={scope} prop="border-color" title="Border color" color />
        ) : (
          <StyleField
            scope={scope}
            prop={`border-${first}-color`}
            title="Border color"
            color
            // The other sides that draw a line take it too.
            also={(c) =>
              Object.fromEntries(drawn.slice(1).map((side) => [`border-${side}-color`, c]))
            }
          />
        )}
      </Row>
      <Row
        action={
          <Toggle
            icon="minus"
            title="Remove border"
            onClick={() => scope.commitEach((t) => removeStroke(t.styles, "inside"))}
          />
        }
      >
        <div {...stylex.props(styles.half)}>
          {uniform && width.kind !== "mixed" ? (
            <StyleField
              scope={scope}
              prop="border-width"
              icon="borderWidth"
              title="Border width"
              unit="px"
            />
          ) : (
            <Field
              scope={scope}
              label="Border width"
              title={
                sameWidth
                  ? "Border width: sets every side that draws a line"
                  : "Border width: Mixed"
              }
              text={sameWidth ? bare(firstWidth) : ""}
              placeholder="—"
              toChanges={(typed) => {
                const n = numberOf(typed);
                return n ? onDrawn("width", `${n.value}${n.unit || "px"}`) : null;
              }}
              lead={<LeadIcon name="borderWidth" />}
              scrub={{
                start: sameWidth ? (numberOf(firstWidth)?.value ?? null) : null,
                to: (v) => onDrawn("width", `${v}px`),
              }}
              min={0}
            />
          )}
        </div>
        <Choice
          label="Border style"
          value={style.kind === "mixed" ? null : (parts(rawOf(style) ?? "")[0] ?? "")}
          options={STYLES}
          onPick={(s) => scope.commit(onDrawn("style", s))}
        />
      </Row>
      {/* With an outline on the layer the border has nowhere else to go. */}
      {!outline && (
        <Row>
          <Segments
            label="Border position"
            value="inside"
            options={POSITIONS}
            onPick={(to) => moveEach(scope, (r) => (hasBorder(r) ? "inside" : null), to)}
          />
        </Row>
      )}
      {each && (
        <Block kind="quad">
          {SIDES.map((side) => {
            const name = `${side[0]!.toUpperCase()}${side.slice(1)}`;
            // A side without a line gets the drawn sides' style and color with its width.
            const lineless = !isPaintedStyle(sideStyle(read, side));
            const look = {
              [`border-${side}-style`]: rawOf(style)?.split(" ")[0] || "solid",
              [`border-${side}-color`]: read(`border-${first}-color`) ?? "currentcolor",
            };
            return (
              <StyleField
                key={side}
                scope={scope}
                prop={`border-${side}-width`}
                letter={side[0]!.toUpperCase()}
                title={`${name} width`}
                also={(w) => (lineless && w !== null ? look : {})}
                small
                center
                bareTokens
              />
            );
          })}
        </Block>
      )}
    </>
  );
}

/** The outline: its color with opacity, width, style, and whether it's centered or outside. */
function OutlineStroke({ scope, border }: { scope: Scope; border: boolean }) {
  // Layers without an outline don't count; moving leaves them as they are.
  const positions = new Set(
    scope.targets.map((t) => outlinePosition(readerOf(scope, t))).filter((p) => p !== null),
  );
  const [position] = positions;
  const shown = positions.size === 1 && position ? position : null;
  const style = readOf(scope, "outline-style");
  const taken = "This layer has a border inside already. Remove it to move the outline in.";
  return (
    <>
      <Row>
        <StyleField scope={scope} prop="outline-color" title="Outline color" color />
      </Row>
      <Row
        action={
          <Toggle
            icon="minus"
            title="Remove outline"
            onClick={() => scope.commitEach((t) => removeStroke(t.styles, "outside"))}
          />
        }
      >
        <div {...stylex.props(styles.half)}>
          {readOf(scope, "outline-width").kind === "mixed" ? (
            <Field
              scope={scope}
              label="Outline width"
              title="Outline width: Mixed"
              text=""
              placeholder="—"
              toChanges={(typed) => {
                const n = numberOf(typed);
                return n ? { "outline-width": `${n.value}${n.unit || "px"}` } : null;
              }}
              lead={<LeadIcon name="borderWidth" />}
              min={0}
            />
          ) : (
            <StyleField
              scope={scope}
              prop="outline-width"
              icon="borderWidth"
              title="Outline width"
              unit="px"
              // A centered outline straddles the edge, so its offset follows its width.
              also={(w) =>
                shown === "center" && w !== null ? { "outline-offset": centerOffset(w) } : {}
              }
            />
          )}
        </div>
        <Choice
          label="Outline style"
          value={style.kind === "mixed" ? null : (rawOf(style) ?? "")}
          options={STYLES}
          onPick={(s) => scope.commit({ "outline-style": s })}
        />
      </Row>
      <Row>
        <Segments
          label="Outline position"
          value={shown}
          options={POSITIONS}
          blocked={border ? { inside: taken } : {}}
          onPick={(to) => moveEach(scope, outlinePosition, to)}
        />
      </Row>
    </>
  );
}

const styles = stylex.create({
  /** The width and the style share the row in halves, as the mockup draws them. */
  half: { display: "flex", flexGrow: 1, flexBasis: 0, minWidth: 0 },
});
