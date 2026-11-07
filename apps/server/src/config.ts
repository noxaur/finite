import path from "node:path";
import { allowedHosts } from "./guard.ts";

export type Config = {
  /** `FINITE_PORT` (or `PORT`), default 4100. */
  port: number;
  /** `FINITE_HOST`, default 127.0.0.1. Each design's Vite server binds the same host. */
  host: string;
  /** `FINITE_DATA_DIR`, default `./.finite-data`. */
  dataDir: string;
  /** `FINITE_STATIC_DIR`: the built web app to serve, when set (the desktop app). */
  staticDir: string | undefined;
  /** Loopback names plus `FINITE_ALLOWED_HOSTS` (comma-separated). */
  allowedHosts: string[];
};

/** Reads `FINITE_*`; nothing else does. Throws a readable error on a bad value. */
export function readConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
  const rawPort = env.FINITE_PORT ?? env.PORT ?? "4100";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`FINITE_PORT ${JSON.stringify(rawPort)} is not a port`);
  }
  return {
    port,
    host: env.FINITE_HOST ?? "127.0.0.1",
    dataDir: path.resolve(cwd, env.FINITE_DATA_DIR ?? ".finite-data"),
    staticDir: env.FINITE_STATIC_DIR ? path.resolve(cwd, env.FINITE_STATIC_DIR) : undefined,
    allowedHosts: allowedHosts(env.FINITE_ALLOWED_HOSTS),
  };
}
