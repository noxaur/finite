"use client";

import * as stylex from "@stylexjs/stylex";
import type { DesignEntry } from "@finite/protocol";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { finite, useConnection, useDesigns } from "@/client/finite";
import { raised } from "@/styles/raised";
import { colors, fonts, radii, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { CommandMenu } from "./CommandMenu";
import { Kbd } from "./CommandParts";
import { Icon } from "./Icons";
import { Menu } from "./Menu";
import { NameInput } from "./NameInput";
import { TimeAgo } from "./TimeAgo";
import { toast, ToastSlot } from "./Toast";

/**
 * The designs list: a card per design, newest list from the server, and the ⌘K menu that
 * searches them and starts one (a blank project, an import, a connected codebase, a clone).
 */
export function DesignGrid() {
  const designs = useDesigns();
  const connection = useConnection();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setMenu((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>Designs</h1>
        <ToastSlot />
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menu}
          onClick={() => setMenu(true)}
          {...stylex.props(raised.control, styles.trigger)}
        >
          <Icon name="search" size={15} />
          Search or start
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </button>
      </header>

      {menu && <CommandMenu onClose={() => setMenu(false)} />}

      {designs === null && connection === "closed" && (
        <p {...stylex.props(styles.muted)}>Can’t reach the Finite server. Retrying…</p>
      )}
      {designs !== null && designs.length === 0 && (
        <p {...stylex.props(styles.muted)}>No designs yet. Press ⌘K to start one.</p>
      )}

      <ul {...stylex.props(styles.grid)}>
        {(designs ?? []).map((design) => (
          <DesignCard key={design.id} design={design} />
        ))}
      </ul>
    </main>
  );
}

const ORIGIN: Record<DesignEntry["origin"], string> = {
  connected: "Connected",
  blank: "Blank",
  import: "Imported",
};

function DesignCard({ design }: { design: DesignEntry }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const connected = design.origin === "connected";
  const rename = (name: string) =>
    void finite
      .request("design.rename", { id: design.id, name })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));
  const meta = (
    <span title={design.root} {...stylex.props(styles.origin)}>
      {design.installing ? (
        <span {...stylex.props(styles.installing)}>
          <span {...stylex.props(styles.spinner)} aria-hidden />
          Installing dependencies…
        </span>
      ) : (
        <>
          {ORIGIN[design.origin]}
          {design.updatedAt > 0 && (
            <>
              {" · updated "}
              <TimeAgo at={design.updatedAt} />
            </>
          )}
          {connected && ` · ${design.root}`}
        </>
      )}
    </span>
  );
  return (
    <li {...stylex.props(stylex.defaultMarker(), styles.cardItem)}>
      {renaming ? (
        <div {...stylex.props(styles.card)}>
          <span {...stylex.props(styles.cardIcon)}>
            <Icon name={connected ? "folder" : "artboard"} size={15} />
          </span>
          <span {...stylex.props(styles.meta)}>
            <NameInput
              label="Design name"
              value={design.name}
              autoFocus
              onRename={rename}
              onDone={() => setRenaming(false)}
              style={styles.nameInput}
            />
            {meta}
          </span>
        </div>
      ) : (
        <Link
          href={`/design/?id=${design.id}`}
          onDoubleClick={(e) => {
            e.preventDefault();
            setRenaming(true);
          }}
          {...stylex.props(styles.card)}
        >
          <span {...stylex.props(styles.cardIcon)}>
            <Icon name={connected ? "folder" : "artboard"} size={15} />
          </span>
          <span {...stylex.props(styles.meta)}>
            <span {...stylex.props(styles.name)}>{design.name}</span>
            {meta}
          </span>
        </Link>
      )}
      <IconButton
        ref={more}
        icon="more"
        label={`${design.name} options`}
        variant="ghost"
        size="small"
        expanded={menu}
        onClick={() => setMenu((m) => !m)}
        style={styles.more}
      />
      {menu && more.current && (
        <Menu
          title="Design"
          anchor={more.current}
          trigger={more.current}
          onClose={() => setMenu(false)}
          items={[
            { key: "rename", label: "Rename", icon: "pencil", run: () => setRenaming(true) },
            {
              key: "remove",
              label: connected ? "Remove from Finite" : "Delete design",
              note: connected ? "Files stay" : undefined,
              icon: "trash",
              run: () =>
                void finite
                  .request("design.remove", { id: design.id })
                  .then(() => toast(`Removed ${design.name}.`))
                  .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e))),
            },
          ]}
        />
      )}
    </li>
  );
}

const spin = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  page: {
    minHeight: `calc(100vh - ${size.bar})`,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    padding: space.xl,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: fonts.sans,
  },
  header: { display: "flex", alignItems: "center", gap: space.md },
  title: { margin: 0, marginRight: "auto", fontSize: 20, fontWeight: 600 },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    paddingInline: space.md,
    borderRadius: radii.md,
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.muted,
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  spinner: {
    width: 11,
    height: 11,
    borderRadius: "50%",
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.brand,
    animationName: spin,
    animationDuration: "2.4s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  muted: { margin: 0, fontSize: 12, color: colors.muted },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: space.md,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  cardItem: { position: "relative" },
  card: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 66,
    paddingBlock: space.md,
    paddingLeft: space.md,
    paddingRight: 36,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.borderStrong },
    backgroundColor: colors.surface,
    color: "inherit",
    textDecoration: "none",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  cardIcon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: size.md,
    height: size.md,
    borderRadius: radii.md,
    backgroundColor: colors.sunk,
    color: colors.muted,
  },
  meta: { display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 },
  name: { fontSize: 14, fontWeight: 500 },
  nameInput: {
    width: "100%",
    margin: 0,
    paddingBlock: 0,
    paddingInline: space.xs,
    marginInline: `calc(-1 * ${space.xs})`,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: 500,
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
  },
  installing: { display: "inline-flex", alignItems: "center", gap: space.sm },
  origin: {
    fontSize: 12,
    color: colors.muted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  more: {
    position: "absolute",
    top: space.sm,
    right: space.sm,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      ":focus-visible": 1,
    },
  },
});
