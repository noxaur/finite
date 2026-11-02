"use client";

import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";
import type { ImportResult } from "@/api/Api";
import { exportHref, figmaHref, IMPORT_ACCEPT, originalHref, summarize } from "@/lib/transfer";
import { colors, radii, space } from "@/styles/tokens.stylex";

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
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        {...stylex.props(styles.tool)}
        title="Add artboards from an .html, .finite or .figma.json file"
      >
        {busy ? "Importing…" : "Import"}
      </button>
    </>
  );
}

/** What the Export button opens: a link per artboard as HTML and for Figma, and the whole design as `.finite`. */
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
      data-camera-ignore
      role="menu"
      aria-label="Export"
      {...stylex.props(styles.card)}
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
            {...stylex.props(styles.button, styles.download)}
          >
            Download original
          </a>
        )}
        <button type="button" onClick={onClose} {...stylex.props(styles.button)}>
          Close
        </button>
      </div>
    </aside>
  );
}

const styles = stylex.create({
  tool: {
    minWidth: 28,
    height: 24,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    cursor: { default: "var(--cursor-pointer, pointer)", ":disabled": "default" },
  },
  card: {
    position: "absolute",
    top: 52,
    right: space.sm,
    width: 300,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    margin: 0,
    padding: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.08)",
  },
  result: { width: 360 },
  item: {
    padding: space.xs,
    paddingInline: space.sm,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    textDecoration: "none",
  },
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
  button: {
    display: "inline-flex",
    alignItems: "center",
    height: 28,
    paddingInline: space.sm,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    textDecoration: "none",
    cursor: "var(--cursor-pointer, pointer)",
  },
  download: { marginRight: "auto" },
});
