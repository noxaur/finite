import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// The Node server listens here in development (see apps/server).
const apiTarget = process.env.FINITE_API_URL ?? "http://127.0.0.1:4100";

// Workspace packages ship TypeScript source.
const transpilePackages = ["@finite/protocol"];

// Lets `next dev` serve a page opened at 127.0.0.1 instead of localhost.
const allowedDevOrigins = ["127.0.0.1"];

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      transpilePackages,
      allowedDevOrigins,
      // Proxies HTTP and the `/api/ws` WebSocket upgrade.
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
      },
    };
  }

  // Production builds are a static export in `out/`, served by the Rust server.
  // `trailingSlash` emits `route/index.html`, which the Rust static file server resolves.
  return {
    transpilePackages,
    output: "export",
    trailingSlash: true,
    images: { unoptimized: true },
  };
}
