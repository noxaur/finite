"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { BLENDS, CURSORS, opacityPercent, opacityValue } from "@/design/editing/appearance";
import { customOf, parseInput, type Reading, tokenOf } from "@/design/editing/inspect";
import { whenNumber } from "../DraftField";
import { AddMenu, Choice, Field, Row, Section, Toggle } from "./controls";
import { type Changes, rawOf, readOf, removal, type Scope } from "./scope";

/** Whether a reading is set on the selection, or drawn as something other than `none`. */
const isSet = (r: Reading, ...none: string[]) =>
  r.kind === "value" || r.kind === "mixed" || (r.kind === "computed" && !none.includes(r.raw));

/** A choice's value as its menu shows it: `null` for Mixed, and "Custom" for one it doesn't list. */
const choiceOf = (r: Reading, options: ReadonlyArray<readonly [string, string]>) => {
  if (r.kind === "mixed") return null;
  const raw = rawOf(r) ?? "";
  return raw === "" || options.some(([v]) => v === raw) ? raw : "Custom";
};

/**
 * How the layer looks as a whole: its opacity and blend mode, as Figma
 * always shows them, and the cursor over it, once set or once "+" asks
 * for it. The corner radius is its own section.
 */
export function AppearanceSection({ scope }: { scope: Scope }) {
  const [asked, setAsked] = useState(false);
  const opacity = readOf(scope, "opacity");
  const blend = readOf(scope, "mix-blend-mode");
  const cursor = readOf(scope, "cursor");
  const changed = isSet(opacity, "1") || isSet(blend, "normal");
  // The canvas draws its own cursors, so only the selection's own one counts.
  const pointer = asked || cursor.kind === "value" || cursor.kind === "mixed";
  return (
    <Section
      title="Appearance"
      action={
        !pointer && (
          <AddMenu title="Add cursor" items={[["Cursor", "cursor", () => setAsked(true)]]} />
        )
      }
    >
      <Row
        action={
          changed && (
            <Toggle
              icon="minus"
              title="Reset opacity and blend mode"
              onClick={() =>
                scope.commit({
                  opacity: removal(opacity, "1"),
                  "mix-blend-mode": removal(blend, "normal"),
                })
              }
            />
          )
        }
      >
        <div {...stylex.props(styles.short)}>
          <OpacityField scope={scope} reading={opacity} />
        </div>
        <Choice
          label="Blend mode"
          value={choiceOf(blend, BLENDS)}
          options={BLENDS}
          onPick={(v) => scope.commit({ "mix-blend-mode": v })}
        />
      </Row>
      {pointer && (
        <Row
          action={
            <Toggle
              icon="minus"
              title="Remove cursor"
              onClick={() => {
                setAsked(false);
                scope.commit({ cursor: removal(cursor, "auto") });
              }}
            />
          }
        >
          <Choice
            label="Cursor"
            title="The pointer over this layer in a preview"
            icon="cursor"
            value={choiceOf(cursor, CURSORS)}
            options={CURSORS}
            onPick={(v) => scope.commit({ cursor: v })}
          />
        </Row>
      )}
    </Section>
  );
}

/** The layer's opacity as a percentage, typed, stepped or scrubbed. */
function OpacityField({ scope, reading }: { scope: Scope; reading: Reading }) {
  const raw = rawOf(reading);
  const token = reading.kind === "value" && raw ? tokenOf(raw) : null;
  const percent = raw === undefined || token ? null : opacityPercent(raw);
  const why = reading.kind === "value" && raw && !token && percent === null ? customOf(raw) : null;
  const to = (n: number): Changes => ({ opacity: opacityValue(n) });
  return (
    <Field
      scope={scope}
      label="Layer opacity"
      title={token ? `Layer opacity: ${token}` : "Layer opacity"}
      // The layer's drawn opacity reads as a value, in the value tone, as it's what the layer has.
      text={
        reading.kind === "mixed"
          ? ""
          : (token ?? (percent !== null ? String(percent) : raw === undefined ? "100" : ""))
      }
      placeholder={reading.kind === "mixed" ? "—" : ""}
      token={token !== null}
      custom={why ? { title: why, onReset: () => scope.commit({ opacity: null }) } : undefined}
      toChanges={(typed) => {
        if (typed.trim().startsWith("--")) return { opacity: parseInput("opacity", typed) };
        return whenNumber(typed, to);
      }}
      lead="Opacity"
      scrub={{ start: percent ?? (raw === undefined ? 100 : null), to: (n) => to(n) }}
      min={0}
      max={100}
      unit={token ? "" : "%"}
    />
  );
}

const styles = stylex.create({
  /** Opacity and the blend menu beside it share the row in halves. */
  short: { display: "flex", flexGrow: 1, flexBasis: 0, minWidth: 0 },
});
