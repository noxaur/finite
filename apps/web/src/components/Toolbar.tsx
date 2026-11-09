"use client";

import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";
import type { CanvasEditor, EditorState } from "@/canvas/editor";
import type { ToolDef, ToolGroup } from "@/canvas/tools/host";
import { GROUPS, keyHint, toolOf, toolsIn } from "@/canvas/tools/registry";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { Icon } from "./Icons";
import { Menu, type MenuItem } from "./Menu";

const titleOf = (tool: ToolDef) =>
  tool.keys ? `${tool.label} (${keyHint(tool.keys)})` : tool.label;

/**
 * The canvas's tools, floating at the bottom center: one split button per group, showing the
 * group's last-used tool with a chevron for the rest. The registry says what's here.
 */
export function Toolbar({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const [last, setLast] = useState<Partial<Record<ToolGroup, string>>>({});
  const { group, hint } = toolOf(state.tool);
  // The last-used tool follows the current one, so a group's button shows what it'll pick.
  if (last[group] !== state.tool) setLast({ ...last, [group]: state.tool });
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      data-canvas-ui=""
      data-camera-ignore=""
      {...stylex.props(styles.bar)}
    >
      {GROUPS.map((g) => {
        const tools = toolsIn(g);
        if (tools.length === 0) return null;
        return (
          <ToolGroupButton
            key={g}
            tools={tools}
            current={state.tool}
            shown={last[g]}
            onPick={(id) =>
              editor.setTool(id === "interact" && state.tool === "interact" ? "select" : id)
            }
          />
        );
      })}
      {hint && <span {...stylex.props(styles.note)}>{hint}</span>}
    </div>
  );
}

function ToolGroupButton({
  tools,
  current,
  shown,
  onPick,
}: {
  tools: ToolDef[];
  current: string;
  shown: string | undefined;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chevron = useRef<HTMLButtonElement>(null);
  const tool = tools.find((t) => t.id === shown) ?? tools[0]!;
  const active = tools.some((t) => t.id === current);
  const items: MenuItem[] = tools.map((t) => ({
    key: t.id,
    label: t.label,
    icon: t.icon,
    note: t.keys ? keyHint(t.keys) : undefined,
    checked: t.id === current,
    run: () => onPick(t.id),
  }));
  return (
    <div {...stylex.props(styles.group)}>
      <IconButton
        icon={tool.icon}
        label={tool.label}
        title={titleOf(tool)}
        variant={active ? "brand" : "ghost"}
        aria-pressed={tool.id === current}
        onClick={(e) => {
          onPick(tool.id);
          // A pointer click leaves focus here, and the next tool key would draw the focus ring.
          if (e.detail > 0) e.currentTarget.blur();
        }}
      />
      {tools.length > 1 && (
        <button
          ref={chevron}
          type="button"
          aria-label={`More ${tool.group} tools`}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`More ${tool.group} tools`}
          onClick={() => setOpen((o) => !o)}
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
        >
          <Icon name="chevronDown" size={10} />
        </button>
      )}
      {open && chevron.current && (
        <Menu
          title={`${tool.group} tools`}
          items={items}
          anchor={chevron.current}
          trigger={chevron.current}
          align="left"
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

const styles = stylex.create({
  bar: {
    position: "absolute",
    bottom: `calc(var(--dock-clearance, 0px) + ${space.sm})`,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    padding: space.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  group: { display: "flex", alignItems: "center" },
  chevron: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 27,
    width: 14,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.muted,
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  chevronOpen: { backgroundColor: colors.activeFill, color: colors.text },
  note: { color: colors.muted, paddingInline: space.xs },
});
