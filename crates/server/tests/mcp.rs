//! Drives the MCP endpoint the way an agent does: initialize a session over
//! Streamable HTTP, then call tools and read their text results.

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

/// The last few lines of a tool's text output, for failure messages.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(3)..].join("\n")
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

fn test_app() -> Router {
    app(Hub::new(Arc::new(MemoryStore::default())).unwrap(), None)
}

#[tokio::test]
async fn an_agent_builds_refines_and_undoes() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;

    let tools = agent.rpc("tools/list", None).await;
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for tool in [
        "create_design",
        "write_html",
        "get_comments",
        "reply_to_comment",
    ] {
        assert!(names.contains(&tool), "missing tool {tool}");
    }

    let created = agent
        .ok("create_design", json!({ "name": "Landing" }))
        .await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();

    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 1440, "height": 900 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let wrote = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board,
                    "html": "<button data-name=\"CTA\" style=\"padding: 12px\">Start</button>" }),
        )
        .await;
    let button = id_after(&wrote, "CTA");

    // HTML nested too deep is refused with a reason, before it reaches the design.
    let deep = format!("{}x{}", "<div>".repeat(5_000), "</div>".repeat(5_000));
    let (refused, is_error) = agent
        .call(
            "write_html",
            json!({ "designId": design, "targetId": board, "html": deep }),
        )
        .await;
    assert!(is_error && refused.contains("256 levels"), "{refused}");

    agent
        .ok(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": [button], "styles": { "backgroundColor": "orange" } }] }),
        )
        .await;
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": button }))
        .await;
    assert!(html.contains("background-color: orange"), "{html}");

    agent.ok("undo", json!({ "designId": design })).await;
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": button }))
        .await;
    assert!(!html.contains("orange"), "undo reverted the style: {html}");

    // Errors come back as tool errors the agent can read, not protocol errors.
    let (text, error) = agent
        .call(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": ["missing"], "styles": { "color": "red" } }] }),
        )
        .await;
    assert!(error && text.contains("not found"), "{text}");
}

#[tokio::test]
async fn agents_answer_comments_and_link_their_changes() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Claude").await;
    let created = agent
        .ok("create_design", json!({ "name": "Landing" }))
        .await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 400, "height": 300 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");

    // A user pins a comment over the web API.
    let req = Request::post(format!("/api/designs/{design}/comments"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Make it dark",
                    "artboardId": board, "nodeId": board, "x": 10, "y": 10 })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);

    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    assert!(info.contains("\"openComments\": 1"), "{info}");
    let comments = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    assert!(comments.contains("Make it dark"), "{comments}");
    let comment: Value = serde_json::from_str(&comments).unwrap();
    let comment_id = comment[0]["commentId"].as_str().unwrap().to_owned();

    agent
        .ok(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": [board], "styles": { "background": "#111" } }] }),
        )
        .await;
    let replied = agent
        .ok(
            "reply_to_comment",
            json!({ "designId": design, "commentId": comment_id,
                    "message": "Made it dark", "resolve": true }),
        )
        .await;
    assert!(replied.contains("1 change"), "{replied}");

    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    assert!(info.contains("\"openComments\": 0"), "{info}");
}

#[tokio::test]
async fn an_agent_waits_for_the_next_comment() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Claude").await;
    let created = agent
        .ok("create_design", json!({ "name": "Landing" }))
        .await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();

    // Nothing to do yet: the wait times out.
    let idle = agent
        .ok(
            "wait_for_comments",
            json!({ "designId": design, "timeoutSeconds": 1 }),
        )
        .await;
    assert!(idle.contains("No comments arrived"), "{idle}");

    // A second agent waits while a user comments.
    let waiter = {
        let app = app.clone();
        let design = design.clone();
        tokio::spawn(async move {
            let mut agent = Agent::connect(&app, "Waiter").await;
            agent
                .ok(
                    "wait_for_comments",
                    json!({ "designId": design, "timeoutSeconds": 10 }),
                )
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let req = Request::post(format!("/api/designs/{design}/comments"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Add a footer", "x": 5, "y": 5 })
                .to_string(),
        ))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), 201);
    let woke = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
        .await
        .expect("the waiting agent wakes up")
        .unwrap();
    assert!(woke.contains("Add a footer"), "{woke}");

    // A comment already waiting comes back right away.
    let now = agent
        .ok(
            "wait_for_comments",
            json!({ "designId": design, "timeoutSeconds": 10 }),
        )
        .await;
    assert!(now.contains("Add a footer"), "{now}");
}

/// Viewers show an agent's name, so a long one is cut like a person's.
#[tokio::test]
async fn long_agent_names_are_cut() {
    let app = test_app();
    let long: &'static str = "A".repeat(200).leak();
    let mut agent = Agent::connect(&app, long).await;
    let created = agent.ok("create_design", json!({ "name": "Names" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let post = Request::post(format!("/api/designs/{design}/comments"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Hi", "x": 1, "y": 2 })
                .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(post).await.unwrap();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let comment: Value = serde_json::from_slice(&bytes).unwrap();
    agent
        .ok(
            "reply_to_comment",
            json!({ "designId": design, "commentId": comment["id"], "message": "Hello" }),
        )
        .await;

    let get = Request::get(format!("/api/designs/{design}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(get).await.unwrap();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let snapshot: Value = serde_json::from_slice(&bytes).unwrap();
    let name = snapshot["comments"][0]["messages"][1]["author"]["name"]
        .as_str()
        .unwrap();
    assert_eq!(name.chars().count(), finite_design::comment::MAX_NAME);
}

/// An agent can find a design by name, and a long list is cut short.
#[tokio::test]
async fn list_designs_filters_and_limits() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    for name in ["Alpha", "Beta", "Alphabet"] {
        agent.ok("create_design", json!({ "name": name })).await;
    }
    // The JSON list, before any note about designs left out.
    let count = |text: &str| {
        let list = text.split("\nShowing").next().unwrap();
        serde_json::from_str::<Vec<Value>>(list).unwrap().len()
    };
    let found = agent.ok("list_designs", json!({ "query": "alpha" })).await;
    assert_eq!(count(&found), 2, "{found}");
    assert!(!found.contains("Showing"), "{found}");
    let first = agent.ok("list_designs", json!({ "limit": 1 })).await;
    assert_eq!(count(&first), 1, "{first}");
    assert!(
        first.contains("Showing the 1 most recently edited of 3"),
        "{first}"
    );
}

/// A big artboard's outline and HTML don't flood the agent's context: long
/// results are cut, and say how to see the rest.
#[tokio::test]
async fn long_results_are_cut_with_directions() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent
        .ok("create_design", json!({ "name": "Catalog" }))
        .await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Grid", "width": 1440, "height": 900 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let card = r#"<div data-name="Card" style="padding: 8px"><p>A product with a long description</p></div>"#;
    let wrote = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board, "html": card.repeat(3_000) }),
        )
        .await;
    let limit = 60_000 + 200;
    assert!(wrote.len() < limit, "write_html said {} chars", wrote.len());
    assert!(wrote.contains("cut off after"), "{}", tail(&wrote));

    let tree = agent
        .ok("get_tree_summary", json!({ "designId": design }))
        .await;
    assert!(tree.len() < limit, "the outline is {} chars", tree.len());
    assert!(
        tree.contains("of 6001 lines. Pass the nodeId of one part"),
        "{}",
        tail(&tree)
    );

    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(html.len() < limit, "get_html said {} chars", html.len());
    assert!(
        html.contains("Call get_html on one of its children"),
        "{}",
        tail(&html)
    );

    // Children come 200 at a time.
    let children = agent
        .ok(
            "get_children",
            json!({ "designId": design, "nodeId": board }),
        )
        .await;
    assert!(
        children.ends_with("Showing children 1 to 200 of 3000. Pass offset 200 for the next ones."),
        "{}",
        tail(&children)
    );
    let last = agent
        .ok(
            "get_children",
            json!({ "designId": design, "nodeId": board, "offset": 2_900 }),
        )
        .await;
    let page: Vec<Value> = serde_json::from_str(&last).unwrap();
    assert_eq!(page.len(), 100);

    let first: Vec<Value> =
        serde_json::from_str(&children[..children.rfind(']').unwrap() + 1]).unwrap();
    // Details for 1,000 nodes are more than one result holds.
    let all: Vec<&str> = first
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .cycle()
        .take(1_000)
        .collect();
    let info = agent
        .ok(
            "get_node_info",
            json!({ "designId": design, "nodeIds": all }),
        )
        .await;
    assert!(
        info.len() < limit,
        "get_node_info said {} chars",
        info.len()
    );
    assert!(
        info.contains("of 1000 nodes. Ask for the rest"),
        "{}",
        tail(&info)
    );

    // Presence names at most 100 nodes; repeats count once.
    let ids: Vec<&str> = page.iter().map(|c| c["id"].as_str().unwrap()).collect();
    let repeated: Vec<&str> = ids.iter().cycle().take(5_000).copied().collect();
    agent
        .ok(
            "start_working_on_nodes",
            json!({ "designId": design, "nodeIds": repeated }),
        )
        .await;
    let too_many: Vec<&str> = first
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .take(101)
        .collect();
    let (refused, is_error) = agent
        .call(
            "start_working_on_nodes",
            json!({ "designId": design, "nodeIds": too_many }),
        )
        .await;
    assert!(is_error && refused.contains("at most 100"), "{refused}");

    // A small part still comes back whole.
    let first_card = id_after(&tree, "\"Card\"");
    let small = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": first_card }),
        )
        .await;
    assert!(
        small.starts_with("<div") && !small.contains("cut off"),
        "{small}"
    );
}

/// Many long comments come in parts that fit the result budget.
#[tokio::test]
async fn long_comment_lists_come_in_parts() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Busy" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 400, "height": 300 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    // 40 comments of 4,000 characters: 160,000 characters in all.
    for i in 0..40 {
        let body = format!("{i:02} {}", "x".repeat(3_990));
        let req = Request::post(format!("/api/designs/{design}/comments"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "author": { "id": "u1", "name": "Guest" }, "body": body,
                        "artboardId": board, "nodeId": board, "x": 10, "y": 10 })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), 201);
    }

    let mut offset = 0;
    let mut seen = Vec::new();
    loop {
        let text = agent
            .ok(
                "get_comments",
                json!({ "designId": design, "offset": offset }),
            )
            .await;
        assert!(text.len() < 60_000 + 200, "{} chars", text.len());
        let json_end = text.rfind(']').unwrap() + 1;
        let page: Vec<Value> = serde_json::from_str(&text[..json_end]).unwrap();
        seen.extend(
            page.iter()
                .map(|c| c["thread"][0]["message"].as_str().unwrap()[..2].to_owned()),
        );
        offset += page.len();
        let Some(next) = text.split("Pass offset ").nth(1) else {
            break;
        };
        assert_eq!(next.split(' ').next().unwrap(), offset.to_string());
    }
    let expected: Vec<String> = (0..40).map(|i| format!("{i:02}")).collect();
    assert_eq!(seen, expected, "every comment once, oldest first");

    let waiting = agent
        .ok("wait_for_comments", json!({ "designId": design }))
        .await;
    assert!(waiting.len() < 60_000 + 200, "{} chars", waiting.len());
    assert!(
        waiting.contains("of 40 waiting comments. Reply to these"),
        "{}",
        tail(&waiting)
    );
}

/// An agent that doesn't name itself is known by its MCP session, so its undo
/// lasts as long as the session. A pause of a few minutes, say while a person
/// reviews the work, doesn't end it.
#[tokio::test(start_paused = true)]
async fn an_unnamed_agent_can_undo_after_a_pause() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "").await;
    let created = agent.ok("create_design", json!({ "name": "Paused" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 400, "height": 300 }),
        )
        .await;

    tokio::time::sleep(std::time::Duration::from_secs(20 * 60)).await;

    let undone = agent.ok("undo", json!({ "designId": design })).await;
    assert!(undone.contains("Undid"), "{undone}");

    // An hour without a call does end the session, so idle ones don't pile up.
    tokio::time::sleep(std::time::Duration::from_secs(61 * 60)).await;
    let gone = agent
        .send(json!({ "jsonrpc": "2.0", "id": 99, "method": "tools/list" }))
        .await;
    assert!(gone.is_none(), "{gone:?}");
}

/// The longest design list an agent can ask for fits in one result.
#[tokio::test]
async fn the_longest_design_list_fits() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    for i in 0..250 {
        let name = format!("{i:03} {}", "Long name ".repeat(12));
        agent.ok("create_design", json!({ "name": name })).await;
    }
    let list = agent.ok("list_designs", json!({ "limit": 1_000 })).await;
    let json_end = list.rfind(']').unwrap() + 1;
    let designs: Vec<Value> = serde_json::from_str(&list[..json_end]).unwrap();
    assert_eq!(designs.len(), 200, "the limit is capped at 200");
    assert!(list.len() < 60_000, "{} chars", list.len());
    assert!(list.contains("of 250 designs"), "{}", tail(&list));
}
