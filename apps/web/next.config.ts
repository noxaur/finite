import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// The Rust server listens here in development (see crates/server).
const apiTarget = process.env.FINITE_API_URL ?? "http://127.0.0.1:4100";

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
      },
    };
  }

  // Production builds are a static export in `out/`, served by the Rust server.
  // `trailingSlash` emits `route/index.html`, which the Rust static file server resolves.
  return {
    output: "export",
    trailingSlash: true,
    images: { unoptimized: true },
  };
}
