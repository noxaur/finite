"use client";

import * as stylex from "@stylexjs/stylex";
import { Exit } from "effect";
import { useEffect, useState, type FormEvent } from "react";
import { Api, type Greeting, type Health } from "@/api/Api";
import { runtime } from "@/runtime";
import { colors, radii, space } from "@/styles/tokens.stylex";

type Status = { _tag: "Loading" } | { _tag: "Online"; health: Health } | { _tag: "Offline" };

export function App() {
  const [status, setStatus] = useState<Status>({ _tag: "Loading" });
  const [name, setName] = useState("world");
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  // `window` only exists in the browser, so read the Electron bridge after hydration.
  const [shell, setShell] = useState("Web");

  useEffect(() => {
    if (window.finite) setShell(`Desktop (${window.finite.platform})`);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void runtime
      .runPromiseExit(
        Api.use((api) => api.health),
        {
          signal: controller.signal,
        },
      )
      .then((exit) => {
        if (controller.signal.aborted) return;
        setStatus(
          Exit.isSuccess(exit) ? { _tag: "Online", health: exit.value } : { _tag: "Offline" },
        );
      });
    return () => controller.abort();
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    runtime
      .runPromise(Api.use((api) => api.greet(name)))
      .then(setGreeting, () => setGreeting(null));
  };

  return (
    <main {...stylex.props(styles.page)}>
      <section {...stylex.props(styles.card)}>
        <header {...stylex.props(styles.header)}>
          <h1 {...stylex.props(styles.title)}>Finite</h1>
          <span
            {...stylex.props(styles.badge, status._tag === "Online" ? styles.ok : styles.offline)}
          >
            {status._tag === "Loading"
              ? "Connecting…"
              : status._tag === "Online"
                ? `Server ${status.health.version}`
                : "Server offline"}
          </span>
        </header>
        <p {...stylex.props(styles.muted)}>{shell} · Next.js · Effect · StyleX · Rust</p>
        <form onSubmit={onSubmit} {...stylex.props(styles.row)}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Name"
            {...stylex.props(styles.input)}
          />
          <button type="submit" {...stylex.props(styles.button)}>
            Greet
          </button>
        </form>
        {greeting && <p {...stylex.props(styles.greeting)}>{greeting.message}</p>}
      </section>
    </main>
  );
}

const styles = stylex.create({
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: space.lg,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  title: {
    margin: 0,
    fontSize: 24,
    fontWeight: 600,
  },
  badge: {
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
  ok: { color: colors.ok },
  offline: { color: colors.danger },
  muted: {
    margin: 0,
    fontSize: 14,
    color: colors.muted,
  },
  row: {
    display: "flex",
    gap: space.sm,
  },
  input: {
    flexGrow: 1,
    padding: `${space.sm} ${space.md}`,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    font: "inherit",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.accent}`,
    },
  },
  button: {
    padding: `${space.sm} ${space.md}`,
    borderRadius: radii.sm,
    borderWidth: 0,
    backgroundColor: colors.accent,
    color: "white",
    font: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    opacity: { default: 1, ":hover": 0.9 },
  },
  greeting: {
    margin: 0,
    fontSize: 18,
  },
});
