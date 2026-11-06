"use client";

import * as stylex from "@stylexjs/stylex";
import { Children, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { alphaOf, hexOf, opaque, paintedHex, resolveVars, setAlpha } from "@/design/editing/colors";
import type { Editor } from "@/design/editing/editor";
import {
  bare,
  customOf,
  parseInput,
  type Reading,
  shown,
  shownAs,
  tokenOf,
} from "@/design/editing/inspect";
import { isColor } from "@/lib/tokens";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { numberOf, ScrubLabel, useDraftField } from "../DraftField";
import type { IconName } from "@/lib/icons";
import { Icon } from "../Icons";
import { useDismiss } from "../useDismiss";
import { Dropdown, Menu, type MenuItem } from "../Menu";
import type { Geometry, GeometryFacts } from "./geometry";
import {
  type Changes,
  matchingTokens,
  pairOf,
  rawOf,
  readOf,
  resolve,
  type Scope,
  type TokenKind,
} from "./scope";

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  // A section with nothing in it is only its header, so it takes no room below.
  const empty = Children.toArray(children).length === 0;
  return (
    <section aria-label={title} {...stylex.props(styles.section, empty && styles.sectionEmpty)}>
      <div {...stylex.props(styles.sectionHead)}>
        <span>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A line of fields, with room on the right for the button that acts on them. */
export function Row({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.row)}>
      {children}
      {action && <span {...stylex.props(styles.rowAction)}>{action}</span>}
    </div>
  );
}

/** A square icon button; with `pressed`, a toggle that shows when it's on. */
export function Toggle({
  icon,
  title,
  pressed,
  accent = false,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  title: string;
  pressed?: boolean;
  /** On in a second way, in the brand color. */
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      {...stylex.props(
        styles.iconButton,
        pressed && styles.iconButtonOn,
        accent && styles.iconButtonAccent,
        disabled && styles.iconButtonOff,
      )}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

/** Properties whose numbers scrub by a hundredth a pixel. */
const FRACTIONS = new Set(["opacity", "line-height"]);
/** Properties without a unit. */
const UNITLESS = new Set([
  "opacity",
  "line-height",
  "font-weight",
  "z-index",
  "flex-grow",
  "flex-shrink",
]);

/** Which kind of token each property takes, for the ◇ picker. */
const TOKEN_KINDS: Readonly<Record<string, TokenKind>> = {
  gap: "length",
  padding: "length",
  "border-radius": "length",
  width: "length",
  height: "length",
};

/**
 * One CSS property as a field. What's typed shows as it's typed; Enter or
 * leaving keeps it, Escape puts the shown value back. The leading icon or
 * letter scrubs a number. A token shows by name, with what it stands for
 * after it. A value the field can't show as a number, a keyword or a
 * token, like a `calc()`, shows as a Custom chip. A color property is the
 * shared color row, `ColorField`.
 */
export function StyleField({
  scope,
  prop,
  title,
  icon,
  letter,
  before,
  unit,
  tokens = TOKEN_KINDS[prop],
  color = false,
  menu = false,
  small = false,
  grow = false,
  center = false,
  bareTokens = false,
  chip = false,
  extra,
  extraOn = false,
  empty,
  show,
  tag,
  options,
  custom = customOf,
  also,
  axis,
}: {
  scope: Scope;
  prop: string;
  /** Reads and writes both of these longhands as one value, like a box's left and right. */
  axis?: readonly [string, string];
  title: string;
  icon?: IconName;
  letter?: string;
  /** Leads the field in place of an icon or letter. */
  before?: ReactNode;
  /** Shown after a plain value. */
  unit?: string;
  tokens?: TokenKind;
  color?: boolean;
  /** Picks tokens from a ▾ list instead of the ◇ button. */
  menu?: boolean;
  small?: boolean;
  /** The small field takes the room left in its row. */
  grow?: boolean;
  center?: boolean;
  /** Leaves out what a token stands for, where there's no room. */
  bareTokens?: boolean;
  /** Shows a token as the number it stands for, with its name in a chip after it. */
  chip?: boolean;
  /** An action on this field, kept at its end with the ◇ until the pointer is over it. */
  extra?: ReactNode;
  /** The action is on, so it stays shown. */
  extraOn?: boolean;
  /** The placeholder when nothing reads. */
  empty?: string;
  /** How a value shows; lengths drop their `px` by default. */
  show?: (raw: string) => string;
  /** A note after the value, from what it resolves to. */
  tag?: (resolved: string) => string | null;
  /** Values to pick from a ▾ list, as [label, CSS]. */
  options?: ReadonlyArray<readonly [string, string]>;
  /** Why a value can't show in the field, in plain words, or `null` when it can. */
  custom?: (raw: string) => string | null;
  /** More styles to set with each value, like a centered stroke's offset. */
  also?: (value: string | null) => Changes;
}) {
  const reading = axis ? pairOf(scope, axis) : readOf(scope, prop);
  const raw = rawOf(reading);
  const set = (v: string | null): Changes => ({
    ...(axis ? { [axis[0]]: v, [axis[1]]: v } : { [prop]: v }),
    ...also?.(v),
  });
  if (color) {
    return (
      <ColorField
        scope={scope}
        label={title}
        reading={reading}
        toChanges={set}
        menu={menu}
        small={small}
      />
    );
  }
  if (options) {
    // A list to pick from is one dropdown, text and chevron, with no typing.
    const display = show ?? ((v: string) => shownAs(prop, v));
    const name = raw === undefined ? "" : display(raw);
    const known = options.find(([label, css]) => css === raw || (name && label === name));
    const list = known || raw === undefined ? options : [...options, [name, raw] as const];
    return (
      <Choice
        label={title}
        {...(letter ? { lead: letter } : {})}
        value={reading.kind === "mixed" ? null : (known?.[1] ?? raw ?? "")}
        options={list.map(([label, css]) => [css, label] as const)}
        onPick={(css) => scope.commit(set(css))}
        inherited={reading.kind === "computed"}
      />
    );
  }
  const kind = tokens;
  const token = reading.kind === "value" ? tokenOf(raw ?? "") : null;
  const resolved = token ? resolve(scope, token) : raw;
  const display = show ?? ((v: string) => shownAs(prop, v));
  const why = reading.kind === "value" && raw !== undefined && !token ? custom(raw) : null;
  const { text, placeholder } = shown(
    reading.kind === "value" && raw !== undefined
      ? {
          ...reading,
          raw: token && !(chip && resolved) ? token : display(resolved ?? raw),
          token: null,
        }
      : reading.kind === "computed" && raw !== undefined
        ? { kind: "computed", raw: display(raw) }
        : reading,
  );
  const n = numberOf(resolved ?? "");
  const step = FRACTIONS.has(prop) ? 0.01 : 1;
  const unitOf = n?.unit || (UNITLESS.has(prop) ? "" : "px");
  const note = resolved && tag && !why ? tag(resolved) : null;
  if (menu && kind) {
    // Tokens to pick from are one dropdown over the name, its note and the chevron.
    const list = matchingTokens(scope, kind).map(([name]) => [`var(${name})`, name] as const);
    return (
      <Choice
        label={title}
        {...(letter ? { lead: letter } : {})}
        value={reading.kind === "mixed" ? null : token ? `var(${token})` : display(raw ?? "")}
        options={list}
        onPick={(css) => scope.commit(set(css))}
        note={note}
        mono
        placeholder={empty ?? "—"}
        inherited={reading.kind === "computed"}
      />
    );
  }
  const tokenButton = kind && (
    <TokenButton
      scope={scope}
      kind={kind}
      menu={menu}
      onPick={(name) => scope.commit(set(`var(${name})`))}
    />
  );
  return (
    <Field
      scope={scope}
      label={title}
      title={token ? `${title} (${token}: ${resolved ?? "not defined"})` : title}
      text={text}
      placeholder={placeholder || empty || ""}
      token={token !== null && !chip}
      custom={why ? { title: why, onReset: () => scope.commit(set(null)) } : undefined}
      toChanges={(typed) => set(parseInput(prop, typed))}
      lead={
        before ??
        (icon ? (
          <span {...stylex.props(styles.leadIcon)}>
            <Icon name={icon} size={14} />
          </span>
        ) : (
          letter
        ))
      }
      scrub={{
        start: why ? null : (n?.value ?? (raw === undefined ? 0 : null)),
        step,
        to: (v) => set(`${Math.max(v, prop === "opacity" ? 0 : -1e6)}${unitOf}`),
      }}
      small={small}
      grow={grow}
      center={center}
      {...(!token && !why && unit && raw !== undefined ? { unit } : {})}
      after={
        <>
          {note && <span {...stylex.props(styles.tagNote)}>{note}</span>}
          {chip && token && <span {...stylex.props(styles.tagNote)}>{token.slice(2)}</span>}
          {token && resolved && !chip && !tag && !bareTokens && kind !== "shadow" && (
            <span {...stylex.props(styles.unit)}>{bare(resolved)}</span>
          )}
          {(kind || extra) &&
            (menu ? (
              tokenButton
            ) : (
              <Reveal pinned={extraOn}>
                {extra}
                {tokenButton}
              </Reveal>
            ))}
        </>
      }
    />
  );
}

/** A color as the field names it: its token, its hex, or its keyword; `null` for anything else. */
function colorName(color: string, painted: string | undefined): string | null {
  const token = tokenOf(color);
  if (token) return token;
  if (/^[a-z]+$/i.test(color.trim())) return color.trim().toLowerCase();
  // `hsl()`, `oklch()` or a mix of two colors shows as the hex it paints.
  return hexOf(color) ?? paintedHex(painted);
}

/**
 * The one color row every color in the panel uses: a swatch that opens
 * the picker, the color's token chip or hex, the ◇ token list, the
 * eyedropper and its opacity %. Opacity is edited in the color's own
 * notation (`setAlpha`), so a token keeps its name. `reading` is what
 * shows; `toChanges` the styles for a new color, or `null` to take it off.
 */
export function ColorField({
  scope,
  label,
  reading,
  toChanges,
  menu = false,
  small = false,
  alpha: hasAlpha = true,
  dropper = true,
  fit = false,
  swatch: swatchButton,
  trailing,
}: {
  scope: Scope;
  label: string;
  reading: Reading;
  toChanges: (color: string | null) => Changes;
  /** Ends the field, after its opacity: a row's expand button. */
  trailing?: ReactNode;
  menu?: boolean;
  small?: boolean;
  alpha?: boolean;
  /** Shows the eyedropper; off where there's no room for it. */
  dropper?: boolean;
  /** The color's name is only as wide as its text, as `Field`'s `fit`. */
  fit?: boolean;
  /** Stands in for the swatch that opens the browser's picker, given the color it draws. */
  swatch?: (color: string | undefined) => ReactNode;
}) {
  const raw = rawOf(reading);
  const alpha = raw === undefined ? 100 : alphaOf(raw);
  const base = raw === undefined ? undefined : opaque(raw);
  const token = base !== undefined ? tokenOf(base) : null;
  // Tokens inside a color, like a mix's, resolve so the swatch can paint it.
  const resolved = token
    ? resolve(scope, token)
    : base && resolveVars(base, (n) => resolve(scope, n));
  const name = base !== undefined ? colorName(base, resolved) : null;
  // A new color keeps the opacity the old one had, unless it brings its own.
  const keep = (v: string | null) =>
    v !== null && alpha < 100 && alphaOf(v) === 100 ? setAlpha(v, alpha) : v;
  const why = raw !== undefined && name === null && !isColor(resolved) ? "Custom color" : null;
  const text = reading.kind === "value" && base !== undefined ? (name ?? "") : "";
  const placeholder =
    reading.kind === "mixed"
      ? "Mixed"
      : reading.kind === "computed" && base !== undefined
        ? (name ?? "")
        : "";
  return (
    <Field
      scope={scope}
      label={label}
      title={token ? `${label} (${token}: ${resolved ?? "not defined"})` : label}
      text={text}
      placeholder={placeholder}
      token={token !== null}
      custom={
        why && reading.kind === "value"
          ? {
              title: `${why}: one the controls can't show`,
              onReset: () => scope.commit(toChanges(null)),
            }
          : undefined
      }
      toChanges={(typed) => toChanges(keep(parseInput("color", typed)))}
      lead={
        swatchButton ? (
          swatchButton(isColor(resolved) ? resolved : undefined)
        ) : (
          <ColorSwatch
            scope={scope}
            swatch={isColor(resolved) ? resolved : undefined}
            toChanges={(c) => toChanges(keep(c))}
          />
        )
      }
      small={small}
      fit={fit}
      after={
        <>
          <Reveal>
            <TokenButton
              scope={scope}
              kind="color"
              menu={menu}
              onPick={(t) => scope.commit(toChanges(keep(`var(${t})`)))}
            />
            {dropper && <EyeDropperButton onPick={(c) => scope.commit(toChanges(keep(c)))} />}
          </Reveal>
          {hasAlpha && raw !== undefined && (
            <AlphaChip scope={scope} alpha={alpha} toChanges={(a) => toChanges(setAlpha(raw, a))} />
          )}
          {trailing}
        </>
      }
    />
  );
}

/**
 * A value the controls can't show: a neutral chip whose tooltip says what
 * it is. Clicking it types a new value over it; × takes it off.
 */
export function CustomChip({
  title,
  onEdit,
  onReset,
}: {
  title: string;
  onEdit?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
}) {
  return (
    <span {...stylex.props(styles.custom)}>
      <button
        type="button"
        title={title}
        aria-label={`Custom: ${title}`}
        onClick={onEdit}
        disabled={!onEdit}
        {...stylex.props(styles.customLabel)}
      >
        Custom
      </button>
      {onReset && (
        <button
          type="button"
          title="Reset: take this value off"
          aria-label="Reset"
          onClick={onReset}
          {...stylex.props(styles.customReset)}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

/**
 * A caption over a group of fields whose meaning isn't plain from the
 * fields: small, muted, close to its fields, and apart from the group
 * before it.
 */
export function Labeled({
  caption,
  apart = false,
  children,
}: {
  caption?: string | undefined;
  /** Sets it a step further from what's above, for the groups of one section. */
  apart?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={caption} {...stylex.props(styles.labeled, apart && styles.apart)}>
      {caption && <span {...stylex.props(styles.caption)}>{caption}</span>}
      <div {...stylex.props(styles.labeledBody)}>{children}</div>
    </div>
  );
}

/** A caption over each half of a two-field row, as the row's column heads. */
export function Heads({
  captions,
  children,
}: {
  captions: readonly [string, string];
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.heads)}>
      <div {...stylex.props(styles.pair, styles.inset)}>
        <span {...stylex.props(styles.caption)}>{captions[0]}</span>
        <span {...stylex.props(styles.caption)}>{captions[1]}</span>
      </div>
      {children}
    </div>
  );
}

/** Actions a field keeps out of sight until the pointer is over it or focus is inside it. */
export function Reveal({
  pinned = false,
  children,
}: {
  /** Stays shown, like a toggle that's on. */
  pinned?: boolean;
  children: ReactNode;
}) {
  return <span {...stylex.props(styles.reveal, pinned && styles.revealPinned)}>{children}</span>;
}

/** Several icon buttons side by side, as a section header's action. */
export function Actions({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.actions)}>{children}</span>;
}

/**
 * The shell every field shares: a lead that scrubs `scrub`'s number, a text
 * input that previews `toChanges` as it's typed, and whatever comes `after`.
 * With `custom`, a Custom chip stands in for the input until it's clicked.
 */
export function Field({
  scope,
  label,
  title,
  text,
  placeholder = "",
  token = false,
  custom,
  toChanges,
  lead,
  scrub,
  after,
  unit,
  small = false,
  center = false,
  narrow = false,
  short = false,
  fit = false,
  grow = false,
}: {
  scope: Scope;
  label: string;
  title?: string;
  text: string;
  placeholder?: string;
  token?: boolean;
  custom?: { readonly title: string; readonly onReset: () => void } | undefined;
  toChanges: (typed: string) => Changes | null;
  lead?: ReactNode;
  scrub?: { start: number | null; step?: number; to: (value: number) => Changes } | null;
  after?: ReactNode;
  /** Shown after the value, like `px`. */
  unit?: string;
  small?: boolean;
  center?: boolean;
  /** A short number beside a row's body. */
  narrow?: boolean;
  /** A number of a few digits beside another field, like a gradient stop's position. */
  short?: boolean;
  /** The input is only as wide as its text, and the room after it belongs to the row, which a click there opens. */
  fit?: boolean;
  /** A small field that still takes the room left in its row, to the row's right edge. */
  grow?: boolean;
}) {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const field = useDraftField(
    scope.editor,
    custom ? "" : text,
    (typed) => {
      const changes = toChanges(typed);
      return changes ? scope.edits(changes) : null;
    },
    placeholder,
  );
  const chip = custom && !replacing;
  // Words, like Auto or No limit, read in the UI font; numbers, hex and token names stay mono.
  const words = /^[a-z]/i.test(field.props.value || placeholder);
  return (
    <div
      title={chip ? custom.title : title}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.field,
        small && styles.fieldSmall,
        center && styles.fieldCenter,
        narrow && styles.fieldNarrow,
        short && styles.fieldShort,
        grow && styles.fieldGrow,
      )}
    >
      {lead !== undefined &&
        (scrub ? (
          <ScrubLabel
            editor={scope.editor}
            start={scrub.start}
            step={scrub.step ?? 1}
            toEdits={(v) => scope.edits(scrub.to(v))}
            style={styles.lead}
          >
            {lead}
          </ScrubLabel>
        ) : (
          <span {...stylex.props(styles.lead)}>{lead}</span>
        ))}
      {chip ? (
        <span {...stylex.props(styles.customSlot)}>
          <CustomChip
            title={custom.title}
            onEdit={() => setReplacing(true)}
            onReset={custom.onReset}
          />
        </span>
      ) : (
        <input
          id={id}
          aria-label={label}
          placeholder={placeholder}
          // Only when the Custom chip was clicked to type over it.
          autoFocus={replacing}
          {...field.props}
          onBlur={() => {
            field.props.onBlur();
            setReplacing(false);
          }}
          {...stylex.props(
            styles.input,
            fit && !unit && styles.inputFit,
            words && styles.inputWords,
            token && !field.typing && styles.token,
          )}
        />
      )}
      {fit && !unit && <span {...stylex.props(styles.fieldRoom)} />}
      {unit && !chip && (
        <>
          {/* The number is at the field's left and its unit, muted, at the right end. */}
          {scrub ? (
            // The unit scrubs the number, as its lead does.
            <ScrubLabel
              editor={scope.editor}
              start={scrub.start}
              step={scrub.step ?? 1}
              toEdits={(v) => scope.edits(scrub.to(v))}
              style={styles.unit}
            >
              {unit}
            </ScrubLabel>
          ) : (
            <span {...stylex.props(styles.unit)}>{unit}</span>
          )}
        </>
      )}
      {after}
    </div>
  );
}

/** A color's swatch, which opens the browser's picker; each color picked shows at once. */
export function ColorSwatch({
  scope,
  swatch,
  toChanges,
}: {
  scope: Scope;
  swatch: string | undefined;
  toChanges: (color: string) => Changes;
}) {
  const draft = useRef<ReturnType<Editor["begin"]> | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  // The picker closing fires `change`; React's onChange is every `input`.
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const keep = () => {
      draft.current?.commit();
      draft.current = null;
    };
    input.addEventListener("change", keep);
    return () => {
      input.removeEventListener("change", keep);
      keep();
    };
  }, []);
  return (
    <span {...stylex.props(styles.swatch)} style={{ background: swatch ?? "transparent" }}>
      <input
        ref={ref}
        type="color"
        aria-label="Pick a color"
        tabIndex={-1}
        value={paintedHex(swatch) ?? "#000000"}
        onChange={(e) => {
          draft.current ??= scope.editor.begin({ onLost: () => (draft.current = null) });
          draft.current.preview(scope.edits(toChanges(e.target.value)));
        }}
        onBlur={() => {
          draft.current?.commit();
          draft.current = null;
        }}
        {...stylex.props(styles.picker)}
      />
    </span>
  );
}

/** The browser's eyedropper, where it has one: picks a color from anywhere on the screen. */
export function EyeDropperButton({ onPick }: { onPick: (color: string) => void }) {
  type Dropper = { open(): Promise<{ sRGBHex: string }> };
  const Ctor = (globalThis as { EyeDropper?: new () => Dropper }).EyeDropper;
  if (!Ctor) return null;
  return (
    <button
      type="button"
      title="Pick a color from the screen"
      aria-label="Pick a color from the screen"
      onClick={() =>
        new Ctor().open().then(
          (r) => onPick(r.sRGBHex),
          () => {},
        )
      }
      {...stylex.props(styles.fieldButton)}
    >
      <Icon name="eyedropper" size={14} />
    </button>
  );
}

/** A color's opacity as a percentage to type, step or scrub. */
export function AlphaChip({
  scope,
  alpha,
  toChanges,
}: {
  scope: Scope;
  alpha: number;
  toChanges: (alpha: number) => Changes;
}) {
  const field = useDraftField(scope.editor, `${alpha}%`, (typed) => {
    const n = parseFloat(typed);
    return Number.isFinite(n) ? scope.edits(toChanges(n)) : null;
  });
  return (
    <input
      aria-label="Opacity"
      title="Opacity"
      {...field.props}
      {...stylex.props(styles.chip)}
      size={4}
    />
  );
}

const KIND_NAMES: Readonly<Record<TokenKind, string>> = {
  color: "color",
  length: "size",
  shadow: "shadow",
  font: "text style",
  family: "font",
};

/** The ◇ (or ▾) button that lists the design's tokens of one kind, to use one. */
export function TokenButton({
  scope,
  kind,
  menu,
  onPick,
}: {
  scope: Scope;
  kind: TokenKind;
  menu: boolean;
  onPick: (name: string) => void;
}) {
  const items = matchingTokens(scope, kind).map(([name, value]) => ({
    key: name,
    label: name,
    note: kind === "color" || kind === "shadow" ? undefined : bare(value),
    swatch:
      kind === "color"
        ? { background: value }
        : kind === "shadow"
          ? { boxShadow: value }
          : undefined,
    run: () => onPick(name),
  }));
  return (
    <Popup
      title={`Pick a ${KIND_NAMES[kind]} token`}
      icon={menu ? "chevronDown" : "token"}
      items={items}
      empty={`This design has no ${KIND_NAMES[kind]} tokens yet. Add them under Tokens.`}
    />
  );
}

/** A section's + button, with a menu of what it can add. */
export function AddMenu({
  title,
  items,
}: {
  title: string;
  /** What it can add, as [label, icon, add]; a `null` is a line between groups. */
  items: ReadonlyArray<readonly [string, IconName, () => void] | null>;
}) {
  return (
    <Popup
      title={title}
      icon="plus"
      big
      items={items.map((item, i) =>
        item === null
          ? { key: `sep${i}`, label: "", separator: true, run: () => {} }
          : { key: item[0], label: item[0], icon: item[1], run: item[2] },
      )}
      empty=""
    />
  );
}

/** A button that opens a menu under it; picking an item, Escape or a click elsewhere closes it. */
export function Popup({
  title,
  icon,
  items,
  empty,
  big = false,
  children,
}: {
  title: string;
  icon: IconName;
  items: ReadonlyArray<MenuItem>;
  empty: string;
  big?: boolean;
  /** The text the button covers with its chevron, as the one trigger of a row that shows it. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        {...(children
          ? stylex.props(styles.coverButton)
          : stylex.props(
              big ? styles.iconButton : styles.fieldButton,
              open && styles.iconButtonOn,
            ))}
      >
        {children}
        <span {...stylex.props(icon === "chevronDown" && open && styles.chevronOpen)}>
          <Icon name={icon} size={big ? 16 : icon === "chevronDown" ? 12 : 14} />
        </span>
      </button>
      {open && button.current && (
        // Under the field the button sits in, right-aligned with it.
        <Menu
          title={title}
          items={items}
          empty={empty}
          anchor={button.current.parentElement ?? button.current}
          trigger={button.current}
          align={children ? "left" : "right"}
          matchWidth={!!children}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * A field that picks one of `options`, from the app's own menu. The whole
 * field, its text and its chevron, is one button with no chrome of its own.
 */
export function Choice({
  label,
  value,
  options,
  onPick,
  icon,
  lead,
  mono = false,
  bare = false,
  small = false,
  disabled = false,
  inherited = false,
  note,
  placeholder = "—",
  title,
}: {
  label: string;
  value: string | null;
  options: ReadonlyArray<readonly [string, string]>;
  onPick: (value: string) => void;
  /** A quiet note after the value, like a text style's size. */
  note?: string | null;
  /** What shows when there's no value. */
  placeholder?: string;
  icon?: IconName;
  /** A short word before the value, like a field's letter. */
  lead?: string;
  /** The value is a token name or a number, so it shows in the code font. */
  mono?: boolean;
  /** Without a field's box, inside a list's row. */
  bare?: boolean;
  /** Without a field's box, as a short note at the end of another field. */
  small?: boolean;
  disabled?: boolean;
  /** The value is what the browser draws, not one the layer sets: shown faint, like a placeholder. */
  inherited?: boolean;
  title?: string | undefined;
}) {
  const known = options.find(([v]) => v === value);
  return (
    <div
      title={title ?? label}
      {...stylex.props(
        small ? styles.choiceSmall : bare ? styles.choiceBare : styles.field,
        styles.choice,
        !small && !bare && styles.choiceBox,
      )}
    >
      <Dropdown
        label={label}
        title={title ?? label}
        value={known ? value : null}
        options={options}
        onPick={onPick}
        disabled={disabled}
        style={[
          styles.choiceButton,
          !small && !bare && styles.choiceButtonBox,
          small && styles.choiceButtonSmall,
        ]}
      >
        {(open) => (
          <>
            {icon && (
              <span {...stylex.props(styles.leadIcon)}>
                <Icon name={icon} size={14} />
              </span>
            )}
            {lead && <span {...stylex.props(styles.lead)}>{lead}</span>}
            <span
              {...stylex.props(
                styles.choiceText,
                mono && known && styles.choiceTextMono,
                bare && styles.choiceTextBare,
                small && styles.choiceTextSmall,
                inherited && styles.choiceTextInherited,
                disabled && styles.choiceTextOff,
              )}
            >
              {known ? known[1] : value === null ? "Mixed" : value || placeholder}
            </span>
            {note && <span {...stylex.props(styles.tagNote)}>{note}</span>}
            <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
              <Icon name="chevronDown" size={12} />
            </span>
          </>
        )}
      </Dropdown>
    </div>
  );
}

export function Segments<T extends string>({
  label,
  value,
  options,
  onPick,
  blocked,
}: {
  label: string;
  value: string | null;
  /** Why a segment can't be picked now, by its value; it's left out, and the group's tooltip says why. */
  blocked?: Readonly<Partial<Record<T, string>>>;
  /** [value, icon, name], and what a segment without an icon shows when not its name, like `AA`. */
  options: ReadonlyArray<
    readonly [T, IconName | null, string] | readonly [T, IconName | null, string, string]
  >;
  onPick: (value: T) => void;
}) {
  const open = options.filter(([option]) => blocked?.[option] === undefined);
  // Nothing to choose between: one place left, or none.
  if (open.length < 2) return null;
  const why: string | undefined = Object.values<string | undefined>(blocked ?? {})[0];
  return (
    <div role="radiogroup" aria-label={label} title={why} {...stylex.props(styles.segments)}>
      {open.map(([option, icon, name, short]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          aria-label={name}
          title={name}
          onClick={() => value !== option && onPick(option)}
          {...stylex.props(
            styles.segment,
            !icon && styles.segmentWord,
            value === option && styles.segmentOn,
            value === option && !icon && styles.segmentWordOn,
          )}
        >
          {icon ? <Icon name={icon} size={14} /> : (short ?? name)}
        </button>
      ))}
    </div>
  );
}

/**
 * A point on a box as a 3×3 grid of dots, like a transform's origin or a
 * gradient's center. `cell` is the one that's on, or `null` when the point
 * is off the grid; clicking a dot picks it.
 */
export function PointGrid({
  label,
  cell,
  onPick,
}: {
  label: string;
  cell: { x: number; y: number } | null;
  onPick: (x: number, y: number) => void;
}) {
  return (
    <div role="group" aria-label={label} {...stylex.props(styles.pointGrid)}>
      {[0, 1, 2].flatMap((y) =>
        [0, 1, 2].map((x) => {
          const on = cell?.x === x && cell.y === y;
          const name = `${["Top", "Middle", "Bottom"][y]} ${["left", "center", "right"][x]}`;
          return (
            <button
              key={`${x}${y}`}
              type="button"
              aria-pressed={on}
              aria-label={name}
              title={name}
              onClick={() => !on && onPick(x, y)}
              {...stylex.props(styles.pointCell)}
            >
              <span {...stylex.props(styles.pointDot, on && styles.pointDotOn)} />
            </button>
          );
        }),
      )}
    </div>
  );
}

/** One of X, Y, W and H: typed, stepped or scrubbed, shown on the canvas as it changes. */
export function GeometryField({
  field,
  editor,
  geometry,
  small = false,
  after,
}: {
  field: Geometry;
  editor: Editor;
  geometry: GeometryFacts;
  small?: boolean;
  /** Ends the field, like a size's mode. */
  after?: ReactNode;
}) {
  const value = geometry.values[field];
  const disabled = (field === "x" || field === "y") && !geometry.movable;
  const latest = useRef(geometry.editFor);
  latest.current = geometry.editFor;
  // Each edit states where it ends up, from the node as drawn now, so a
  // preview that replaces the last one still lands on `n`.
  const toEdits = (n: number) => {
    const edit = latest.current(field, n);
    return edit ? [edit] : null;
  };
  const input = useDraftField(editor, String(Math.round(value)), (text) =>
    toEdits(parseFloat(text)),
  );
  const label = { x: "X position", y: "Y position", w: "Width", h: "Height" }[field];
  return (
    <label title={label} {...stylex.props(styles.field, small && styles.fieldSmall)}>
      <ScrubLabel
        editor={editor}
        start={disabled ? null : Math.round(value)}
        toEdits={(n) => toEdits(field === "w" || field === "h" ? Math.max(n, 0) : n)}
        style={styles.lead}
      >
        {field.toUpperCase()}
      </ScrubLabel>
      <input
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        title={disabled ? "Its layout places it; drag it to reorder it" : undefined}
        {...input.props}
        {...stylex.props(styles.input)}
      />
      {after}
    </label>
  );
}

/**
 * The rows of one list, like a layer's shadows, in its order: the first
 * entry is the top row. Dragging a row by its background moves it to where
 * it's dropped, as one edit; a click without a drag calls `onClick`.
 */
export function DragList({
  count,
  onMove,
  children,
}: {
  count: number;
  onMove: (from: number, to: number) => void;
  children: (index: number, drag: (e: React.PointerEvent) => void) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ from: number; to: number } | null>(null);
  const start = (from: number) => (e: React.PointerEvent) => {
    // Fields, buttons and menus inside the row keep their own pointer.
    if ((e.target as HTMLElement).closest("input, button") || e.button !== 0) return;
    const rows = [...(list.current?.children ?? [])] as HTMLElement[];
    const y0 = e.clientY;
    let to = from;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      to = rows.filter(
        (r) => r.getBoundingClientRect().top + r.offsetHeight / 2 < ev.clientY,
      ).length;
      setDrop({ from, to });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrop(null);
      // Dropping below itself lands after the row it passed.
      const at = to > from ? to - 1 : to;
      if (moved && at !== from) onMove(from, at);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={list} {...stylex.props(styles.list)}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          {...stylex.props(
            styles.listItem,
            drop?.from === i && styles.listDragged,
            drop !== null && drop.to === i && drop.to !== drop.from && styles.dropAbove,
            drop !== null && i === count - 1 && drop.to === count && styles.dropBelow,
          )}
        >
          {children(i, start(i))}
        </div>
      ))}
    </div>
  );
}

/** The chevron that opens a row's details beneath it, and closes them. */
export function ExpandButton({
  open,
  title,
  onClick,
}: {
  open: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={open ? `Hide ${title.toLowerCase()}` : title}
      aria-label={title}
      aria-expanded={open}
      onClick={onClick}
      {...stylex.props(styles.fieldButton, open && styles.expandOpen)}
    >
      <Icon name="chevronDown" size={12} />
    </button>
  );
}

/** The eye in a list row's gutter, as a toggle: hides the entry without losing it, or shows it again. */
export function EyeToggle({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <Toggle icon={hidden ? "eyeOff" : "eye"} title={hidden ? "Show" : "Hide"} onClick={onClick} />
  );
}

/** The row that stands for a list the selected layers don't share, with a way to clear it from all of them. */
export function MixedRow({ what, onRemove }: { what: string; onRemove: () => void }) {
  return (
    <Row
      action={
        <Toggle icon="minus" title={`Remove the ${what} from every layer`} onClick={onRemove} />
      }
    >
      <RowBody title={`The selected layers have different ${what}`}>
        <RowName>Mixed</RowName>
      </RowBody>
    </Row>
  );
}

/** The eye on a list's row: hides the entry without losing it, or shows it again. */
export function EyeButton({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  const title = hidden ? "Show" : "Hide";
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={hidden}
      onClick={onClick}
      {...stylex.props(styles.eye, hidden && styles.eyeOff)}
    >
      <Icon name={hidden ? "eyeOff" : "eye"} size={14} />
    </button>
  );
}

/**
 * The body of a list's row, shaped like a field: what's inside it, and a
 * click on its background that opens the row's details.
 */
export function RowBody({
  children,
  open,
  onToggle,
  onPointerDown,
  hidden = false,
  title,
}: {
  children: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  onPointerDown?: ((e: React.PointerEvent) => void) | undefined;
  hidden?: boolean;
  title?: string | undefined;
}) {
  return (
    <div
      title={title}
      aria-expanded={onToggle ? open : undefined}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("input, button")) onToggle?.();
      }}
      {...stylex.props(
        styles.field,
        styles.rowBody,
        open && styles.rowBodyOpen,
        hidden && styles.rowBodyHidden,
      )}
    >
      {children}
    </div>
  );
}

/** A name inside a row's body, like "Layer blur". */
export function RowName({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.rowName)}>{children}</span>;
}

/** A quiet note inside a row's body, like a summary. */
export function RowNote({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.unit)}>{children}</span>;
}

/** A token's name as a chip, in the brand color. */
export function TokenChip({ name, title }: { name: string; title?: string }) {
  return (
    <span title={title} {...stylex.props(styles.tokenChip)}>
      {name}
    </span>
  );
}

/** A block of fields laid out one of the panel's ways, lined up with the rows' fields. */
export function Block({
  kind,
  children,
}: {
  kind: "inset" | "triple" | "quad" | "pair" | "pairTight" | "stack" | "stackLoose" | "align";
  children: ReactNode;
}) {
  const layout = {
    inset: [styles.inset],
    triple: [styles.triple, styles.inset],
    quad: [styles.quad, styles.inset],
    pair: [styles.pair, styles.inset],
    pairTight: [styles.pairTight],
    stack: [styles.stack],
    stackLoose: [styles.stackLoose, styles.inset],
    align: [styles.alignRow, styles.inset],
  }[kind];
  return <div {...stylex.props(...layout)}>{children}</div>;
}

/** A color as a small square, for a row that shows it without a picker. */
export function PaintDot({ color }: { color: string | undefined }) {
  return <span {...stylex.props(styles.swatch)} style={{ background: color ?? "transparent" }} />;
}

/** A small faint icon that leads a field, turned by `turn` degrees. */
export function LeadIcon({
  name,
  size = 14,
  turn,
}: {
  name: IconName;
  size?: number;
  turn?: number;
}) {
  return (
    <span {...stylex.props(styles.leadIcon)} style={turn ? { rotate: `${turn}deg` } : undefined}>
      <Icon name={name} size={size} />
    </span>
  );
}

/**
 * A panel for a row's details, like a gradient's stops, beside the
 * inspector and level with `anchor`. Escape or a press outside it (and
 * outside `anchor` and any menu it opened) closes it.
 */
export function Popover({
  anchor,
  title,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useDismiss({
    contains: (t) => Boolean(panel.current?.contains(t) || anchor?.contains(t)),
    onClose,
    enabled: anchor !== null,
  });
  useEffect(() => {
    if (!anchor) return;
    const place = () => {
      const row = anchor.getBoundingClientRect();
      const side = anchor.closest("[aria-label='Inspector']")?.getBoundingClientRect() ?? row;
      const height = panel.current?.offsetHeight ?? 0;
      setAt({
        top: Math.max(8, Math.min(row.top, window.innerHeight - height - 8)),
        right: window.innerWidth - side.left + 8,
      });
    };
    place();
    const resize = new ResizeObserver(place);
    if (panel.current) resize.observe(panel.current);
    window.addEventListener("resize", place);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={title}
      style={at ?? { top: 0, right: 0, visibility: "hidden" }}
      {...stylex.props(styles.popover)}
    >
      {children}
    </div>,
    document.body,
  );
}

/** A 3×3 grid of cells to pick one, like where an image sits; `cell` is the one picked. */
export function CellGrid({
  label,
  cell,
  onPick,
}: {
  label: string;
  cell: { x: number; y: number } | null;
  onPick: (x: number, y: number) => void;
}) {
  return (
    <div role="group" aria-label={label} title={label} {...stylex.props(styles.cells)}>
      {[0, 1, 2].flatMap((y) =>
        [0, 1, 2].map((x) => {
          const on = cell?.x === x && cell.y === y;
          const name = `${["Top", "Middle", "Bottom"][y]} ${["left", "center", "right"][x]}`;
          return (
            <button
              key={`${x}${y}`}
              type="button"
              aria-pressed={on}
              aria-label={name}
              title={name}
              onClick={() => onPick(x, y)}
              {...stylex.props(styles.cell)}
            >
              <span {...stylex.props(styles.cellDot, on && styles.cellDotOn)} />
            </button>
          );
        }),
      )}
    </div>
  );
}

/** The room a row keeps on its right for its button: the button and a gap. */
const ACTION = `calc(${size.xs} + ${space.sm})`;

const styles = stylex.create({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.ms,
    paddingInline: space.ms,
    borderTopWidth: { default: 1, ":first-of-type": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  labeled: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    minWidth: 0,
  },
  labeledBody: { display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 },
  apart: { marginTop: space.sm },
  heads: { display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 },
  caption: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: "16px",
  },
  sectionEmpty: { paddingBottom: space.sm },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: size.xs,
    color: colors.text,
    fontSize: 12,
    lineHeight: "16px",
    fontWeight: 500,
  },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingRight: ACTION,
  },
  rowAction: {
    position: "absolute",
    top: `calc((${size.sm} - ${size.xs}) / 2)`,
    right: 0,
    display: "flex",
  },
  /** Lines up a block that isn't a row with the rows' fields. */
  inset: { marginRight: ACTION },
  iconButton: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: size.xs,
    height: size.xs,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  iconButtonAccent: { color: colors.brandText },
  iconButtonOff: { opacity: 0.4, cursor: "default" },
  iconButtonOn: {
    backgroundColor: colors.sunk,
    boxShadow: shadows.inset,
    color: colors.text,
  },
  field: {
    position: "relative",
    flexGrow: 1,
    flexBasis: 0,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    height: size.sm,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: {
      default: "none",
      ":hover": `inset 0 0 0 1px ${colors.border}`,
      ":focus-within": `inset 0 0 0 1px ${colors.borderStrong}`,
    },
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    cursor: "text",
  },
  fieldSmall: { flexGrow: 0, flexBasis: "auto" },
  fieldNarrow: { flexGrow: 0, flexBasis: "auto", width: 87 },
  fieldGrow: { flexGrow: 1, flexBasis: 0 },
  fieldShort: { flexGrow: 0, flexBasis: "auto", width: 63 },
  fieldCenter: { paddingInline: 6, gap: space.xs },
  lead: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    minWidth: 12,
    color: colors.faint,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "16px",
    fontWeight: 500,
  },
  leadIcon: { display: "flex", color: colors.faint },
  unit: {
    flexShrink: 0,
    color: colors.faint,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  },
  tagNote: {
    flexShrink: 0,
    color: colors.faint,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  },
  fieldButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 21,
    height: 21,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    color: { default: colors.faint, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  chip: {
    flexShrink: 0,
    width: 39,
    height: 21,
    marginRight: -3,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: colors.surface,
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    textAlign: "center",
    outline: "none",
  },
  swatch: {
    position: "relative",
    overflow: "hidden",
    width: 12,
    height: 12,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    boxShadow: shadows.edge,
  },
  picker: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    padding: 0,
    borderWidth: 0,
    opacity: 0,
    cursor: "var(--cursor-pointer, pointer)",
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    width: "100%",
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.text, ":disabled": colors.faint },
    fontFamily: fonts.mono,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    textOverflow: "ellipsis",
    outline: "none",
    "::placeholder": { color: colors.faint },
  },
  token: { color: colors.brandText },
  inputWords: { fontFamily: fonts.sans, fontSize: 13 },
  /** Only as wide as what's typed, so a unit can follow it. */
  inputFit: { flexGrow: 0, width: "auto", minWidth: "1ch", fieldSizing: "content" },
  fieldRoom: { flexGrow: 1, alignSelf: "stretch", cursor: "var(--cursor-pointer, pointer)" },
  /** Shown while the pointer is over the field, or focus is in it. */
  reveal: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
      ":has([aria-expanded=true])": 1,
    },
  },
  revealPinned: { opacity: 1 },
  actions: { display: "flex" },
  /** One invisible button over a row's text and its chevron. */
  coverButton: {
    display: "flex",
    alignItems: "center",
    flexGrow: 1,
    gap: space.xs,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    outline: "none",
    cursor: "var(--cursor-pointer, pointer)",
  },
  choiceBare: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    height: "100%",
  },
  choice: { cursor: "var(--cursor-pointer, pointer)" },
  /** The field's own box, whose button fills it to the edge. */
  choiceBox: { paddingInline: 0 },
  choiceSmall: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 3,
    height: "100%",
  },
  /** The one button over a choice's text and chevron. */
  choiceButton: {
    display: "flex",
    alignItems: "center",
    flexGrow: 1,
    gap: space.xs,
    minWidth: 0,
    height: "100%",
    borderRadius: radii.sm,
    color: "inherit",
  },
  choiceButtonBox: { gap: space.sm, paddingInline: space.sm },
  choiceButtonSmall: {
    flexGrow: 0,
    boxShadow: { default: "none", ":focus-visible": `inset 0 0 0 1px ${colors.borderStrong}` },
  },
  choiceText: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  choiceTextMono: { fontFamily: fonts.mono, fontSize: 12 },
  choiceTextOff: { color: colors.muted },
  /** Takes its row's color, so a hidden row dims it. */
  choiceTextInherited: { color: colors.faint },
  choiceTextBare: { color: "inherit" },
  choiceTextSmall: {
    flexGrow: 0,
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: fonts.sans,
    fontSize: 12,
  },
  chevron: { display: "flex", color: colors.faint, pointerEvents: "none" },
  /** The chevron of a dropdown whose menu is open. */
  chevronOpen: { display: "flex", rotate: "180deg" },
  custom: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    height: 21,
    borderRadius: radii.xs,
    backgroundColor: colors.surface,
    color: colors.muted,
  },
  customLabel: {
    height: "100%",
    paddingInline: 6,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: 500,
    cursor: { default: "var(--cursor-pointer, pointer)", ":disabled": "default" },
  },
  customReset: {
    display: "grid",
    placeItems: "center",
    width: 12,
    height: "100%",
    padding: 0,
    marginLeft: -3,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.faint, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  customSlot: { flexGrow: 1, minWidth: 0, display: "flex" },
  list: { display: "flex", flexDirection: "column", gap: space.sm },
  listItem: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  listDragged: { opacity: 0.5 },
  dropAbove: {
    "::before": {
      content: "''",
      position: "absolute",
      top: -6,
      left: 0,
      right: ACTION,
      height: 3,
      borderRadius: 1,
      backgroundColor: colors.brand,
    },
  },
  dropBelow: {
    "::after": {
      content: "''",
      position: "absolute",
      bottom: -6,
      left: 0,
      right: ACTION,
      height: 3,
      borderRadius: 1,
      backgroundColor: colors.brand,
    },
  },
  eye: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 21,
    height: 21,
    padding: 0,
    marginLeft: -3,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    color: { default: colors.faint, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  eyeOff: { color: colors.muted },
  expandOpen: { rotate: "180deg", color: colors.text },
  rowBody: { cursor: "default", userSelect: "none" },
  rowBodyOpen: { boxShadow: `inset 0 0 0 1px ${colors.border}` },
  rowBodyHidden: { color: colors.faint },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: "20px",
  },
  tokenChip: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.brandText,
  },
  pair: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm },
  pairTight: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm },
  triple: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: space.sm },
  quad: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: space.sm },
  stack: { display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 },
  stackLoose: { display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 },
  alignRow: { display: "grid", gridTemplateColumns: "84px 1fr", gap: space.sm },
  segments: {
    flexGrow: 1,
    display: "flex",
    padding: space.px,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  segment: {
    flexGrow: 1,
    flexBasis: 0,
    display: "grid",
    placeItems: "center",
    height: `calc(${size.sm} - ${space.px} * 2)`,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  pointGrid: {
    flexShrink: 0,
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gridTemplateRows: "repeat(3, 1fr)",
    width: 57,
    height: 57,
    padding: space.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  pointCell: {
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    cursor: "var(--cursor-pointer, pointer)",
  },
  pointDot: { width: 3, height: 3, borderRadius: "50%", backgroundColor: colors.faint },
  pointDotOn: {
    width: 6,
    height: 6,
    backgroundColor: colors.brand,
  },
  /** Words alone carry a quieter segment than icons do. */
  segmentWord: { fontWeight: 400 },
  segmentWordOn: { fontWeight: 500 },
  segmentOn: {
    backgroundColor: colors.surface,
    boxShadow: shadows.inset,
    color: colors.text,
  },
  popover: {
    position: "fixed",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: 312,
    padding: space.ms,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    color: colors.text,
    fontFamily: fonts.sans,
  },
  cells: {
    display: "grid",
    flexShrink: 0,
    gridTemplateColumns: "repeat(3, 1fr)",
    gridTemplateRows: "repeat(3, 1fr)",
    width: 63,
    height: 63,
    padding: space.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  cell: {
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    cursor: "var(--cursor-pointer, pointer)",
  },
  cellDot: { width: 3, height: 3, borderRadius: "50%", backgroundColor: colors.faint },
  cellDotOn: { width: 6, height: 6, backgroundColor: colors.brand },
});
