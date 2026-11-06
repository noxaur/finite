"use client";

import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";
import type { ImportResult } from "@/api/Api";
import {
  appHref,
  exportHref,
  FIGMA_PLUGIN_URL,
  figmaHref,
  IMPORT_ACCEPT,
  jsxHref,
  originalHref,
  repoHref,
  summarize,
} from "@/lib/transfer";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Button, buttonStyle } from "./Button";

/** Where an import is: sending the file, done, or refused with the server's reason. */
export type ImportState =
  | { readonly status: "working" }
  | { readonly status: "done"; readonly result: ImportResult }
  | { readonly status: "failed"; readonly message: string };

/** The top bar's Import button. It opens the file picker and hands the file to `onFile`. */
export function ImportButton({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Clear it, so picking the same file again still counts as a change.
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      <Button
        disabled={busy}
        onClick={() => input.current?.click()}
        title="Add artboards from an .html, .finite, .figma.json or .tar file"
      >
        {busy ? "Importing…" : "Import"}
      </Button>
    </>
  );
}

/**
 * What the Export button opens: a link per artboard as HTML, as JSX and for
 * Figma, the whole design as `.finite`, text files or a React Router or
 * TanStack Router app, and where to get the Figma plugin that opens the
 * Figma files.
 */
export function ExportMenu({
  designId,
  artboards,
  onClose,
}: {
  designId: string;
  artboards: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onClose: () => void;
}) {
  return (
    <div
      data-canvas-chrome
      data-camera-ignore
      role="menu"
      aria-label="Export"
      {...stylex.props(styles.card, styles.menu)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {artboards.flatMap(({ id, name }) => {
        const label = artboards.length === 1 ? "This artboard" : name;
        return [
          <a
            key={id}
            role="menuitem"
            href={exportHref(designId, id)}
            download
            onClick={onClose}
            {...stylex.props(styles.item)}
          >
            {label} as HTML
          </a>,
          <a
            key={`${id}:jsx`}
            role="menuitem"
            href={jsxHref(designId, id)}
            download
            onClick={onClose}
            {...stylex.props(styles.item)}
          >
            {label} as JSX
          </a>,
          <a
            key={`${id}:figma`}
            role="menuitem"
            href={figmaHref(designId, id)}
            download
            onClick={onClose}
            {...stylex.props(styles.item)}
          >
            {label} for Figma
          </a>,
        ];
      })}
      <a
        role="menuitem"
        href={exportHref(designId, null)}
        download
        onClick={onClose}
        {...stylex.props(styles.item)}
      >
        Whole design as .finite
      </a>
      <a
        role="menuitem"
        href={repoHref(designId)}
        download
        onClick={onClose}
        {...stylex.props(styles.item)}
      >
        Whole design as text files (.tar)
      </a>
      <a
        role="menuitem"
        href={appHref(designId)}
        download
        onClick={onClose}
        {...stylex.props(styles.item)}
      >
        Whole design as a React Router app (.tar)
      </a>
      <a
        role="menuitem"
        href={appHref(designId, "tanstack-router")}
        download
        onClick={onClose}
        {...stylex.props(styles.item)}
      >
        Whole design as a TanStack Router app (.tar)
      </a>
      <p {...stylex.props(styles.note)}>
        Files for Figma open in the Finite Figma plugin.{" "}
        <a
          href={FIGMA_PLUGIN_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          {...stylex.props(styles.link)}
        >
          Get the plugin
        </a>
      </p>
    </div>
  );
}

/** What an import did: how many artboards it made, what it left out, or why it failed. */
export function ImportResultCard({
  designId,
  state,
  nameOf,
  onClose,
}: {
  designId: string;
  state: ImportState;
  /** A node's layer name, to say which element a diagnostic is about. */
  nameOf: (nodeId: string) => string | undefined;
  onClose: () => void;
}) {
  if (state.status === "working") return null;
  const summary = state.status === "done" ? summarize(state.result, nameOf) : null;
  return (
    <aside
      data-canvas-chrome
      data-camera-ignore
      aria-label="Import"
      {...stylex.props(styles.card, styles.result)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {summary && state.status === "done" ? (
        <>
          <p role="status" {...stylex.props(styles.title)}>
            {summary.headline}
          </p>
          {summary.lines.length > 0 && (
            <ul {...stylex.props(styles.list)}>
              {summary.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
              {summary.more > 0 && <li {...stylex.props(styles.muted)}>and {summary.more} more</li>}
            </ul>
          )}
        </>
      ) : (
        <p role="alert" {...stylex.props(styles.title, styles.failed)}>
          {state.status === "failed" ? state.message : ""}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        {state.status === "done" && state.result.diagnostics.length > 0 && (
          <a
            href={originalHref(designId, state.result.import.id)}
            download
            {...stylex.props(...buttonStyle({}), styles.download)}
          >
            Download original
          </a>
        )}
        <Button variant="brand" onClick={onClose}>
          Close
        </Button>
      </div>
    </aside>
  );
}

const styles = stylex.create({
  card: {
    position: "absolute",
    top: 51,
    right: space.sm,
    width: 300,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    margin: 0,
    padding: space.sm,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
  },
  /** Packed like the app menu (`Menu.tsx`): rows edge to edge, 3px in from a 6px-radius edge. */
  menu: { gap: 0, padding: space.xs, borderRadius: radii.md },
  result: { width: 360 },
  /** A menu row, the size of the app menu's (`Menu.tsx`). */
  item: {
    display: "flex",
    alignItems: "center",
    height: size.sm,
    flexShrink: 0,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: "inherit",
    textDecoration: "none",
  },
  note: {
    margin: 0,
    marginTop: space.xs,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    paddingInline: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    color: colors.muted,
  },
  link: { color: colors.text },
  title: { margin: 0, fontWeight: 500 },
  failed: { color: colors.danger, fontWeight: 400 },
  muted: { color: colors.muted },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    margin: 0,
    paddingLeft: space.md,
    overflowWrap: "anywhere",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.xs,
  },
  download: { marginRight: "auto" },
});
