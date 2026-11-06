"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { resolveVars } from "@/design/editing/colors";
import type { Editor } from "@/design/editing/editor";
import { type Reading, tokenOf } from "@/design/editing/inspect";
import type { PageEntry, TokenTable } from "@/design/replica";
import { resolveToken } from "@/lib/tokens";
import { colors } from "@/styles/tokens.stylex";
import { Button } from "../Button";
import { ColorField, Section, Toggle } from "./controls";
import type { Changes, Scope } from "./scope";

/** The one style the background field writes, which the scope below turns into a page edit. */
const KEY = "background";

/**
 * The inspector when nothing is selected: the canvas color behind the
 * shown page's artboards, then the way to bring more agents in. The color
 * row is the Fill section's own, fed through a scope whose edits are page
 * edits, so a color, a token or an opacity picked is one undo step like
 * any style.
 */
export function PagePanel({
  editor,
  page,
  tokens,
}: {
  editor: Editor;
  page: PageEntry;
  tokens: TokenTable;
}) {
  const theme = useThemeCanvas();
  const edits = (changes: Changes) => [
    {
      kind: "setPageBackground" as const,
      id: page.id,
      background: typedColor(changes[KEY] ?? null),
    },
  ];
  const scope: Scope = {
    targets: [],
    text: false,
    computed: null,
    computedOf: () => null,
    tokens,
    // The canvas sits outside every artboard, so tokens read in the first mode.
    mode: tokens.modes[0]?.id ?? "",
    editor,
    edits,
    editsEach: () => [],
    commit: (changes) => void editor.commit(edits(changes)),
    commitEach: () => {},
  };
  // Unset, the field shows the theme's canvas color faintly, as a style the browser draws.
  const reading: Reading =
    page.background !== undefined
      ? { kind: "value", raw: page.background, token: tokenOf(page.background) }
      : theme.color
        ? { kind: "computed", raw: theme.color }
        : { kind: "unset" };

  return (
    <div role="group" aria-label="Page" {...stylex.props(styles.panel)}>
      <Section
        title="Page"
        action={
          page.background !== undefined && (
            <Toggle
              icon="minus"
              title="Use the theme's canvas color"
              onClick={() => scope.commit({ [KEY]: null })}
            />
          )
        }
      >
        <ColorField
          scope={scope}
          label="Background"
          reading={reading}
          toChanges={(color) => ({ [KEY]: color })}
        />
      </Section>
      <Section title="MCP">
        {/* What connecting asks for comes later; for now the button only says where agents come in. */}
        <Button style={styles.connect}>Connect more agents</Button>
      </Section>
      {theme.probe}
    </div>
  );
}

/** The canvas color a page's background paints: its tokens read in the design's first mode. */
export function pageCanvasColor(background: string, tokens: TokenTable): string {
  const mode = tokens.modes[0]?.id ?? "";
  return resolveVars(background, (name) => resolveToken(tokens, name, mode));
}

/** A color as typed: a bare hex like `e8eef0` gets its `#`; anything else goes as it is. */
function typedColor(color: string | null): string | null {
  return color !== null && /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? `#${color}` : color;
}

/**
 * The theme's canvas color as the browser paints it, read off a hidden
 * probe painted with `colors.canvas`, and read again when the system
 * switches between light and dark. `color` is `null` until the probe has
 * mounted.
 */
function useThemeCanvas(): { color: string | null; probe: ReactNode } {
  const ref = useRef<HTMLSpanElement>(null);
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      if (ref.current) setColor(getComputedStyle(ref.current).backgroundColor);
    };
    read();
    const dark = matchMedia("(prefers-color-scheme: dark)");
    dark.addEventListener("change", read);
    return () => dark.removeEventListener("change", read);
  }, []);
  return { color, probe: <span ref={ref} aria-hidden {...stylex.props(styles.probe)} /> };
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  connect: { width: "100%" },
  probe: { display: "none", backgroundColor: colors.canvas },
});
