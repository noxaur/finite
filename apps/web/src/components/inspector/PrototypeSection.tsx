"use client";

import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";
import type { Editor } from "@/design/editing/editor";
import { artboardLinkTarget } from "@/design/html";
import type { Replica } from "@/design/replica";
import type { Node } from "@/design/schema";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Choice, Labeled, Section } from "./controls";

/** Whether `node` is a link, which can go to an artboard in interactive mode. */
const isLink = (node: Node) => node.tag === "a" || node.tag === "area";

/**
 * Where a selected link goes (`href="#finite-artboard=<id>"`), or the
 * route a selected artboard is on (`data-route`). Artboards on one route
 * are one page at several widths, and a link opens the one closest to its
 * own width. Nothing for other layers, or for a node inside an instance.
 */
export function PrototypeSection({
  node,
  editor,
  replica,
}: {
  node: Node | undefined;
  editor: Editor;
  replica: Replica;
}) {
  if (!node || node.id.includes("/")) return null;
  if (node.parent === null) return <RouteField node={node} editor={editor} replica={replica} />;
  if (!isLink(node)) return null;
  const href = node.attrs.href ?? "";
  const to = artboardLinkTarget(href) ?? "";
  const here = replica.artboardOf(node.id)?.id;
  const options: Array<readonly [string, string]> = [
    ["", to === "" && href !== "" ? href : "No artboard"],
    ...(to !== "" && !replica.get(to) ? [[to, "Missing artboard"] as const] : []),
    ...replica
      .artboards()
      .filter((b) => b.id !== here)
      .map((b) => [b.id, b.name ?? "Artboard"] as const),
  ];
  return (
    <Section title="Prototype">
      <Labeled caption="Link">
        <Choice
          label="Link to artboard"
          title="The artboard this link opens in interactive mode"
          value={to}
          options={options}
          onPick={(value) =>
            void editor.commit([
              { kind: "setLink", ids: [node.id], to: value === "" ? null : value },
            ])
          }
        />
      </Labeled>
    </Section>
  );
}

function RouteField({ node, editor, replica }: { node: Node; editor: Editor; replica: Replica }) {
  const [typing, setTyping] = useState<string | null>(null);
  const putBack = useRef(false);
  const own = node.attrs["data-route"] ?? "";
  const route = replica.flow().routes.find((r) => r.screens.some((s) => s.artboard === node.id));
  const commit = () => {
    const text = typing?.trim();
    setTyping(null);
    if (putBack.current || text === undefined || text === own) {
      putBack.current = false;
      return;
    }
    void editor.commit([{ kind: "setRoute", id: node.id, route: text === "" ? null : text }]);
  };
  return (
    <Section title="Prototype">
      <Labeled caption="Route">
        <label {...stylex.props(styles.field)}>
          <input
            aria-label="Route"
            spellCheck={false}
            value={typing ?? own}
            placeholder={route?.path}
            title="Artboards with the same route are one page at different widths"
            onChange={(e) => setTyping(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                putBack.current = true;
                e.currentTarget.blur();
              }
            }}
            {...stylex.props(styles.input)}
          />
        </label>
      </Labeled>
    </Section>
  );
}

const styles = stylex.create({
  field: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    height: size.sm,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: {
      default: shadows.field,
      ":hover": `${shadows.field}, inset 0 0 0 1px ${colors.border}`,
      ":focus-within": `${shadows.field}, inset 0 0 0 1px ${colors.brand}`,
    },
    cursor: "text",
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    width: "100%",
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    outline: "none",
    "::placeholder": { color: colors.faint },
  },
});
