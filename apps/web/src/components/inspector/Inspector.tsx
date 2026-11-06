"use client";

import * as stylex from "@stylexjs/stylex";
import type { Frame, Inspection, Token } from "@finite/protocol";
import { useEffect, useMemo, useState } from "react";
import { bridgeOf } from "@/canvas/bridge";
import { finite } from "@/client/finite";
import { type CanvasEditor, useActiveEditor, useEditorState } from "@/canvas/editor";
import { baseName, fileOf } from "@/canvas/gestures";
import { keyOf, type SelectionItem, useSelection } from "@/canvas/selection";
import { radiusOf } from "@/design/editing/appearance";
import { routeStyles } from "@/design/editing/inspect";
import type { TokenTable } from "@/design/types";
import { colors, fonts, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "../Button";
import { Icon } from "../Icons";
import { AppearanceSection } from "./AppearanceSection";
import { EffectsSection } from "./EffectsSection";
import { FillSection } from "./FillSection";
import { geometryOf } from "./geometry";
import { LayoutSection } from "./LayoutSection";
import { RadiusSection } from "./RadiusSection";
import type { Changes, Scope } from "./scope";
import { StrokeSection } from "./StrokeSection";
import { createStyleEditor, type StyleEdit, type Target } from "./styleEditor";
import { TypographySection } from "./TypographySection";
import { GeometryFrameFields } from "./FrameFields";

/** The design's tokens as the fields read them: a Light and a Dark mode. */
export function tokenTable(tokens: readonly Token[]): TokenTable {
  const table: Record<string, Record<string, string>> = {};
  for (const t of tokens) {
    table[t.name] = {
      ...(t.light === undefined ? {} : { light: t.light }),
      ...(t.dark === undefined ? {} : { dark: t.dark }),
    };
  }
  return {
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
    tokens: table,
  };
}

const CORNERS = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
] as const;

const camel = (prop: string) => prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A `CSSStyleDeclaration` the fields can read, from what the bridge measured (camelCase keys). */
function declaration(computed: Readonly<Record<string, string>>): CSSStyleDeclaration {
  const own = (prop: string) => computed[prop] ?? computed[camel(prop)] ?? "";
  // The bridge measures the corners; the radius field reads them as one, like `rounded-card`.
  const read = (prop: string) => {
    if (prop !== "border-radius" && prop !== "borderRadius") return own(prop);
    const corners = CORNERS.map(own) as [string, string, string, string];
    return own(prop) || (corners.every(Boolean) ? radiusOf(corners) : "");
  };
  // Fields read it both ways: `getPropertyValue("flex-direction")` and `.flexDirection`.
  return new Proxy({} as CSSStyleDeclaration, {
    get: (_, key) =>
      key === "getPropertyValue" ? read : typeof key === "string" ? read(key) : undefined,
  });
}

type Inspected = { item: SelectionItem & { loc: string }; inspection: Inspection };

/** What the bridge says about each selected element, measured again after every frame update. */
function useInspections(items: readonly SelectionItem[], updates: number): Inspected[] | null {
  const [found, setFound] = useState<Inspected[] | null>(null);
  const key = items.map(keyOf).join(" ");
  useEffect(() => {
    let live = true;
    const els = items.filter((i): i is SelectionItem & { loc: string } => i.loc !== undefined);
    void Promise.all(
      els.map(async (item) => {
        const inspection = await bridgeOf(item.frameId)
          ?.inspect(item.loc, item.index ?? 0)
          .catch(() => null);
        return inspection ? { item, inspection } : null;
      }),
    ).then((all) => {
      if (live) setFound(all.filter((x): x is Inspected => x !== null));
    });
    return () => {
      live = false;
    };
    // `items` is keyed by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, updates]);
  return found;
}

function useTokens(designId: string | undefined): TokenTable {
  const [tokens, setTokens] = useState<readonly Token[]>([]);
  useEffect(() => {
    if (!designId) return;
    let live = true;
    void finite
      .request("tokens.get", { designId })
      .then((t) => live && setTokens(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [designId]);
  return useMemo(() => tokenTable(tokens), [tokens]);
}

/**
 * The selection's styles, down the right side, collapsed by default. It reads what the browser
 * draws (through the frame's bridge) and writes CSS properties as `style` source edits, which
 * the server turns into the design's convention (Tailwind classes, a CSS module rule, or inline
 * styles). Typing previews in the frame on each key and is kept as one edit. A selected frame
 * shows its place and size on the canvas.
 */
export function Inspector({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const editor = useActiveEditor();
  const state = useEditorState(editor);
  const selection = useSelection();
  const inspected = useInspections(selection, state?.updates ?? 0);
  const tokens = useTokens(editor?.designId);

  if (!open) {
    return (
      <div {...stylex.props(styles.closed)}>
        <IconButton
          size="small"
          variant="ghost"
          icon="sidebar"
          label="Show inspector"
          onClick={() => onOpenChange(true)}
        />
      </div>
    );
  }
  const frames = selection.filter((s) => s.loc === undefined);
  const header = (title: string, kind?: string) => (
    <header {...stylex.props(styles.top)}>
      <span {...stylex.props(styles.topIcon)}>
        <Icon name={kind === "Frame" ? "artboard" : "box"} size={15} />
      </span>
      <span {...stylex.props(styles.topName)}>{title}</span>
      {kind && <span {...stylex.props(styles.tag)}>{kind}</span>}
      <IconButton
        size="small"
        variant="ghost"
        icon="sidebar"
        label="Hide inspector"
        onClick={() => onOpenChange(false)}
      />
    </header>
  );

  let body = <p {...stylex.props(styles.empty)}>Select a frame or an element to see its styles.</p>;
  let title = "Inspector";
  let kind: string | undefined;
  const frame = frames.length === 1 && editor ? editor.frame(frames[0]!.frameId) : undefined;
  if (editor && frame && selection.length === 1) {
    title = frame.name;
    kind = "Frame";
    body = <FramePanel editor={editor} frame={frame} />;
  } else if (editor && inspected && inspected.length > 0) {
    const panel = <ElementPanel editor={editor} inspected={inspected} tokens={tokens} />;
    const [first] = inspected;
    title = inspected.length === 1 ? `<${first!.inspection.tag}>` : `${inspected.length} layers`;
    kind = inspected.length === 1 ? baseName(fileOf(first!.item.loc)) : undefined;
    body = (
      <>
        {state?.label && <p {...stylex.props(styles.label)}>{state.label}</p>}
        {panel}
      </>
    );
  }
  return (
    <div role="group" aria-label="Inspector" {...stylex.props(styles.panel)}>
      {header(title, kind)}
      <div {...stylex.props(styles.scroll)}>{body}</div>
    </div>
  );
}

function FramePanel({ editor, frame }: { editor: CanvasEditor; frame: Frame }) {
  return <GeometryFrameFields editor={editor} frame={frame} />;
}

function ElementPanel({
  editor,
  inspected,
  tokens,
}: {
  editor: CanvasEditor;
  inspected: Inspected[];
  tokens: TokenTable;
}) {
  const byId = new Map(inspected.map((x) => [keyOf(x.item), x]));
  const styleEditor = useMemo(
    () =>
      createStyleEditor(
        (id) => {
          const x = byId.get(id);
          return x && { frameId: x.item.frameId, loc: x.item.loc };
        },
        (groups) => editor.styleEdits(groups),
      ),
    // A new selection makes a new editor; within one, the locs stay put.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, inspected.map((x) => keyOf(x.item)).join(" ")],
  );
  const targets: Target[] = inspected.map((x) => ({
    id: keyOf(x.item),
    parent: `${keyOf(x.item)}^`,
    styles: {},
  }));
  const computedOf = (id: string) => {
    if (id.endsWith("^")) {
      const p = byId.get(id.slice(0, -1))?.inspection.parent;
      return p ? declaration({ display: p.display, "flex-direction": p.flexDirection }) : null;
    }
    const x = byId.get(id);
    return x ? declaration(x.inspection.computed) : null;
  };
  const editsEach = (changes: (target: Target) => Changes): StyleEdit[] => {
    // Targets that write the same styles share one edit.
    const groups = new Map<string, { ids: string[]; styles: Changes }>();
    for (const t of targets) {
      const routed = routeStyles(t.styles, changes(t));
      const key = JSON.stringify(routed);
      const group = groups.get(key);
      if (group) group.ids.push(t.id);
      else groups.set(key, { ids: [t.id], styles: routed });
    }
    return [...groups.values()].map((g) => ({ kind: "setStyles", ...g }));
  };
  const edits = (changes: Changes) => editsEach(() => changes);
  const [first] = targets;
  const scope: Scope = {
    targets,
    text: inspected.every((x) => x.inspection.text !== undefined),
    computed: first ? computedOf(first.id) : null,
    computedOf,
    tokens,
    mode: "light",
    editor: styleEditor,
    edits,
    editsEach,
    commit: (changes) => void styleEditor.commit(edits(changes)),
    commitEach: (changes) => void styleEditor.commit(editsEach(changes)),
  };
  const one = inspected.length === 1 ? inspected[0] : undefined;
  const rect = one && editor.state.rects[keyOf(one.item)];
  const geometry = one && first && rect ? geometryOf(first, rect) : null;
  // Fields start fresh for a new selection.
  const key = targets.map((t) => t.id).join(" ");
  return (
    <div key={key}>
      <LayoutSection scope={scope} editor={styleEditor} geometry={geometry} />
      <FillSection scope={scope} />
      <StrokeSection scope={scope} />
      <RadiusSection scope={scope} />
      <AppearanceSection scope={scope} />
      <EffectsSection scope={scope} />
      <TypographySection scope={scope} />
    </div>
  );
}

const styles = stylex.create({
  closed: {
    display: "flex",
    justifyContent: "flex-end",
    padding: space.xs,
  },
  panel: {
    display: "flex",
    fontFamily: fonts.sans,
    flexDirection: "column",
    width: size.right,
    minHeight: 0,
    height: "100%",
    backgroundColor: colors.surface,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
  },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  top: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.lg,
    flexShrink: 0,
    paddingInline: space.ms,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  topIcon: { color: colors.faint, display: "flex" },
  topName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 14,
    lineHeight: "18px",
    fontWeight: 500,
  },
  tag: {
    flexShrink: 0,
    color: colors.faint,
    fontSize: 12,
    lineHeight: "15px",
  },
  label: {
    margin: 0,
    paddingInline: space.ms,
    paddingBlock: space.sm,
    color: colors.muted,
    fontSize: 12,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.borderSoft,
  },
  empty: {
    margin: 0,
    padding: space.ms,
    color: colors.faint,
    fontSize: 13,
  },
});
