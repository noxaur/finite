//! Drives the MCP endpoint the way an agent does: initialize a session over
//! Streamable HTTP, then call tools and read their text results.

mod agent;

use agent::{Agent, id_after, test_app};
use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// The last few lines of a tool's text output, for failure messages.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(3)..].join("\n")
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

    // Without a height the artboard fits its content, and the result says so.
    let fitting = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Fits", "width": 390 }),
        )
        .await;
    assert!(fitting.contains("390 × auto height"), "{fitting}");

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

/// A comment can point at several elements, and agents see each of them.
#[tokio::test]
async fn a_comment_points_at_several_elements() {
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
    let wrote = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board,
                    "html": "<h1 data-name=\"Title\">Hi</h1><button data-name=\"CTA\">Go</button>" }),
        )
        .await;
    let title = id_after(&wrote, "Title");
    let cta = id_after(&wrote, "CTA");

    let post = |extra: Value| {
        let app = app.clone();
        let req = Request::post(format!("/api/designs/{design}/comments"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Line these up",
                        "artboardId": board, "nodeId": title, "extraNodeIds": extra,
                        "x": 10, "y": 10 })
                .to_string(),
            ))
            .unwrap();
        async move { app.oneshot(req).await.unwrap().status() }
    };
    assert_eq!(post(json!([title])).await, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(post(json!([cta])).await, StatusCode::CREATED);

    let comments = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    let comment: Value = serde_json::from_str(&comments).unwrap();
    assert_eq!(comment[0]["nodeId"], title.as_str());
    assert_eq!(
        comment[0]["alsoSelected"][0]["nodeId"],
        cta.as_str(),
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

    // The waiter took it, so the first agent doesn't start on it too.
    let theirs = agent
        .ok(
            "wait_for_comments",
            json!({ "designId": design, "timeoutSeconds": 1 }),
        )
        .await;
    assert!(theirs.contains("No comments arrived"), "{theirs}");
}

/// A person edits tokens and modes in the app. They're saved in the
/// design, and an agent reading an artboard's HTML hears that it reads them.
#[tokio::test]
async fn a_person_sets_tokens() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Css" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 390, "height": 844 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let author = json!({ "id": "u1", "name": "Guest" });
    let send = |method: &str, path: String, body: Value| {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let put = |body: Value| send("PUT", format!("/api/designs/{design}/tokens"), body);
    let res = app
        .clone()
        .oneshot(put(json!({
            "author": author,
            "modes": ["Light", "Dark"],
            "tokens": { "--bg": { "Light": "#fff", "Dark": "#111" }, "--brand": "red" },
        })))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let changed: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(changed["seq"].is_u64(), "{changed}");
    let bad = json!({ "author": author, "tokens": { "--brand": "red; } body { color: red" } });
    let res = app.clone().oneshot(put(bad)).await.unwrap();
    assert_eq!(res.status(), 422);
    let res = app
        .clone()
        .oneshot(send(
            "PUT",
            format!("/api/designs/{design}/artboards/mode"),
            json!({ "author": author, "ids": [board], "mode": "Dark" }),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let get = Request::get(format!("/api/designs/{design}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(get).await.unwrap();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let snapshot: Value = serde_json::from_slice(&bytes).unwrap();
    let dark = snapshot["modes"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, mode)| mode["name"] == "Dark")
        .map(|(id, _)| id.clone())
        .unwrap();
    assert_eq!(snapshot["tokens"]["--bg"][&dark], "#111");
    let tokens = agent.ok("get_tokens", json!({ "designId": design })).await;
    let tokens: Value = serde_json::from_str(&tokens).unwrap();
    assert_eq!(tokens["artboardModes"]["Dark"], json!([board]));

    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(html.contains("2 tokens (get_tokens)"), "{html}");

    // Deleting Dark takes its values, and the artboard goes back to Light.
    let res = app
        .clone()
        .oneshot(send(
            "DELETE",
            format!("/api/designs/{design}/modes/{dark}"),
            json!({ "author": author }),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let tokens = agent.ok("get_tokens", json!({ "designId": design })).await;
    let tokens: Value = serde_json::from_str(&tokens).unwrap();
    assert_eq!(
        tokens,
        json!({ "modes": ["Light"], "tokens": { "--bg": "#fff", "--brand": "red" } })
    );
    // The person's edit is theirs to undo, not the agent's.
    assert_eq!(
        agent.ok("undo", json!({ "designId": design })).await,
        "Undid: Create artboard \"Home\""
    );
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

/// A person edits their newest message over HTTP, agents see it was edited,
/// and deleting the comment takes it away from agents too.
#[tokio::test]
async fn people_edit_their_newest_message_and_delete_comments() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Edits" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let send = |method: &str, path: String, body: Value| {
        let app = app.clone();
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        async move { app.oneshot(req).await.unwrap() }
    };
    let me = json!({ "id": "u1", "name": "Per" });
    let res = send(
        "POST",
        format!("/api/designs/{design}/comments"),
        json!({ "author": me, "body": "Make it red", "x": 1, "y": 2 }),
    )
    .await;
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let comment: Value = serde_json::from_slice(&bytes).unwrap();
    let id = comment["id"].as_str().unwrap();
    let last = format!("/api/designs/{design}/comments/{id}/messages/last");

    let someone = json!({ "id": "u2", "name": "Guest" });
    let res = send(
        "PATCH",
        last.clone(),
        json!({ "author": someone, "body": "No" }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let res = send(
        "PATCH",
        last.clone(),
        json!({ "author": me, "body": "Make it blue" }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let comments = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    assert!(comments.contains("Make it blue"), "{comments}");
    assert!(comments.contains(r#""edited": true"#), "{comments}");

    let res = send(
        "DELETE",
        format!("/api/designs/{design}/comments/{id}"),
        json!({}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let comments = agent
        .ok(
            "get_comments",
            json!({ "designId": design, "includeResolved": true }),
        )
        .await;
    assert!(!comments.contains("Make it blue"), "{comments}");
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

/// A design's id finds it too, and the result says the id matched, not the name.
#[tokio::test]
async fn list_designs_matches_ids() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent
        .ok("create_design", json!({ "name": "Checkout" }))
        .await;
    agent.ok("create_design", json!({ "name": "Other" })).await;
    let id: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let list = |text: &str| {
        let json = text.split("\nThe query").next().unwrap();
        serde_json::from_str::<Vec<Value>>(json).unwrap()
    };
    for query in [id.clone(), id[..4].to_uppercase()] {
        let found = agent.ok("list_designs", json!({ "query": query })).await;
        let designs = list(&found);
        assert_eq!(designs.len(), 1, "{found}");
        assert_eq!(designs[0]["name"], "Checkout", "{found}");
        assert!(
            found.contains("matched the designId, not the name"),
            "{found}"
        );
    }
    let by_name = agent
        .ok("list_designs", json!({ "query": "checkout" }))
        .await;
    assert!(!by_name.contains("matched the designId"), "{by_name}");
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
    // An explicit depth that's still too long falls back the same way.
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": board, "depth": 1 }),
        )
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

    // The artboard's own details list 200 child ids and the full count.
    let info = agent
        .ok(
            "get_node_info",
            json!({ "designId": design, "nodeIds": [board] }),
        )
        .await;
    let info: Vec<Value> = serde_json::from_str(&info).unwrap();
    assert_eq!(info[0]["childCount"], 3000);
    assert_eq!(info[0]["childIds"].as_array().unwrap().len(), 200);

    // A megabyte of inline image data comes back as its start and its length.
    let image = format!(
        r#"<img data-name="Photo" src="data:image/png;base64,{}">"#,
        "A".repeat(1 << 20)
    );
    let wrote = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board, "html": image, "index": 0 }),
        )
        .await;
    let photo = id_after(&wrote, "\"Photo\"");
    let info = agent
        .ok(
            "get_node_info",
            json!({ "designId": design, "nodeIds": [photo] }),
        )
        .await;
    assert!(info.len() < 2_000, "{} chars", info.len());
    assert!(info.contains("characters in all"), "{info}");
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": photo }))
        .await;
    assert!(html.contains("get_node_info shows them"), "{html}");

    // Copying 6,000 nodes lists their ids up to the budget, whole ids only.
    let strip = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Strip", "width": 400, "height": 300 }),
        )
        .await;
    let strip = id_after(&strip, "Created artboard");
    agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": strip, "html": "<i></i>".repeat(6_000) }),
        )
        .await;
    let mut dots: Vec<String> = Vec::new();
    while dots.len() < 6_000 {
        let text = agent
            .ok(
                "get_children",
                json!({ "designId": design, "nodeId": strip, "offset": dots.len() }),
            )
            .await;
        let page: Vec<Value> = serde_json::from_str(&text[..text.rfind(']').unwrap() + 1]).unwrap();
        dots.extend(page.iter().map(|c| c["id"].as_str().unwrap().to_owned()));
    }
    let copied = agent
        .ok(
            "duplicate_nodes",
            json!({ "designId": design, "nodeIds": dots }),
        )
        .await;
    assert!(copied.len() < limit, "{} chars", copied.len());
    assert!(
        copied.starts_with("Created 6000 copies:"),
        "{}",
        &copied[..40]
    );
    assert!(
        copied.contains("Call get_children on their parent"),
        "{}",
        tail(&copied)
    );
    // Each copy is an outline line, and the cut falls between them.
    let last = copied.lines().rev().nth(1).unwrap();
    assert!(last.starts_with("i #") && last.len() == 11, "{last:?}");
    agent.ok("undo", json!({ "designId": design })).await;

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
    let mut seen_ids: Vec<String> = Vec::new();
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
        seen_ids.extend(
            page.iter()
                .map(|c| c["commentId"].as_str().unwrap().to_owned()),
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

    // A long thread shows its first message and its latest ten.
    let first_comment = seen_ids[0].clone();
    for i in 0..50 {
        let req = Request::post(format!(
            "/api/designs/{design}/comments/{first_comment}/replies"
        ))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "author": { "id": "u1", "name": "Guest" }, "body": format!("reply {i}") })
                .to_string(),
        ))
        .unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), 201);
    }
    let text = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
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

/// A design with hundreds of artboards lists 200 of them in its overview.
#[tokio::test]
async fn an_overview_lists_at_most_200_artboards() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Wall" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    for i in 0..250 {
        agent
            .ok(
                "create_artboard",
                json!({ "designId": design, "name": format!("Tile {i}"), "width": 100, "height": 100 }),
            )
            .await;
    }
    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    let json_end = info.rfind('}').unwrap() + 1;
    let overview: Value = serde_json::from_str(&info[..json_end]).unwrap();
    assert_eq!(overview["artboardCount"], 250);
    assert_eq!(overview["artboards"].as_array().unwrap().len(), 200);
    assert!(
        info.ends_with("get_children without a nodeId pages through them all."),
        "{}",
        tail(&info)
    );
}

/// An agent's id from `X-Finite-Agent` is cut to 64 characters, since it's
/// stored with every change and reply it makes.
#[tokio::test]
async fn a_long_agent_name_is_cut() {
    let app = test_app();
    let name: &'static str = Box::leak("Agent".repeat(400).into_boxed_str());
    let mut agent = Agent::connect(&app, name).await;
    let created = agent.ok("create_design", json!({ "name": "Named" })).await;
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
    let req = Request::post(format!("/api/designs/{design}/comments"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Hi",
                    "artboardId": board, "nodeId": board, "x": 1, "y": 1 })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let comment: Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    agent
        .ok(
            "reply_to_comment",
            json!({ "designId": design, "commentId": comment["id"], "message": "Done" }),
        )
        .await;
    let req = Request::get(format!("/api/designs/{design}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let snapshot: Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let author = snapshot["comments"][0]["messages"][1]["author"].clone();
    assert_eq!(
        author["id"].as_str().unwrap().len(),
        "agent:".len() + 64,
        "{author}"
    );
    assert_eq!(author["name"].as_str().unwrap().chars().count(), 48);
}

#[tokio::test]
async fn agents_choose_what_html_and_screenshots_show() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Shots" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Card", "width": 400, "height": 300 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let wrote = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board, "html": r#"<style>.title { color: red }</style><section data-name="Body" style="padding: 24px"><div data-name="Row"><p class="title">Hello</p><img src="data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAA"></div></section>"# }),
        )
        .await;
    let body = id_after(&wrote, "\"Body\"");

    // A depth, no styles, short values and the artboard's stylesheet.
    let html = agent
        .ok(
            "get_html",
            json!({ "designId": design, "nodeId": body, "depth": 1, "includeStyles": false,
                    "includeStylesheets": true, "maxValueLength": 10 }),
        )
        .await;
    assert!(html.starts_with("<style"), "{html}");
    assert!(
        html.contains("<!-- 2 child elements not shown -->"),
        "{html}"
    );
    assert!(!html.contains("padding"), "{html}");
    assert!(html.contains("shows 1 level below the node"), "{html}");
    assert!(html.contains("from elsewhere in the artboard"), "{html}");

    // Screenshots: the outcome depends on whether a browser is installed.
    let result = agent
        .rpc(
            "tools/call",
            Some(json!({ "name": "get_screenshot",
                         "arguments": { "designId": design, "nodeIds": [board, body], "padding": 4 } })),
        )
        .await;
    let content = result["content"].as_array().unwrap();
    let texts: Vec<&str> = content.iter().filter_map(|c| c["text"].as_str()).collect();
    if texts.iter().any(|t| t.contains("no Chrome")) {
        eprintln!("skipped the screenshot: no browser");
        return;
    }
    let images = content.iter().filter(|c| c["type"] == "image").count();
    assert_eq!(images, 2, "{texts:?}");
    assert!(
        texts
            .iter()
            .any(|t| t.contains(&format!("#{body} in artboard #{board}"))),
        "{texts:?}"
    );
    // The whole artboard's shot also gets a layout check; the node's doesn't.
    assert_eq!(
        texts.iter().filter(|t| t.starts_with("Layout:")).count(),
        1,
        "{texts:?}"
    );

    let (refused, is_error) = agent
        .call(
            "get_screenshot",
            json!({ "designId": design, "nodeId": body, "format": "jpeg", "transparent": true }),
        )
        .await;
    assert!(is_error && refused.contains("no transparency"), "{refused}");
}

/// What the AX runs (`e2e/ax`) changed: a screen in one call, edits that say
/// what they changed, search and replace, and the argument shapes agents guess.
#[tokio::test]
async fn tools_answer_what_agents_asked_for() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Ax").await;
    let created = agent.ok("create_design", json!({ "name": "Ax" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();

    // One call makes the artboard and its content, and reports both.
    let made = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Phone", "width": 390, "height": 844,
                    "html": "<style>.cta { color: #3B82F6 }</style><button data-name=\"CTA\" class=\"cta\" style=\"background: rgba(59, 130, 246, 0.2)\">Go</button>" }),
        )
        .await;
    assert!(made.contains("at x 0, y 0, 390 × 844"), "{made}");
    let board = id_after(&made, "Created artboard");
    let button = id_after(&made, "\"CTA\"");

    // An edit names the nodes it changed. A flat update with values sent as
    // JSON strings, as agents send before loading a schema, works too.
    let edited = agent
        .ok(
            "update_styles",
            json!({ "designId": design, "nodeIds": format!("[\"{button}\"]"), "styles": "{\"padding\": \"12px\"}" }),
        )
        .await;
    assert!(
        edited.starts_with("Changed 1 value on 1 node:") && edited.contains("\"CTA\""),
        "{edited}"
    );

    // Find the blue in any notation, in styles and in the <style> block.
    let found = agent
        .ok(
            "find_nodes",
            json!({ "designId": design, "style": "#3b82f6" }),
        )
        .await;
    assert!(found.starts_with("2 elements match"), "{found}");
    let replaced = agent
        .ok(
            "replace_values",
            json!({ "designId": design, "find": "#3b82f6", "replace": "#f97316" }),
        )
        .await;
    assert!(
        replaced.starts_with("Replaced 2 uses on 2 nodes"),
        "{replaced}"
    );
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(
        html.contains("color: #f97316") && html.contains("rgba(249, 115, 22, 0.2)"),
        "{html}"
    );
    // One undo step puts it all back.
    agent.ok("undo", json!({ "designId": design })).await;
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(html.contains("#3B82F6"), "{html}");

    // The edits showed users which artboard the agent was on.
    let info: Value = serde_json::from_str(
        &agent
            .ok("get_basic_info", json!({ "designId": design }))
            .await,
    )
    .unwrap();
    assert_eq!(info["agentsWorking"][0]["nodeIds"], json!([board]));

    // Part of a <style> or <script> is found and replaced; an ambiguous match
    // is refused unless it's narrowed or `all` is set.
    let made = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Motion", "width": 300, "height": 200,
                    "html": "<style>.a { transition: opacity 300ms } .b { animation: spin 300ms }</style><div class=\"a\">Hi</div><script>setTimeout(tick, 1500)</script>" }),
        )
        .await;
    let motion = id_after(&made, "Created artboard");
    let one = agent
        .ok(
            "replace_values",
            json!({ "designId": design, "within": motion, "find": "1500", "replace": "3000" }),
        )
        .await;
    assert!(one.contains("script: setTimeout(tick, 1500)"), "{one}");
    let (refused, is_error) = agent
        .call(
            "replace_values",
            json!({ "designId": design, "within": motion, "find": "300ms", "replace": "500ms" }),
        )
        .await;
    assert!(
        is_error && refused.contains("matches 2 times") && refused.contains("all: true"),
        "{refused}"
    );
    let dry = agent
        .ok(
            "replace_values",
            json!({ "designId": design, "within": motion, "find": "300ms", "replace": "500ms", "dryRun": true }),
        )
        .await;
    assert!(dry.starts_with("Would replace 2 uses"), "{dry}");
    let all = agent
        .ok(
            "replace_values",
            json!({ "designId": design, "within": motion, "find": "300ms", "replace": "500ms", "all": true }),
        )
        .await;
    assert!(all.starts_with("Replaced 2 uses"), "{all}");
}

/// get_layout says where things rendered and what overlaps, without an image;
/// get_screenshot with only a designId captures every artboard; passing the
/// designId as a node says so.
#[tokio::test]
async fn agents_find_where_things_rendered() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Layout").await;
    let created = agent.ok("create_design", json!({ "name": "Layout" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let made = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Frame", "width": 400, "height": 300, "class": "frame",
                    "html": "<div data-name=\"Title\" style=\"position: absolute; left: 10px; top: 10px\">Checkout</div><div data-name=\"Badge\" style=\"position: absolute; left: 30px; top: 12px\">Agent working</div><h3 data-name=\"Heading\" style=\"position: absolute; left: 0; right: 0; top: 100px; margin: 0\">Hi</h3>" }),
        )
        .await;
    let board = id_after(&made, "Created artboard");
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(html.contains("class=\"frame\""), "{html}");

    let (layout, is_error) = agent
        .call("get_layout", json!({ "designId": design, "nodeId": board }))
        .await;
    if layout.contains("no Chrome") {
        eprintln!("skipped: no browser");
        return;
    }
    assert!(!is_error, "{layout}");
    assert!(layout.contains("@ 0,0 400×300"), "{layout}");
    assert!(
        layout.contains("\"Title\"") && layout.contains("@ 10,10"),
        "{layout}"
    );
    assert!(
        layout.contains("1 pair of text elements overlap"),
        "{layout}"
    );

    let result = agent
        .rpc(
            "tools/call",
            Some(json!({ "name": "get_screenshot", "arguments": { "designId": design } })),
        )
        .await;
    let images = result["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["type"] == "image")
        .count();
    assert_eq!(images, 1, "{result}");

    let (refused, is_error) = agent
        .call(
            "get_layout",
            json!({ "designId": design, "nodeId": design }),
        )
        .await;
    assert!(is_error && refused.contains("is the designId"), "{refused}");
}

#[tokio::test]
async fn an_agent_imports_and_exports_a_file() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Importer").await;
    let created = agent
        .ok("create_design", json!({ "name": "Imports" }))
        .await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let page = "<div data-name=\"Card\"><button onclick=\"steal()\">Go</button></div>";

    let imported = agent
        .ok(
            "import_design",
            json!({ "designId": design, "format": "html", "content": page,
                    "fileName": "card.html" }),
        )
        .await;
    assert!(
        imported.contains("onclick at") && imported.contains("editable no"),
        "{imported}"
    );
    assert!(imported.contains("keeps the original"), "{imported}");
    let board = id_after(&imported, "Imported");
    let tree = agent
        .ok(
            "get_tree_summary",
            json!({ "designId": design, "nodeId": board }),
        )
        .await;
    assert!(tree.contains("Card"), "{tree}");

    let exported = agent
        .ok(
            "export_design",
            json!({ "designId": design, "format": "html", "artboardId": board }),
        )
        .await;
    assert!(exported.contains("data-name=\"Card\""), "{exported}");
    assert!(!exported.contains("steal()"), "{exported}");

    // Base64 works too, and strict mode refuses what isn't editable.
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(page);
    let (refused, is_error) = agent
        .call(
            "import_design",
            json!({ "designId": design, "format": "html", "contentBase64": encoded,
                    "strict": ["editable"] }),
        )
        .await;
    assert!(
        is_error && refused.contains("strict import refused"),
        "{refused}"
    );
    let (refused, is_error) = agent
        .call(
            "import_design",
            json!({ "designId": design, "format": "html", "content": page,
                    "contentBase64": encoded }),
        )
        .await;
    assert!(is_error && refused.contains("exactly one"), "{refused}");
    let (refused, is_error) = agent
        .call(
            "export_design",
            json!({ "designId": design, "format": "docx" }),
        )
        .await;
    assert!(is_error && refused.contains("no format"), "{refused}");
}

/// A real page links dozens of stylesheets and fonts, each quarantined. The
/// result says so in one line per kind, and the import record keeps them all.
#[tokio::test]
async fn a_big_pages_diagnostics_come_grouped() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Importer").await;
    let created = agent.ok("create_design", json!({ "name": "Big" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let links = "<link rel=\"stylesheet\" href=\"https://x/a.css\">".repeat(40);
    let page = format!(
        "<!doctype html><html><head>{links}</head><body><p>Hi</p><script>a()</script></body></html>"
    );
    let imported = agent
        .ok(
            "import_design",
            json!({ "designId": design, "format": "html", "content": page }),
        )
        .await;
    assert!(
        imported.contains("41 diagnostic(s) of 2 kind(s)")
            && imported.contains("- 40 × <link> at /0/0, /0/1, /0/2 and 37 more: ")
            && imported.contains("- <script> at /1/1: "),
        "{imported}"
    );
    assert!(
        imported.contains(&format!("GET /api/designs/{design}/imports")),
        "{imported}"
    );
    assert!(imported.len() < 1000, "{imported}");

    let req = Request::get(format!("/api/designs/{design}/imports"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let records: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(records[0]["quarantined"].as_array().unwrap().len(), 41);

    // The artboard grows to fit the page instead of cutting it off at 900px.
    let board = id_after(&imported, "Imported");
    let info = agent
        .ok(
            "get_node_info",
            json!({ "designId": design, "nodeId": board }),
        )
        .await;
    assert!(info.contains("\"height\": \"auto\""), "{info}");
}

/// A script that changes the page after 5 seconds is only seen in an image
/// when the agent asks for a later capture with settleMs.
#[tokio::test]
async fn agents_choose_when_the_screenshot_is_taken() {
    use base64::Engine;

    let app = test_app();
    let mut agent = Agent::connect(&app, "Timer").await;
    let created = agent.ok("create_design", json!({ "name": "Timer" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let made = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Late", "width": 40, "height": 40,
                    "html": "<div id=\"box\" style=\"width: 40px; height: 40px; background: #f00\"></div><script>setTimeout(() => { document.getElementById('box').style.background = '#00f'; }, 5000);</script>" }),
        )
        .await;
    let board = id_after(&made, "Created artboard");

    let result = agent
        .rpc(
            "tools/call",
            Some(json!({ "name": "get_screenshot",
                         "arguments": { "designId": design, "nodeId": board, "settleMs": 6000 } })),
        )
        .await;
    let content = result["content"].as_array().unwrap();
    let texts: Vec<&str> = content.iter().filter_map(|c| c["text"].as_str()).collect();
    if texts.iter().any(|t| t.contains("no Chrome")) {
        eprintln!("skipped the screenshot: no browser");
        return;
    }
    assert!(
        texts.iter().any(|t| t.contains("captured 6.0s after load")),
        "{texts:?}"
    );
    let data = content
        .iter()
        .find(|c| c["type"] == "image")
        .and_then(|c| c["data"].as_str())
        .expect("an image");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap();
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    let at = (20 * info.width as usize + 20) * info.color_type.samples();
    assert_eq!(&buf[at..at + 3], &[0, 0, 255], "the box turned blue");
}

#[tokio::test]
async fn agents_keep_components_on_their_own_page() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Kit" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let home = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 400, "height": 300 }),
        )
        .await;
    let home = id_after(&home, "Created artboard");

    let page = agent
        .ok(
            "create_page",
            json!({ "designId": design, "name": "Components" }),
        )
        .await;
    let page = page.split('"').nth(1).expect("a pageId").to_owned();
    let button = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Button", "width": 200, "height": 80,
                    "pageId": page }),
        )
        .await;
    // Placed on its own page, not beside Home.
    assert!(button.contains("at x 0, y 0"), "{button}");

    let info: Value = serde_json::from_str(
        &agent
            .ok("get_basic_info", json!({ "designId": design }))
            .await,
    )
    .unwrap();
    assert_eq!(
        info["pages"],
        json!([
            { "id": "page-1", "name": "Page 1", "artboardCount": 1 },
            { "id": page, "name": "Components", "artboardCount": 1 },
        ])
    );
    assert_eq!(info["artboards"][0]["pageId"], "page-1");

    let tree = agent
        .ok("get_tree_summary", json!({ "designId": design }))
        .await;
    assert!(
        tree.contains(&format!("Page \"Components\" (pageId {page})")),
        "{tree}"
    );

    agent
        .ok(
            "move_to_page",
            json!({ "designId": design, "artboardIds": [home], "pageId": page }),
        )
        .await;
    let deleted = agent
        .ok("delete_page", json!({ "designId": design, "pageId": page }))
        .await;
    assert_eq!(deleted, "Deleted the page and its 2 artboards.");
    let (refused, is_error) = agent
        .call(
            "delete_page",
            json!({ "designId": design, "pageId": "page-1" }),
        )
        .await;
    assert!(is_error && refused.contains("only page"), "{refused}");
    agent.ok("undo", json!({ "designId": design })).await;
    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    assert!(info.contains("\"artboardCount\": 2"), "{info}");
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
    agent
        .ok(
            "create_artboard",
            json!({ "designId": id, "name": "Home", "width": 390 }),
        )
        .await;
    let handle = hub.get(id).unwrap();
    let (_, _, mut viewer) = handle.subscribe();
    let (_, mut lobby) = hub.subscribe_lobby();
    let tools = agent.rpc("tools/list", None).await;
    let tool = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "delete_design")
        .unwrap();
    assert_eq!(tool["annotations"]["destructiveHint"], true);
    let deleted = agent.ok("delete_design", json!({ "designId": id })).await;
    assert_eq!(deleted, "Deleted the design permanently.");
    assert!(viewer.recv().await.is_err());
    let message: Value = serde_json::from_str(&lobby.recv().await.unwrap().json).unwrap();
    assert_eq!(message["type"], "designs");
    assert_eq!(message["total"], 1);
    assert_eq!(message["designs"][0]["id"], kept.meta.id);
    for tool in ["get_basic_info", "undo", "delete_design"] {
        let (text, error) = agent.call(tool, json!({ "designId": id })).await;
        assert!(error && text.contains("not found"), "{tool}: {text}");
    }
    let listed = agent.ok("list_designs", json!({})).await;
    assert!(!listed.contains(id));
    assert!(listed.contains(&kept.meta.id));
    hub.flush();
    let restored = finite_server::Hub::new(store).unwrap();
    assert!(restored.get(id).is_none());
    assert!(restored.get(&kept.meta.id).is_some());
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
            .call(
                "wait_for_comments",
                json!({ "designId": waiting_id, "timeoutSeconds": 3 }),
            )
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
async fn an_agent_gets_jsx_for_a_node() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Dev").await;
    let created = agent.ok("create_design", json!({ "name": "Code" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let hash = "a".repeat(64);
    let html = format!(
        "<div data-name=\"Card\" class=\"card\" style=\"display: flex; gap: 8px; background-color: #fff; color: red !important\"><label for=\"a\">Name</label><img src=\"/api/designs/{design}/assets/{hash}\"><script>go()</script></div>"
    );
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Card", "width": 390, "height": 400, "html": html }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let card = agent
        .ok(
            "get_children",
            json!({ "designId": design, "nodeId": board }),
        )
        .await;
    let card: Value = serde_json::from_str(&card).unwrap();
    let card = card[0]["id"].as_str().unwrap().to_owned();

    let jsx = agent
        .ok("get_jsx", json!({ "designId": design, "nodeId": card }))
        .await;
    assert!(
        jsx.contains("className=\"card\"")
            && jsx.contains("htmlFor=\"a\"")
            && jsx.contains("backgroundColor: \"#fff\"")
            && jsx.contains("gap: \"8px\""),
        "{jsx}"
    );
    assert!(jsx.contains("Left out <script>"), "{jsx}");
    assert!(jsx.contains("Left out !important on color"), "{jsx}");
    assert!(!jsx.contains("important\""), "{jsx}");
    // Stored images keep their server URLs, as in get_html, and the result says so.
    assert!(
        jsx.contains(&format!("/api/designs/{design}/assets/{hash}")),
        "{jsx}"
    );
    assert!(
        jsx.contains("1 image URL points at this server's stored files"),
        "{jsx}"
    );

    let tailwind = agent
        .ok(
            "get_jsx",
            json!({ "designId": design, "nodeId": card, "tailwind": true }),
        )
        .await;
    assert!(
        tailwind.contains("className=\"card ")
            && tailwind.contains(" flex ")
            && tailwind.contains("gap-[8px]")
            && tailwind.contains("[background-color:#fff]")
            && !tailwind.contains("style={{"),
        "{tailwind}"
    );

    let (error, failed) = agent
        .call(
            "get_jsx",
            json!({ "designId": design, "nodeId": "missing" }),
        )
        .await;
    assert!(failed && error.contains("not found"), "{error}");
}

/// A node too big for one result returns its outline, and JSX is a format
/// that only exports, so it fails clearly where the others work.
#[tokio::test]
async fn jsx_results_are_cut_and_the_format_only_exports() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Dev").await;
    let created = agent.ok("create_design", json!({ "name": "Big" })).await;
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
    agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board, "html": card.repeat(3_000) }),
        )
        .await;
    let jsx = agent
        .ok("get_jsx", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(jsx.len() < 60_000 + 200, "get_jsx said {} chars", jsx.len());
    assert!(
        jsx.contains("Call get_jsx on one of its children"),
        "{}",
        tail(&jsx)
    );

    // The whole design doesn't fit in one component file.
    let (error, failed) = agent
        .call(
            "export_design",
            json!({ "designId": design, "format": "jsx" }),
        )
        .await;
    assert!(failed && error.contains("pick one"), "{error}");
    let exported = agent
        .ok(
            "export_design",
            json!({ "designId": design, "format": "jsx", "artboardId": board }),
        )
        .await;
    assert!(exported.contains("grid.jsx"), "{}", tail(&exported));

    let (error, failed) = agent
        .call(
            "import_design",
            json!({ "designId": design, "format": "jsx", "content": "<div/>" }),
        )
        .await;
    assert!(failed && error.contains("can only be exported"), "{error}");
    // An unknown format lists jsx among the ones that exist.
    let (error, failed) = agent
        .call(
            "export_design",
            json!({ "designId": design, "format": "nope" }),
        )
        .await;
    assert!(
        failed && error.contains("html, finite, figma, jsx, repo"),
        "{error}"
    );
}

/// A person posts a note for people over HTTP, then turns it back into a
/// request for agents, and the classic tools follow.
#[tokio::test]
async fn people_choose_who_a_comment_is_for() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let created = agent.ok("create_design", json!({ "name": "Notes" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let send = |method: &str, path: String, body: Value| {
        let app = app.clone();
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        async move { app.oneshot(req).await.unwrap() }
    };
    let me = json!({ "id": "u1", "name": "Per" });
    let res = send(
        "POST",
        format!("/api/designs/{design}/comments"),
        json!({ "author": me, "body": "Ask the client", "x": 1, "y": 2,
                "audience": { "kind": "people" } }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::CREATED);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let comment: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(comment["audience"], json!({ "kind": "people" }));
    let id = comment["id"].as_str().unwrap();
    let wait = json!({ "designId": design, "timeoutSeconds": 1 });
    let none = agent.ok("wait_for_comments", wait.clone()).await;
    assert!(none.contains("No comments arrived"), "{none}");
    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    assert!(info.contains(r#""commentsWaitingForYou": 0"#), "{info}");

    let path = format!("/api/designs/{design}/comments/{id}");
    let res = send(
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
    let res = send("PATCH", path.clone(), json!({})).await;
    assert_eq!(
        res.status(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "nothing to change"
    );
    let res = send("PATCH", path, json!({ "audience": { "kind": "agents" } })).await;
    assert_eq!(res.status(), StatusCode::OK);
    let waited = agent.ok("wait_for_comments", wait).await;
    assert!(waited.contains("Ask the client"), "{waited}");
}
