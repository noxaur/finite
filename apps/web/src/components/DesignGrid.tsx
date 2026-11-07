"use client";

import * as stylex from "@stylexjs/stylex";
import type { DesignEntry } from "@finite/protocol";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import { finite, useConnection, useDesigns, useSettings } from "@/client/finite";
import { raised } from "@/styles/raised";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icons";
import { Menu } from "./Menu";
import { NameInput } from "./NameInput";
import { TimeAgo } from "./TimeAgo";
import { toast, ToastSlot } from "./Toast";

type Start = "blank" | "import" | "connect";

const BRAND_PROMPT =
  "Import this design's brand assets onto the Brand page: logos, images and fonts from the code " +
  "or the source, and its colors, type and spacing as tokens. Say what you found and what's missing.";

const importPrompt = (source: string, files: number) =>
  `Rebuild this design in TSX${source ? ` from ${source}` : ""}${
    files ? `${source ? ", and" : " from"} the attached ${files === 1 ? "file" : "files"}` : ""
  }. Put each screen on a page as a route, split shared parts into components, and set the ` +
  "colors, fonts and spacing as tokens first.";

/**
 * The designs list: three ways to start (a blank project, an import, a connected codebase) and a
 * card per design, newest list from the server.
 */
export function DesignGrid() {
  const designs = useDesigns();
  const connection = useConnection();
  const [start, setStart] = useState<Start | null>(null);

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>Designs</h1>
        <ToastSlot />
      </header>

      <div {...stylex.props(styles.starts)}>
        <StartButton
          icon="plus"
          label="Create blank design"
          note="A new React + Tailwind project"
          on={start === "blank"}
          onClick={() => setStart(start === "blank" ? null : "blank")}
        />
        <StartButton
          icon="download"
          label="Import a design"
          note="From Figma, a URL or files"
          on={start === "import"}
          onClick={() => setStart(start === "import" ? null : "import")}
        />
        <StartButton
          icon="folder"
          label="Connect a codebase"
          note="An app, or a monorepo with several"
          on={start === "connect"}
          onClick={() => setStart(start === "connect" ? null : "connect")}
        />
      </div>

      {start && <StartForm key={start} kind={start} onCancel={() => setStart(null)} />}

      {designs === null && connection === "closed" && (
        <p {...stylex.props(styles.muted)}>Can’t reach the Finite server. Retrying…</p>
      )}
      {designs !== null && designs.length === 0 && !start && (
        <p {...stylex.props(styles.muted)}>No designs yet. Start one above.</p>
      )}

      <ul {...stylex.props(styles.grid)}>
        {(designs ?? []).map((design) => (
          <DesignCard key={design.id} design={design} />
        ))}
      </ul>
    </main>
  );
}

function StartButton({
  icon,
  label,
  note,
  on,
  onClick,
}: {
  icon: "plus" | "download" | "folder";
  label: string;
  note: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={on}
      onClick={onClick}
      {...stylex.props(raised.control, styles.start, on && raised.on)}
    >
      <span {...stylex.props(styles.startIcon)}>
        <Icon name={icon} size={15} />
      </span>
      <span {...stylex.props(styles.startText)}>
        <span {...stylex.props(styles.startLabel)}>{label}</span>
        <span {...stylex.props(styles.startNote)}>{note}</span>
      </span>
    </button>
  );
}

function StartForm({ kind, onCancel }: { kind: Start; onCancel: () => void }) {
  const router = useRouter();
  const settings = useSettings();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [brand, setBrand] = useState(kind !== "blank");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = typeof window !== "undefined" && !!window.finite?.pickFolder;

  const thread = async (designId: string, text: string, attachments: string[] = []) => {
    const s = settings ?? (await finite.request("settings.get", {}));
    const { threadId } = await finite.request("thread.send", {
      designId,
      new: {},
      text,
      attachments,
      model: s.model,
      effort: s.effort,
      fast: s.fast,
      mode: "steer",
    });
    return threadId;
  };

  const upload = async (designId: string) => {
    const paths: string[] = [];
    for (const file of files) {
      const body = new FormData();
      body.append("file", file, file.name);
      const res = await fetch(`/api/designs/${encodeURIComponent(designId)}/attachments`, {
        method: "POST",
        body,
      });
      const json = (await res.json()) as { path?: string; reason?: string };
      if (!res.ok || !json.path) throw new Error(json.reason ?? `Couldn't upload ${file.name}`);
      paths.push(json.path);
    }
    return paths;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      let design: DesignEntry;
      let threadId: string | null = null;
      if (kind === "connect") {
        setBusy("Reading the project…");
        design = await finite.request("design.connect", { path: path.trim() });
        if (design.setup) {
          // Finite can't run it as it is: a setup thread writes its finite.json first.
          setBusy("Starting the setup…");
          ({ threadId } = await finite.request("design.setup", { designId: design.id }));
        }
      } else {
        setBusy(kind === "blank" ? "Creating the project…" : "Creating the design…");
        design = await finite.request("design.create", {
          name: name.trim() || (kind === "blank" ? "Untitled" : "Imported design"),
          kind: kind === "blank" ? "blank" : "import",
          ...(kind === "import" && source.trim() ? { source: source.trim() } : {}),
        });
        if (kind === "import") {
          setBusy("Starting the import…");
          const attachments = await upload(design.id);
          threadId = await thread(
            design.id,
            importPrompt(source.trim(), files.length),
            attachments,
          );
        }
      }
      if (brand && !design.setup) {
        setBusy("Starting the brand import…");
        const brandThread = await thread(design.id, BRAND_PROMPT);
        threadId ??= brandThread;
      }
      const q = new URLSearchParams({ id: design.id });
      if (threadId) q.set("thread", threadId);
      router.push(`/design/?${q.toString()}`);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pick = async () => {
    const folder = await window.finite?.pickFolder?.();
    if (folder) setPath(folder);
  };

  const ready =
    kind === "connect"
      ? path.trim().length > 0
      : kind === "import"
        ? !!source.trim() || files.length > 0
        : true;

  return (
    <form onSubmit={(e) => void submit(e)} {...stylex.props(styles.form)}>
      {kind !== "connect" && (
        <Field label="Name">
          <input
            autoFocus
            value={name}
            placeholder={kind === "blank" ? "Untitled" : "Imported design"}
            onChange={(e) => setName(e.target.value)}
            {...stylex.props(styles.input)}
          />
        </Field>
      )}
      {kind === "import" && (
        <>
          <Field label="Figma link or URL">
            <input
              value={source}
              placeholder="https://figma.com/design/… or https://…"
              onChange={(e) => setSource(e.target.value)}
              {...stylex.props(styles.input)}
            />
          </Field>
          <Field label="Or files">
            <span {...stylex.props(styles.files)}>
              <input
                type="file"
                multiple
                accept="image/*,.html,.htm,.css,.pdf,.zip"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                {...stylex.props(styles.fileInput)}
              />
            </span>
          </Field>
        </>
      )}
      {kind === "connect" && (
        <Field label="Project folder">
          <span {...stylex.props(styles.pathRow)}>
            <input
              autoFocus={!desktop}
              value={path}
              placeholder="/Users/you/code/my-app"
              onChange={(e) => setPath(e.target.value)}
              {...stylex.props(styles.input, styles.grow)}
            />
            {desktop && (
              <Button onClick={() => void pick()} icon="folder">
                Choose…
              </Button>
            )}
          </span>
        </Field>
      )}
      <label {...stylex.props(styles.check)}>
        <input type="checkbox" checked={brand} onChange={(e) => setBrand(e.target.checked)} />
        Start a thread to import brand assets
      </label>
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        {busy && (
          <span role="status" {...stylex.props(styles.busy)}>
            <span {...stylex.props(styles.spinner)} aria-hidden />
            {busy}
          </span>
        )}
        <span {...stylex.props(styles.grow)} />
        <Button variant="ghost" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
        <Button type="submit" variant="brand" disabled={busy !== null || !ready}>
          {kind === "blank" ? "Create" : kind === "import" ? "Import" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>{label}</span>
      {children}
    </label>
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
  header: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { margin: 0, fontSize: 20, fontWeight: 600 },
  starts: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: space.md,
  },
  start: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    height: 60,
    paddingInline: space.lg,
    borderRadius: radii.lg,
    fontFamily: fonts.sans,
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  startIcon: { display: "flex", color: colors.brandText },
  startText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  startLabel: { fontSize: 14, fontWeight: 500, color: colors.text },
  startNote: { fontSize: 12, color: colors.muted },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    maxWidth: 560,
    padding: space.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  field: { display: "flex", flexDirection: "column", gap: space.xs },
  fieldLabel: { fontSize: 12, fontWeight: 500, color: colors.muted },
  input: {
    height: size.sm,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
    "::placeholder": { color: colors.faint },
  },
  files: { display: "flex" },
  fileInput: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  pathRow: { display: "flex", gap: space.sm },
  grow: { flexGrow: 1, minWidth: 0 },
  check: { display: "flex", alignItems: "center", gap: space.sm, fontSize: 13 },
  // An invalid finite.json's reason lists one problem per line.
  error: { margin: 0, color: colors.danger, fontSize: 13, whiteSpace: "pre-wrap" },
  actions: { display: "flex", alignItems: "center", gap: space.sm },
  busy: { display: "flex", alignItems: "center", gap: space.sm, color: colors.muted, fontSize: 12 },
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
