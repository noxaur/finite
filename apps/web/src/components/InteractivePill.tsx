"use client";

import * as stylex from "@stylexjs/stylex";
import type { Presence } from "@/design/schema";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

interface InteractivePillProps {
  readonly name: string;
  /** Where the artboard is in what ←/→ step through, and how many there are. */
  readonly index: number;
  readonly total: number;
  readonly canGoBack: boolean;
  /** Reloads wait while held. */
  readonly held: boolean;
  /** "Updated by …", while it shows. */
  readonly note: string | null;
  /** Hosts the page reached. */
  readonly hosts: ReadonlyArray<string>;
  readonly presence: ReadonlyArray<Presence>;
  readonly onStep: (by: 1 | -1) => void;
  readonly onBack: () => void;
  readonly onReload: () => void;
  readonly onHold: () => void;
  readonly onExit: () => void;
}

/**
 * Interactive mode's one piece of chrome, at the top center: the artboard,
 * the stepper, Back, reload, holding off reloads, the network it used, who
 * is editing, and the way out.
 */
export function InteractivePill(props: InteractivePillProps) {
  const { name, index, total, canGoBack, held, note, hosts, presence } = props;
  return (
    <div
      role="toolbar"
      aria-label="Interactive mode"
      data-canvas-chrome=""
      {...stylex.props(styles.pill)}
    >
      <span {...stylex.props(styles.name)}>{name}</span>
      {total > 1 && (
        <>
          <button
            type="button"
            onClick={() => props.onStep(-1)}
            {...stylex.props(styles.tool)}
            aria-label="Previous artboard"
            title="Previous artboard (←)"
          >
            <Icon name="previous" size={14} />
          </button>
          <span {...stylex.props(styles.muted)}>
            {index + 1} of {total}
          </span>
          <button
            type="button"
            onClick={() => props.onStep(1)}
            {...stylex.props(styles.tool)}
            aria-label="Next artboard"
            title="Next artboard (→)"
          >
            <Icon name="next" size={14} />
          </button>
        </>
      )}
      {canGoBack && (
        <button
          type="button"
          onClick={props.onBack}
          {...stylex.props(styles.tool)}
          title="Back to where the link was (⌘[)"
        >
          Back
        </button>
      )}
      <span {...stylex.props(styles.divider)} />
      {note && <span {...stylex.props(styles.note)}>{note}</span>}
      <button
        type="button"
        onClick={props.onReload}
        {...stylex.props(styles.tool)}
        title="Load the page again from the start"
      >
        Reload
      </button>
      <button
        type="button"
        aria-pressed={held}
        onClick={props.onHold}
        {...stylex.props(styles.tool, held && styles.pressed)}
        title={held ? "Changes wait until you let go" : "Hold off reloads while you use the page"}
      >
        Hold
      </button>
      {hosts.length > 0 && (
        <span
          {...stylex.props(styles.network)}
          title={`Uses the network: ${hosts.join(", ")}`}
          aria-label={`Uses the network: ${hosts.join(", ")}`}
        >
          <Icon name="wifi" size={14} />
        </span>
      )}
      {presence.map((p) => (
        <span key={p.actor} {...stylex.props(styles.chip)} title={p.status ?? undefined}>
          {p.name}
        </span>
      ))}
      <button
        type="button"
        onClick={props.onExit}
        {...stylex.props(styles.tool)}
        aria-label="Exit"
        title="Back to the canvas (Esc)"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

const styles = stylex.create({
  pill: {
    position: "absolute",
    top: space.sm,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    maxWidth: `calc(100% - 2 * ${space.sm})`,
    padding: space.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    whiteSpace: "nowrap",
  },
  name: { fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  muted: { color: colors.muted, fontVariantNumeric: "tabular-nums" },
  divider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
  note: { color: colors.muted },
  tool: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: 27,
    height: 24,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
  },
  pressed: {
    backgroundColor: { default: colors.accent, ":hover": colors.accent },
    color: colors.onAccent,
  },
  network: { display: "inline-grid", placeItems: "center", color: colors.muted },
  chip: {
    paddingInline: 6,
    paddingBlock: 1,
    borderRadius: 4,
    backgroundColor: colors.accent,
    color: colors.onAccent,
    fontSize: 12,
  },
});
