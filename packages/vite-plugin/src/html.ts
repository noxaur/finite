import fs from "node:fs";
import type { ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";

type Loose = (...args: unknown[]) => unknown;

const BRIDGE_SOURCE = new URL("./client/bridge.ts", import.meta.url);
/** The bridge as JavaScript, beside the bundled plugin in the desktop app (`vite-plugin.mjs`). */
const BRIDGE_BUILT = new URL("./vite-plugin-bridge.mjs", import.meta.url);
/** How much HTML the streaming injection holds back while it looks for `<head>`. */
const MAX_HELD = 64 * 1024;

/** The frame's half of the bridge as a module, told which hosts the Finite shell may be on. */
export function bridgeScript(allowedHosts: readonly string[]): string {
  const hosts = `const FINITE_ALLOWED_HOSTS = ${JSON.stringify(allowedHosts)};\n`;
  if (fs.existsSync(BRIDGE_BUILT)) {
    const built = fs.readFileSync(BRIDGE_BUILT, "utf8");
    return hosts + built.replace(/^\/\/# sourceMappingURL=.*$/m, "");
  }
  return hosts + stripTypeScriptTypes(fs.readFileSync(BRIDGE_SOURCE, "utf8"));
}

/**
 * Adds `tag` to the `<head>` of an HTML response that doesn't already contain `marker`, for pages rendered
 * by a framework (React Router framework mode) instead of Vite's `transformIndexHtml`. HTML
 * responses are buffered until they end; anything else passes straight through.
 */
export function injectIntoHtml(res: ServerResponse, tag: string, marker: string): void {
  const { original, isHtml } = patchHeaders(res);
  const chunks: Buffer[] = [];
  const patched = res as unknown as Record<"write" | "end", Loose>;
  patched.write = (chunk: unknown, ...rest: unknown[]) => {
    if (!isHtml()) return original.write(chunk, ...rest);
    chunks.push(toBuffer(chunk, rest[0]));
    const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
    callback?.();
    return true;
  };
  patched.end = (chunk: unknown, ...rest: unknown[]) => {
    if (!isHtml()) return original.end(chunk, ...rest);
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      chunks.push(toBuffer(chunk, rest[0]));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (!res.headersSent) res.removeHeader("content-length");
    return original.end(body.includes(marker) ? body : addToHead(body, tag));
  };
}

/**
 * Adds `tag` right after the `<head>` of an HTML response as it streams, for Next.js, whose App
 * Router streams a page in many chunks. Only the bytes before `<head>` are held back; anything
 * that isn't HTML (RSC payloads, assets) passes straight through.
 */
export function streamIntoHtml(res: ServerResponse, tag: string): void {
  const { original, isHtml } = patchHeaders(res);
  let held: Buffer[] = [];
  let done = false;
  /** The held bytes with the tag in place, once `<head>` arrived or `force`; else `null`. */
  const take = (force: boolean): Buffer | null => {
    const bytes = Buffer.concat(held);
    // Latin-1 maps bytes one to one, so the index is a byte offset.
    const head = /<head(?:\s[^>]*)?>/i.exec(bytes.toString("latin1"));
    if (!head && !force && bytes.length < MAX_HELD) return null;
    done = true;
    held = [];
    if (!res.headersSent) res.removeHeader("content-length");
    const at = head ? head.index + head[0].length : 0;
    return Buffer.concat([bytes.subarray(0, at), Buffer.from(tag), bytes.subarray(at)]);
  };
  const patched = res as unknown as Record<"write" | "end", Loose>;
  patched.write = (chunk: unknown, ...rest: unknown[]) => {
    if (done || !isHtml()) return original.write(chunk, ...rest);
    held.push(toBuffer(chunk, rest[0]));
    const callback = rest.find((arg) => typeof arg === "function");
    const ready = take(false);
    if (ready) return callback ? original.write(ready, callback) : original.write(ready);
    (callback as (() => void) | undefined)?.();
    return true;
  };
  patched.end = (chunk: unknown, ...rest: unknown[]) => {
    if (done || !isHtml()) return original.end(chunk, ...rest);
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      held.push(toBuffer(chunk, rest[0]));
    }
    return original.end(take(true));
  };
}

/**
 * Wraps `writeHead` so headers passed to it land on the response, where `isHtml` reads the
 * content type, and an HTML response loses its length, which the injection changes.
 */
function patchHeaders(res: ServerResponse) {
  const original = {
    writeHead: res.writeHead.bind(res) as Loose,
    write: res.write.bind(res) as Loose,
    end: res.end.bind(res) as Loose,
  };
  let html: boolean | undefined;
  const isHtml = () => (html ??= String(res.getHeader("content-type") ?? "").includes("text/html"));
  (res as unknown as Record<"writeHead", Loose>).writeHead = (
    status: unknown,
    ...rest: unknown[]
  ) => {
    // Move headers onto the response so they can be read and the length dropped.
    const message = typeof rest[0] === "string" ? rest[0] : undefined;
    const headers = rest.find((arg) => typeof arg === "object" && arg !== null);
    if (Array.isArray(headers)) {
      const pairs = Array.isArray(headers[0])
        ? (headers as [string, string][])
        : headers.flatMap((_, i) =>
            i % 2 ? [] : [[headers[i], headers[i + 1]] as [string, string]],
          );
      for (const [key, value] of pairs) res.appendHeader(key, value);
    } else if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) res.setHeader(key, value as string | string[]);
      }
    }
    if (isHtml()) res.removeHeader("content-length");
    return message === undefined ? original.writeHead(status) : original.writeHead(status, message);
  };
  return { original, isHtml };
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  return typeof chunk === "string"
    ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
    : Buffer.from(chunk as Uint8Array);
}

function addToHead(html: string, tag: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    );
  return tag + html;
}
