"use client";

import { propName } from "@/design/editing/advanced";
import { type ListEntry, moveEntry, readList, writeList } from "@/design/editing/lists";
import {
  isEasing,
  msOf,
  parseTransition,
  partialTransition,
  resetTransition,
  rowEntries,
  tokenIn,
  type TransitionRow,
  transitionRows,
} from "@/design/editing/transitions";
import { numberOf } from "../DraftField";
import {
  CustomChip,
  DragList,
  EyeButton,
  Field,
  Heads,
  Popup,
  Row,
  RowBody,
  RowName,
  RowNote,
  Section,
  TokenChip,
  Toggle,
} from "./controls";
import { type Changes, rawOf, readOf, removal, resolve, type Scope } from "./scope";

const PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ["all", "All"],
  ["opacity", "Opacity"],
  ["transform", "Transform"],
  ["colors", "Colors"],
  ["background-color", "Background"],
  ["box-shadow", "Shadow"],
  ["filter", "Filter"],
  ["width", "Width"],
  ["height", "Height"],
];

const EASINGS: ReadonlyArray<readonly [string, string]> = [
  ["ease", "Ease"],
  ["ease-in", "In"],
  ["ease-out", "Out"],
  ["ease-in-out", "In-out"],
  ["linear", "Linear"],
];

/** What a row says animates, by name. */
const label = (property: string | undefined) =>
  property === undefined
    ? "Transition"
    : (PROPERTIES.find(([p]) => p === property)?.[1] ?? propName(property));

/** A new row: everything, a fifth of a second. */
const NEW = "all 200ms ease";

/** Whether what the browser draws animates nothing: no entries, or every one takes no time. */
const still = (raw: string) =>
  readList({}, "transition", raw).every((e) => {
    const t = parseTransition(e.css);
    return t !== null && msOf(t.duration) === 0 && msOf(t.delay) === 0;
  });

/**
 * Transitions, as a list of rows: what animates, how long, its easing and
 * its delay. Colors and Transform are one row each that writes an entry
 * per property they cover. Rows have the shared eye, drag and "−"; "+"
 * appends one. Collapsed behind "+" when there are none.
 */
export function TransitionsSection({ scope }: { scope: Scope }) {
  const reading = readOf(scope, "transition");
  const raw = rawOf(reading);
  const first = scope.targets[0]?.styles ?? {};
  const resolver = (t: string) => resolve(scope, t);
  const entries: ListEntry[] | null =
    reading.kind === "mixed"
      ? null
      : reading.kind === "value"
        ? readList(first, "transition")
        : raw !== undefined && !still(raw)
          ? readList({}, "transition", raw)
          : [];
  const rows = entries ? transitionRows(entries, resolver) : null;
  const flat = (all: ReadonlyArray<TransitionRow>) => all.flatMap((r) => r.entries);
  const write = (next: ReadonlyArray<TransitionRow> | ReadonlyArray<ListEntry>) => {
    const list = (next as ReadonlyArray<TransitionRow | ListEntry>).flatMap((r) =>
      "css" in r ? [r] : r.entries,
    );
    return scope.editsEach((t) =>
      writeList(t.styles, "transition", list, removal(reading, "none")),
    );
  };
  const commit = (next: ReadonlyArray<TransitionRow> | ReadonlyArray<ListEntry>) =>
    void scope.editor.commit(write(next));
  const add = (
    <Toggle
      icon="plus"
      title="Add a transition"
      onClick={() => commit([...flat(rows ?? []), { css: NEW, hidden: false }])}
    />
  );
  if (rows === null) {
    return (
      <Section title="Transitions" action={add}>
        <Row
          action={
            <Toggle
              icon="minus"
              title="Remove the transitions from every layer"
              onClick={() => commit([])}
            />
          }
        >
          <RowBody title="The selected layers have different transitions">
            <RowName>Mixed</RowName>
          </RowBody>
        </Row>
      </Section>
    );
  }
  return (
    <Section title="Transitions" action={add}>
      {rows.length > 0 && (
        <DragList count={rows.length} onMove={(from, to) => commit(moveEntry(rows, from, to))}>
          {(i, drag) => (
            <TransitionItem
              scope={scope}
              row={rows[i]!}
              drag={drag}
              edits={(next) => {
                const all: Array<TransitionRow | ListEntry> = [...rows];
                all.splice(i, 1, ...(next ?? []));
                return write(all as ListEntry[]);
              }}
            />
          )}
        </DragList>
      )}
    </Section>
  );
}

/**
 * One row in two lines: what animates and its easing, with the eye; its
 * duration and delay under their captions, with "−". `edits` puts `next` in its place (`null`
 * takes it out).
 */
function TransitionItem({
  scope,
  row,
  drag,
  edits,
}: {
  scope: Scope;
  row: TransitionRow;
  drag: (e: React.PointerEvent) => void;
  edits: (next: ListEntry[] | null) => ReturnType<Scope["edits"]>;
}) {
  const commit = (next: ListEntry[] | null) => void scope.editor.commit(edits(next));
  const remove = (
    <Toggle icon="minus" title="Remove this transition" onClick={() => commit(null)} />
  );
  const hide = () => commit(row.entries.map((e) => ({ ...e, hidden: !row.hidden })));
  // In the gutter it's the same eye as Fill's and Effects'.
  const eye = (
    <Toggle
      icon={row.hidden ? "eyeOff" : "eye"}
      title={row.hidden ? "Show" : "Hide"}
      onClick={hide}
    />
  );
  const timing = row.timing;
  const seen = partialTransition(row.entries[0]?.css ?? "");
  const seenMs = seen.duration === undefined ? null : msOf(seen.duration);
  if (timing === null) {
    return (
      <Row action={remove}>
        <RowBody
          onPointerDown={drag}
          hidden={row.hidden}
          title="A transition the controls can't show"
        >
          <EyeButton hidden={row.hidden} onClick={hide} />
          <RowName>{label(seen.property)}</RowName>
          {seenMs !== null && <RowNote>{seenMs} ms</RowNote>}
          <CustomChip
            title="Custom transition: a part the controls can't show. Reset keeps what animates and how long, with a plain easing."
            onReset={() =>
              commit(row.entries.map((e) => ({ css: resetTransition(e.css), hidden: e.hidden })))
            }
          />
        </RowBody>
      </Row>
    );
  }
  const set = ({ property, ...change }: Partial<typeof timing> & { property?: string }) =>
    rowEntries(property ?? row.property, { ...timing, ...change }, row.hidden);
  /** A field's scope whose changes are this row's new parts, so it previews and keeps as one edit. */
  const rowScope: Scope = {
    ...scope,
    edits: (c: Changes) => edits(set(c as Partial<typeof timing>)),
    commit: (c: Changes) => void scope.editor.commit(edits(set(c as Partial<typeof timing>))),
  };
  const time = (key: "duration" | "delay", label: string) => {
    const v = timing[key];
    const token = tokenIn(v);
    const ms = msOf(v);
    return (
      <Field
        scope={rowScope}
        label={label}
        title={token ? `${token}: ${resolve(scope, token) ?? "not defined"}` : label}
        text={token ?? (ms === null ? "" : String(ms))}
        token={token !== null}
        toChanges={(typed) => {
          const t = typed.trim();
          if (/^--[\w-]+$/.test(t)) return { [key]: `var(${t})` };
          const n = numberOf(t);
          if (!n) return null;
          const unit = n.unit === "s" ? 1000 : 1;
          return { [key]: `${Math.max(0, n.value * unit)}ms` };
        }}
        scrub={
          ms === null
            ? null
            : { start: ms, step: 10, to: (n) => ({ [key]: `${Math.max(0, Math.round(n))}ms` }) }
        }
        min={0}
        unit={token ? "" : "ms"}
      />
    );
  };
  const options = PROPERTIES.some(([p]) => p === row.property)
    ? PROPERTIES
    : [...PROPERTIES, [row.property, propName(row.property)] as const];
  const easingToken = tokenIn(timing.easing);
  const named = EASINGS.find(([e]) => e === timing.easing)?.[1];
  const easingTokens = Object.keys(scope.tokens.tokens).filter((name) =>
    isEasing(`var(${name})`, (t) => resolve(scope, t)),
  );
  return (
    <>
      <Row action={eye}>
        <RowBody onPointerDown={drag} hidden={row.hidden} title="What animates">
          <Popup
            title="What animates"
            icon="chevronDown"
            items={options.map(([property, label]) => ({
              key: property,
              label,
              checked: property === row.property,
              run: () => commit(set({ property })),
            }))}
            empty=""
          >
            <RowName>{options.find(([p]) => p === row.property)?.[1]}</RowName>
          </Popup>
        </RowBody>
        <RowBody title="Easing" hidden={row.hidden}>
          <Popup
            title="Pick an easing"
            icon="chevronDown"
            items={[
              ...EASINGS.map(([css, label]) => ({
                key: css,
                label,
                checked: css === timing.easing,
                run: () => commit(set({ easing: css })),
              })),
              ...(easingTokens.length > 0
                ? [{ key: "sep", label: "", separator: true, run: () => {} }]
                : []),
              ...easingTokens.map((name) => ({
                key: name,
                label: name,
                checked: name === easingToken,
                run: () => commit(set({ easing: `var(${name})` })),
              })),
            ]}
            empty=""
          >
            {easingToken ? (
              <RowName>
                <TokenChip
                  name={easingToken}
                  title={`${easingToken}: ${resolve(scope, easingToken) ?? "not defined"}`}
                />
              </RowName>
            ) : named ? (
              <RowName>{named}</RowName>
            ) : (
              <RowName>
                <span title="Custom curve: one the named easings don't cover">Custom</span>
              </RowName>
            )}
          </Popup>
        </RowBody>
      </Row>
      <Heads captions={["Duration", "Delay"]}>
        <Row action={remove}>
          {time("duration", "Duration")}
          {time("delay", "Delay")}
        </Row>
      </Heads>
    </>
  );
}
