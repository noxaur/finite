import type { KeyCombo, ToolHost } from "./host";

/** Where a key press came from, and what the canvas is doing, for what it may mean. */
export type KeyEnv = {
  source: "page" | "frame";
  interact: boolean;
  /** A text or label editor is open. */
  editing: boolean;
  /** In vector edit mode. */
  vector: boolean;
};

/** A shortcut that isn't a tool. */
export type CommandDef = {
  readonly id: string;
  readonly keys: readonly KeyCombo[];
  readonly enabled: boolean;
  /** Fires even while typing into a frame in Interact mode or editing text. */
  readonly always?: true;
  readonly when?: (env: KeyEnv) => boolean;
  run(host: ToolHost): void;
};

export const COMMANDS: readonly CommandDef[] = [
  {
    id: "space",
    keys: [{ code: "Space" }, { code: "Space", shift: true }, { code: "Space", alt: true }],
    enabled: true,
    run: (host) => host.setSpace(true),
  },
  {
    id: "escape",
    keys: [{ key: "escape", loose: true }],
    enabled: true,
    always: true,
    run: (host) => host.escape(),
  },
  {
    id: "undo",
    keys: [{ key: "z", mod: true }],
    enabled: true,
    always: true,
    run: (host) => void host.undo("undo"),
  },
  {
    id: "redo",
    keys: [{ key: "z", mod: true, shift: true }],
    enabled: true,
    always: true,
    run: (host) => void host.undo("redo"),
  },
  {
    id: "duplicate",
    keys: [{ key: "d", mod: true }],
    enabled: true,
    always: true,
    run: (host) => void host.duplicate(),
  },
  {
    id: "zoomIn",
    keys: [
      { key: "=", mod: true },
      { key: "+", mod: true },
      { key: "+", mod: true, shift: true },
    ],
    enabled: true,
    always: true,
    run: (host) => host.camera.zoomBy(1.25),
  },
  {
    id: "zoomOut",
    keys: [{ key: "-", mod: true }],
    enabled: true,
    always: true,
    run: (host) => host.camera.zoomBy(0.8),
  },
  {
    id: "zoomReset",
    keys: [{ key: "0", mod: true }],
    enabled: true,
    always: true,
    run: (host) => host.camera.set({ ...host.camera.view, zoom: 1 }),
  },
  {
    id: "delete",
    keys: [
      { key: "backspace", loose: true },
      { key: "delete", loose: true },
    ],
    enabled: true,
    run: (host) => void host.remove(),
  },
  {
    id: "fitAll",
    keys: [{ code: "Digit1", shift: true }],
    enabled: true,
    run: (host) => host.fitAll(),
  },
  {
    id: "fitSelection",
    keys: [{ code: "Digit2", shift: true }],
    enabled: true,
    run: (host) => host.fitSelection(),
  },
];
