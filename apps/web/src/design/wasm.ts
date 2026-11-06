/**
 * The Rust document model (`crates/design`), compiled to WebAssembly by
 * `crates/wasm`. The viewer applies ops, exports HTML and checks attributes
 * by calling it, so the browser runs the server's own rules.
 *
 * The module's exports are a plain C ABI that passes UTF-8 strings through
 * two buffers in its memory (see `crates/wasm/src/lib.rs`): write the
 * arguments to the input buffer, call, then read the result from the
 * output buffer. This file is all the glue there is.
 */

export interface Exports {
  readonly memory: WebAssembly.Memory;
  init(): void;
  input(len: number): number;
  output(): number;
  panic_message(): number;
  panic_message_len(): number;
  replica_new(): number;
  replica_free(handle: number): void;
  replica_load(handle: number, len: number): number;
  replica_apply(handle: number, len: number): number;
  replica_export(handle: number, len: number, ids: number): number;
  replica_pages(handle: number): number;
  replica_expand(handle: number, len: number): number;
  replica_take_dirty(handle: number): number;
  replica_component_info(handle: number, len: number): number;
  replica_tokens(handle: number): number;
  replica_token_style(handle: number, len: number, shadow: number): number;
  replica_flow(handle: number): number;
  replica_flow_target(handle: number, len: number, width: number): number;
  replica_set_client(handle: number, len: number): number;
  replica_draft(handle: number, seed: number, len: number): number;
  replica_propose(handle: number, mid: number, len: number): number;
  replica_receive(handle: number, len: number, mine: number): number;
  replica_settle(handle: number, mid: number): number;
  replica_has_local(handle: number): number;
  replica_pixel_size(handle: number, len: number): number;
  is_safe_attr(nameLen: number, valueLen: number): number;
  rules(): number;
  bootstrap_script(nonceLen: number, storageLen: number): number;
  artboard_target(len: number): number;
  percent_decode(len: number): number;
}

/**
 * The module's export names, which the test checks against the real file.
 * The type makes the compiler check this list against `Exports` both ways.
 */
export const EXPORT_NAMES: Record<keyof Exports, true> = {
  memory: true,
  init: true,
  input: true,
  output: true,
  panic_message: true,
  panic_message_len: true,
  replica_new: true,
  replica_free: true,
  replica_load: true,
  replica_apply: true,
  replica_export: true,
  replica_pages: true,
  replica_expand: true,
  replica_take_dirty: true,
  replica_component_info: true,
  replica_tokens: true,
  replica_token_style: true,
  replica_flow: true,
  replica_flow_target: true,
  replica_set_client: true,
  replica_draft: true,
  replica_propose: true,
  replica_receive: true,
  replica_settle: true,
  replica_has_local: true,
  replica_pixel_size: true,
  is_safe_attr: true,
  rules: true,
  bootstrap_script: true,
  artboard_target: true,
  percent_decode: true,
};

/** The constants `finite-design` renders artboards with (`Rules` in `crates/wasm/src/lib.rs`). */
export interface Rules {
  /** The styles every artboard renders with (`html::BASE_CSS`). */
  readonly baseCss: string;
  /** The cascade layer for the base styles, before the tokens', so an artboard's styles override them. */
  readonly baseLayer: string;
  /** The content policy for artboards that run scripts (`html::CSP`). */
  readonly csp: string;
  /** The `sandbox` of the iframe an artboard that runs scripts renders in. */
  readonly sandbox: string;
  /** The `allow` of that iframe. */
  readonly framePermissions: string;
  /** Tags the viewer never creates as elements (`html::BLOCKED_TAGS`). */
  readonly blockedTags: ReadonlyArray<string>;
  /** The size of an artboard without a pixel width or height: width, then height. */
  readonly defaultArtboardSize: readonly [number, number];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How a `WasmDocument` reaches the module it lives in. */
interface DocumentIo {
  number(f: (exports: Exports) => number): number;
  /** Calls a function that returns a string. */
  text(f: (exports: Exports) => number): string;
  /** Calls a function that takes one string argument and returns a string. */
  withArg(arg: string, f: (exports: Exports, len: number) => number): string;
  free(): void;
}

/** The loaded module: the rules that don't need a document, and the calls that do. */
export class DesignModel {
  readonly rules: Rules;
  /** Set once the module has panicked. A panic aborts mid-call, so its state can't be trusted. */
  private broken: Error | null = null;
  private readonly freeHandle = new FinalizationRegistry<number>((handle) => {
    if (!this.broken) this.exports.replica_free(handle);
  });

  constructor(private readonly exports: Exports) {
    exports.init();
    this.rules = JSON.parse(this.call(() => exports.rules())) as Rules;
  }

  /**
   * `html::bootstrap_script`: the `<script>` that runs first in artboards
   * that run scripts. `nonce` identifies the document, and `storage` is
   * the design's page storage, which the page's `localStorage` starts from.
   */
  bootstrapScript(nonce: string, storage: Readonly<Record<string, string>>): string {
    const [nonceLen, storageLen] = this.put([nonce, JSON.stringify(storage)]);
    return this.call(() => this.exports.bootstrap_script(nonceLen!, storageLen!));
  }

  /** `flow::href_target`: the artboard a link's `href` names, or `null` when it names none. */
  artboardTarget(href: string): string | null {
    const [len] = this.put([href]);
    return JSON.parse(this.call(() => this.exports.artboard_target(len!))) as string | null;
  }

  /** `decodeURIComponent` that returns `null` instead of throwing on a malformed escape. */
  percentDecode(text: string): string | null {
    const [len] = this.put([text]);
    return JSON.parse(this.call(() => this.exports.percent_decode(len!))) as string | null;
  }

  /** `html::is_safe_attr`: no event handlers, no `srcdoc`, no script URLs. */
  isSafeAttr(name: string, value: string): boolean {
    const [nameLen, valueLen] = this.put([name, value]);
    return this.run(() => this.exports.is_safe_attr(nameLen!, valueLen!)) === 1;
  }

  /** A new, empty document. Free it when done; otherwise it's freed once garbage collected. */
  newDocument(): WasmDocument {
    const handle = this.run(() => this.exports.replica_new());
    const io: DocumentIo = {
      number: (f) => this.run(() => f(this.exports)),
      text: (f) => this.call(() => f(this.exports)),
      withArg: (arg, f) => {
        const [len] = this.put([arg]);
        return this.call(() => f(this.exports, len!));
      },
      free: () => {
        this.freeHandle.unregister(io);
        if (!this.broken) this.exports.replica_free(handle);
      },
    };
    const doc = new WasmDocument(io, handle);
    this.freeHandle.register(doc, handle, io);
    return doc;
  }

  /** Runs `f` and reads its result from the output buffer. A negative length is an error. */
  private call(f: () => number): string {
    const n = this.run(f);
    const text = this.read(this.exports.output(), Math.abs(n));
    if (n < 0) throw new Error(`finite.wasm: ${text}`);
    return text;
  }

  /** Runs `f`, turning a trap into an error that says what panicked. */
  private run<T>(f: () => T): T {
    if (this.broken) throw this.broken;
    try {
      return f();
    } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
      const message = this.read(this.exports.panic_message(), this.exports.panic_message_len());
      this.broken = new Error(`finite.wasm panicked: ${message || error.message}`);
      throw this.broken;
    }
  }

  /**
   * Writes `args` to the input buffer back to back and returns each one's
   * length in bytes. Most text is ASCII, so it starts with one byte per
   * UTF-16 unit and grows the buffer only if the text needs more.
   */
  private put(args: ReadonlyArray<string>): number[] {
    let later = args.reduce((n, arg) => n + arg.length, 0);
    let capacity = later;
    let at = this.run(() => this.exports.input(capacity));
    let offset = 0;
    const lens: number[] = [];
    for (const arg of args) {
      later -= arg.length;
      const start = offset;
      let read = 0;
      for (;;) {
        // Growing the buffer can grow the memory, which replaces `memory.buffer`.
        const view = new Uint8Array(this.exports.memory.buffer, at + offset, capacity - offset);
        const done = encoder.encodeInto(read === 0 ? arg : arg.slice(read), view);
        read += done.read;
        offset += done.written;
        if (read >= arg.length) break;
        // A UTF-16 unit takes at most three bytes in UTF-8.
        capacity = offset + (arg.length - read) * 3 + later;
        at = this.run(() => this.exports.input(capacity));
      }
      lens.push(offset - start);
    }
    return lens;
  }

  private read(at: number, len: number): string {
    return len === 0 ? "" : decoder.decode(new Uint8Array(this.exports.memory.buffer, at, len));
  }
}

/**
 * One document inside the module: the Rust `Replica` in `crates/wasm`.
 * `Replica` (`replica.ts`) wraps it with a cache the renderer reads.
 */
export class WasmDocument {
  private freed = false;

  constructor(
    private readonly io: DocumentIo,
    private readonly handle: number,
  ) {}

  /** Replaces the document. Returns JSON: each parent's child ids in sibling order. */
  load(nodesJson: string): string {
    return this.io.withArg(nodesJson, (e, len) => e.replica_load(this.handle, len));
  }

  /** Applies a JSON array of ops. Returns JSON: what each op touched, or `null`. */
  apply(opsJson: string): string {
    return this.io.withArg(opsJson, (e, len) => e.replica_apply(this.handle, len));
  }

  /** The `width` and `height` styles of node `id` when they are plain pixels (`edit::pixel_size`), else `null`. */
  pixelSize(id: string): { width: number | null; height: number | null } {
    const [width, height] = JSON.parse(
      this.io.withArg(id, (e, len) => e.replica_pixel_size(this.handle, len)),
    ) as [number | null, number | null];
    return { width, height };
  }

  /** The subtree at `id` as compact HTML; with `ids`, elements carry `data-finite-id`. */
  exportHtml(id: string, ids: boolean): string {
    return this.io.withArg(id, (e, len) => e.replica_export(this.handle, len, ids ? 1 : 0));
  }

  /** JSON: the pages in order, as `{id, name, background?}`, with the implicit first page when there are none. */
  pages(): string {
    return this.io.text((e) => e.replica_pages(this.handle));
  }

  /** Instance `id` as it renders: JSON nodes, its root first, then what's inside it, parents first. */
  expand(id: string): string {
    return this.io.withArg(id, (e, len) => e.replica_expand(this.handle, len));
  }

  /** JSON ids of the instances whose content changed since the last call. */
  takeDirty(): string {
    return this.io.text((e) => e.replica_take_dirty(this.handle));
  }

  /** JSON: the modes in order, as `{id, name}`, and each token's values by mode id. */
  tokens(): string {
    return this.io.text((e) => e.replica_tokens(this.handle));
  }

  /**
   * `tokens::style`: artboard `id`'s tokens in its mode, as a `<style>`
   * element's text, in a layer the artboard's own styles override. With
   * `shadow` they go on `:host`, else on `:root`. Empty without tokens.
   */
  tokenStyle(id: string, shadow: boolean): string {
    return this.io.withArg(id, (e, len) => e.replica_token_style(this.handle, len, shadow ? 1 : 0));
  }

  /** JSON: the design's routes, links and broken links (`flow::Flow`). */
  flow(): string {
    return this.io.text((e) => e.replica_flow(this.handle));
  }

  /**
   * `Flow::target`: the artboard a link to `to` opens from a screen `width`
   * pixels wide (any width when `null`), or `""` when `to` isn't an artboard.
   */
  flowTarget(to: string, width: number | null): string {
    return this.io.withArg(to, (e, len) =>
      e.replica_flow_target(this.handle, len, width ?? Number.NaN),
    );
  }

  /** JSON: the instance and component a node belongs to, or `null`. */
  componentInfo(id: string): string {
    return this.io.withArg(id, (e, len) => e.replica_component_info(this.handle, len));
  }

  /** Names the tab in its stamps, which new node ids are made from. */
  setClient(client: string) {
    this.io.withArg(client, (e, len) => e.replica_set_client(this.handle, len));
  }

  /**
   * Replaces the gesture's draft with a JSON array of edits, or clears it
   * with `null`. `seed` is the mutation id it will be sent as. Returns an outcome.
   */
  draft(seed: number, editsJson: string): string {
    return this.io.withArg(editsJson, (e, len) => e.replica_draft(this.handle, seed, len));
  }

  /** Makes a JSON array of edits the tab's mutation `mid`. Returns an outcome. */
  propose(mid: number, editsJson: string): string {
    return this.io.withArg(editsJson, (e, len) => e.replica_propose(this.handle, mid, len));
  }

  /** Applies a server change's JSON ops; `mine` is its mutation id, or 0. Returns an outcome. */
  receive(opsJson: string, mine: number): string {
    return this.io.withArg(opsJson, (e, len) => e.replica_receive(this.handle, len, mine));
  }

  /** Drops mutation `mid`, which changed nothing on the server. Returns an outcome. */
  settle(mid: number): string {
    return this.io.text((e) => e.replica_settle(this.handle, mid));
  }

  /** Whether the tab has a draft, or edits the server hasn't answered. */
  hasLocal(): boolean {
    return this.io.number((e) => e.replica_has_local(this.handle)) === 1;
  }

  free() {
    if (this.freed) return;
    this.freed = true;
    this.io.free();
  }
}

let model: DesignModel | null = null;
let loading: Promise<DesignModel> | null = null;
/** Why the last load failed, for `designModel` to rethrow. */
let loadError: Error | null = null;

/** Instantiates the module from its bytes, synchronously. Tests use this. */
export function initDesignModel(bytes: BufferSource): DesignModel {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  model = new DesignModel(instance.exports as unknown as Exports);
  return model;
}

/** Fetches and instantiates the module once. Await it before using a `Replica`. */
export function loadDesignModel(): Promise<DesignModel> {
  if (model) return Promise.resolve(model);
  loading ??= (async () => {
    // The bundler copies the file into the build with a hashed name.
    const url = new URL("../../../../crates/wasm/dist/finite.wasm", import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`couldn't load finite.wasm: ${response.status}`);
    const { instance } = await WebAssembly.instantiateStreaming(response, {});
    model = new DesignModel(instance.exports as unknown as Exports);
    loadError = null;
    return model;
  })();
  // Keep the error for `designModel`, and let a later call try again.
  loading.catch((error: unknown) => {
    loadError = error instanceof Error ? error : new Error(String(error));
    loading = null;
  });
  return loading;
}

/** The loaded module. Throws the load's error if it failed, or if `loadDesignModel` hasn't finished. */
export function designModel(): DesignModel {
  if (model) return model;
  if (loadError) throw loadError;
  throw new Error("finite.wasm isn't loaded yet: await loadDesignModel() first");
}

// Start loading as soon as the page's code runs, before anything awaits it.
// Not during the static export's prerender, which runs in Node. A failure
// is kept for `designModel` to throw, so nothing is left unhandled here.
if (typeof window !== "undefined") loadDesignModel().catch(() => {});
