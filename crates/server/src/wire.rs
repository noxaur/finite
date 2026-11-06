//! What the servers, the router and the relay say to one another and to
//! clients, in one place so both ends use the same words.

use axum::{
    http::{StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde_json::Value;

use crate::hub::LOBBY_LIMIT;

/// A `421 Misdirected Request` carries the owner's base URL in this header.
pub const OWNER: &str = "finite-owner";

/// The agent an MCP request comes from. A router sets it for the agents it
/// relays, and a server uses it as the agent's identity.
pub const AGENT: &str = "x-finite-agent";

/// The name shown for a relayed agent.
pub const AGENT_NAME: &str = "x-finite-agent-name";

/// What a client is told when no server is live, as when they all restart at
/// once.
pub const NO_SERVER: &str = "No Finite server is running. Try again in a few seconds.";

/// The most designs a list may ask for.
const MAX_LIST: usize = 1000;

/// `limit` on the design list: [`LOBBY_LIMIT`] by default, at most 1,000.
pub fn list_limit(requested: Option<usize>) -> usize {
    requested.unwrap_or(LOBBY_LIMIT).clamp(1, MAX_LIST)
}

/// A `503` that tells the client to try again in a second.
pub fn unavailable(message: impl Into<String>) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(RETRY_AFTER, "1")],
        message.into(),
    )
        .into_response()
}

/// Orders the designs of many servers' lists, most recently edited first.
pub fn newest_first(designs: &mut [Value]) {
    designs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
}
