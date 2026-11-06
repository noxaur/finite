/** A box on the canvas or the page, as the camera and the culler pass it around. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A token's value in each mode, by mode id. */
export type TokenValues = Readonly<Record<string, string>>;

/** The design's tokens: its modes in order, and each token's values by mode id. */
export interface TokenTable {
  readonly modes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly tokens: Readonly<Record<string, TokenValues>>;
}
