"use client";

import * as stylex from "@stylexjs/stylex";
import { Exit } from "effect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Api } from "@/api/Api";
import type { DesignSummary } from "@/design/schema";
import { connectLobby, type SocketStatus } from "@/design/socket";
import { mcpUrl } from "@/lib/mcp";
import { timeAgo } from "@/lib/time";
import { runtime } from "@/runtime";
import { matchesName, mergeLobby } from "@/lib/lobby";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { Thumbnail } from "./Thumbnail";

/** How long the search waits after the last keystroke. */
const SEARCH_DELAY_MS = 250;

/**
 * The most recently edited designs, newest first, updated live as agents
 * create and edit them. The socket starts with at most 200; with more, a
 * search box finds the rest by name.
 */
export function DesignGrid() {
  const router = useRouter();
  const [designs, setDesigns] = useState<ReadonlyArray<DesignSummary> | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  /** How many designs there are in all, from the socket's first message. */
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  /** The server's answer to the last search: its designs, or null if it failed. */
  const [found, setFound] = useState<{
    readonly query: string;
    readonly designs: ReadonlyArray<DesignSummary> | null;
  } | null>(null);
  const [mcp, setMcp] = useState("");

  useEffect(() => setMcp(mcpUrl()), []);

  useEffect(
    () =>
      connectLobby({
        onStatus: setStatus,
        onMessage: (message) => {
          if (message.type === "designs") {
            setDesigns(message.designs);
            setTotal(message.total);
            setFound(null);
            setSearchRevision((revision) => revision + 1);
            return;
          }
          setDesigns((current) => {
            const { designs, trimmed } = mergeLobby(current ?? [], message.design);
            // One fell off the end, so there are more than the page shows.
            if (trimmed) setTotal((total) => Math.max(total, designs.length + 1));
            return designs;
          });
        },
      }),
    [],
  );

  useEffect(() => {
    const search = query.trim();
    if (!search) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void runtime
        .runPromiseExit(
          Api.use((api) => api.searchDesigns(search)),
          { signal: controller.signal },
        )
        .then((exit) => {
          if (controller.signal.aborted) return;
          setFound({ query: search, designs: Exit.isSuccess(exit) ? exit.value : null });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchRevision]);

  const search = query.trim();
  const answer = search && found?.query === search ? found : null;
  // Until the server answers, or if it can't, the page searches the designs
  // it already has. Those are the most recent, so they're a fair start.
  const matches = !search
    ? (designs ?? [])
    : (answer?.designs ?? (designs ?? []).filter((d) => matchesName(d.name, search)));
  const searchFailed = answer !== null && answer.designs === null;
  const sorted = [...matches].sort((a, b) => b.updatedAt - a.updatedAt);
  const more = designs !== null && total > designs.length;

  const create = () => {
    setCreating(true);
    setCreateFailed(false);
    runtime.runPromise(Api.use((api) => api.createDesign("Untitled"))).then(
      (design) => router.push(`/design/?id=${design.id}`),
      () => {
        setCreating(false);
        setCreateFailed(true);
      },
    );
  };

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>Designs</h1>
        <button type="button" onClick={create} disabled={creating} {...stylex.props(styles.button)}>
          New design
        </button>
      </header>

      {createFailed && (
        <p role="alert" {...stylex.props(styles.muted, styles.failed)}>
          Couldn’t create a design. Check the connection and try again.
        </p>
      )}

      {designs === null && status === "closed" && (
        <p {...stylex.props(styles.muted)}>Can’t reach the Finite server. Retrying…</p>
      )}

      {(more || query) && (
        <div {...stylex.props(styles.search)}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search designs by name"
            aria-label="Search designs by name"
            {...stylex.props(styles.searchInput)}
          />
          {!query && (
            <p {...stylex.props(styles.muted)}>
              Showing the {designs?.length} most recently edited of {total} designs.
            </p>
          )}
        </div>
      )}

      {searchFailed && (
        <p role="alert" {...stylex.props(styles.muted, styles.failed)}>
          Couldn’t search every design. These are matches among the {designs?.length ?? 0} most
          recently edited.
        </p>
      )}

      {answer?.designs?.length === 0 && (
        <p {...stylex.props(styles.muted)}>No designs match “{search}”.</p>
      )}

      {!query && designs !== null && sorted.length === 0 && (
        <p {...stylex.props(styles.muted)}>No designs yet. Create one, or ask an agent to.</p>
      )}

      <ul {...stylex.props(styles.grid)}>
        {sorted.map((design) => (
          <li key={design.id}>
            <Link href={`/design/?id=${design.id}`} {...stylex.props(styles.card)}>
              <Thumbnail id={design.id} seq={design.seq} nodeCount={design.nodeCount} />
              <div {...stylex.props(styles.meta)}>
                <span {...stylex.props(styles.name)}>{design.name}</span>
                <span {...stylex.props(styles.muted)}>
                  {design.artboardCount} {design.artboardCount === 1 ? "artboard" : "artboards"} ·{" "}
                  {timeAgo(design.updatedAt)}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <footer {...stylex.props(styles.footer)}>
        Agents connect over MCP at <code {...stylex.props(styles.code)}>{mcp}</code>
      </footer>
    </main>
  );
}

const styles = stylex.create({
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    padding: space.xl,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    margin: 0,
    fontSize: 20,
    fontWeight: 600,
  },
  button: {
    paddingBlock: space.xs,
    paddingInline: space.md,
    borderRadius: radii.sm,
    borderWidth: 0,
    backgroundColor: colors.text,
    color: colors.bg,
    font: "inherit",
    fontSize: 14,
    cursor: "var(--cursor-pointer, pointer)",
    opacity: { default: 1, ":hover": 0.85, ":disabled": 0.5 },
  },
  search: { display: "flex", flexDirection: "column", gap: space.xs, marginBottom: space.md },
  searchInput: {
    maxWidth: 360,
    padding: space.xs,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    color: "inherit",
    font: "inherit",
    fontSize: 14,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: space.lg,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.muted },
    backgroundColor: colors.surface,
    color: "inherit",
    textDecoration: "none",
  },
  meta: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: space.sm,
    paddingInline: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  name: {
    fontSize: 14,
    fontWeight: 500,
  },
  failed: { color: colors.danger, marginBottom: space.md },
  muted: {
    margin: 0,
    fontSize: 13,
    color: colors.muted,
  },
  footer: {
    marginTop: "auto",
    fontSize: 13,
    color: colors.muted,
  },
  code: {
    fontFamily: "ui-monospace, monospace",
    color: colors.text,
    userSelect: "all",
  },
});
