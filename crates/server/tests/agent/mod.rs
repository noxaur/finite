//! An MCP client for tests: it initializes a session over Streamable HTTP,
//! the way an agent does, then calls tools and reads their text results.

#![allow(dead_code)]

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, header},
};
use finite_server::{Hub, app, store::MemoryStore};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

pub struct Agent {
    app: Router,
    /// The endpoint: `/mcp`, or `/mcp/classic`.
    path: &'static str,
    pub name: &'static str,
    session: Option<String>,
    next_id: u64,
}

impl Agent {
    pub async fn connect(app: &Router, name: &'static str) -> Self {
        Self::connect_at(app, name, "/mcp").await
    }

    /// Connects to the MCP endpoint at `path`.
    pub async fn connect_at(app: &Router, name: &'static str, path: &'static str) -> Self {
        let mut agent = Self {
            app: app.clone(),
            path,
            name,
            session: None,
            next_id: 1,
        };
        let init = json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "1" },
        });
        agent.rpc("initialize", Some(init)).await;
        agent.notify("notifications/initialized").await;
        agent
    }

    fn request(&self, body: Value) -> Request<Body> {
        // rmcp checks Host to block DNS rebinding, so send what a local client would.
        let mut req = Request::post(self.path)
            .header(header::HOST, "127.0.0.1:4100")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream");
        // An empty name stands for an agent that doesn't name itself.
        if !self.name.is_empty() {
            req = req.header("x-finite-agent", self.name);
        }
        if let Some(session) = &self.session {
            req = req.header("mcp-session-id", session);
        }
        req.body(Body::from(body.to_string())).unwrap()
    }

    pub async fn send(&mut self, body: Value) -> Option<Value> {
        let res = self.app.clone().oneshot(self.request(body)).await.unwrap();
        if let Some(session) = res.headers().get("mcp-session-id") {
            self.session = Some(session.to_str().unwrap().to_owned());
        }
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        // Responses arrive as server-sent events: `data: {...}` lines.
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        let data: String = text
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .collect();
        (!data.trim().is_empty()).then(|| serde_json::from_str(&data).unwrap())
    }

    pub async fn notify(&mut self, method: &str) {
        self.send(json!({ "jsonrpc": "2.0", "method": method }))
            .await;
    }

    pub async fn rpc(&mut self, method: &str, params: Option<Value>) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let mut body = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(params) = params {
            body["params"] = params;
        }
        let response = self.send(body).await.expect("a response");
        assert!(
            response.get("error").is_none(),
            "{method} failed: {response}"
        );
        response["result"].clone()
    }

    /// Calls a tool and returns its text, and whether it reported an error.
    pub async fn call(&mut self, tool: &str, args: Value) -> (String, bool) {
        let result = self
            .rpc(
                "tools/call",
                Some(json!({ "name": tool, "arguments": args })),
            )
            .await;
        let text = result["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        (text, result["isError"] == true)
    }

    pub async fn ok(&mut self, tool: &str, args: Value) -> String {
        let (text, error) = self.call(tool, args).await;
        assert!(!error, "{tool} failed: {text}");
        text
    }
}

/// The first `#id` after `needle` in a tool's text output.
pub fn id_after(text: &str, needle: &str) -> String {
    let rest = &text[text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} in {text}"))..];
    let start = rest.find('#').unwrap() + 1;
    rest[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect()
}

pub fn test_app() -> Router {
    app(Hub::new(Arc::new(MemoryStore::default())).unwrap(), None)
}
