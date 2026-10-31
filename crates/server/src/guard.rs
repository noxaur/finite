//! Keeps other websites out of the browser API.
//!
//! A page on any site can open a WebSocket to `127.0.0.1:4100`, because
//! browsers don't apply the same-origin policy to WebSockets. Without a check,
//! it could read every design live: **cross-site WebSocket hijacking**. And
//! with **DNS rebinding**, a site's own name can point at this machine, which
//! makes its requests same-origin. So `/api` accepts a request only if its
//! `Host`, and its `Origin` if it has one, name a host this server knows: a
//! loopback name, a server in `FINITE_NODES`, or one in `FINITE_ALLOWED_HOSTS`.
//! That's the same list MCP checks `Host` against, and the guard covers
//! `/mcp` too, since rmcp doesn't check `Origin` unless it's given a list.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// The middleware. `allowed` comes from [`crate::cluster::Cluster::allowed_hosts`].
pub async fn known_hosts(
    State(allowed): State<Arc<[String]>>,
    req: Request,
    next: Next,
) -> Response {
    if let Some(refused) = refuse(&allowed, &req) {
        return (StatusCode::FORBIDDEN, refused).into_response();
    }
    next.run(req).await
}

/// Why `req` is refused, if it is.
fn refuse(allowed: &[String], req: &Request) -> Option<String> {
    let header = |name| req.headers().get(name).and_then(|v| v.to_str().ok());
    // HTTP/1.1 clients always send Host, and a rebound name always has one.
    if let Some(host) = header(header::HOST)
        && !allows(allowed, host)
    {
        return Some(format!(
            "unknown host {host:?}; add it to FINITE_ALLOWED_HOSTS"
        ));
    }
    // Sandboxed frames and local files send `Origin: null`, which no host matches.
    if let Some(origin) = header(header::ORIGIN) {
        let authority = origin.split_once("://").map(|(_, rest)| rest);
        if !authority.is_some_and(|a| allows(allowed, a)) {
            return Some(format!("requests from {origin:?} aren't allowed"));
        }
    }
    None
}

/// Whether `authority` (`host` or `host:port`) is allowed. A listed name
/// without a port allows any port.
pub fn allows(allowed: &[String], authority: &str) -> bool {
    let authority = authority.trim_end_matches('/');
    let host = match authority.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => authority
            .rsplit_once(':')
            .map_or(authority, |(host, _)| host),
    };
    allowed
        .iter()
        .any(|a| a.eq_ignore_ascii_case(authority) || a.eq_ignore_ascii_case(host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_match_with_or_without_their_port() {
        let allowed: Vec<String> = ["localhost", "127.0.0.1", "::1", "10.0.0.2:4100"]
            .map(String::from)
            .to_vec();
        for ok in [
            "localhost:5310",
            "127.0.0.1:4100",
            "[::1]:4100",
            "10.0.0.2:4100",
            "LOCALHOST",
        ] {
            assert!(allows(&allowed, ok), "{ok}");
        }
        for bad in [
            "evil.example",
            "evil.example:4100",
            "10.0.0.2:9999",
            "127.0.0.1.evil.example",
            "null",
        ] {
            assert!(!allows(&allowed, bad), "{bad}");
        }
    }
}
