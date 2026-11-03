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

interface Exports {
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
  replica_draft(handle: number, len: number): number;
  replica_propose(handle: number, mid: number, len: number): number;
  replica_receive(handle: number, len: number, mine: number): number;
  replica_settle(handle: number, mid: number): number;
  replica_has_local(handle: number): number;
  is_safe_attr(nameLen: number, valueLen: number): number;
  shared_style(len: number, shadow: number): number;
  base_css(): number;
  csp(): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The loaded module: the rules that don't need a document, and the calls that do. */
export class DesignModel {
  /** The styles every artboard renders with (`html::BASE_CSS`). */
  readonly baseCss: string;
  /** The content policy for artboards that run scripts (`html::CSP`). */
  readonly csp: string;
  /** Set once the module has panicked. A panic aborts mid-call, so its state can't be trusted. */
  private broken: Error | null = null;
  private readonly freeHandle = new FinalizationRegistry<number>((handle) => {
    if (!this.broken) this.exports.replica_free(handle);
  });

  constructor(private readonly exports: Exports) {
    exports.init();
    this.baseCss = this.call(() => exports.base_css());
    this.csp = this.call(() => exports.csp());
  }

  /** `html::is_safe_attr`: no event handlers, no `srcdoc`, no script URLs. */
  isSafeAttr(name: string, value: string): boolean {
    const [nameLen, valueLen] = this.put([name, value]);
    return this.run(() => this.exports.is_safe_attr(nameLen!, valueLen!)) === 1;
  }

  /**
   * `html::shared_style`: the design's shared CSS as a `<style>` element's
   * text, in a layer the artboard's own styles override. With `shadow`,
   * `:root` becomes `:host`, since `:root` matches nothing in a shadow root.
   */
  sharedStyle(css: string, shadow: boolean): string {
    return this.callWith(css, (e, len) => e.shared_style(len, shadow ? 1 : 0));
  }

  /** A new, empty document. Free it when done; otherwise it's freed once garbage collected. */
  newDocument(): WasmDocument {
    const handle = this.run(() => this.exports.replica_new());
    const doc = new WasmDocument(this, handle);
    this.freeHandle.register(doc, handle, doc);
    return doc;
  }

  /** @internal */
  free(doc: WasmDocument, handle: number) {
    this.freeHandle.unregister(doc);
    if (!this.broken) this.exports.replica_free(handle);
  }

  /** @internal Calls a function that returns a number. */
  callNumber(f: (exports: Exports) => number): number {
    return this.run(() => f(this.exports));
  }

  /** @internal Calls a function that returns a string. */
  callNoArgs(f: (exports: Exports) => number): string {
    return this.call(() => f(this.exports));
  }

  /** @internal Calls a function that takes one string argument and returns a string. */
  callWith(arg: string, f: (exports: Exports, len: number) => number): string {
    const [len] = this.put([arg]);
    return this.call(() => f(this.exports, len!));
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
    private readonly model: DesignModel,
    private readonly handle: number,
  ) {}

  /** Replaces the document. Returns JSON: each parent's child ids in sibling order. */
  load(nodesJson: string): string {
    return this.model.callWith(nodesJson, (e, len) => e.replica_load(this.handle, len));
  }

  /** Applies a JSON array of ops. Returns JSON: what each op touched, or `null`. */
  apply(opsJson: string): string {
    return this.model.callWith(opsJson, (e, len) => e.replica_apply(this.handle, len));
  }

  /** The subtree at `id` as compact HTML; with `ids`, elements carry `data-finite-id`. */
  exportHtml(id: string, ids: boolean): string {
    return this.model.callWith(id, (e, len) => e.replica_export(this.handle, len, ids ? 1 : 0));
  }

  /** JSON: the pages in order, as `{id, name}`, with the implicit first page when there are none. */
  pages(): string {
    return this.model.callNoArgs((e) => e.replica_pages(this.handle));
  }

  /** Instance `id` as it renders: JSON nodes, its root first, then what's inside it, parents first. */
  expand(id: string): string {
    return this.model.callWith(id, (e, len) => e.replica_expand(this.handle, len));
  }

  /** JSON ids of the instances whose content changed since the last call. */
  takeDirty(): string {
    return this.model.callNoArgs((e) => e.replica_take_dirty(this.handle));
  }

  /** JSON: the instance and component a node belongs to, or `null`. */
  componentInfo(id: string): string {
    return this.model.callWith(id, (e, len) => e.replica_component_info(this.handle, len));
  }

  /** Replaces the gesture's draft with a JSON array of edits, or clears it with `null`. Returns an outcome. */
  draft(editsJson: string): string {
    return this.model.callWith(editsJson, (e, len) => e.replica_draft(this.handle, len));
  }

  /** Makes a JSON array of edits the tab's mutation `mid`. Returns an outcome. */
  propose(mid: number, editsJson: string): string {
    return this.model.callWith(editsJson, (e, len) => e.replica_propose(this.handle, mid, len));
  }

  /** Applies a server change's JSON ops; `mine` is its mutation id, or 0. Returns an outcome. */
  receive(opsJson: string, mine: number): string {
    return this.model.callWith(opsJson, (e, len) => e.replica_receive(this.handle, len, mine));
  }

  /** Drops mutation `mid`, which changed nothing on the server. Returns an outcome. */
  settle(mid: number): string {
    return this.model.callNoArgs((e) => e.replica_settle(this.handle, mid));
  }

  /** Whether the tab has a draft, or edits the server hasn't answered. */
  hasLocal(): boolean {
    return this.model.callNumber((e) => e.replica_has_local(this.handle)) === 1;
  }

  free() {
    if (this.freed) return;
    this.freed = true;
    this.model.free(this, this.handle);
  }
}

let model: DesignModel | null = null;
let loading: Promise<DesignModel> | null = null;

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
    return model;
  })();
  // Let a later call try again.
  loading.catch(() => (loading = null));
  return loading;
}

/** The loaded module. Throws if `loadDesignModel` hasn't finished. */
export function designModel(): DesignModel {
  if (!model) throw new Error("finite.wasm isn't loaded yet: await loadDesignModel() first");
  return model;
}

// Start loading as soon as the page's code runs, before anything awaits it.
// Not during the static export's prerender, which runs in Node.
if (typeof window !== "undefined") loadDesignModel().catch(() => {});
