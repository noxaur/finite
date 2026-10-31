/**
 * Where agents connect. In development the Rust server runs on its own port;
 * in production it serves the app, so it's the page's origin.
 */
export function mcpUrl() {
  return process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:4100/mcp"
    : `${window.location.origin}/mcp`;
}
