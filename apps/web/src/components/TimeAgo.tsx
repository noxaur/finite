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

/** The clock, refreshed with the labels: for lists that sort or label by time. */
export function useNow(): number {
  const v = useSyncExternalStore(
    subscribe,
    () => version,
    () => -1,
  );
  // The version stands for the time; Date.now() is read once per refresh.
  return v < 0 ? 0 : nowAt(v);
}

let stamped = { version: -2, at: 0 };
function nowAt(v: number) {
  if (stamped.version !== v) stamped = { version: v, at: Date.now() };
  return stamped.at;
}
