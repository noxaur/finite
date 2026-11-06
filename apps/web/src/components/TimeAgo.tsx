"use client";

import { useSyncExternalStore } from "react";
import { timeAgo } from "@/lib/time";

const REFRESH_MS = 15_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    version++;
    for (const l of listeners) l();
  }, REFRESH_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** "3 minutes ago" for `at`, which refreshes itself so the parents don't re-render. */
export function TimeAgo({ at }: { at: number }) {
  // The version only wakes this up; the label is read from the clock as it renders.
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return <>{timeAgo(at)}</>;
}
