"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { localUser } from "@/lib/user";
import { colors, fonts } from "@/styles/tokens.stylex";

/**
 * Who's using this browser, as a round initial. There are no accounts
 * yet, so it shows the name this browser comments under; a profile
 * picture takes its place once people sign in. The name lives in local
 * storage, which the server can't read, so the server and the first
 * render draw an empty circle and the name comes in after mount.
 */
export function UserAvatar() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    try {
      setName(localUser().name);
    } catch {
      // Storage can be blocked, as in a private window.
      setName("Guest");
    }
  }, []);
  return (
    <span
      role="img"
      aria-label={name ?? "Account"}
      title={name ?? undefined}
      {...stylex.props(styles.avatar, name === null && styles.waiting)}
    >
      {name?.trim().charAt(0).toUpperCase()}
    </span>
  );
}

const styles = stylex.create({
  avatar: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 24,
    borderRadius: "50%",
    backgroundColor: colors.accent,
    color: colors.onAccent,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
    userSelect: "none",
  },
  // Before the name is read: a neutral circle, so nothing jumps when it comes in.
  waiting: { backgroundColor: colors.sunk },
});
