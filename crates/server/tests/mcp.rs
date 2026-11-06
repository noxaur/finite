//! The MCP endpoint seen from outside: sessions, people working beside the
//! agent over HTTP, and results kept within what a client can take. The
//! per-tool behavior is in `tools.rs`.

mod agent;

use agent::{Agent, id_after, test_app};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    response::Response,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// What a tool result may hold, with room for the note at its end.
const LIMIT: usize = 40_000 + 200;

/// The last few lines of a tool's text output, for failure messages.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(3)..].join("\n")
}

/// A request to the web API, as a person's browser makes it.
async fn send(app: &Router, method: &str, path: String, body: Value) -> Response {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    app.clone().oneshot(req).await.unwrap()
}

async fn json_of(res: Response) -> Value {
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

/// A person pins a comment, and returns the comment.
async fn pin(app: &Router, design: &str, body: Value) -> Value {
    let res = send(app, "POST", format!("/api/designs/{design}/comments"), body).await;
    assert_eq!(res.status(), StatusCode::CREATED);
    json_of(res).await
}

fn guest() -> Value {
    json!({ "id": "u1", "name": "Guest" })
}

#[tokio::test]
async fn an_agent_builds_refines_and_undoes() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Landing").await;
    let board = agent.artboard(&design, "Home", 1440, 900).await;

    // Without a height the artboard fits its content, and the result says so.
    let fitting = agent
        .edit(
            &design,
            json!([{ "op": "artboard", "name": "Fits", "width": 390 }]),
        )
        .await;
    assert!(fitting.contains("390 × auto height"), "{fitting}");

    let wrote = agent
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{board}"),
                     "html": "<button data-name=\"CTA\" style=\"padding: 12px\">Start</button>" }]),
        )
        .await;
    let button = id_after(&wrote, "CTA");

    // HTML nested too deep is refused with a reason, before it reaches the design.
    let deep = format!("{}x{}", "<div>".repeat(5_000), "</div>".repeat(5_000));
    let (refused, is_error) = agent
        .call(
            "edit",
            json!({ "designId": design, "check": false,
                    "ops": [{ "op": "html", "select": format!("#{board}"), "html": deep }] }),
        )
        .await;
    assert!(is_error && refused.contains("256 levels"), "{refused}");

    agent
        .edit(
            &design,
            json!([{ "op": "css", "select": format!("#{button}"), "css": "background-color: orange" }]),
        )
        .await;
    let html = agent
        .ok(
            "read",
            json!({ "designId": design, "select": format!("#{button}"), "as": "html" }),
        )
        .await;
    assert!(html.contains("background-color: orange"), "{html}");

    agent.ok("undo", json!({ "designId": design })).await;
    let html = agent
        .ok(
            "read",
            json!({ "designId": design, "select": format!("#{button}"), "as": "html" }),
        )
        .await;
    assert!(!html.contains("orange"), "undo reverted the style: {html}");

    // Errors come back as tool errors the agent can read, not protocol errors.
    let (text, error) = agent
        .call(
            "edit",
            json!({ "designId": design, "check": false,
                    "ops": [{ "op": "css", "select": "#missing", "css": "color: red" }] }),
        )
        .await;
    assert!(error && text.contains("matches no element"), "{text}");
}

#[tokio::test]
async fn a_comment_points_at_several_elements() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Claude").await;
    let design = agent.design("Landing").await;
    let board = agent.artboard(&design, "Home", 400, 300).await;
    let wrote = agent
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{board}"),
                     "html": "<h1 data-name=\"Title\">Hi</h1><button data-name=\"CTA\">Go</button>" }]),
        )
        .await;
    let title = id_after(&wrote, "Title");
    let cta = id_after(&wrote, "CTA");

    let post = |extra: Value| {
        send(
            &app,
            "POST",
            format!("/api/designs/{design}/comments"),
            json!({ "author": guest(), "body": "Line these up", "artboardId": board,
                    "nodeId": title, "extraNodeIds": extra, "x": 10, "y": 10 }),
        )
    };
    assert_eq!(
        post(json!([title])).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(post(json!([cta])).await.status(), StatusCode::CREATED);

    let comments = agent.ok("comments", json!({ "designId": design })).await;
    assert!(
        comments.contains(&format!("\"select\": \"#{title}\"")),
        "{comments}"
    );
    let comment: Value =
        serde_json::from_str(&comments[..comments.rfind(']').unwrap() + 1]).unwrap();
    assert_eq!(
        comment[0]["alsoSelected"][0]["select"],
        format!("#{cta}"),
        "{comments}"
    );
    assert!(
        comment[0]["alsoSelected"][0]["node"]
            .as_str()
            .unwrap()
            .contains("CTA"),
        "{comments}"
    );
}

#[tokio::test]
async fn an_agent_waits_for_the_next_comment() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Claude").await;
    let design = agent.design("Landing").await;
    let idle = "No comments arrived in 1 seconds. Call again to keep listening.";

    // A second agent waits while a person comments.
    let waiter = {
        let app = app.clone();
        let design = design.clone();
        tokio::spawn(async move {
            let mut agent = Agent::connect(&app, "Waiter").await;
            agent
                .ok("comments", json!({ "designId": design, "wait": 10 }))
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    pin(
        &app,
        &design,
        json!({ "author": guest(), "body": "Add a footer", "x": 5, "y": 5 }),
    )
    .await;
    let woke = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
        .await
        .expect("the waiting agent wakes up")
        .unwrap();
    assert!(woke.contains("Add a footer"), "{woke}");

    // The waiter took it, so the first agent doesn't start on it too.
    let theirs = agent
        .ok("comments", json!({ "designId": design, "wait": 1 }))
        .await;
    assert_eq!(theirs, idle);
}

#[tokio::test]
async fn deleting_a_design_ends_a_pending_comment_wait() {
    let hub = finite_server::Hub::new(std::sync::Arc::new(
        finite_server::store::MemoryStore::default(),
    ))
    .unwrap();
    let design = hub.create("Waiting").meta.id;
    let app = finite_server::app(hub.clone(), None);
    let mut waiter = Agent::connect(&app, "Waiter").await;
    let waiting_id = design.clone();
    let waiting = tokio::spawn(async move {
        waiter
            .call("comments", json!({ "designId": waiting_id, "wait": 3 }))
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let handle = hub.get(&design).unwrap();
    hub.delete(&handle).unwrap();
    let (text, error) = tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
        .await
        .expect("deletion must end the wait promptly")
        .unwrap();
    assert!(error && text.contains("not found"), "{text}");
}

#[tokio::test]
async fn people_choose_who_a_comment_is_for() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Notes").await;
    let me = json!({ "id": "u1", "name": "Per" });
    let comment = pin(
        &app,
        &design,
        json!({ "author": me, "body": "Ask the client", "x": 1, "y": 2,
                "audience": { "kind": "people" } }),
    )
    .await;
    assert_eq!(comment["audience"], json!({ "kind": "people" }));
    let id = comment["id"].as_str().unwrap();
    let wait = json!({ "designId": design, "wait": 1 });
    let none = agent.ok("comments", wait.clone()).await;
    assert!(
        none.contains("No comments arrived in 1 seconds. Call again to keep listening."),
        "{none}"
    );

    let path = format!("/api/designs/{design}/comments/{id}");
    let res = send(
        &app,
        "PATCH",
        path.clone(),
        json!({ "audience": { "kind": "agent", "id": "b7" } }),
    )
    .await;
    assert_eq!(
        res.status(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "not an agent's id"
    );
    let res = send(&app, "PATCH", path.clone(), json!({})).await;
    assert_eq!(
        res.status(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "nothing to change"
    );
    let res = send(
        &app,
        "PATCH",
        path,
        json!({ "audience": { "kind": "agents" } }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let waited = agent.ok("comments", wait).await;
    assert!(waited.contains("Ask the client"), "{waited}");
}

/// A person edits their newest message over HTTP, agents see it was edited,
/// and deleting the comment takes it away from agents too.
#[tokio::test]
async fn people_edit_their_newest_message_and_delete_comments() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Edits").await;
    let me = json!({ "id": "u1", "name": "Per" });
    let comment = pin(
        &app,
        &design,
        json!({ "author": me, "body": "Make it red", "x": 1, "y": 2 }),
    )
    .await;
    let id = comment["id"].as_str().unwrap();
    let last = format!("/api/designs/{design}/comments/{id}/messages/last");

    let someone = json!({ "id": "u2", "name": "Guest" });
    let res = send(
        &app,
        "PATCH",
        last.clone(),
        json!({ "author": someone, "body": "No" }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let res = send(
        &app,
        "PATCH",
        last,
        json!({ "author": me, "body": "Make it blue" }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let comments = agent.ok("comments", json!({ "designId": design })).await;
    assert!(comments.contains("Make it blue"), "{comments}");
    assert!(comments.contains(r#""edited": true"#), "{comments}");

    let res = send(
        &app,
        "DELETE",
        format!("/api/designs/{design}/comments/{id}"),
        json!({}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let comments = agent
        .ok(
            "comments",
            json!({ "designId": design, "includeResolved": true }),
        )
        .await;
    assert!(!comments.contains("Make it blue"), "{comments}");
}

/// Viewers show an agent's name, so a long one is cut like a person's, and
/// its id is cut to 64 characters, since it's stored with every reply.
#[tokio::test]
async fn a_long_agent_name_is_cut() {
    let app = test_app();
    let name: &'static str = Box::leak("Agent".repeat(400).into_boxed_str());
    let mut agent = Agent::connect(&app, name).await;
    let design = agent.design("Named").await;
    let comment = pin(
        &app,
        &design,
        json!({ "author": guest(), "body": "Hi", "x": 1, "y": 1 }),
    )
    .await;
    agent
        .ok(
            "comments",
            json!({ "designId": design,
                    "reply": [{ "commentId": comment["id"], "message": "Done" }] }),
        )
        .await;
    let res = send(&app, "GET", format!("/api/designs/{design}"), Value::Null).await;
    let snapshot = json_of(res).await;
    let author = snapshot["comments"][0]["messages"][1]["author"].clone();
    assert_eq!(
        author["id"].as_str().unwrap().len(),
        "agent:".len() + 64,
        "{author}"
    );
    assert_eq!(
        author["name"].as_str().unwrap().chars().count(),
        finite_design::comment::MAX_NAME
    );
}

/// A person sets tokens and an artboard's mode over HTTP; the agent reads
/// them, and the person's edit is theirs to undo, not the agent's.
#[tokio::test]
async fn a_person_sets_tokens() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Css").await;
    let board = agent.artboard(&design, "Home", 390, 844).await;
    let author = guest();
    let put = |body: Value| send(&app, "PUT", format!("/api/designs/{design}/tokens"), body);
    let res = put(json!({
        "author": author,
        "modes": ["Light", "Dark"],
        "tokens": { "--bg": { "Light": "#fff", "Dark": "#111" }, "--brand": "red" },
    }))
    .await;
    assert_eq!(res.status(), 200);
    let changed = json_of(res).await;
    assert!(changed["seq"].is_u64(), "{changed}");
    let bad = json!({ "author": author, "tokens": { "--brand": "red; } body { color: red" } });
    assert_eq!(put(bad).await.status(), 422);
    let res = send(
        &app,
        "PUT",
        format!("/api/designs/{design}/artboards/mode"),
        json!({ "author": author, "ids": [board], "mode": "Dark" }),
    )
    .await;
    assert_eq!(res.status(), 200);

    let snapshot =
        json_of(send(&app, "GET", format!("/api/designs/{design}"), Value::Null).await).await;
    let dark = snapshot["modes"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, mode)| mode["name"] == "Dark")
        .map(|(id, _)| id.clone())
        .unwrap();
    assert_eq!(snapshot["tokens"]["--bg"][&dark], "#111");
    let sheets = agent
        .ok("read", json!({ "designId": design, "as": "css" }))
        .await;
    assert!(
        sheets.contains("--bg") && sheets.contains("#111") && sheets.contains("Dark"),
        "{sheets}"
    );

    // Deleting Dark takes its values, and the artboard goes back to Light.
    let res = send(
        &app,
        "DELETE",
        format!("/api/designs/{design}/modes/{dark}"),
        json!({ "author": author }),
    )
    .await;
    assert_eq!(res.status(), 200);
    let sheets = agent
        .ok("read", json!({ "designId": design, "as": "css" }))
        .await;
    assert!(!sheets.contains("#111"), "{sheets}");
    assert_eq!(
        agent.ok("undo", json!({ "designId": design })).await,
        "Undid your last edit (Artboard \"Home\")."
    );
}

/// Many long comments come in parts that fit the result budget.
#[tokio::test]
async fn long_comment_lists_come_in_parts() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Busy").await;
    let board = agent.artboard(&design, "Home", 400, 300).await;
    // 40 comments of 4,000 characters: 160,000 characters in all.
    for i in 0..40 {
        let body = format!("{i:02} {}", "x".repeat(3_990));
        pin(
            &app,
            &design,
            json!({ "author": guest(), "body": body, "artboardId": board,
                    "nodeId": board, "x": 10, "y": 10 }),
        )
        .await;
    }

    let mut offset = 0;
    let mut seen = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    loop {
        let text = agent
            .ok("comments", json!({ "designId": design, "offset": offset }))
            .await;
        assert!(text.len() < LIMIT, "{} chars", text.len());
        let json_end = text.rfind(']').unwrap() + 1;
        let page: Vec<Value> = serde_json::from_str(&text[..json_end]).unwrap();
        seen.extend(
            page.iter()
                .map(|c| c["thread"][0]["message"].as_str().unwrap()[..2].to_owned()),
        );
        seen_ids.extend(
            page.iter()
                .map(|c| c["commentId"].as_str().unwrap().to_owned()),
        );
        offset += page.len();
        let Some(next) = text.split("offset ").nth(1) else {
            break;
        };
        assert!(next.starts_with(&offset.to_string()), "{}", tail(&text));
    }
    let expected: Vec<String> = (0..40).map(|i| format!("{i:02}")).collect();
    assert_eq!(seen, expected, "every comment once, oldest first");

    let waiting = agent.ok("comments", json!({ "designId": design })).await;
    assert!(waiting.len() < LIMIT, "{} chars", waiting.len());

    // A long thread shows its first message and its latest ten.
    let first_comment = seen_ids[0].clone();
    for i in 0..50 {
        let res = send(
            &app,
            "POST",
            format!("/api/designs/{design}/comments/{first_comment}/replies"),
            json!({ "author": guest(), "body": format!("reply {i}") }),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
    }
    let text = agent.ok("comments", json!({ "designId": design })).await;
    let json_end = text.rfind(']').unwrap() + 1;
    let page: Vec<Value> = serde_json::from_str(&text[..json_end]).unwrap();
    let thread = &page[0]["thread"];
    assert_eq!(thread.as_array().unwrap().len(), 11);
    assert_eq!(page[0]["messagesNotShown"], 40);
    assert_eq!(thread[10]["message"], "reply 49");
}

/// An agent that doesn't name itself is known by its MCP session, so its undo
/// lasts as long as the session. A pause of a few minutes, say while a person
/// reviews the work, doesn't end it.
#[tokio::test(start_paused = true)]
async fn an_unnamed_agent_can_undo_after_a_pause() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "").await;
    let design = agent.design("Paused").await;
    agent.artboard(&design, "Home", 400, 300).await;

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

/// An agent can find a design by name or by id, and a long list is cut short.
#[tokio::test]
async fn designs_filter_and_limit() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    for name in ["Alpha", "Beta", "Alphabet"] {
        agent.design(name).await;
    }
    // The JSON list, before any note about designs left out.
    let count = |text: &str| {
        let list = text.split("\nShowing").next().unwrap();
        serde_json::from_str::<Vec<Value>>(list).unwrap().len()
    };
    let found = agent.ok("designs", json!({ "query": "alpha" })).await;
    assert_eq!(count(&found), 2, "{found}");
    assert!(!found.contains("Showing"), "{found}");
    let first = agent.ok("designs", json!({ "limit": 1 })).await;
    assert_eq!(count(&first), 1, "{first}");
    assert!(
        first.contains("Showing the 1 most recently edited of 3"),
        "{first}"
    );
}

/// A design's id finds it too, and the result says the id matched, not the name.
#[tokio::test]
async fn designs_match_ids() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let id = agent.design("Checkout").await;
    agent.design("Other").await;
    let list = |text: &str| {
        let json = text.split("\nThe query").next().unwrap();
        serde_json::from_str::<Vec<Value>>(json).unwrap()
    };
    for query in [id.clone(), id[..4].to_uppercase()] {
        let found = agent.ok("designs", json!({ "query": query })).await;
        let designs = list(&found);
        assert_eq!(designs.len(), 1, "{found}");
        assert_eq!(designs[0]["name"], "Checkout", "{found}");
        assert!(
            found.contains("matched the designId, not the name"),
            "{found}"
        );
    }
    let by_name = agent.ok("designs", json!({ "query": "checkout" })).await;
    assert!(!by_name.contains("matched the designId"), "{by_name}");
}

/// The longest design list an agent can ask for fits in one result.
#[tokio::test]
async fn the_longest_design_list_fits() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    for i in 0..250 {
        agent
            .design(&format!("{i:03} {}", "Long name ".repeat(12)))
            .await;
    }
    let list = agent.ok("designs", json!({ "limit": 1_000 })).await;
    let json_end = list.rfind(']').unwrap() + 1;
    let designs: Vec<Value> = serde_json::from_str(&list[..json_end]).unwrap();
    assert!(designs.len() < 200, "a list cuts itself to fit one result");
    assert!(list.len() < LIMIT, "{} chars", list.len());
    assert!(list.contains("of 250 designs"), "{}", tail(&list));
}

/// A big artboard's outline and HTML don't flood the agent's context: long
/// results are cut, and say how to see the rest.
#[tokio::test]
async fn long_results_are_cut_with_directions() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Catalog").await;
    let board = agent.artboard(&design, "Grid", 1440, 900).await;
    let on_board = format!("#{board}");
    let card = r#"<div data-name="Card" style="padding: 8px"><p>A product with a long description</p></div>"#;
    let wrote = agent
        .edit(
            &design,
            json!([{ "op": "html", "select": on_board, "html": card.repeat(3_000) }]),
        )
        .await;
    assert!(wrote.len() < LIMIT, "edit said {} chars", wrote.len());

    let overview = agent.ok("read", json!({ "designId": design })).await;
    assert!(overview.len() < LIMIT, "{} chars", overview.len());

    let outline = agent
        .ok("read", json!({ "designId": design, "select": on_board }))
        .await;
    assert!(outline.len() < LIMIT, "{} chars", outline.len());

    let html = agent
        .ok(
            "read",
            json!({ "designId": design, "select": on_board, "as": "html" }),
        )
        .await;
    assert!(
        html.len() < LIMIT,
        "read said {} chars: {} ... {}",
        html.len(),
        &html[..300],
        tail(&html)
    );
    assert!(
        html.contains("cut off") || html.contains("not shown"),
        "{}",
        tail(&html)
    );

    // A megabyte of inline image data comes back as its start and its length.
    let image = format!(
        r#"<img data-name="Photo" src="data:image/png;base64,{}">"#,
        "A".repeat(1 << 20)
    );
    let wrote = agent
        .edit(
            &design,
            json!([{ "op": "html", "select": on_board, "html": image, "position": "prepend" }]),
        )
        .await;
    let photo = id_after(&wrote, "\"Photo\"");
    let html = agent
        .ok(
            "read",
            json!({ "designId": design, "select": format!("#{photo}"), "as": "html" }),
        )
        .await;
    assert!(html.len() < 2_000, "{} chars", html.len());
    assert!(html.contains("characters"), "{html}");

    // A small part still comes back whole.
    let small = agent
        .ok(
            "read",
            json!({ "designId": design, "select": "[data-name=Card]:nth-of-type(2)", "as": "html" }),
        )
        .await;
    assert!(
        small.contains("<div") && !small.contains("cut off"),
        "{small}"
    );
}

/// A design with hundreds of artboards still gets an overview in one result.
#[tokio::test]
async fn an_overview_of_hundreds_of_artboards_fits() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Wall").await;
    let ops: Vec<Value> = (0..250)
        .map(|i| json!({ "op": "artboard", "name": format!("Tile {i}"), "width": 100, "height": 100 }))
        .collect();
    agent.edit(&design, json!(ops)).await;
    let overview = agent.ok("read", json!({ "designId": design })).await;
    assert!(overview.contains("250 artboards"), "{}", tail(&overview));
    assert!(overview.len() < LIMIT, "{} chars", overview.len());
}

/// A page links dozens of stylesheets, each quarantined. The result says so
/// in one line per kind, and the import record keeps them all.
#[tokio::test]
async fn a_big_pages_diagnostics_come_grouped() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Importer").await;
    let design = agent.design("Big").await;
    let links = "<link rel=\"stylesheet\" href=\"https://x/a.css\">".repeat(40);
    let page = format!(
        "<!doctype html><html><head>{links}</head><body><p>Hi</p><script>a()</script></body></html>"
    );
    let imported = agent
        .edit(
            &design,
            json!([{ "op": "import", "name": "big.html", "content": page }]),
        )
        .await;
    assert!(
        imported.contains("41 diagnostic(s) of 2 kind(s)")
            && imported.contains("- 40 × <link> at /0/0, /0/1, /0/2 and 37 more: ")
            && imported.contains("- <script> at /1/1: "),
        "{imported}"
    );
    assert!(imported.contains("keeps the original"), "{imported}");

    let res = send(
        &app,
        "GET",
        format!("/api/designs/{design}/imports"),
        Value::Null,
    )
    .await;
    let records = json_of(res).await;
    assert_eq!(records[0]["quarantined"].as_array().unwrap().len(), 41);
}

/// A node too big for one result is cut, and JSX is a format that only
/// exports, so it fails clearly where the others work.
#[tokio::test]
async fn exports_say_what_they_cannot_do() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Dev").await;
    let design = agent.design("Big").await;
    let board = agent.artboard(&design, "Grid", 1440, 900).await;
    let card = r#"<div data-name="Card" style="padding: 8px"><p>A product with a long description</p></div>"#;
    agent
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{board}"), "html": card.repeat(3_000) }]),
        )
        .await;
    let jsx = agent
        .ok(
            "read",
            json!({ "designId": design, "select": format!("#{board}"), "as": "jsx" }),
        )
        .await;
    assert!(jsx.len() < LIMIT, "jsx said {} chars", jsx.len());

    // The whole design doesn't fit in one component file.
    let (error, failed) = agent
        .call("read", json!({ "designId": design, "export": "jsx" }))
        .await;
    assert!(failed && error.contains("takes one artboard"), "{error}");
    let exported = agent
        .ok(
            "read",
            json!({ "designId": design, "select": format!("#{board}"), "export": "jsx" }),
        )
        .await;
    assert!(exported.contains("grid.jsx"), "{}", tail(&exported));
    // An unknown format lists every one that exists.
    let (error, failed) = agent
        .call("read", json!({ "designId": design, "export": "nope" }))
        .await;
    assert!(
        failed && error.contains("html, finite, figma, jsx, repo, app"),
        "{error}"
    );
    // `app` is a tar, so the result says where to download it.
    let (text, failed) = agent
        .call("read", json!({ "designId": design, "export": "app" }))
        .await;
    assert!(
        !failed && text.contains("-app.tar") && text.contains("not text"),
        "{text}"
    );
    let (text, failed) = agent
        .call(
            "read",
            json!({ "designId": design, "export": "app", "router": "tanstack-router" }),
        )
        .await;
    assert!(!failed && text.contains("router=tanstack-router"), "{text}");
    let (error, failed) = agent
        .call(
            "read",
            json!({ "designId": design, "export": "app", "router": "nope" }),
        )
        .await;
    assert!(
        failed && error.contains("react-router") && error.contains("tanstack-router"),
        "{error}"
    );
}

#[tokio::test]
async fn an_agent_deletes_a_design_permanently() {
    let store = std::sync::Arc::new(finite_server::store::MemoryStore::default());
    let hub = finite_server::Hub::new(store.clone()).unwrap();
    let app = finite_server::app(hub.clone(), None);
    let mut agent = Agent::connect(&app, "Alice").await;
    let doomed = hub.create("Draft");
    let kept = hub.create("Keep");
    let id = &doomed.meta.id;
    agent.artboard(id, "Home", 390, 300).await;
    let handle = hub.get(id).unwrap();
    let (_, _, mut viewer) = handle.subscribe();
    let (_, mut lobby) = hub.subscribe_lobby();
    let tools = agent.rpc("tools/list", None).await;
    let tool = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "designs")
        .unwrap();
    assert_eq!(tool["annotations"]["readOnlyHint"], false);
    let deleted = agent.ok("designs", json!({ "delete": id })).await;
    assert!(deleted.contains("permanently"), "{deleted}");
    assert!(viewer.recv().await.is_err());
    let message: Value = serde_json::from_str(&lobby.recv().await.unwrap().json).unwrap();
    assert_eq!(message["type"], "designs");
    assert_eq!(message["total"], 1);
    assert_eq!(message["designs"][0]["id"], kept.meta.id);
    for tool in ["read", "undo", "comments"] {
        let (text, error) = agent.call(tool, json!({ "designId": id })).await;
        assert!(error && text.contains("no design"), "{tool}: {text}");
    }
    let listed = agent.ok("designs", json!({})).await;
    assert!(!listed.contains(id.as_str()));
    assert!(listed.contains(&kept.meta.id));
    hub.flush();
    let restored = finite_server::Hub::new(store).unwrap();
    assert!(restored.get(id).is_none());
    assert!(restored.get(&kept.meta.id).is_some());
}

/// The overview names the pages, and an artboard made for a page is placed
/// on it, not beside the others.
#[tokio::test]
async fn agents_keep_components_on_their_own_page() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Kit").await;
    agent.artboard(&design, "Home", 400, 300).await;
    let made = agent
        .edit(
            &design,
            json!([{ "op": "page", "create": "Components" },
                   { "op": "artboard", "name": "Button", "width": 200, "height": 80,
                     "page": "Components" }]),
        )
        .await;
    assert!(made.contains("at x 0, y 0"), "{made}");
    let overview = agent.ok("read", json!({ "designId": design })).await;
    assert!(
        overview.contains("Components") && overview.contains("\"Button\""),
        "{overview}"
    );
}
