//! Components over MCP, the way an agent uses them: build two screens with
//! the same top bar, make it a component, and change it once for both.
//!
//! The component tools are an extra group (`FINITE_MCP_EXTRA=components`),
//! read once per process, so they're tested in their own binary, in one
//! test that turns them on before anything starts.

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

struct Agent {
    app: Router,
    name: &'static str,
    session: Option<String>,
    next_id: u64,
}

impl Agent {
    async fn connect(app: &Router, name: &'static str) -> Self {
        let mut agent = Self {
            app: app.clone(),
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
        let mut req = Request::post("/mcp")
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

    async fn send(&mut self, body: Value) -> Option<Value> {
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

    async fn notify(&mut self, method: &str) {
        self.send(json!({ "jsonrpc": "2.0", "method": method }))
            .await;
    }

    async fn rpc(&mut self, method: &str, params: Option<Value>) -> Value {
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
    async fn call(&mut self, tool: &str, args: Value) -> (String, bool) {
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

    async fn ok(&mut self, tool: &str, args: Value) -> String {
        let (text, error) = self.call(tool, args).await;
        assert!(!error, "{tool} failed: {text}");
        text
    }
}

/// The first `#id` after `needle` in a tool's text output.
fn id_after(text: &str, needle: &str) -> String {
    let rest = &text[text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} in {text}"))..];
    let start = rest.find('#').unwrap() + 1;
    rest[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// A top bar like an agent writes for each screen.
fn top_bar(title: &str) -> String {
    format!(
        r#"<header data-name="Top bar" style="display: flex; padding: 16px; background: #ffffff"><h1 data-name="Title" style="margin: 0">{title}</h1><button data-name="Menu">Menu</button></header>"#
    )
}

#[tokio::test]
async fn a_component_changes_every_screen_in_one_edit() {
    // SAFETY: this binary's only test sets it before starting anything.
    unsafe { std::env::set_var("FINITE_MCP_EXTRA", "components") };
    let app = app(Hub::new(Arc::new(MemoryStore::default())).unwrap(), None);
    let mut agent = Agent::connect(&app, "Ada").await;

    let created = agent.ok("create_design", json!({ "name": "App" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let mut screens = Vec::new();
    let mut bars = Vec::new();
    for title in ["Home", "Settings"] {
        let made = agent
            .ok(
                "create_artboard",
                json!({ "designId": design, "name": title, "width": 390, "height": 844,
                        "html": format!("{}<p>{title} content</p>", top_bar(title)) }),
            )
            .await;
        screens.push(id_after(&made, "Created artboard"));
        bars.push(id_after(&made, "\"Top bar\""));
    }

    // The first bar becomes the component, the second an instance of it.
    let made = agent
        .ok(
            "create_component",
            json!({ "designId": design, "nodeId": bars[0], "name": "Top bar",
                    "replaceNodeIds": [bars[1]] }),
        )
        .await;
    assert!(
        made.contains("is a component") && made.contains("1 override"),
        "{made}"
    );
    assert!(
        !made.contains("styled by <style> blocks"),
        "inline styles: {made}"
    );
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": screens[1] }),
        )
        .await;
    assert!(
        html.contains(&format!(
            r#"data-id="{}" data-instance-of="{}""#,
            bars[1], bars[0]
        )),
        "{html}"
    );
    assert!(
        html.contains(">Settings</h1>"),
        "the copy's title is an override: {html}"
    );
    assert!(
        html.contains(&format!(r#"data-id="{}/"#, bars[1])),
        "{html}"
    );
    assert!(
        html.contains("Elements with data-instance-of are instances"),
        "{html}"
    );

    // One edit to the component changes both screens, and says so.
    let edited = agent
        .ok(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": [bars[0]], "styles": { "background": "#111827" } }] }),
        )
        .await;
    assert!(edited.contains("all 1 instance show it too"), "{edited}");
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": screens[1] }),
        )
        .await;
    assert!(html.contains("background: #111827"), "{html}");

    // An edit inside the instance changes only it.
    let title = {
        let needle = r#"<h1 data-id=""#;
        let start = html.find(&format!("{needle}{}/", bars[1])).unwrap() + needle.len();
        html[start..start + html[start..].find('"').unwrap()].to_owned()
    };
    let text = agent
        .ok(
            "set_text_content",
            json!({ "designId": design, "updates": [{ "nodeId": title, "text": "Preferences" }] }),
        )
        .await;
    assert!(
        text.contains(&format!("Only instance #{}", bars[1])),
        "{text}"
    );
    let home = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": screens[0] }),
        )
        .await;
    assert!(
        home.contains(">Home</h1>") && !home.contains("Preferences"),
        "{home}"
    );
    let found = agent
        .ok(
            "find_nodes",
            json!({ "designId": design, "text": "Preferences" }),
        )
        .await;
    assert!(
        found.contains(&title),
        "search sees inside instances: {found}"
    );

    // Structure inside an instance is refused, with what to do instead.
    let (refused, error) = agent
        .call(
            "delete_nodes",
            json!({ "designId": design, "nodeIds": [title] }),
        )
        .await;
    assert!(error && refused.contains("detach_instance"), "{refused}");

    // A third screen gets an instance from insert_instance, a fourth from HTML.
    let third = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Profile", "width": 390, "height": 844 }),
        )
        .await;
    let third = id_after(&third, "Created artboard");
    let inserted = agent
        .ok(
            "insert_instance",
            json!({ "designId": design, "componentId": bars[0], "parentId": third,
                    "overrides": [{ "nodeId": title.split('/').nth(1).unwrap(), "text": "Profile" }] }),
        )
        .await;
    assert!(inserted.contains("\"Profile\""), "{inserted}");
    // get_layout renders the instance with its component's content.
    let (layout, _) = agent
        .call("get_layout", json!({ "designId": design, "nodeId": third }))
        .await;
    assert!(
        layout.contains("no Chrome") || layout.contains("\"Profile\" @ "),
        "{layout}"
    );
    let fourth = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Inbox", "width": 390, "height": 844,
                    "html": format!(r#"<header data-instance-of="{}"></header><p>Mail</p>"#, bars[0]) }),
        )
        .await;
    assert!(fourth.contains("(instance of \"Top bar\""), "{fourth}");

    let list = agent
        .ok("get_components", json!({ "designId": design }))
        .await;
    let list: Value = serde_json::from_str(&list).unwrap();
    assert_eq!(list[0]["name"], "Top bar");
    assert_eq!(list[0]["instanceCount"], 3);

    // Changing a color everywhere changes the component, not each instance.
    agent
        .ok(
            "replace_values",
            json!({ "designId": design, "find": "#111827", "replace": "#7c3aed" }),
        )
        .await;
    let info = agent
        .ok(
            "get_node_info",
            json!({ "designId": design, "nodeIds": [bars[1]] }),
        )
        .await;
    let info: Value = serde_json::from_str(&info).unwrap();
    assert_eq!(info[0]["styles"]["background"], "#7c3aed");
    // Only the title it already had: the color came from the component.
    assert_eq!(info[0]["overrides"].as_object().unwrap().len(), 1, "{info}");

    // Detaching makes a plain copy; undo makes it an instance again.
    let detached = agent
        .ok(
            "detach_instance",
            json!({ "designId": design, "nodeIds": [bars[1]] }),
        )
        .await;
    assert!(
        detached.contains("plain copy") && !detached.contains("Only instance"),
        "{detached}"
    );
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": screens[1] }),
        )
        .await;
    assert!(
        !html.contains("data-instance-of") && html.contains("Preferences"),
        "{html}"
    );
    agent.ok("undo", json!({ "designId": design })).await;
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": screens[1] }),
        )
        .await;
    assert!(html.contains("data-instance-of"), "{html}");

    // A component styled by its artboard's <style> block hears that
    // instances elsewhere won't get those rules.
    let wrote = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": screens[0],
                    "html": r#"<style>.pill { color: red } .pillbox { gap: 2px }</style><span data-name="Pill" class="pill">Hi</span>"# }),
        )
        .await;
    let pill = id_after(&wrote, "\"Pill\"");
    let made = agent
        .ok(
            "create_component",
            json!({ "designId": design, "nodeId": pill }),
        )
        .await;
    assert!(made.contains("Its classes .pill are styled"), "{made}");

    // An instance can't go inside its own component.
    let (refused, error) = agent
        .call(
            "insert_instance",
            json!({ "designId": design, "componentId": bars[0], "parentId": bars[0] }),
        )
        .await;
    assert!(error && refused.contains("contain itself"), "{refused}");
}
