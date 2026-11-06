"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { Editor } from "@/design/editing/editor";
import { routeStyles } from "@/design/editing/inspect";
import { iconOf } from "@/design/editing/layers";
import { nodeOf } from "@/design/editing/tree";
import type { Renderer } from "@/design/renderer";
import type { Replica, TokenTable } from "@/design/replica";
import type { Node, UserEdit } from "@/design/schema";
import type { DesignSession } from "@/design/session";
import { colors, size, space } from "@/styles/tokens.stylex";
import { Icon } from "../Icons";
import { useRedrawOnChange } from "../SelectionLayer";
import { Toggle } from "./controls";
import { AppearanceSection } from "./AppearanceSection";
import { AdvancedSection } from "./AdvancedSection";
import { EffectsSection } from "./EffectsSection";
import { FillSection } from "./FillSection";
import { geometryOf } from "./geometry";
import { LayoutSection } from "./LayoutSection";
import { PositionSection } from "./PositionSection";
import { RadiusSection } from "./RadiusSection";
import type { Changes, Scope } from "./scope";
import { SizeSection } from "./SizeSection";
import { StrokeSection } from "./StrokeSection";
import { TransformSection } from "./TransformSection";
import { TransitionsSection } from "./TransitionsSection";
import { TypographySection } from "./TypographySection";

function kindOf(node: Node): string {
  if (node.parent === null) return "Artboard";
  if (node.component) return "Component";
  if (node.instanceOf !== undefined) return "Instance";
  if (node.type === "text") return "Text";
  return node.tag ?? "Element";
}
/**
 * The selection's styles, down the right side. Each field shows the inline
 * style every selected element shares, the token it uses, or, faintly,
 * what the browser draws when none of them sets one. Typing into a field
 * shows on the canvas with each key and sets it on the whole selection as
 * one edit when it's kept, so one undo takes it back; agents see it like
 * any other change. Dragging a field's icon or letter scrubs its number,
 * and ↑ and ↓ step it. The ◇ button picks one of the design's tokens. X,
 * Y, W and H move and resize the one selected element the way dragging
 * does. The fields follow every change as it's made, a drag on the canvas
 * included.
 */
export function Inspector({
  editor,
  session,
  renderer,
  replica,
  tokens,
}: {
  editor: Editor;
  session: DesignSession;
  renderer: Renderer;
  replica: Replica;
  tokens: TokenTable;
}) {
  useRedrawOnChange(session);
  const [state, setState] = useState(editor.state);
  useEffect(() => {
    setState(editor.state);
    return editor.subscribe(() => setState(editor.state));
  }, [editor]);

  const selected = state.selection
    .map((id) => nodeOf(replica, id))
    .filter((n): n is Node => n !== undefined);
  if (selected.length === 0) {
    return (
      <p {...stylex.props(styles.empty)}>
        Select a layer on the canvas or in Layers to see and change its styles.
      </p>
    );
  }
  const targets = [
    ...new Map(
      selected
        .map((n) => (n.type === "text" && n.parent !== null ? nodeOf(replica, n.parent) : n))
        .filter((n): n is Node => n !== undefined)
        .map((n) => [n.id, n]),
    ).values(),
  ];
  const [first] = targets;
  if (!first) return null;
  const board = replica.artboardOf(first.id);
  const editsEach = (changes: (target: Node) => Changes): UserEdit[] => {
    // Targets that write the same styles share one edit.
    const byStyles = new Map<string, { ids: string[]; styles: Changes }>();
    for (const t of targets) {
      const routed = routeStyles(t.styles, changes(t));
      const key = JSON.stringify(routed);
      const group = byStyles.get(key);
      if (group) group.ids.push(t.id);
      else byStyles.set(key, { ids: [t.id], styles: routed });
    }
    return [...byStyles.values()].map((g) => ({ kind: "setStyles", ...g }));
  };
  const edits = (changes: Changes) => editsEach(() => changes);
  const scope: Scope = {
    targets,
    // A text layer: a text node, or an element that holds only text, like a heading.
    text: targets.every((t) => {
      const kids = replica.children(t.id);
      return kids.length > 0 && kids.every((k) => k.type === "text");
    }),
    computed: renderer.computedStyle(first.id),
    computedOf: (id) => renderer.computedStyle(id),
    tokens,
    mode: board ? replica.modeOf(board) : "",
    editor,
    edits,
    editsEach,
    commit: (changes) => void editor.commit(edits(changes)),
    commitEach: (changes) => void editor.commit(editsEach(changes)),
  };
  const action = selected.length === 1 ? editor.componentAction(first.id) : null;
  const one = selected.length === 1 ? selected[0] : undefined;
  const geometry = one ? geometryOf(one, renderer, replica) : null;
  // Ids change with the selection, so every field starts fresh for a new one.
  const key = targets.map((t) => t.id).join(" ");

  return (
    <div key={key} role="group" aria-label="Inspector" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.top)}>
        <span {...stylex.props(styles.topIcon)}>
          <Icon name={one ? iconOf(one) : "box"} size={16} />
        </span>
        <span {...stylex.props(styles.topName)}>
          {one ? (one.name ?? one.text ?? one.tag ?? "Layer") : `${selected.length} layers`}
        </span>
        {one && <span {...stylex.props(styles.tag)}>{kindOf(one)}</span>}
        {action && (
          <Toggle
            icon={action === "make" ? "component" : "unlink"}
            title={action === "make" ? "Make component (⌥⌘K)" : "Detach instance (⌥⌘B)"}
            onClick={() => editor.toggleComponent(first.id)}
          />
        )}
      </header>
      <PositionSection scope={scope} />
      <LayoutSection scope={scope} editor={editor} geometry={geometry} />
      <SizeSection scope={scope} editor={editor} geometry={geometry} />
      <FillSection scope={scope} />
      <StrokeSection scope={scope} />
      <RadiusSection scope={scope} />
      <AppearanceSection scope={scope} />
      <EffectsSection scope={scope} />
      <TypographySection scope={scope} />
      <TransformSection scope={scope} />
      <TransitionsSection scope={scope} />
      <AdvancedSection scope={scope} />
    </div>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  empty: {
    margin: 0,
    padding: space.ms,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "16px",
  },
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
    lineHeight: "20px",
    fontWeight: 500,
  },
  tag: {
    flexShrink: 0,
    color: colors.faint,
    fontSize: 12,
    lineHeight: "16px",
  },
});
