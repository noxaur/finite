"use client";

import * as stylex from "@stylexjs/stylex";
import type { Canvas as CanvasDoc, InstallState, PreviewState, ThreadMeta } from "@finite/protocol";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { finite, findThread, useClaudeStatus, useDesignState, useSettings } from "@/client/finite";
import { UNTIL_OPENED } from "@/lib/threads";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Button, IconButton } from "./Button";
import {
  Canvas,
  Inspector,
  LayersTree,
  selectionStore,
  TokensSection,
  useSelection,
} from "@/canvas";
import { runWith, selectionFor } from "@/lib/composer";
import { ChatPanel } from "./ChatPanel";
import { Composer, focusComposer, type Outgoing } from "./Composer";
import { type LeftMode, LeftSidebar } from "./LeftSidebar";
import { Settings } from "./Settings";
import { StarMenu } from "./StarMenu";
import { TabBar } from "./TabBar";
import { ThreadList } from "./ThreadList";
import { toast } from "./Toast";

/** Where the screen is: `/design/?id=…&tab=prototypes&thread=…&canvas=…`. */
interface Place {
  readonly tab: LeftMode;
  readonly thread: string | null;
  readonly canvas: string | null;
}

function href(id: string, place: Place): string {
  const q = new URLSearchParams({ id });
  if (place.tab === "prototypes") q.set("tab", "prototypes");
  if (place.thread) q.set("thread", place.thread);
  if (place.canvas) q.set("canvas", place.canvas);
  return `/design/?${q.toString()}`;
}

/** The page a design opens on: Routes first, then whatever page comes first. */
function defaultPage(pages: ReadonlyArray<CanvasDoc>): CanvasDoc | undefined {
  return pages.find((p) => p.name === "Routes") ?? pages[0];
}

/**
 * One open design: the tab bar, the left sidebar (Design | Prototypes), the canvas with the
 * ✱ menu and the floating composer, and on the right the inspector (collapsed by default) and
 * a thread's messages.
 */
export function DesignScreen({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const view = useDesignState(id);
  const settings = useSettings();
  const claude = useClaudeStatus();
  const selection = useSelection();
  const [inspector, setInspector] = useState(false);
  const [history, setHistory] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const place: Place = {
    tab: params.get("tab") === "prototypes" ? "prototypes" : "design",
    thread: params.get("thread"),
    canvas: params.get("canvas"),
  };
  const go = (next: Place, push = true) => {
    const url = href(id, next);
    if (push) router.push(url);
    else router.replace(url);
  };

  const state = view.state;
  const canvases = state?.canvases ?? [];
  const threads = state?.threads ?? [];
  const pages = canvases.filter((c) => c.kind === "page" && c.removedAt === undefined);
  const thread = findThread(view, place.thread) ?? null;

  const canvas: CanvasDoc | null =
    place.tab === "design"
      ? (pages.find((p) => p.id === place.canvas) ?? defaultPage(pages) ?? null)
      : (canvases.find((c) => c.id === place.canvas) ?? null);
  const pageId = place.tab === "design" ? (canvas?.id ?? null) : null;

  // A new canvas on screen starts with nothing picked.
  const canvasId = canvas?.id ?? null;
  useEffect(() => selectionStore.set([]), [canvasId]);

  // When a thread opens its first prototype, the screen follows it there.
  const seenCanvases = useRef<{ thread: string | null; count: number }>({ thread: null, count: 0 });
  useEffect(() => {
    if (!thread) return;
    const seen = seenCanvases.current;
    const count = thread.canvasIds.length;
    if (seen.thread === thread.id && seen.count === 0 && count > 0) {
      go({ tab: "prototypes", thread: thread.id, canvas: thread.canvasIds[count - 1]! }, false);
    }
    seenCanvases.current = { thread: thread.id, count };
  });

  // Opening a thread snoozed "until I open it" wakes it.
  const threadId = thread?.id;
  const wake = thread?.snoozedUntil !== undefined && thread.snoozedUntil >= UNTIL_OPENED;
  useEffect(() => {
    if (threadId && wake) {
      void finite.request("thread.snooze", { designId: id, threadId, until: null }).catch(() => {});
    }
  }, [id, threadId, wake]);

  const sendTo = async (
    message: Outgoing,
    target:
      | { threadId: string }
      | { new: { canvasId?: string; parentId?: string; prototype?: boolean } },
  ) => {
    const { threadId: sent } = await finite.request("thread.send", {
      designId: id,
      ...target,
      text: message.text,
      attachments: message.attachments,
      ...(message.selection ? { selection: message.selection } : {}),
      model: message.model,
      ...(message.effort ? { effort: message.effort } : {}),
      fast: message.fast,
      mode: message.mode,
    });
    return sent;
  };

  /** A new prototype: the server makes its thread and canvas together, then the screen goes there. */
  const startPrototype = async (message: Outgoing, parentId?: string) => {
    const sent = await sendTo(message, {
      new: { prototype: true, ...(parentId ? { parentId } : {}) },
    });
    const canvas = findThread(finite.design(id), sent)?.canvasIds[0] ?? null;
    go({ tab: "prototypes", thread: sent, canvas }, place.thread !== null);
  };

  const send = async (message: Outgoing) => {
    if (thread) {
      await sendTo(message, { threadId: thread.id });
      return;
    }
    if (place.tab === "prototypes") return startPrototype(message);
    // From the Design tab: a thread without a canvas, until the agent opens one.
    const sent = await sendTo(message, { new: {} });
    go({ tab: "design", thread: sent, canvas: place.canvas }, false);
  };

  const composerChoice = (text: string): Outgoing => {
    return {
      text,
      attachments: [],
      selection: selectionFor(selection),
      ...runWith(claude?.models ?? [], settings ?? null, thread, null),
      mode: settings?.sendMode ?? "steer",
    };
  };

  const explore = (prompt: string) => {
    const message = composerChoice(prompt);
    const run =
      place.tab === "prototypes" && thread
        ? sendTo(message, { threadId: thread.id })
        : startPrototype(message, place.tab === "prototypes" ? undefined : thread?.id);
    void run.catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));
  };

  const exportSelection = () => {
    if (!canvas) return;
    const frameIds = [...new Set(selection.map((s) => s.frameId))].join(",");
    const a = document.createElement("a");
    a.href = `/api/designs/${encodeURIComponent(id)}/export?canvasId=${encodeURIComponent(canvas.id)}${frameIds ? `&frameIds=${encodeURIComponent(frameIds)}` : ""}`;
    a.download = "";
    a.click();
  };

  // A setup thread in this design opens instead of starting a second one.
  const setupThread = threads.find((t) => t.setup && t.running);
  const setUp = async () => {
    const threadId =
      setupThread?.id ?? (await finite.request("design.setup", { designId: id })).threadId;
    go({ tab: "design", thread: threadId, canvas: place.canvas });
  };

  // When setup turned this design into other ones (a monorepo's apps), the screen follows.
  useEffect(
    () =>
      finite.on("setup.done", (event) => {
        if (event.designId === id && event.next !== id) {
          router.push(`/design/?id=${encodeURIComponent(event.next)}`);
        }
      }),
    [id, router],
  );

  // A thread without a canvas talks in the side panel; a canvas thread does when History is on.
  const chat: ThreadMeta | null =
    thread && (thread.canvasIds.length === 0 || history) ? thread : null;
  const running = threads.filter((t) => t.running);

  if (view.error && !state) {
    return (
      <div {...stylex.props(styles.screen)}>
        <TabBar current={id} />
        <div {...stylex.props(styles.message)}>
          <p>Couldn’t open this design: {view.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.screen)}>
      <TabBar
        current={id}
        currentName={state?.design.name ?? null}
        working={running.map((t) => ({ name: t.title || "Agent", status: null }))}
      >
        {thread && thread.canvasIds.length > 0 && (
          <IconButton
            icon="history"
            label={history ? "Hide messages" : "Show messages"}
            title="History"
            variant="ghost"
            size="small"
            pressed={history}
            onClick={() => setHistory((h) => !h)}
          />
        )}
        <IconButton
          icon="sidebar"
          label={inspector ? "Hide inspector" : "Show inspector"}
          variant="ghost"
          size="small"
          pressed={inspector}
          onClick={() => setInspector((o) => !o)}
          style={styles.mirror}
        />
      </TabBar>

      <div {...stylex.props(styles.body)}>
        <LeftSidebar
          designId={id}
          name={state?.design.name ?? ""}
          mode={place.tab}
          onMode={(tab) => {
            if (tab === place.tab) return;
            go(
              tab === "design"
                ? { tab, thread: null, canvas: pageId }
                : { tab, thread: null, canvas: null },
            );
          }}
          canvases={canvases}
          page={pageId}
          onPage={(canvasId) => go({ tab: "design", thread: place.thread, canvas: canvasId })}
          layers={<LayersTree canvas={canvas} />}
          tokens={<TokensSection designId={id} />}
          prototypes={
            <ThreadList
              designId={id}
              threads={threads}
              canvases={canvases}
              current={place.thread ? { threadId: place.thread, canvasId: place.canvas } : null}
              showWorkingSeparately={settings?.showWorkingSeparately ?? false}
              onOpen={({ threadId: t, canvasId: c }) =>
                go({ tab: "prototypes", thread: t, canvas: c })
              }
              onNew={() => {
                go({ tab: "prototypes", thread: null, canvas: null });
                focusComposer();
              }}
            />
          }
          onSettings={() => setSettingsOpen(true)}
        />

        <main {...stylex.props(styles.main)}>
          <Canvas
            key={canvas?.id ?? "new"}
            designId={id}
            canvas={canvas}
            mode={place.tab === "design" ? "design" : "prototypes"}
          />
          <Preview
            state={state?.preview}
            install={state?.install}
            setupThread={setupThread ?? null}
            onSetup={() =>
              void setUp().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
            }
          />
          {place.tab === "prototypes" && !thread && (
            <div {...stylex.props(styles.hello)}>
              <p {...stylex.props(styles.helloTitle)}>Describe something to prototype</p>
              <p {...stylex.props(styles.helloText)}>
                The agent builds it on this canvas from your app&apos;s code and names it.
              </p>
              <div {...stylex.props(styles.examples)}>
                {EXAMPLE_PROMPTS.map(([label, prompt]) => (
                  <Button key={label} size="small" onClick={() => focusComposer(prompt)}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <StarMenu
            mode={place.tab === "design" ? "design" : "prototypes"}
            onExplore={explore}
            onMoveToProd={(target) =>
              void (
                thread
                  ? sendTo(composerChoice(`Move ${target} to production.`), { threadId: thread.id })
                  : Promise.resolve()
              ).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
            }
            onAsk={focusComposer}
            onExport={exportSelection}
          />
          <div {...stylex.props(styles.dock)}>
            <Composer
              designId={id}
              thread={thread}
              pill={place.tab === "design" && !thread}
              onSend={send}
            />
          </div>
        </main>

        {(chat || inspector) && (
          <div {...stylex.props(styles.right)}>
            {chat && (
              <ChatPanel
                designId={id}
                thread={chat}
                onClose={
                  chat.canvasIds.length > 0
                    ? () => setHistory(false)
                    : () => go({ ...place, thread: null }, false)
                }
              />
            )}
            {inspector && <Inspector open onOpenChange={setInspector} />}
          </div>
        )}
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/**
 * While a new design's dependencies install, its dev server starts, or either fails. A failed
 * preview, or a folder Finite can't run yet, offers a setup thread that writes its finite.json.
 */
function Preview({
  state,
  install,
  setupThread,
  onSetup,
}: {
  state: PreviewState | undefined;
  install: InstallState | undefined;
  setupThread: ThreadMeta | null;
  onSetup: () => void;
}) {
  const installing = install && install.status !== "done" ? install : undefined;
  if (!installing && (!state || state.status === "ready" || state.status === "stopped")) {
    return null;
  }
  const failed = installing ? installing.status === "error" : state?.status === "error";
  const needsSetup = !installing && state?.status === "needs-setup";
  const title = installing
    ? failed
      ? "Installing dependencies failed"
      : "Installing dependencies…"
    : needsSetup
      ? "Finite can’t run this folder yet"
      : failed
        ? "The dev server stopped"
        : "Starting the dev server…";
  let log = installing ? installing.log : state?.log?.trim();
  // A setup design's log is its reason. A failed preview's starts with what went wrong and what
  // to do, then the output.
  let reason: string | undefined;
  if (needsSetup) {
    reason = log;
    log = undefined;
  } else if (!installing && failed && log?.includes("\n\n")) {
    reason = log.slice(0, log.indexOf("\n\n"));
    log = log.slice(reason.length);
  }
  const tail = log?.trim().split("\n").slice(-6).join("\n");
  return (
    <div role="status" {...stylex.props(styles.preview)}>
      <p {...stylex.props(styles.previewTitle)}>{title}</p>
      {reason && <p {...stylex.props(styles.reason)}>{reason}</p>}
      {tail && <pre {...stylex.props(styles.log)}>{tail}</pre>}
      {!installing && (failed || needsSetup) && (
        <div {...stylex.props(styles.previewActions)}>
          <span {...stylex.props(styles.previewNote)}>
            {setupThread
              ? "Claude is writing finite.json."
              : "Claude can write a finite.json that tells Finite how to run it."}
          </span>
          <Button size="small" variant="brand" onClick={onSetup}>
            {setupThread ? "Open setup thread" : "Set up with Claude"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the empty Prototypes canvas offers to start from; each fills the composer. */
const EXAMPLE_PROMPTS = [
  ["Pricing card, 3 styles", "A small pricing card, explore 3 style directions"],
  ["Settings page", "A settings page for this app, in its own components and tokens"],
  ["Empty search results", "An empty state for a search with no results"],
] as const;

const styles = stylex.create({
  screen: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    overflow: "hidden",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: fonts.sans,
  },
  body: {
    display: "grid",
    gridTemplateColumns: `${size.left} minmax(0, 1fr) auto`,
    gridTemplateAreas: '"left main right"',
    flexGrow: 1,
    minHeight: 0,
  },
  main: {
    gridArea: "main",
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: colors.canvas,
  },
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: space.lg,
    zIndex: 10,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  right: { gridArea: "right", display: "flex", minHeight: 0 },
  mirror: { transform: "scaleX(-1)" },
  hello: {
    position: "absolute",
    left: "50%",
    top: "38%",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
    pointerEvents: "none",
  },
  examples: {
    pointerEvents: "auto",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space.sm,
    marginTop: space.lg,
  },
  helloTitle: { margin: 0, fontSize: 20, fontWeight: 500, color: colors.text },
  helloText: { marginTop: space.sm, marginBottom: 0, fontSize: 13, color: colors.muted },
  preview: {
    position: "absolute",
    top: space.lg,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 5,
    maxWidth: 520,
    paddingBlock: space.ms,
    paddingInline: space.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
  },
  previewTitle: { margin: 0, fontSize: 13, fontWeight: 500 },
  previewActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    marginTop: space.ms,
  },
  previewNote: { fontSize: 12, color: colors.muted },
  reason: {
    marginTop: space.sm,
    marginBottom: 0,
    fontSize: 12,
    lineHeight: "17px",
    color: colors.muted,
    whiteSpace: "pre-line",
    overflowWrap: "anywhere",
  },
  log: {
    marginTop: space.sm,
    marginBottom: 0,
    maxHeight: 120,
    overflow: "hidden",
    color: colors.faint,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: "15px",
    whiteSpace: "pre-wrap",
  },
  message: { padding: space.xl, color: colors.muted, fontSize: 13 },
});
