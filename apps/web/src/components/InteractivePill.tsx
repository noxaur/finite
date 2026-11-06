"use client";

import * as stylex from "@stylexjs/stylex";
import type { Presence } from "@/design/schema";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icons";

interface InteractivePillProps {
  readonly name: string;
  /** Where the artboard is in what ←/→ step through, and how many there are. */
  readonly index: number;
  readonly total: number;
  readonly canGoBack: boolean;
  /** Whether it has moved on from the artboard it opened on. */
  readonly canRestart: boolean;
  /** Links on this artboard that go to no artboard. */
  readonly broken: number;
  /** Reloads wait while held. */
  readonly held: boolean;
  /** "Updated by …", while it shows. */
  readonly note: string | null;
  /** Hosts the page reached. */
  readonly hosts: ReadonlyArray<string>;
  readonly presence: ReadonlyArray<Presence>;
  readonly onStep: (by: 1 | -1) => void;
  readonly onBack: () => void;
  readonly onRestart: () => void;
  readonly onReload: () => void;
  readonly onHold: () => void;
  readonly onExit: () => void;
}

/**
 * Interactive mode's one piece of chrome, at the top center: the artboard,
 * the stepper, Back and Restart, broken links, reload, holding off reloads, the network it used, who
 * is editing, and the way out.
 */
export function InteractivePill(props: InteractivePillProps) {
  const { name, index, total, canGoBack, canRestart, broken, held, note, hosts, presence } = props;
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
          <IconButton
            size="small"
            icon="previous"
            label="Previous artboard"
            title="Previous artboard (←)"
            onClick={() => props.onStep(-1)}
          />
          <span {...stylex.props(styles.muted)}>
            {index + 1} of {total}
          </span>
          <IconButton
            size="small"
            icon="next"
            label="Next artboard"
            title="Next artboard (→)"
            onClick={() => props.onStep(1)}
          />
        </>
      )}
      {canGoBack && (
        <Button size="small" onClick={props.onBack} title="Back to where the link was (⌘[)">
          Back
        </Button>
      )}
      {canRestart && (
        <Button
          size="small"
          onClick={props.onRestart}
          title="Back to the artboard you started on (R)"
        >
          Restart
        </Button>
      )}
      {broken > 0 && (
        <span
          {...stylex.props(styles.broken)}
          title="Links here go to artboards that are gone. Undo the delete, or pick another target."
        >
          {broken} broken link{broken === 1 ? "" : "s"}
        </span>
      )}
      <span {...stylex.props(styles.divider)} />
      {note && <span {...stylex.props(styles.note)}>{note}</span>}
      <Button size="small" onClick={props.onReload} title="Load the page again from the start">
        Reload
      </Button>
      <Button
        size="small"
        pressed={held}
        onClick={props.onHold}
        title={held ? "Changes wait until you let go" : "Hold off reloads while you use the page"}
      >
        Hold
      </Button>
      {hosts.length > 0 && (
        <span
          {...stylex.props(styles.network)}
          title={`Uses the network: ${hosts.join(", ")}`}
          aria-label={`Uses the network: ${hosts.join(", ")}`}
        >
          <Icon name="wifi" size={15} />
        </span>
      )}
      {presence.map((p) => (
        <span key={p.actor} {...stylex.props(styles.chip)} title={p.status ?? undefined}>
          {p.name}
        </span>
      ))}
      <IconButton
        size="small"
        icon="close"
        label="Exit"
        title="Back to the canvas (Esc)"
        onClick={props.onExit}
      />
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
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  name: { fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  muted: { color: colors.muted, fontVariantNumeric: "tabular-nums" },
  divider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
  note: { color: colors.muted },
  broken: { color: colors.danger, whiteSpace: "nowrap" },
  network: { display: "inline-grid", placeItems: "center", color: colors.muted },
  chip: {
    paddingInline: space.sm,
    paddingBlock: space.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
    color: colors.onAccent,
    fontSize: 12,
  },
});
