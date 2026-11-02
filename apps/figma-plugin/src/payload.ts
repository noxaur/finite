// The JSON the plugin and Finite's server exchange, both ways. This mirrors
// `crates/transfer/src/figma/payload.rs` field for field, in the same
// camelCase. Where the Rust side has a default, the field is optional here and
// the plugin leaves it out when it has the default value. When you change one
// file, change the other.
//
// A few types carry a `Fig` prefix. Rust calls them `File`, `Paint`, `Effect`
// and `Text`, but the Plugin API and the DOM already use those names.

/** The payload's format version; see `crates/design/src/version.rs`. */
export const PAYLOAD_VERSION = 1;

/** What a payload's `kind` says. */
export const KIND = "figma-payload";

export interface Payload {
  kind: typeof KIND;
  file: FileInfo;
  /** Top-level frames. Each becomes an artboard. */
  nodes: FigNode[];
  /**
   * Image fills' bytes as base64. The plugin keys them by Figma's image hash
   * when it saves a selection; Finite keys them by sha256 when it exports.
   */
  images?: Record<string, string>;
}

export interface FileInfo {
  name: string;
  /** Figma's file key, when the plugin knows it. */
  key?: string;
}

/** One Figma layer. Positions and sizes are in pixels, relative to the parent. */
export interface FigNode {
  /** Figma's node id, like `12:34`, when saved by the plugin; Finite's node id on export. */
  id: string;
  /** Figma's node type: `FRAME`, `GROUP`, `TEXT`, `RECTANGLE`, `ELLIPSE`, `VECTOR`, `INSTANCE`, … */
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Default `true`. */
  visible?: boolean;
  /** Default `1`. */
  opacity?: number;
  /** Degrees, counterclockwise, as Figma reports it. Default `0`. */
  rotation?: number;
  fills?: FigPaint[];
  strokes?: FigPaint[];
  strokeWeight?: number;
  /** `INSIDE`, `OUTSIDE` or `CENTER`. */
  strokeAlign?: string;
  /** Top left, top right, bottom right, bottom left. */
  cornerRadii?: [number, number, number, number];
  effects?: FigEffect[];
  /** Default `false`. */
  clipsContent?: boolean;
  /** Auto layout, for a frame that has it. */
  layout?: AutoLayout;
  /** How the node sits in its auto-layout parent. */
  child?: LayoutChild;
  text?: FigText;
  /** Vector shapes as SVG markup: vectors, boolean operations, stars, lines. */
  svg?: string;
  children?: FigNode[];
}

export interface FigPaint {
  /** `SOLID`, `IMAGE`, `GRADIENT_LINEAR`, `GRADIENT_RADIAL`, … */
  type: string;
  /** Default `true`. */
  visible?: boolean;
  /** Default `1`. */
  opacity?: number;
  /** For `SOLID`. */
  color?: Rgba;
  /** For `IMAGE`: the key into {@link Payload.images}. */
  imageHash?: string;
  /** For `IMAGE`: `FILL`, `FIT`, `CROP` or `TILE`. */
  scaleMode?: string;
  /** For gradients. */
  gradientStops?: Stop[];
}

/** A color with channels from 0 to 1, as Figma has them. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** Default `1`. */
  a?: number;
}

export interface Stop {
  position: number;
  color: Rgba;
}

export interface FigEffect {
  /** `DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR` or `BACKGROUND_BLUR`. */
  type: string;
  /** Default `true`. */
  visible?: boolean;
  color?: Rgba;
  offset?: Offset;
  /** Default `0`. */
  radius?: number;
  /** Default `0`. */
  spread?: number;
}

export interface Offset {
  x: number;
  y: number;
}

export interface AutoLayout {
  /** `HORIZONTAL` or `VERTICAL`. */
  mode: string;
  /** Default `false`. */
  wrap?: boolean;
  /** Default `0`. */
  gap?: number;
  /** Between wrapped rows or columns. Default `0`. */
  counterGap?: number;
  /** Top, right, bottom, left. Default all `0`. */
  padding?: [number, number, number, number];
  /** `MIN`, `CENTER`, `MAX` or `SPACE_BETWEEN`. Default `MIN`. */
  primaryAlign?: string;
  /** `MIN`, `CENTER`, `MAX` or `BASELINE`. Default `MIN`. */
  counterAlign?: string;
  /** How the frame sizes itself on each axis: `FIXED` or `AUTO` (hug). Default `FIXED`. */
  primarySizing?: string;
  /** Default `FIXED`. */
  counterSizing?: string;
}

export interface LayoutChild {
  /** `ABSOLUTE` for a child that ignores its parent's auto layout. */
  positioning?: string;
  /** How much of the free space along the parent's axis it takes. Default `0`. */
  grow?: number;
  /** `STRETCH` to fill the parent's other axis. */
  align?: string;
}

export interface FigText {
  characters: string;
  fontFamily: string;
  /** Figma's style name, like `Semi Bold Italic`. */
  fontStyle?: string;
  fontWeight: number;
  fontSize: number;
  /** Default `false`. */
  italic?: boolean;
  lineHeight?: Measure;
  letterSpacing?: Measure;
  /** `LEFT`, `CENTER`, `RIGHT` or `JUSTIFIED`. Default `LEFT`. */
  align?: string;
  /** `NONE`, `UNDERLINE` or `STRIKETHROUGH`. */
  decoration?: string;
  /** `ORIGINAL`, `UPPER`, `LOWER` or `TITLE`. */
  case?: string;
  /** Runs of characters styled unlike the rest, when there are any. */
  runs?: TextRun[];
}

/** A value in Figma's units: `PIXELS`, `PERCENT`, or `AUTO` with no value. */
export interface Measure {
  unit: string;
  /** Default `0`. */
  value?: number;
}

/** Characters `start..end` of a text layer, with what differs from its base style. */
export interface TextRun {
  start: number;
  end: number;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  fills?: FigPaint[];
  decoration?: string;
}

/**
 * `payload` as JSON with `"v":1` as its first key, the way `Schema::encode`
 * writes it in `crates/design/src/version.rs`. The server reads the version
 * from the first bytes before it parses the rest.
 */
export function encodePayload(payload: Payload): string {
  const json = JSON.stringify(payload);
  const rest = json.slice(1);
  return `{"v":${PAYLOAD_VERSION}${rest === "}" ? "" : ","}${rest}`;
}

/**
 * Reads a payload file. A file with no `v` counts as version 1, and a newer
 * one is refused rather than guessed at. Throws an `Error` whose message is
 * fit to show.
 */
export function decodePayload(text: string): Payload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("That file isn't a Finite export.");
  }
  const { v, kind, nodes } = value as Record<string, unknown>;
  if (kind !== KIND) throw new Error("That file isn't a Finite export for Figma.");
  const version = v === undefined ? 1 : v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("That file's version isn't a number.");
  }
  if (version > PAYLOAD_VERSION) {
    throw new Error(
      `That file is version ${version}, and this plugin reads up to ${PAYLOAD_VERSION}. Update the plugin.`,
    );
  }
  if (!Array.isArray(nodes)) throw new Error("That file has no layers.");
  return value as Payload;
}
