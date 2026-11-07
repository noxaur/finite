"use client";

import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";
import { type Inline, parseMarkdown } from "@/lib/markdown";
import { colors, fonts, radii, space } from "@/styles/tokens.stylex";

/** The agent's Markdown as elements (see `parseMarkdown`); text is never read as HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div {...stylex.props(styles.root)}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "p":
            return (
              <p key={i} {...stylex.props(styles.p)}>
                <Spans nodes={block.inline} />
              </p>
            );
          case "heading":
            return (
              <p key={i} role="heading" aria-level={block.level} {...stylex.props(styles.heading)}>
                <Spans nodes={block.inline} />
              </p>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i} {...stylex.props(styles.list)}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Spans nodes={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <pre key={i} {...stylex.props(styles.pre)}>
                <code>{block.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}

function Spans({ nodes }: { nodes: ReadonlyArray<Inline> }) {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} {...stylex.props(styles.code)}>
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} {...stylex.props(styles.strong)}>
            <Spans nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Spans nodes={node.children} />
          </em>
        );
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            {...stylex.props(styles.link)}
          >
            <Spans nodes={node.children} />
          </a>
        );
    }
  });
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    minWidth: 0,
    fontSize: 13,
    lineHeight: "19px",
    overflowWrap: "anywhere",
  },
  p: { margin: 0 },
  heading: { margin: 0, fontWeight: 600 },
  strong: { fontWeight: 600 },
  list: {
    margin: 0,
    paddingLeft: 18,
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  code: {
    paddingInline: 3,
    borderRadius: radii.xs,
    backgroundColor: colors.sunk,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  pre: {
    margin: 0,
    padding: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: "17px",
    whiteSpace: "pre",
    overflowX: "auto",
  },
  link: {
    color: "inherit",
    textDecorationLine: "underline",
    textDecorationColor: { default: colors.faint, ":hover": colors.text },
    textUnderlineOffset: 2,
  },
});
