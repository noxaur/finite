/** Exposed by apps/desktop/src/preload.ts. Undefined when running in a plain browser. */
interface FiniteBridge {
  readonly platform: string;
  readonly versions: { readonly electron: string; readonly chrome: string };
}

interface Window {
  readonly finite?: FiniteBridge;
}
