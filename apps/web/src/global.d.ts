/** What the desktop app's menu asks the page to do: see `sendCommand` in apps/desktop/src/main.ts. */
type FiniteCommand = "closeTab" | "nextTab" | "previousTab";

/** Exposed by apps/desktop/src/preload.ts. Undefined when running in a plain browser. */
interface FiniteBridge {
  readonly platform: string;
  readonly versions: { readonly electron: string; readonly chrome: string };
  /** Calls `listener` with each menu command; returns a function that stops it. Older builds lack it. */
  readonly onCommand?: (listener: (command: FiniteCommand) => void) => () => void;
  /** Opens the system folder picker; resolves to the chosen folder, or null when cancelled. */
  readonly pickFolder?: () => Promise<string | null>;
}

interface Window {
  readonly finite?: FiniteBridge;
}
