"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { bare, parseInput, tokenOf } from "@/design/editing/inspect";
import {
  isFlip,
  originCell,
  originValue,
  readTransform,
  type Transform,
  transformResets,
  transformStyles,
  withSheet,
} from "@/design/editing/transform";
import type { Node } from "@/design/schema";
import { colors, space } from "@/styles/tokens.stylex";
import { numberOf } from "../DraftField";
import type { IconName } from "../Icons";
import {
  CustomChip,
  Field,
  LeadIcon,
  PointGrid,
  Row,
  RowBody,
  RowName,
  Section,
  Toggle,
} from "./controls";
import { type Changes, perTarget, resolve, type Scope, transformSheet } from "./scope";

/** The inline properties that make the section show without its "+". */
const OWN = ["translate", "scale", "transform", "transform-origin"];

/** What every target agrees on, or `null` when they differ. */
function agreed<T>(all: ReadonlyArray<T>): T | null {
  const set = new Set(all);
  return set.size === 1 ? ([...set][0] as T) : null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Move, scale, skew and origin, written as the individual `translate` and
 * `scale` properties, with `transform` only for a skew. A `transform` an
 * agent wrote moves into them on the first edit; one the controls can't
 * say is a Custom row with Reset. Rotation and flips are in Layout,
 * through the same reader, so a flip alone doesn't open this. Collapsed
 * behind "+" until something's set.
 */
export function TransformSection({ scope }: { scope: Scope }) {
  const [adding, setAdding] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  // Each target's own styles, with what a class sets where it sets nothing inline.
  const sheetOf = (t: Node) => transformSheet(scope, t);
  const stylesOf = (t: Node) => withSheet(t.styles, sheetOf(t));
  const readings = scope.targets.map((t) => readTransform(stylesOf(t)));
  const drawn = (v: string | undefined) => v !== undefined && v !== "none";
  // A scale that only mirrors is Layout's flip, so this stays closed for it.
  const scaled = (v: string | undefined) => v !== undefined && !isFlip(v);
  const has = scope.targets.some((t) => {
    const sheet = sheetOf(t);
    return (
      OWN.some((p) => p !== "scale" && t.styles[p] !== undefined) ||
      scaled(t.styles.scale) ||
      drawn(sheet.translate) ||
      scaled(sheet.scale) ||
      drawn(sheet.transform)
    );
  });
  if (!has && !adding) {
    return (
      <Section
        title="Transform"
        action={<Toggle icon="plus" title="Add a transform" onClick={() => setAdding(true)} />}
      />
    );
  }
  const values = readings.map((r) => r.value);
  const one = <K extends keyof Transform>(key: K) =>
    values.every((v) => v !== null) ? agreed(values.map((v) => v![key])) : null;
  const fields = perTarget(scope, (t, c) => {
    const { value } = readTransform(stylesOf(t));
    if (!value) return {};
    const n = (k: string) => (c[k] === undefined || c[k] === null ? undefined : Number(c[k]));
    const next: Transform = {
      ...value,
      ...(c.x !== undefined && { x: c.x ?? "0" }),
      ...(c.y !== undefined && { y: c.y ?? "0" }),
      ...(c.scaleX !== undefined && { scaleX: Math.sign(value.scaleX || 1) * n("scaleX")! }),
      ...(c.scaleY !== undefined && { scaleY: Math.sign(value.scaleY || 1) * n("scaleY")! }),
      ...(c.skewX !== undefined && { skewX: n("skewX") ?? 0 }),
      ...(c.skewY !== undefined && { skewY: n("skewY") ?? 0 }),
    };
    return transformStyles(t.styles, next, sheetOf(t));
  });
  // A target the controls can't read leaves the fields blank, not Mixed; its Custom row says why.
  const unreadable = values.some((v) => v === null);
  const sx = one("scaleX");
  const sy = one("scaleY");
  const linked = !unlinked && (sx === null || sy === null || Math.abs(sx) === Math.abs(sy));
  const custom = readings.some((r) => r.custom);
  const origin = agreed(scope.targets.map((t) => originCell(t.styles["transform-origin"])));

  /** A number field for one part of the transform, typed, stepped or scrubbed. */
  const part = (
    key: string,
    letter: string,
    title: string,
    shown: string | null,
    toValue: (n: number, unit: string) => string,
    unit?: string,
  ) => {
    const token = shown === null ? null : tokenOf(shown);
    const n = shown === null || token ? null : numberOf(shown);
    return (
      <Field
        scope={fields}
        label={title}
        title={token ? `${token}: ${resolve(scope, token) ?? "not defined"}` : title}
        text={token ?? shown ?? ""}
        token={token !== null}
        placeholder={shown === null && !unreadable ? "Mixed" : ""}
        toChanges={(typed) => {
          if (key.length === 1 && /^--[\w-]+$/.test(typed.trim()))
            return { [key]: `var(${typed.trim()})` };
          const m = numberOf(typed.trim());
          if (!m) return null;
          return { [key]: toValue(m.value, m.unit) };
        }}
        lead={letter}
        scrub={
          token ? null : { start: n?.value ?? 0, to: (v) => ({ [key]: toValue(v, n?.unit ?? "") }) }
        }
        unit={unit ?? ""}
      />
    );
  };
  const length = (v: number, u: string) => parseInput("gap", `${round(v)}${u}`) ?? "0";
  const percent = (key: "scaleX" | "scaleY") => {
    const v = one(key);
    return v === null ? null : String(round(Math.abs(v) * 100));
  };
  const factor = (v: number) => String(Math.max(v, 0) / 100);

  return (
    <Section
      title="Transform"
      action={
        <Toggle
          icon="minus"
          title="Remove the transform"
          onClick={() => {
            setAdding(false);
            scope.commitEach((t) => {
              const out: Record<string, string | null> = {};
              // A flip is Layout's, so it stays.
              for (const p of OWN) {
                if (t.styles[p] !== undefined && !(p === "scale" && isFlip(t.styles[p]))) {
                  out[p] = null;
                }
              }
              return out;
            });
          }}
        />
      }
    >
      {custom && (
        <Row>
          <RowBody title="A transform the controls can't show">
            <RowName>Transform</RowName>
            <CustomChip
              title="Custom transform: one the controls can't show. Reset takes it off."
              onReset={() =>
                scope.commitEach((t): Changes => {
                  const { translate, rotate, scale, transform } = t.styles;
                  return transformResets({ translate, rotate, scale, transform }, sheetOf(t));
                })
              }
            />
          </RowBody>
        </Row>
      )}
      <Line icon="move" label="Move">
        {part("x", "X", "Move X", one("x") === null ? null : bare(one("x")!), length)}
        {part("y", "Y", "Move Y", one("y") === null ? null : bare(one("y")!), length)}
      </Line>
      <Line
        icon="scale"
        label="Scale"
        action={
          <Toggle
            icon={linked ? "link" : "unlink"}
            title={linked ? "Scale width and height apart" : "Scale width and height together"}
            pressed={linked}
            onClick={() => setUnlinked(linked)}
          />
        }
      >
        {linked ? (
          <Field
            scope={fields}
            label="Scale"
            title="Scale"
            text={percent("scaleX") ?? ""}
            placeholder={percent("scaleX") === null && !unreadable ? "Mixed" : ""}
            toChanges={(typed) => {
              const n = parseFloat(typed);
              return Number.isFinite(n) ? { scaleX: factor(n), scaleY: factor(n) } : null;
            }}
            lead={<LeadIcon name="link" />}
            scrub={{
              start: Number(percent("scaleX") ?? 100),
              to: (v) => ({ scaleX: factor(v), scaleY: factor(v) }),
            }}
            unit="%"
          />
        ) : (
          <>
            {part("scaleX", "W", "Scale width", percent("scaleX"), factor, "%")}
            {part("scaleY", "H", "Scale height", percent("scaleY"), factor, "%")}
          </>
        )}
      </Line>
      {!custom && (
        <Line icon="skew" label="Skew">
          {part(
            "skewX",
            "X",
            "Skew X: slant along the width",
            one("skewX") === null ? null : String(one("skewX")),
            (v) => String(round(v)),
            "°",
          )}
          {part(
            "skewY",
            "Y",
            "Skew Y: slant along the height",
            one("skewY") === null ? null : String(one("skewY")),
            (v) => String(round(v)),
            "°",
          )}
        </Line>
      )}
      <Line icon="origin" label="Origin">
        <PointGrid
          label="Origin: the point it scales, turns and skews around"
          cell={origin}
          onPick={(x, y) =>
            scope.commitEach((t) =>
              x === 1 && y === 1
                ? t.styles["transform-origin"] === undefined
                  ? {}
                  : { "transform-origin": null }
                : { "transform-origin": originValue(x, y) },
            )
          }
        />
      </Line>
    </Section>
  );
}

/** One labeled line of the section: what it sets, by icon and word, then its fields. */
function Line({
  icon,
  label,
  action,
  children,
}: {
  icon: IconName;
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Row action={action}>
      <span {...stylex.props(styles.label)}>
        <LeadIcon name={icon} />
        {label}
      </span>
      {children}
    </Row>
  );
}

const styles = stylex.create({
  label: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    width: 63,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "15px",
  },
});
