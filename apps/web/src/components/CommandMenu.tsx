"use client";

import * as stylex from "@stylexjs/stylex";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { finite, useDesigns } from "@/client/finite";
import type { IconName } from "@/lib/icons";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import { CommandGroup, CommandHints, CommandItem, CommandSearch } from "./CommandParts";
import { connectFolder, cloneRepo, createBlank, createImport } from "./startDesign";

type Repo = {
  name: string;
  url: string;
  description?: string | undefined;
  language?: string | undefined;
  stars?: number | undefined;
};

/** Where the menu is: the list of actions, or one of the flows it leads into. */
type Step =
  | { kind: "root" }
  | { kind: "new" }
  | { kind: "import" }
  | { kind: "connect" }
  | { kind: "clone-search" }
  | { kind: "clone-dest"; repo: Repo };

type Row = {
  key: string;
  group: string;
  icon: IconName;
  label: string;
  note?: string | undefined;
  /** A folder row, which shows the chevron. */
  open?: boolean | undefined;
  run: () => void;
};

const ACTIONS = [
  { step: "new", icon: "folderPlus", label: "New project", note: "Create a blank design" },
  { step: "import", icon: "importTray", label: "Add existing project", note: "Import a design" },
  {
    step: "connect",
    icon: "code",
    label: "Add production environment",
    note: "Connect a codebase",
  },
  { step: "clone-search", icon: "gitFork", label: "Clone git repo", note: "From a GitHub URL" },
] as const;

const CHIP: Record<Step["kind"], string | null> = {
  root: null,
  new: "New project",
  import: "Add existing project",
  connect: "Add production environment",
  "clone-search": "Clone git repo",
  "clone-dest": "Clone git repo",
};

const PLACEHOLDER: Record<Step["kind"], string> = {
  root: "Search…",
  new: "Name your project…",
  import: "Paste a Figma link or URL…",
  connect: "Path to your project…",
  "clone-search": "Search GitHub or paste a repo URL…",
  "clone-dest": "Choose where to clone…",
};

/** The folder to list for a path being typed, and the part after it that filters the list. */
function splitPath(value: string): { dir: string; rest: string } {
  if (value === "~") return { dir: "~/", rest: "" };
  const at = value.lastIndexOf("/");
  return at < 0
    ? { dir: "~/", rest: value }
    : { dir: value.slice(0, at + 1), rest: value.slice(at + 1) };
}

/** `~/code/app/` up one folder is `~/code/`. */
const parentOf = (dir: string) => dir.replace(/[^/]+\/$/, "") || "/";

/**
 * The ⌘K menu on the designs page: search the designs and four ways to start one. Picking an
 * action keeps the search bar and turns it into that flow's input (a name, a link, a path, a
 * repo), with a chip saying which flow it is.
 */
export function CommandMenu({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const designs = useDesigns();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: "root" });
  const [value, setValue] = useState("");
  // null is the default row, the first one or, when picking a folder, the first folder.
  const [active, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const reposQuery = useRef("");
  const files = useRef<HTMLInputElement>(null);

  const go = (next: Step) => {
    setStep(next);
    setValue(next.kind === "connect" || next.kind === "clone-dest" ? "~/" : "");
    // The clone step starts with nothing chosen, so Enter means "clone here".
    setActive(next.kind === "clone-dest" ? -1 : null);
    setError(null);
    setRepos([]);
    input.current?.focus();
  };

  const finish = async (work: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      router.push(await work());
      onClose();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const picksFolder = step.kind === "connect" || step.kind === "clone-dest";
  const { dir, rest } = splitPath(value);
  const typedPath = `${dir}${rest}`;

  // The folders of the path being typed.
  useEffect(() => {
    if (!picksFolder) return;
    let live = true;
    setDirs([]);
    finite
      .request("fs.list", { path: dir })
      .then((r) => live && (setDirs(r.dirs), setError(null)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [picksFolder, dir]);

  // Repos matching the text, a moment after typing stops.
  useEffect(() => {
    if (step.kind !== "clone-search" || !value.trim()) return setRepos([]);
    let live = true;
    const query = value.trim();
    const timer = setTimeout(() => {
      finite
        .request("repo.search", { query })
        .then((r) => {
          if (!live) return;
          reposQuery.current = query;
          setRepos(r);
          setError(null);
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [step.kind, value]);

  const folderRows = (): Row[] => {
    // Arriving in a folder highlights nothing, so Enter or ⌘↵ acts on that folder.
    const moveTo = (path: string) => () => {
      setValue(path);
      setActive(-1);
    };
    const rows: Row[] = [];
    if (dir !== "~/" && dir !== "/") {
      rows.push({
        key: "..",
        group: `In ${dir}`,
        icon: "chevronsUp",
        label: "..",
        run: moveTo(parentOf(dir)),
      });
    }
    for (const name of dirs.filter((d) => d.toLowerCase().startsWith(rest.toLowerCase()))) {
      rows.push({
        key: name,
        group: `In ${dir}`,
        icon: "folder",
        label: name,
        open: true,
        run: moveTo(`${dir}${name}/`),
      });
    }
    return rows;
  };

  const rows = useMemo((): Row[] => {
    const q = value.trim().toLowerCase();
    switch (step.kind) {
      case "root": {
        const actions: Row[] = ACTIONS.filter(
          (a) => !q || `${a.label} ${a.note}`.toLowerCase().includes(q),
        ).map((a) => ({
          key: a.step,
          group: "Actions",
          icon: a.icon,
          label: a.label,
          note: a.note,
          run: () => go({ kind: a.step }),
        }));
        const found: Row[] = q
          ? (designs ?? [])
              .filter((d) => d.name.toLowerCase().includes(q))
              .map((d) => ({
                key: d.id,
                group: "Designs",
                icon: d.origin === "connected" ? "folder" : "artboard",
                label: d.name,
                note: d.origin === "connected" ? d.root : undefined,
                run: () => {
                  router.push(`/design/?id=${d.id}`);
                  onClose();
                },
              }))
          : [];
        return [...actions, ...found];
      }
      case "new":
        return value.trim()
          ? [
              {
                key: "create",
                group: "Create",
                icon: "folderPlus",
                label: `Create “${value.trim()}”`,
                note: "A blank React + Tailwind project",
                run: () => void finish(() => createBlank(value)),
              },
            ]
          : [];
      case "import": {
        const out: Row[] = [];
        if (q)
          out.push({
            key: "link",
            group: "Import from",
            icon: "importTray",
            label: `Import ${value.trim()}`,
            note: "From a link",
            run: () => void finish(() => createImport(value, [])),
          });
        out.push({
          key: "files",
          group: "Import from",
          icon: "importTray",
          label: "Choose files…",
          note: "Images, HTML, CSS, PDF or zip",
          run: () => files.current?.click(),
        });
        return out;
      }
      case "connect": {
        const pick = window.finite?.pickFolder;
        const chooser: Row[] = pick
          ? [
              {
                key: "system-picker",
                group: "This computer",
                icon: "folder",
                label: "Choose folder…",
                note: "Open the system folder picker",
                run: () =>
                  void pick().then((folder) => {
                    if (folder) void finish(() => connectFolder(folder));
                  }),
              },
            ]
          : [];
        return [...chooser, ...folderRows()];
      }
      case "clone-search":
        return repos.map((r) => ({
          key: r.name,
          group: "Repositories",
          icon: "gitFork",
          label: r.name,
          note: [r.description, r.language, r.stars === undefined ? null : `${r.stars} stars`]
            .filter(Boolean)
            .join(" · "),
          run: () => go({ kind: "clone-dest", repo: r }),
        }));
      case "clone-dest":
        return folderRows().map((r) => ({ ...r, group: "Browse" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, value, dir, rest, dirs, repos, designs, busy]);

  const clamped = Math.min(
    active ?? (picksFolder ? rows.findIndex((r) => r.open) : 0),
    rows.length - 1,
  );
  const target = rows[clamped];

  /** Enter on a row runs it; on nothing, the folder steps connect or clone at the typed path. */
  const confirm = (withCommand: boolean) => {
    if (busy) return;
    // The rows still on screen answer an earlier query until the new search returns.
    if (step.kind === "clone-search" && reposQuery.current !== value.trim()) return;
    if (step.kind === "connect" && (withCommand || !target)) {
      const path = (target?.open ? `${dir}${target.label}` : typedPath).replace(/\/$/, "") || "/";
      return void finish(() => connectFolder(path));
    }
    if (step.kind === "clone-dest" && !target) {
      return void finish(() => cloneRepo(step.repo.url, typedPath));
    }
    target?.run();
  };

  const back = () => (step.kind === "root" ? onClose() : go({ kind: "root" }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(picksFolder ? -1 : 0, Math.min(rows.length - 1, clamped + d)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm(e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    } else if (e.key === "Backspace" && value === "" && step.kind !== "root") {
      e.preventDefault();
      back();
    }
  };

  useEffect(() => input.current?.focus(), []);

  const groups = rows.reduce<Array<{ name: string; rows: Row[] }>>((acc, row) => {
    const last = acc.at(-1);
    if (last?.name === row.group) last.rows.push(row);
    else acc.push({ name: row.group, rows: [row] });
    return acc;
  }, []);

  const hints = [
    { keys: ["↑", "↓"], label: "Navigate" },
    {
      keys: ["↵"],
      label:
        step.kind === "root"
          ? "Select"
          : step.kind === "connect"
            ? target
              ? "Open"
              : "Connect"
            : step.kind === "clone-dest"
              ? target
                ? "Open"
                : "Clone"
              : step.kind === "new"
                ? "Create"
                : step.kind === "import"
                  ? "Import"
                  : "Next",
    },
    ...(step.kind === "connect" && target ? [{ keys: ["⌘", "↵"], label: "Connect" }] : []),
    { keys: ["esc"], label: step.kind === "root" ? "Close" : "Back" },
  ];

  const chip = CHIP[step.kind];
  const chips = chip ? [chip] : [];

  return createPortal(
    <div
      role="presentation"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      {...stylex.props(styles.scrim)}
    >
      <div role="dialog" aria-label="Command menu" {...stylex.props(styles.panel)}>
        <CommandSearch
          value={value}
          placeholder={PLACEHOLDER[step.kind]}
          chips={chips}
          onChange={(v) => {
            setValue(v);
            // A path ending in / or a bare ~ has arrived in a folder, like opening one.
            setActive(
              step.kind === "clone-dest" || (picksFolder && (v.endsWith("/") || v === "~"))
                ? -1
                : null,
            );
          }}
          onBack={step.kind === "root" ? undefined : back}
          inputRef={input}
          onKeyDown={onKeyDown}
        />
        <div role="listbox" {...stylex.props(styles.list)}>
          {step.kind === "clone-dest" && (
            <>
              <CommandGroup>Repository</CommandGroup>
              <CommandItem icon="gitFork" label={step.repo.name} note={step.repo.url} />
            </>
          )}
          {groups.map((g) => (
            <Group key={g.name} name={g.name}>
              {g.rows.map((row) => (
                <CommandItem
                  key={row.key}
                  icon={row.icon}
                  label={row.label}
                  note={row.note}
                  open={row.open}
                  on={rows.indexOf(row) === clamped}
                  onClick={row.run}
                  onHover={() => setActive(rows.indexOf(row))}
                />
              ))}
            </Group>
          ))}
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
          {busy && (
            <p role="status" {...stylex.props(styles.status)}>
              Working…
            </p>
          )}
        </div>
        <CommandHints hints={hints} />
        <input
          ref={files}
          type="file"
          multiple
          hidden
          accept="image/*,.html,.htm,.css,.pdf,.zip"
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            if (chosen.length) void finish(() => createImport(value, chosen));
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function Group({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <CommandGroup>{name}</CommandGroup>
      {children}
    </>
  );
}

const styles = stylex.create({
  scrim: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    paddingTop: "12vh",
    backgroundColor: "rgba(23, 26, 28, 0.45)",
  },
  panel: {
    width: 520,
    maxWidth: "calc(100vw - 36px)",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    color: colors.text,
    fontFamily: fonts.sans,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    maxHeight: 360,
    overflowY: "auto",
    padding: space.sm,
  },
  error: { margin: 0, padding: space.md, color: colors.danger, fontSize: 12 },
  status: { margin: 0, padding: space.md, color: colors.muted, fontSize: 12 },
});
