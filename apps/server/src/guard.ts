import type { IncomingHttpHeaders } from "node:http";

/**
 * Keeps other websites out. Browsers don't apply the same-origin policy to WebSockets, so any page
 * could open one to 127.0.0.1:4100 and read every design (cross-site WebSocket hijacking), and with
 * DNS rebinding a site's own name can point at this machine. So the server accepts a request only
 * if its `Host`, and its `Origin` when it has one, name a known host: a loopback name or one in
 * `FINITE_ALLOWED_HOSTS`.
 */
export function allowedHosts(env: string | undefined): string[] {
  const extra = (env ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return ["localhost", "127.0.0.1", "::1", ...extra];
}

/** Whether `authority` (`host` or `host:port`) is allowed. A listed name without a port allows any port. */
export function allows(allowed: readonly string[], authority: string): boolean {
  const trimmed = authority.replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();
  const host = trimmed.startsWith("[")
    ? (trimmed.slice(1).split("]")[0] ?? "")
    : trimmed.includes(":")
      ? trimmed.slice(0, trimmed.lastIndexOf(":"))
      : trimmed;
  return allowed.some((a) => {
    const name = a.toLowerCase();
    return name === lower || name === host.toLowerCase();
  });
}

/** Why a request is refused, if it is. */
export function refuse(
  allowed: readonly string[],
  headers: IncomingHttpHeaders,
): string | undefined {
  const host = headers.host;
  if (host !== undefined && !allows(allowed, host)) {
    return `unknown host ${JSON.stringify(host)}; add it to FINITE_ALLOWED_HOSTS`;
  }
  // Sandboxed frames and local files send `Origin: null`, which no host matches.
  const origin = headers.origin;
  if (origin !== undefined) {
    const authority = origin.includes("://") ? origin.slice(origin.indexOf("://") + 3) : undefined;
    if (authority === undefined || !allows(allowed, authority)) {
      return `requests from ${JSON.stringify(origin)} aren't allowed`;
    }
  }
  return undefined;
}
