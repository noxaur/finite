import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { finiteNext } from "./index.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FILE = ".finite/boards/c/New.tsx";

test("a second request for a new frame file waits for Next too", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finite-registry-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".finite/boards/c"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { next: "*" } }),
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, FILE), "export default () => null;\n");

  // Next's frame route: 404 until it has recompiled with the file in its registry.
  let compiled = false;
  const next = http.createServer((_, res) => {
    res.statusCode = compiled ? 200 : 404;
    res.end();
  });
  await new Promise<void>((resolve) => next.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => next.close(resolve)));
  const host = `127.0.0.1:${(next.address() as AddressInfo).port}`;

  const finite = finiteNext({ root, allowedHosts: ["127.0.0.1"] });
  const request = () =>
    finite.handle(
      {
        url: `/__finite/frame?file=${encodeURIComponent(FILE)}`,
        method: "GET",
        headers: { host, rsc: "1" },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
    );

  let settled = 0;
  const first = request().finally(() => settled++);
  const second = request().finally(() => settled++);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(settled).toBe(0);

  compiled = true;
  await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
});
