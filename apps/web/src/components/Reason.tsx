"use client";

import * as stylex from "@stylexjs/stylex";

/** A reason from the server, with its `backticked` commands set as code. */
export function Reason({ text, code }: { text: string; code: stylex.StyleXStyles }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) =>
        i % 2 ? (
          <code key={i} {...stylex.props(code)}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
