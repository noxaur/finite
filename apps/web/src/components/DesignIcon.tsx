"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { DesignEntry } from "@finite/protocol";
import { radii } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

/**
 * The connected app's own icon (the server finds it on each request), or the folder or artboard
 * glyph when the design has none or the image doesn't load.
 */
export function DesignIcon({ design, size }: { design: DesignEntry; size: number }) {
  // The id that failed, not a flag, so a row reused for another design tries its icon again.
  const [failed, setFailed] = useState<string>();
  if (failed === design.id) {
    return <Icon name={design.origin === "connected" ? "folder" : "artboard"} size={15} />;
  }
  return (
    <img
      alt=""
      src={`/api/designs/${encodeURIComponent(design.id)}/icon`}
      width={size}
      height={size}
      onError={() => setFailed(design.id)}
      {...stylex.props(styles.image)}
    />
  );
}

const styles = stylex.create({
  image: { objectFit: "contain", borderRadius: radii.sm },
});
