import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Refused } from "@finite/protocol";
import busboy from "busboy";
import { zipSync } from "fflate";
import type { Hub, Modules } from "./hub.ts";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type Route = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: string[],
) => Promise<void>;

/**
 * The HTTP side of `/api`, for what doesn't fit a JSON socket message. Everything else under `/api`
 * is a 404; outside `/api` it serves the built web app when `staticDir` is set.
 */
export function createHttpHandler(hub: Hub, modules: Modules, staticDir: string | undefined) {
  const routes: [method: string, pattern: RegExp, route: Route][] = [
    ["GET", /^\/api\/health$/, async (_req, res) => json(res, 200, { ok: true })],
    [
      "POST",
      /^\/api\/designs\/([^/]+)\/attachments$/,
      async (req, res, _url, [designId]) => {
        const open = await hub.open(designId!);
        const file = await readUpload(req);
        json(res, 200, await open.saveAttachment(file.name, file.data));
      },
    ],
    // GET /api/designs/:id/export?canvasId=…[&frameIds=a,b]: a zip of the frames' files at their
    // paths in the design (see `SourceEditor.exportFrames`), named after the canvas.
    [
      "GET",
      /^\/api\/designs\/([^/]+)\/export$/,
      async (_req, res, url, [designId]) => {
        const open = await hub.open(designId!);
        const canvasId = url.searchParams.get("canvasId");
        if (!canvasId) throw new Refused("export needs ?canvasId=", "invalid");
        const canvas = (await open.canvases()).find((c) => c.id === canvasId);
        if (!canvas) throw new Refused(`no canvas ${canvasId} in this design`, "not-found");
        const ids = url.searchParams.get("frameIds")?.split(",").filter(Boolean);
        const frames = ids ? canvas.frames.filter((f) => ids.includes(f.id)) : canvas.frames;
        const files = await modules.source.exportFrames(open, canvasId, frames);
        const zip = zipSync(Object.fromEntries(files.map((f) => [f.path, f.data])));
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${safeName(canvas.name)}.zip"`,
        });
        res.end(zip);
      },
    ],
  ];

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      for (const [method, pattern, route] of routes) {
        const match = pattern.exec(url.pathname);
        if (match && req.method === method) {
          return await route(req, res, url, match.slice(1).map(decodeURIComponent));
        }
      }
      if (
        url.pathname.startsWith("/api/") ||
        !staticDir ||
        !(await serveStatic(staticDir, url, res))
      ) {
        json(res, 404, { reason: `nothing at ${req.method} ${url.pathname}` });
      }
    } catch (error) {
      if (error instanceof Refused) {
        const status =
          error.code === "not-found" ? 404 : error.code === "not-implemented" ? 501 : 400;
        return json(res, status, { reason: error.message, code: error.code });
      }
      console.error(`${req.method} ${url.pathname} failed:`, error);
      json(res, 500, { reason: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The one file in a multipart upload. */
function readUpload(req: IncomingMessage): Promise<{ name: string; data: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES },
      });
    } catch {
      return reject(new Refused("send the attachment as multipart/form-data", "invalid"));
    }
    let file: { name: string; data: Uint8Array } | undefined;
    parser.on("file", (_field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () =>
        reject(
          new Refused(
            `attachments are at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
            "invalid",
          ),
        ),
      );
      stream.on("end", () => {
        file = { name: path.basename(info.filename || "attachment"), data: Buffer.concat(chunks) };
      });
    });
    parser.on("error", reject);
    parser.on("close", () =>
      file ? resolve(file) : reject(new Refused("the upload has no file", "invalid")),
    );
    req.pipe(parser);
  });
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Serves the Next static export (`trailingSlash`: `route/index.html`). */
async function serveStatic(dir: string, url: URL, res: ServerResponse): Promise<boolean> {
  const file = path.join(dir, path.posix.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(dir)) return false;
  for (const candidate of [file, path.join(file, "index.html")]) {
    const stat = await fs.promises.stat(candidate).catch(() => undefined);
    if (stat?.isFile()) {
      res.writeHead(200, {
        "content-type": types[path.extname(candidate)] ?? "application/octet-stream",
      });
      fs.createReadStream(candidate).pipe(res);
      return true;
    }
  }
  return false;
}

function safeName(name: string): string {
  return name.replace(/[^\w .-]+/g, "_").trim() || "export";
}
