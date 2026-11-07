"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { colors, fonts, space } from "@/styles/tokens.stylex";
import {
  EFFECT_PROPS,
  type EffectProp,
  effectName,
  FILTERS,
  filterText,
  parseFilter,
  parseShadow,
  type Shadow,
  shadowText,
} from "@/design/editing/effects";
import { opaque } from "@/design/editing/colors";
import { bare, customOf, parseInput, type Reading, tokenOf } from "@/design/editing/inspect";
import { type ListEntry, moveEntry, readList, splitList, writeList } from "@/design/editing/lists";
import type { Target as Node } from "./styleEditor";
import { numberOf, whenNumber } from "../DraftField";
import type { IconName } from "@/lib/icons";
import { tokenRef } from "@/lib/tokens";
import {
  AddMenu,
  Block,
  Choice,
  ColorField,
  CustomChip,
  DragList,
  ExpandButton,
  Field,
  LeadIcon,
  PaintDot,
  Row,
  RowBody,
  RowName,
  Section,
  TokenButton,
  TokenChip,
  Toggle,
  EyeToggle,
  MixedRow,
} from "./controls";
import { type Changes, rawOf, readOf, removal, resolve, type Scope, swatchOf } from "./scope";

/** What each list starts a new entry with. */
const NEW: Readonly<Record<string, readonly [EffectProp, string]>> = {
  "Drop shadow": ["box-shadow", "0 4px 12px rgba(0, 0, 0, 0.12)"],
  "Inner shadow": ["box-shadow", "inset 0 1px 3px rgba(0, 0, 0, 0.12)"],
  "Text shadow": ["text-shadow", "0 1px 2px rgba(0, 0, 0, 0.25)"],
  "Layer blur": ["filter", "blur(4px)"],
  "Background blur": ["backdrop-filter", "blur(8px)"],
  Brightness: ["filter", "brightness(120%)"],
  Contrast: ["filter", "contrast(120%)"],
  Saturation: ["filter", "saturate(150%)"],
  Grayscale: ["filter", "grayscale(100%)"],
  Hue: ["filter", "hue-rotate(90deg)"],
};

/** What a custom entry can be replaced with, by list, as [name, CSS]. */
const REPLACE: Readonly<Partial<Record<EffectProp, readonly [string, string]>>> = {
  "box-shadow": ["drop shadow", NEW["Drop shadow"]![1]],
  "text-shadow": ["text shadow", NEW["Text shadow"]![1]],
  "backdrop-filter": ["background blur", NEW["Background blur"]![1]],
};

/** One effect list as the section shows it: its entries, or `null` when the selection disagrees. */
interface EffectList {
  readonly prop: EffectProp;
  readonly reading: Reading;
  readonly entries: ReadonlyArray<ListEntry> | null;
}

function listOf(scope: Scope, prop: EffectProp): EffectList {
  const reading = readOf(scope, prop);
  const first = scope.targets[0]?.styles ?? {};
  const entries =
    reading.kind === "mixed"
      ? null
      : reading.kind === "value"
        ? readList(first, prop)
        : readList({}, prop, rawOf(reading));
  return { prop, reading, entries };
}

/**
 * Shadows, blurs and filters, as one list of rows: `box-shadow`,
 * `text-shadow`, `filter` and `backdrop-filter`, each split into its
 * entries, the first on top. A row's eye swaps its entry for a placeholder
 * and keeps it in the list's stash; "−" takes it out; dragging a row moves
 * it within its list. "+" always adds at the end.
 */
export function EffectsSection({ scope }: { scope: Scope }) {
  const lists = EFFECT_PROPS.map((prop) => listOf(scope, prop));
  /** Sets `prop`'s entries on every target, from each one's own list. */
  const write =
    (list: EffectList, change: (entries: ListEntry[]) => ListEntry[]) => (target: Node) =>
      writeList(
        target.styles,
        list.prop,
        change(list.entries ? [...list.entries] : readList(target.styles, list.prop)),
        removal(list.reading, "none"),
      );
  const add = (label: string) => {
    const [prop, css] = NEW[label]!;
    const list = lists.find((l) => l.prop === prop)!;
    scope.commitEach(write(list, (entries) => [...entries, { css, hidden: false }]));
  };
  const menu: Array<readonly [string, IconName, () => void] | null> = [
    ...(scope.text
      ? [["Text shadow", "shadow", () => add("Text shadow")] as const]
      : ([
          ["Drop shadow", "shadow", () => add("Drop shadow")],
          ["Inner shadow", "innerShadow", () => add("Inner shadow")],
        ] as const)),
    ["Layer blur", "opacity", () => add("Layer blur")],
    ["Background blur", "opacity", () => add("Background blur")],
    null,
    ...(["Brightness", "Contrast", "Saturation", "Grayscale", "Hue"] as const).map(
      (label) => [label, "opacity", () => add(label)] as const,
    ),
  ];
  return (
    <Section title="Effects" action={<AddMenu title="Add effect" items={menu} />}>
      {/* Each kind is its own list: rows reorder within it, not across. */}
      {lists.map((list) =>
        list.entries === null ? (
          <MixedRow
            key={list.prop}
            what="effects"
            onRemove={() => scope.commitEach(write(list, () => []))}
          />
        ) : (
          list.entries.length > 0 && (
            <DragList
              key={list.prop}
              count={list.entries.length}
              onMove={(from, to) =>
                scope.commitEach(write(list, (entries) => moveEntry(entries, from, to)))
              }
            >
              {(i, drag) => (
                <EffectRow
                  scope={scope}
                  prop={list.prop}
                  entry={list.entries![i]!}
                  drag={drag}
                  set={(next) =>
                    write(list, (entries) => {
                      if (next === null) entries.splice(i, 1);
                      else entries.splice(i, 1, ...next);
                      return entries;
                    })(scope.targets[0]!)
                  }
                  commit={(next) =>
                    scope.commitEach(
                      write(list, (entries) => {
                        if (next === null) entries.splice(i, 1);
                        else entries.splice(i, 1, ...next);
                        return entries;
                      }),
                    )
                  }
                />
              )}
            </DragList>
          )
        ),
      )}
    </Section>
  );
}

/**
 * One entry, as a pair of rows like the mockup's: its type with the eye
 * in the gutter, then its color or token, or its amount, with "−". The
 * chevron on the second row opens the values beneath. `set` gives the
 * styles that put `next` in its place (`null` takes it out), for
 * previews; `commit` keeps them.
 */
function EffectRow({
  scope,
  prop,
  entry,
  drag,
  set,
  commit,
}: {
  scope: Scope;
  prop: EffectProp;
  entry: ListEntry;
  drag: ((e: React.PointerEvent) => void) | undefined;
  set: (next: ListEntry[] | null) => Changes;
  commit: (next: ListEntry[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const shadow = prop === "box-shadow" || prop === "text-shadow";
  const token = tokenOf(entry.css);
  // A token's shadow shows as its chip; its values are the first shadow it stands for.
  const resolved = token ? (resolve(scope, token) ?? "") : entry.css;
  const [firstCss = "", ...restCss] = shadow ? splitList(prop, resolved) : [resolved];
  const parsedShadow = shadow ? parseShadow(firstCss) : null;
  const filter = shadow ? null : parseFilter(entry.css);
  const parsed = parsedShadow ?? filter;
  const name = effectName(prop, parsed, entry.css);
  const custom =
    parsed === null ? (customOf(entry.css) ?? "An effect the controls can't show") : null;
  const visible = (css: string): ListEntry => ({ css, hidden: entry.hidden });
  /** The entries that replace this one when its shadow changes: a token detaches into what it was. */
  const withShadow = (next: Shadow) => [
    visible(shadowText(next, prop === "text-shadow")),
    ...restCss.map(visible),
  ];
  const remove = (
    <Toggle icon="minus" title={`Remove ${name.toLowerCase()}`} onClick={() => commit(null)} />
  );
  const eye = (
    <EyeToggle
      hidden={entry.hidden}
      onClick={() => commit([{ css: entry.css, hidden: !entry.hidden }])}
    />
  );
  const fallback = REPLACE[prop];
  /** Both rows, and what opens under them, drag together. */
  const pair = (rows: React.ReactNode, details?: React.ReactNode) => (
    <div onPointerDown={drag} {...stylex.props(styles.pair, entry.hidden && styles.hiddenPair)}>
      {rows}
      {open && details}
    </div>
  );
  const expand = <ExpandButton open={open} title="Values" onClick={() => setOpen(!open)} />;

  if (custom || parsed === null) {
    return pair(
      <>
        <Row action={eye}>
          <RowBody hidden={entry.hidden} title={custom ?? undefined}>
            <RowName>{name}</RowName>
          </RowBody>
        </Row>
        <Row action={remove}>
          <RowBody hidden={entry.hidden}>
            <RowName>Custom</RowName>
            <CustomChip
              title={
                fallback ? `${custom}. Click to replace it with a ${fallback[0]}` : (custom ?? "")
              }
              onEdit={fallback && (() => commit([visible(fallback[1])]))}
              onReset={() => commit(null)}
            />
          </RowBody>
        </Row>
      </>,
    );
  }

  if (filter) {
    const unit = FILTERS[filter.fn]?.unit ?? "";
    const shownUnit = unit === "deg" ? "°" : unit;
    const to = (amount: number) => set([visible(filterText({ ...filter, amount }))]);
    return pair(
      <>
        <Row action={eye}>
          <RowBody hidden={entry.hidden}>
            <RowName>{name}</RowName>
          </RowBody>
        </Row>
        <Row action={remove}>
          <RowBody open={open} onToggle={() => setOpen(!open)} hidden={entry.hidden}>
            <RowName>{`${filter.amount}${shownUnit}`}</RowName>
            {expand}
          </RowBody>
        </Row>
      </>,
      <Block kind="inset">
        <Field
          scope={scope}
          label={`${name} amount`}
          title={name}
          text={String(filter.amount)}
          toChanges={(typed) => whenNumber(typed, to)}
          lead={<LeadIcon name="letterSpacing" />}
          scrub={{ start: filter.amount, to }}
          min={filter.fn === "hue-rotate" ? undefined : 0}
          unit={shownUnit}
        />
      </Block>,
    );
  }

  const s = parsedShadow!;
  const text = prop === "text-shadow";
  const typeOptions = [
    ["drop", "Drop shadow"],
    ["inner", "Inner shadow"],
  ] as const;
  const first = text ? (
    <RowBody hidden={entry.hidden}>
      <LeadIcon name="shadow" />
      <RowName>{name}</RowName>
    </RowBody>
  ) : (
    <Choice
      label="Shadow type"
      icon={s.inset ? "innerShadow" : "shadow"}
      value={s.inset ? "inner" : "drop"}
      title={token ? "Changing it detaches the token" : "Shadow type"}
      options={typeOptions}
      onPick={(kind) => scope.commit(set(withShadow({ ...s, inset: kind === "inner" })))}
    />
  );
  // The swatch shows the color under its opacity, which the % beside it says.
  const swatch = swatchOf(scope, opaque(s.color));
  return pair(
    <>
      <Row action={eye}>{first}</Row>
      <Row action={remove}>
        {token ? (
          <RowBody open={open} onToggle={() => setOpen(!open)} hidden={entry.hidden}>
            {/* A token's color is the token's; picking one detaches it, below. */}
            <PaintDot color={swatch} />
            <span {...stylex.props(styles.grow)}>
              <TokenChip name={token} title={`${token}: ${name}`} />
            </span>
            {expand}
          </RowBody>
        ) : (
          <ColorField
            scope={scope}
            label="Shadow color"
            reading={{ kind: "value", raw: s.color, token: tokenOf(s.color) }}
            toChanges={(c) => set(withShadow({ ...s, color: c ?? "transparent" }))}
            trailing={expand}
          />
        )}
      </Row>
    </>,
    <>
      <Block kind={text ? "triple" : "quad"}>
        {(
          [
            ["x", "X", "X offset"],
            ["y", "Y", "Y offset"],
            ["blur", "B", "Blur"],
            ...(text ? [] : ([["spread", "S", "Spread"]] as const)),
          ] as const
        ).map(([part, letter, title]) => {
          const n = numberOf(s[part]);
          return (
            <Field
              key={part}
              scope={scope}
              label={title}
              title={token ? `${title}: changing it detaches ${token}` : title}
              text={bare(s[part])}
              toChanges={(typed) => {
                const v = parseInput("gap", typed);
                return v === null ? null : set(withShadow({ ...s, [part]: v }));
              }}
              lead={letter}
              scrub={
                n && {
                  start: n.value,
                  to: (v) =>
                    set(
                      withShadow({
                        ...s,
                        [part]: `${v}${n.unit || "px"}`,
                      }),
                    ),
                }
              }
              // Blur can't be negative; the offsets and the spread can.
              min={part === "blur" ? 0 : undefined}
              small
              center
            />
          );
        })}
      </Block>
      <Block kind="inset">
        <div {...stylex.props(styles.line)}>
          <span {...stylex.props(styles.label, styles.grow)}>
            {token ? "Another shadow token" : "Use a shadow token"}
          </span>
          <TokenButton
            scope={scope}
            kind="shadow"
            menu={false}
            onPick={(t) => commit([visible(tokenRef(t))])}
          />
        </div>
      </Block>
      {token && (
        <Block kind="inset">
          <ColorField
            scope={scope}
            label="Shadow color"
            reading={{ kind: "value", raw: s.color, token: tokenOf(s.color) }}
            toChanges={(c) => set(withShadow({ ...s, color: c ?? "transparent" }))}
          />
        </Block>
      )}
    </>,
  );
}

const styles = stylex.create({
  pair: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    marginBottom: { default: 0, ":not(:last-child)": space.xs },
  },
  hiddenPair: { opacity: 0.6 },
  grow: { flexGrow: 1, minWidth: 0, display: "flex" },
  label: { color: colors.muted, fontSize: 12, lineHeight: "15px", fontWeight: 500 },
  line: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 },
  kind: {
    flexShrink: 0,
    whiteSpace: "nowrap",
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: "18px",
  },
});
