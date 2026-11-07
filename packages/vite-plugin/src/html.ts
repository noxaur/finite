import type { ServerResponse } from "node:http";

type Loose = (...args: unknown[]) => unknown;

/**
 * Adds `tag` to the `<head>` of an HTML response that doesn't already contain `marker`, for pages rendered
 * by a framework (React Router framework mode) instead of Vite's `transformIndexHtml`. HTML
 * responses are buffered until they end; anything else passes straight through.
 */
export function injectIntoHtml(res: ServerResponse, tag: string, marker: string): void {
  const original = {
    writeHead: res.writeHead.bind(res) as Loose,
    write: res.write.bind(res) as Loose,
    end: res.end.bind(res) as Loose,
  };
  const chunks: Buffer[] = [];
  let html: boolean | undefined;
  const isHtml = () => (html ??= String(res.getHeader("content-type") ?? "").includes("text/html"));
  const toBuffer = (chunk: unknown, encoding: unknown) =>
    typeof chunk === "string"
      ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
      : Buffer.from(chunk as Uint8Array);

  const patched = res as unknown as Record<"writeHead" | "write" | "end", Loose>;
  patched.writeHead = (status: unknown, ...rest: unknown[]) => {
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

function addToHead(html: string, tag: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    );
  return tag + html;
}
