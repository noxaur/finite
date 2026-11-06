"use client";

import { useState } from "react";
import { bare, customOf, type Reading, tokenOf } from "@/design/editing/inspect";
import {
  decorationColorOf,
  decorationColorStyles,
  decorationOf,
  decorationStyles,
  lineHeightInput,
  lineHeightShown,
  maxLinesOf,
  maxLinesStyles,
  TEXT_PROPS,
  type WrapMode,
  wrapOf,
  wrapStyles,
} from "@/design/editing/typography";
import { roundTo } from "@/design/editing/units";
import type { Node } from "@/design/schema";
import { numberOf } from "../DraftField";
import {
  Block,
  Choice,
  ColorField,
  Field,
  Labeled,
  Row,
  Section,
  Segments,
  StyleField,
  Toggle,
} from "./controls";
import {
  type Changes,
  matchingTokens,
  perTarget,
  rawOf,
  readOf,
  resolve,
  type Scope,
} from "./scope";

const WEIGHTS: ReadonlyArray<readonly [string, string]> = [
  ["100", "Thin"],
  ["200", "Extra light"],
  ["300", "Light"],
  ["400", "Regular"],
  ["500", "Medium"],
  ["600", "Semibold"],
  ["700", "Bold"],
  ["800", "Extra bold"],
  ["900", "Black"],
];

const FAMILIES = ["Helvetica Neue", "Inter", "system-ui", "Georgia", "JetBrains Mono"];

/** The first family of a `font-family` list, without its quotes. */
const firstFamily = (raw: string) => (raw.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");

export function TypographySection({ scope }: { scope: Scope }) {
  const [adding, setAdding] = useState(false);
  // A text layer, or one that sets a text style of its own; on a box the rest wait behind "+".
  const textual =
    scope.text || scope.targets.some((t) => TEXT_PROPS.some((p) => t.styles[p] !== undefined));
  if (!textual && !adding) {
    return (
      <Section
        title="Typography"
        action={
          <Toggle
            icon="plus"
            title="Set text styles for the text inside"
            onClick={() => setAdding(true)}
          />
        }
      />
    );
  }
  return <TypographyFields scope={scope} />;
}

function TypographyFields({ scope }: { scope: Scope }) {
  const font = readOf(scope, "font");
  const weight = readOf(scope, "font-weight");
  const align = rawOf(readOf(scope, "text-align"));
  const textStyles = matchingTokens(scope, "font");
  const families = [
    ...new Set([
      ...matchingTokens(scope, "family").map(([, v]) => firstFamily(v)),
      ...textStyles.map(([, v]) =>
        firstFamily(v.replace(/^.*?\d[\w%.]*(\s*\/\s*[\d.]+\w*)?\s+/, "")),
      ),
      ...FAMILIES,
    ]),
  ].filter(Boolean);
  const weightValue = weight.kind === "mixed" ? null : (rawOf(weight) ?? "");
  return (
    <Section title="Typography">
      <Labeled>
        {(font.kind === "value" || font.kind === "mixed" || textStyles.length > 0) && (
          <Block kind="inset">
            <StyleField
              scope={scope}
              prop="font"
              title="Text style"
              tokens="font"
              letter="Style"
              menu
              empty="Text style"
              custom={() => "A text style written out; its parts show below"}
              // What the browser draws is shown by its parts below, not as CSS.
              show={() => ""}
            />
          </Block>
        )}
        <Block kind="inset">
          <StyleField
            scope={scope}
            prop="font-family"
            title="Font"
            letter="Family"
            show={firstFamily}
            options={families.map((f) => [f, f.includes(" ") ? `"${f}"` : f])}
          />
        </Block>
        <Block kind="pair">
          <Choice
            label="Weight"
            value={weightValue}
            options={[
              ...WEIGHTS,
              ...(weightValue && !WEIGHTS.some(([w]) => w === weightValue)
                ? [[weightValue, weightValue] as const]
                : []),
            ]}
            onPick={(w) => scope.commit({ "font-weight": w })}
            inherited={weight.kind === "computed"}
            title={
              weight.kind === "computed" ? "Weight: inherited, not set on this layer" : "Weight"
            }
          />
          <StyleField scope={scope} prop="font-size" icon="fontSize" title="Size" />
        </Block>
        <Block kind="inset">
          <StyleField scope={scope} prop="color" title="Text color" color />
        </Block>
      </Labeled>
      <Labeled apart>
        <Block kind="pair">
          <LineHeightField scope={scope} />
          <StyleField
            scope={scope}
            prop="letter-spacing"
            letter="Letter"
            title="Letter spacing"
            show={(raw) => (raw === "normal" ? "0" : bare(raw))}
          />
        </Block>
      </Labeled>
      <TextDetails scope={scope} align={align} />
    </Section>
  );
}

/** Reads a target's own style, then what the browser draws on it. */
const readerOf = (scope: Scope, target: Node) => (prop: string) =>
  target.styles[prop] ?? (scope.computedOf(target.id)?.getPropertyValue(prop) || undefined);

/** What every target agrees on, or `null` when they differ. */
function agreed<T>(scope: Scope, of: (target: Node) => T): T | null {
  const all = new Set(scope.targets.map(of));
  return all.size === 1 ? ([...all][0] as T) : null;
}

/**
 * Style, decoration, case, max lines and wrap, compactly under the
 * mockup's rows, and the decoration's color once there is one. Each
 * target keeps its own shorthands: a line or its color goes into the
 * `text-decoration` it has, and truncate writes its three declarations
 * together.
 */
function TextDetails({ scope, align }: { scope: Scope; align: string | undefined }) {
  const style = readOf(scope, "font-style");
  const italic = agreed(scope, (t) =>
    /^(italic|oblique)/.test(readerOf(scope, t)("font-style") ?? ""),
  );
  const transform = readOf(scope, "text-transform");
  const decoration = agreed(scope, (t) => {
    const line = decorationOf(t.styles, readerOf(scope, t));
    return line === "line-through" || line === "underline" || line === "none" ? line : "";
  });
  const wrap = agreed(scope, (t) => wrapOf(readerOf(scope, t)));
  const allLines = new Set(scope.targets.map((t) => maxLinesOf(t.styles, readerOf(scope, t))));
  const lines = allLines.size === 1 ? [...allLines][0]! : null;
  const linesScope = perTarget(scope, (t, c) =>
    maxLinesStyles(t.styles, c.lines ? Number(c.lines) : null),
  );
  const decorated = scope.targets.some(
    (t) => decorationOf(t.styles, readerOf(scope, t)) !== "none",
  );
  return (
    <>
      <Labeled caption="Align and style" apart>
        <Row>
          <Segments
            label="Text align"
            value={align === "start" ? "left" : align || null}
            options={[
              ["left", "alignLeft", "Align left"],
              ["center", "alignCenter", "Align center"],
              ["right", "alignRight", "Align right"],
              ["justify", "justify", "Justify"],
            ]}
            onPick={(a) => scope.commit({ "text-align": a })}
          />
        </Row>
        <Block kind="pair">
          <Segments
            label="Style"
            value={italic === null ? null : italic ? "italic" : "upright"}
            options={[
              ["upright", "upright", "Upright"],
              ["italic", "italic", "Italic"],
            ]}
            onPick={(v) =>
              scope.commit({
                "font-style": v === "italic" ? "italic" : style.kind === "value" ? null : "normal",
              })
            }
          />
          <Segments
            label="Decoration"
            value={decoration}
            options={[
              ["none", "noneMark", "No decoration"],
              ["underline", "underline", "Underline"],
              ["line-through", "strike", "Strikethrough"],
            ]}
            onPick={(line) =>
              scope.commitEach((t) => decorationStyles(t.styles, readerOf(scope, t), line))
            }
          />
        </Block>
        <Block kind="pair">
          <Segments
            label="Case"
            value={transform.kind === "mixed" ? null : (rawOf(transform) ?? "none")}
            options={[
              ["none", "noneMark", "Case as typed"],
              ["uppercase", "caseUpper", "Uppercase"],
              ["lowercase", "caseLower", "Lowercase"],
              ["capitalize", "caseTitle", "Capitalize each word"],
            ]}
            onPick={(v) =>
              scope.commit({
                "text-transform": v === "none" && transform.kind === "value" ? null : v,
              })
            }
          />
          <Segments
            label="Wrap"
            value={wrap}
            options={[
              ["wrap", "wrap", "Wrap"],
              ["nowrap", "noWrap", "No wrap: one line"],
              ["truncate", "truncate", "Truncate: one line, cut off with an ellipsis"],
              ["balance", "balance", "Balance: lines of even length"],
            ]}
            onPick={(mode: WrapMode) =>
              scope.commitEach((t) => wrapStyles(t.styles, readerOf(scope, t), mode))
            }
          />
        </Block>
        <Block kind="inset">
          <Field
            scope={linesScope}
            label="Max lines"
            title="Max lines: the text stops there with an ellipsis"
            text={lines === null ? "" : String(lines)}
            placeholder={allLines.size > 1 ? "Mixed" : "No limit"}
            toChanges={(typed) => {
              const n = parseInt(typed, 10);
              return { lines: Number.isFinite(n) && n > 0 ? String(n) : null };
            }}
            lead="Max lines"
            scrub={{
              start: lines ?? 0,
              to: (n) => ({ lines: n >= 1 ? String(Math.round(n)) : null }),
            }}
            min={0}
          />
        </Block>
      </Labeled>
      {decorated && (
        <Block kind="inset">
          <ColorField
            scope={perTarget(scope, (t, c) => decorationColorStyles(t.styles, c.color ?? null))}
            label="Decoration color"
            reading={decorationColorReading(scope)}
            toChanges={(color) => ({ color })}
          />
        </Block>
      )}
    </>
  );
}

/** The decoration's color across the targets, as the shared color row reads it. */
function decorationColorReading(scope: Scope): Reading {
  const own = scope.targets.map((t) =>
    t.styles["text-decoration-color"] !== undefined || t.styles["text-decoration"] !== undefined
      ? decorationColorOf(t.styles, () => undefined)
      : undefined,
  );
  const all = new Set(own);
  if (all.size > 1) return { kind: "mixed" };
  const [raw] = all;
  if (raw !== undefined) return { kind: "value", raw, token: tokenOf(raw) };
  const first = scope.targets[0];
  const drawn = first && decorationColorOf({}, readerOf(scope, first));
  return drawn ? { kind: "computed", raw: drawn } : { kind: "unset" };
}

/**
 * Line height: a bare number is pixels, `150%` a percentage, `1.5x` a
 * multiple of the font size (shown as 1.5×) and `auto` the browser's
 * `normal` (shown as Auto). Scrubbing keeps the unit it shows.
 */
function LineHeightField({ scope }: { scope: Scope }) {
  const reading = readOf(scope, "line-height");
  const raw = rawOf(reading);
  const token = reading.kind === "value" ? tokenOf(raw ?? "") : null;
  const resolved = token ? resolve(scope, token) : raw;
  const parsed = resolved === undefined ? null : lineHeightShown(resolved);
  const custom = reading.kind === "value" && !token && parsed === null;
  const size = numberOf(rawOf(readOf(scope, "font-size")) ?? "")?.value ?? 16;
  // Auto starts a scrub from what the browser draws for it, about 1.2 times the size.
  const start = parsed ? (parsed.value ?? Math.round(size * 1.2)) : null;
  const unit = parsed?.unit ?? "px";
  const to = (n: number): Changes => ({
    "line-height":
      unit === "" ? String(Math.max(0, roundTo(n, 2))) : `${Math.max(0, Math.round(n))}${unit}`,
  });
  return (
    <Field
      scope={scope}
      label="Line height"
      title={
        token ? `${token}: ${resolved ?? "not defined"}` : "Line height: 24, 150%, 1.5x or auto"
      }
      text={reading.kind === "value" ? (token ?? parsed?.text ?? "") : ""}
      placeholder={
        reading.kind === "mixed" ? "Mixed" : reading.kind === "computed" ? (parsed?.text ?? "") : ""
      }
      token={token !== null}
      custom={
        custom
          ? {
              title: customOf(raw ?? "") ?? "Custom line height",
              onReset: () => scope.commit({ "line-height": null }),
            }
          : undefined
      }
      toChanges={(typed) => {
        const v = lineHeightInput(typed);
        return v === null && typed.trim() !== "" ? null : { "line-height": v };
      }}
      lead="Line"
      scrub={token || custom ? null : { start, step: unit === "" ? 0.05 : 1, to }}
      min={0}
    />
  );
}
