"use client";

import * as stylex from "@stylexjs/stylex";
import type { EffortLevel, Queued, SendMode, Selection, ThreadMeta } from "@finite/protocol";
import { useEffect, useRef, useState } from "react";
import { finite, useClaudeStatus, useSettings } from "@/client/finite";
import {
  effortFor,
  effortName,
  effortShort,
  findModel,
  type ModelChoice,
  pickableModels,
  modelName,
  runWith,
  sendLabel,
  sendModeFor,
} from "@/lib/composer";
import { raised } from "@/styles/raised";
import { colors, fonts, motion, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { IconButton, Strip, StripItem } from "./Button";
import { selectionStore, useSelection } from "@/canvas";
import { selectionFor } from "@/lib/composer";
import { Icon } from "./Icons";
import { Reason } from "./Reason";
import { toast } from "./Toast";
import { useDismiss } from "./useDismiss";

/** One message, as the composer hands it to the screen to send. */
export interface Outgoing {
  readonly text: string;
  readonly attachments: string[];
  readonly selection: Selection[] | undefined;
  readonly model: string;
  readonly effort: EffortLevel | undefined;
  readonly fast: boolean;
  readonly mode: SendMode;
}

// Anything can ask the composer to open and take focus: ⌘L, the ✱ menu's "Ask about this", or an
// example prompt, which `text` puts in the box.
const focusListeners = new Set<(text?: string) => void>();
export function focusComposer(text?: string): void {
  for (const l of focusListeners) l(text);
}

interface Attachment {
  readonly name: string;
  /** The stored path, once uploaded. */
  readonly path: string | null;
}

/**
 * The floating message box at the bottom of the canvas: what's typed, attachments, the picked
 * elements, and the model to send with. While the thread runs, Enter steers or queues (the
 * default from Settings) and ⌥Enter does the other; queued messages wait above it as chips. In
 * the Design tab it rests as a small pill until it's clicked or ⌘L.
 */
export function Composer({
  designId,
  thread,
  pill = false,
  onSend,
}: {
  designId: string;
  thread: ThreadMeta | null;
  /** Rests as "Ask Finite ⌘L" until opened. */
  pill?: boolean;
  onSend: (message: Outgoing) => Promise<void>;
}) {
  const settings = useSettings();
  const claude = useClaudeStatus();
  const selection = useSelection();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<Attachment>>([]);
  const [open, setOpen] = useState(!pill);
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState(false);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setOpen(!pill), [pill]);

  // The open thread's settings (a new thread's: the defaults), until the person picks others.
  const models = claude?.models ?? [];
  const { model, effort, fast } = runWith(models, settings, thread, choice);
  const running = !!thread?.running;
  const defaultMode = settings?.sendMode ?? "steer";
  const blocked = claude !== null && (!claude.installed || !claude.loggedIn);

  useEffect(() => {
    const focus = (prefill?: string) => {
      setOpen(true);
      if (prefill !== undefined) setText(prefill);
      requestAnimationFrame(() => {
        const el = box.current;
        if (!el) return;
        el.focus();
        if (prefill !== undefined) el.setSelectionRange(prefill.length, prefill.length);
      });
    };
    focusListeners.add(focus);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        focus(undefined);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      focusListeners.delete(focus);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // A pill folds back when it's left empty.
  useDismiss({
    enabled: pill && open,
    contains: (t) => !!card.current?.contains(t),
    onClose: () => {
      if (!box.current?.value.trim() && files.length === 0) setOpen(false);
    },
  });

  const upload = async (list: FileList) => {
    for (const file of Array.from(list)) {
      setFiles((f) => [...f, { name: file.name, path: null }]);
      try {
        const body = new FormData();
        body.append("file", file, file.name);
        const res = await fetch(`/api/designs/${encodeURIComponent(designId)}/attachments`, {
          method: "POST",
          body,
        });
        const json = (await res.json()) as { path?: string; reason?: string };
        if (!res.ok || !json.path) throw new Error(json.reason ?? `Upload failed (${res.status})`);
        const path = json.path;
        setFiles((f) =>
          f.map((a) => (a.name === file.name && a.path === null ? { ...a, path } : a)),
        );
      } catch (e) {
        setFiles((f) => f.filter((a) => !(a.name === file.name && a.path === null)));
        toast(`Couldn't attach ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const send = async (alt: boolean) => {
    const message = text.trim();
    if (!message || sending || blocked || !model) return;
    if (files.some((f) => f.path === null)) return toast("Wait for the attachments to upload.");
    setSending(true);
    try {
      await onSend({
        text: message,
        attachments: files.map((f) => f.path!),
        selection: selectionFor(selection),
        model,
        effort,
        fast,
        mode: sendModeFor(running, defaultMode, alt),
      });
      setText("");
      setFiles([]);
      selectionStore.set([]);
      // The thread now runs with what was sent; a new thread starts from the defaults again.
      setChoice(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (pill && !open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => box.current?.focus());
        }}
        {...stylex.props(raised.control, styles.pill)}
      >
        <ClaudeMark />
        Ask Finite
        <kbd {...stylex.props(styles.kbd)}>⌘L</kbd>
      </button>
    );
  }

  return (
    <div {...stylex.props(styles.wrap)}>
      {thread && thread.queued.length > 0 && (
        <ul aria-label="Queued messages" {...stylex.props(styles.queue)}>
          {thread.queued.map((q) => (
            <QueuedChip key={q.id} designId={designId} thread={thread} queued={q} />
          ))}
        </ul>
      )}
      <div ref={card} {...stylex.props(styles.card)}>
        {(selection.length > 0 || files.length > 0) && (
          <div {...stylex.props(styles.chips)}>
            {selection.map((s) => (
              <span key={`${s.frameId}:${s.loc}:${s.index}`} {...stylex.props(styles.chip)}>
                <Icon name={s.loc === undefined ? "artboard" : "cursor"} size={12} />
                <span {...stylex.props(styles.chipText)}>
                  {s.name || (s.loc === undefined ? "this frame" : "this element")}
                </span>
                <button
                  type="button"
                  aria-label={`Leave out ${s.name ?? "this"}`}
                  onClick={() => selectionStore.set(selection.filter((x) => x !== s))}
                  {...stylex.props(styles.chipX)}
                >
                  <Icon name="close" size={8} />
                </button>
              </span>
            ))}
            {files.map((f, i) => (
              <span
                key={`${f.name}:${i}`}
                {...stylex.props(styles.chip, !f.path && styles.uploading)}
              >
                <Icon name="paperclip" size={12} />
                <span {...stylex.props(styles.chipText)}>{f.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                  {...stylex.props(styles.chipX)}
                >
                  <Icon name="close" size={8} />
                </button>
              </span>
            ))}
          </div>
        )}
        {blocked && (
          <p {...stylex.props(styles.blocked)}>
            <Reason text={claude?.reason ?? "Claude Code isn't ready."} code={styles.code} /> Then{" "}
            <button
              type="button"
              onClick={() => void finite.refreshClaude()}
              {...stylex.props(styles.link)}
            >
              check again
            </button>
            .
          </p>
        )}
        <textarea
          ref={box}
          aria-label="Message"
          placeholder={
            running
              ? defaultMode === "steer"
                ? "Steer the agent while it works…"
                : "Queue a message for after this turn…"
              : "Ask anything. @ files, $ skills, / commands"
          }
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(e.altKey);
            } else if (e.key === "Escape" && pill && !text) {
              setOpen(false);
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void upload(e.clipboardData.files);
            }
          }}
          {...stylex.props(styles.input)}
        />
        <div {...stylex.props(styles.bar)}>
          <IconButton
            icon="paperclip"
            label="Attach files"
            variant="ghost"
            onClick={() => fileInput.current?.click()}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <span {...stylex.props(styles.spacer)} />
          <div {...stylex.props(styles.modelWrap)}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={picker}
              onClick={() => setPicker((p) => !p)}
              {...stylex.props(styles.model)}
            >
              <ClaudeMark />
              <span>{model ? modelName(models, model) : "Claude"}</span>
              {effort && <span {...stylex.props(styles.muted)}>{effortName(effort)}</span>}
              {fast && <span {...stylex.props(styles.muted)}>Fast</span>}
            </button>
            {picker && (
              <ModelPicker
                models={models}
                model={model}
                effort={effort}
                fast={fast}
                onPick={(next) => setChoice({ ...next, threadId: thread?.id ?? null })}
                onClose={() => setPicker(false)}
              />
            )}
          </div>
          {running && (
            <button
              type="button"
              aria-label="Stop"
              title="Stop the agent"
              onClick={() =>
                void finite
                  .request("thread.interrupt", { designId, threadId: thread!.id })
                  .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
              }
              {...stylex.props(styles.send, raised.control)}
            >
              <Icon name="stop" size={15} />
            </button>
          )}
          {(!running || text.trim()) && (
            <button
              type="button"
              aria-label="Send"
              title={sendLabel(running, defaultMode)}
              disabled={!text.trim() || sending || blocked}
              onClick={(e) => void send(e.altKey)}
              {...stylex.props(
                styles.send,
                text.trim() && !blocked ? raised.brand : raised.control,
                (!text.trim() || blocked) && styles.sendIdle,
              )}
            >
              <Icon name="arrowUp" size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function QueuedChip({
  designId,
  thread,
  queued,
}: {
  designId: string;
  thread: ThreadMeta;
  queued: Queued;
}) {
  const [editing, setEditing] = useState(false);
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e));
  const edit = (text: string | null) =>
    finite
      .request("thread.queued", { designId, threadId: thread.id, queuedId: queued.id, text })
      .catch(fail);
  return (
    <li {...stylex.props(styles.queued)}>
      <Icon name="clock" size={12} />
      {editing ? (
        <input
          aria-label="Queued message"
          defaultValue={queued.text}
          autoFocus
          onBlur={(e) => {
            setEditing(false);
            const next = e.target.value.trim();
            if (next && next !== queued.text) void edit(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = queued.text;
              e.currentTarget.blur();
            }
          }}
          {...stylex.props(styles.queuedInput)}
        />
      ) : (
        <button
          type="button"
          title="Edit"
          onClick={() => setEditing(true)}
          {...stylex.props(styles.queuedText)}
        >
          {queued.text}
        </button>
      )}
      <IconButton
        icon="arrowUp"
        label="Send now"
        title="Send now: steer the running turn"
        variant="ghost"
        size="small"
        onClick={async () => {
          await edit(null);
          await finite
            .request("thread.send", {
              designId,
              threadId: thread.id,
              text: queued.text,
              attachments: queued.attachments,
              ...(queued.selection ? { selection: queued.selection } : {}),
              model: thread.model,
              ...(thread.effort ? { effort: thread.effort } : {}),
              fast: thread.fast,
              mode: "steer",
            })
            .catch(fail);
        }}
      />
      <IconButton
        icon="trash"
        label="Delete queued message"
        variant="ghost"
        size="small"
        onClick={() => void edit(null)}
      />
    </li>
  );
}

function ModelPicker({
  models,
  model,
  effort,
  fast,
  onPick,
  onClose,
}: {
  models: ReadonlyArray<{
    value: string;
    displayName: string;
    description: string;
    supportedEffortLevels?: EffortLevel[] | undefined;
    supportsFastMode?: boolean | undefined;
  }>;
  model: string;
  effort: EffortLevel | undefined;
  fast: boolean;
  onPick: (choice: { model: string; effort: EffortLevel | undefined; fast: boolean }) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDismiss({
    contains: (t) => !!panel.current?.parentElement?.contains(t),
    onClose,
  });
  const info = findModel(models, model);
  const levels = info?.supportedEffortLevels ?? [];
  return (
    <div ref={panel} role="dialog" aria-label="Model" {...stylex.props(styles.picker)}>
      <p {...stylex.props(styles.pickerLabel)}>Model</p>
      {models.length === 0 && <p {...stylex.props(styles.pickerNote)}>Claude lists no models.</p>}
      {pickableModels(models, model).map((m) => (
        <button
          key={m.value}
          type="button"
          role="menuitemradio"
          aria-checked={m.value === info?.value}
          onClick={() =>
            onPick({
              model: m.value,
              effort: effortFor(models, m.value, effort),
              fast: fast && !!m.supportsFastMode,
            })
          }
          {...stylex.props(styles.pickerRow, m.value === info?.value && styles.pickerRowOn)}
        >
          <span {...stylex.props(styles.pickerName)}>{m.displayName}</span>
          <span {...stylex.props(styles.pickerNote)}>{m.description}</span>
        </button>
      ))}
      {levels.length > 0 && (
        <>
          <p {...stylex.props(styles.pickerLabel)}>Reasoning</p>
          <Strip role="radiogroup" aria-label="Reasoning" size="small">
            {levels.map((level) => (
              <StripItem
                key={level}
                picked={level === effort}
                onClick={() => onPick({ model, effort: level, fast })}
              >
                {effortShort(level)}
              </StripItem>
            ))}
          </Strip>
        </>
      )}
      {info?.supportsFastMode && (
        <>
          <p {...stylex.props(styles.pickerLabel)}>Speed</p>
          <Strip role="radiogroup" aria-label="Speed" size="small">
            <StripItem picked={!fast} onClick={() => onPick({ model, effort, fast: false })}>
              Standard
            </StripItem>
            <StripItem picked={fast} onClick={() => onPick({ model, effort, fast: true })}>
              Fast
            </StripItem>
          </Strip>
        </>
      )}
    </div>
  );
}

/** Claude's asterisk, beside the model's name. */
export function ClaudeMark({ size: px = 15 }: { size?: number }) {
  const rays = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg width={px} height={px} viewBox="0 0 24 24" aria-hidden {...stylex.props(styles.mark)}>
      {rays.map((deg, i) => (
        <line
          key={deg}
          x1="12"
          y1="12"
          x2="12"
          y2={i % 2 ? 3.6 : 2}
          transform={`rotate(${deg} 12 12)`}
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

const styles = stylex.create({
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space.sm,
    width: "min(720px, calc(100% - 36px))",
    pointerEvents: "auto",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingTop: space.md,
    paddingBottom: space.ms,
    paddingInline: space.md,
    borderRadius: 15,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.borderSoft,
    backgroundColor: colors.composer,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
  },
  input: {
    minHeight: 48,
    maxHeight: 240,
    resize: "none",
    fieldSizing: "content",
    padding: 0,
    paddingInline: space.xs,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: "21px",
    outline: "none",
    "::placeholder": { color: colors.faint },
  },
  blocked: {
    margin: 0,
    minHeight: 48,
    paddingInline: space.xs,
    color: colors.muted,
    fontSize: 14,
    lineHeight: "21px",
  },
  code: { fontFamily: fonts.mono, fontSize: 13, color: colors.text },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.brandText,
    font: "inherit",
    textDecoration: "underline",
    cursor: "var(--cursor-pointer, pointer)",
  },
  bar: { display: "flex", alignItems: "center", gap: space.sm },
  spacer: { flexGrow: 1 },
  modelWrap: { position: "relative" },
  model: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.md,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  muted: { color: colors.muted, fontWeight: 400 },
  mark: { flexShrink: 0, color: colors.claude },
  send: {
    display: "grid",
    placeItems: "center",
    width: size.md,
    height: size.md,
    padding: 0,
    borderRadius: "50%",
    cursor: { default: "var(--cursor-pointer, pointer)", ":disabled": "default" },
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  sendIdle: { color: colors.faint },
  chips: { display: "flex", flexWrap: "wrap", gap: space.sm },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    maxWidth: 240,
    height: size.xs,
    paddingLeft: space.sm,
    paddingRight: space.xs,
    borderRadius: radii.md,
    backgroundColor: colors.activeFill,
    color: colors.text,
    fontSize: 12,
  },
  uploading: { opacity: 0.6 },
  chipText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chipX: {
    display: "grid",
    placeItems: "center",
    width: 18,
    height: 18,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.muted,
    cursor: "var(--cursor-pointer, pointer)",
  },
  queue: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  queued: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    alignSelf: "flex-start",
    maxWidth: "100%",
    height: size.sm,
    paddingLeft: space.ms,
    paddingRight: space.xs,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    boxShadow: shadows.control,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  queuedText: {
    minWidth: 0,
    maxWidth: 480,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    font: "inherit",
    cursor: "text",
  },
  queuedInput: {
    width: 360,
    height: size.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: colors.text,
    font: "inherit",
    outline: `1px solid ${colors.brand}`,
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    height: size.md,
    paddingInline: space.md,
    borderRadius: 18,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: 500,
    pointerEvents: "auto",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
    transition: `transform ${motion.fast} ${motion.out}`,
    transform: { default: "none", ":active": "scale(0.97)" },
  },
  kbd: { color: colors.faint, fontFamily: fonts.sans, fontSize: 12 },
  picker: {
    position: "absolute",
    right: 0,
    bottom: `calc(100% + ${space.sm})`,
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    width: 270,
    padding: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
  },
  pickerLabel: {
    margin: 0,
    paddingInline: space.xs,
    paddingTop: space.xs,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  pickerRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.text,
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  pickerRowOn: { backgroundColor: { default: colors.activeFill, ":hover": colors.activeFill } },
  pickerName: { fontSize: 13, fontWeight: 500 },
  pickerNote: {
    margin: 0,
    color: colors.faint,
    fontSize: 12,
    lineHeight: "15px",
    paddingInline: 0,
  },
});
