// What the plugin's two halves say to each other. The UI runs in an iframe
// with the file picker and downloads; the main thread has the Plugin API.

export type ToMain =
  | { type: "save" }
  /** The text of a `.figma.json` file the person picked. */
  | { type: "open"; text: string };

export type ToUi =
  /** How many layers are selected, so Save can be turned off. */
  | { type: "selection"; count: number }
  /** A saved selection, for the UI to download as `<name>.figma.json`. */
  | { type: "saved"; name: string; json: string; line: string }
  | { type: "built"; line: string }
  | { type: "failed"; line: string };
