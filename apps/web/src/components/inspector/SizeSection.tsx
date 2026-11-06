"use client";

import { useState } from "react";
import type { Editor } from "@/design/editing/editor";
import {
  type Axis,
  SIZE_MODES,
  type SizeContext,
  type SizeMode,
  sizeContextOf,
  sizeModeOf,
  sizeModeStyles,
} from "@/design/editing/sizing";
import type { Node } from "@/design/schema";
import {
  Actions,
  AddMenu,
  Block,
  Choice,
  GeometryField,
  Row,
  Section,
  StyleField,
  Toggle,
} from "./controls";
import type { GeometryFacts } from "./geometry";
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

/**
 * Width and height, each Fixed, Hug or Fill; min and max sizes behind the
 * header's "+"; the aspect lock; and what happens to content that
 * overflows.
 */
export function SizeSection({
  scope,
  editor,
  geometry,
}: {
  scope: Scope;
  editor: Editor;
  geometry: GeometryFacts | null;
}) {
  const limited = LIMITS.some(([prop]) => owns(scope, prop));
  const [limits, setLimits] = useState(limited);
  const open = limits || limited;
  // An artboard's size is its frame, and it has no parent to hug or fill.
  const contexts = scope.targets.map((t) => (t.parent === null ? null : contextOf(scope, t)));
  const sized = contexts.every((c) => c !== null);
  const mode = (axis: Axis, small: boolean) =>
    sized && (
      <ModeChoice
        axis={axis}
        small={small}
        modes={scope.targets.map((t, i) => sizeModeOf(axis, t.styles, contexts[i]!))}
        onPick={(m) =>
          scope.commitEach((t) => {
            const i = scope.targets.indexOf(t);
            const current = parseFloat(scope.computedOf(t.id)?.[axis] ?? "") || 0;
            return sizeModeStyles(axis, m, t.styles, contexts[i]!, current);
          })
        }
      />
    );
  const ratio = readOf(scope, "aspect-ratio");
  const locked = ratio.kind === "value";
  const overflowReading = readOf(scope, "overflow");
  const overflow =
    overflowReading.kind === "mixed" ? null : (OVERFLOW_OF[rawOf(overflowReading) ?? ""] ?? null);
  const lock = (
    <Toggle
      icon={locked ? "lock" : "unlock"}
      title={locked ? "Unlock aspect ratio" : "Lock aspect ratio"}
      pressed={locked}
      disabled={ratio.kind === "mixed"}
      onClick={() =>
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
        })
      }
    />
  );
  // Limits that are set stay shown, so there's nothing to add or hide.
  const adds = [
    !limited &&
      ([
        open ? "Hide min and max sizes" : "Min and max sizes",
        open ? "minus" : "plus",
        () => setLimits(!limits),
      ] as const),
    overflow !== "scroll" &&
      ([
        "Scroll when content overflows",
        "move",
        () => scope.commit({ overflow: "auto" }),
      ] as const),
  ].filter((item) => item !== false);
  // Clip content: `overflow: hidden` on or off. Content that scrolls shows the toggle in the brand color.
  const clip = (
    <Toggle
      icon="clip"
      title={
        overflow === "scroll"
          ? "Scrolls when content overflows. Press to show it all instead"
          : overflow === "clip"
            ? "Clip content: on"
            : "Clip content"
      }
      pressed={overflow === "clip" || overflow === "scroll"}
      accent={overflow === "scroll"}
      onClick={() =>
        scope.commitEach((t) => {
          const changes: Record<string, string | null> = {
            overflow:
              overflow === "visible" || overflow === null
                ? "hidden"
                : removal(overflowReading, "visible"),
          };
          for (const p of ["overflow-x", "overflow-y"]) {
            if (t.styles[p] !== undefined) changes[p] = null;
          }
          return changes;
        })
      }
    />
  );
  return (
    <Section
      title="Size"
      action={
        <Actions>
          {lock}
          {adds.length > 0 && <AddMenu title="Add to size" items={adds} />}
        </Actions>
      }
    >
      <Row action={clip}>
        {geometry ? (
          <>
            <GeometryField
              field="w"
              editor={editor}
              geometry={geometry}
              after={mode("width", true)}
            />
            <GeometryField
              field="h"
              editor={editor}
              geometry={geometry}
              after={mode("height", true)}
            />
          </>
        ) : (
          <>
            <StyleField scope={scope} prop="width" letter="W" title="Width" />
            <StyleField scope={scope} prop="height" letter="H" title="Height" />
          </>
        )}
      </Row>
      {!geometry && sized && (
        <Block kind="pair">
          {mode("width", false)}
          {mode("height", false)}
        </Block>
      )}
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
    </Section>
  );
}

function contextOf(scope: Scope, t: Node): SizeContext | null {
  const own = scope.computedOf(t.id);
  return own ? sizeContextOf(own, t.parent === null ? null : scope.computedOf(t.parent)) : null;
}

/** A size's mode at the end of its field: Fixed, Hug or Fill. */
function ModeChoice({
  axis,
  small,
  modes,
  onPick,
}: {
  axis: Axis;
  small: boolean;
  modes: ReadonlyArray<SizeMode>;
  onPick: (mode: SizeMode) => void;
}) {
  const [first] = modes;
  const value = first !== undefined && modes.every((m) => m === first) ? first : null;
  return (
    <Choice
      label={axis === "width" ? "Width mode" : "Height mode"}
      value={value}
      options={SIZE_MODES}
      onPick={(m) => onPick(m as SizeMode)}
      small={small}
      {...(small ? {} : { icon: axis === "width" ? "gap" : "lineHeight" })}
    />
  );
}
