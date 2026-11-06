//! Two agents and a person on one design: agent A rewrites a section from a
//! stale read while agent B restyles its button (issue #68) or adds to it
//! (issue #72).

mod agent;

use agent::{Agent, test_app};
use axum::{
    Router,
    body::Body,
    http::{Request, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// The `data-id` of the first `<tag` in `html`.
fn id_of(html: &str, tag: &str) -> String {
    let at = html.find(&format!("<{tag} ")).expect(tag);
    let rest = &html[at..];
    let start = rest.find("data-id=\"").unwrap() + 9;
    rest[start..start + rest[start..].find('"').unwrap()].to_owned()
}

async fn api(app: &Router, request: Request<Body>) -> Value {
    let res = app.clone().oneshot(request).await.unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

async fn read_html(agent: &mut Agent, design: &str, select: &str) -> String {
    agent
        .ok(
            "read",
            json!({ "designId": design, "select": select, "as": "html" }),
        )
        .await
}

#[tokio::test]
async fn a_stale_rewrite_keeps_ids_pins_and_other_agents_work() {
    let app = test_app();
    let mut a = Agent::connect(&app, "Alice").await;
    let mut b = Agent::connect(&app, "Bob").await;
    let design = a.design("Plan").await;
    let board = a.artboard(&design, "Page", 600, 400).await;
    a.edit(
        &design,
        json!([{ "op": "html", "select": format!("#{board}"),
                 "html": "<section data-name=\"Plan\"><h2>Pro</h2><button data-name=\"Buy\" style=\"color: white\">Buy</button></section>" }]),
    )
    .await;
    let html = read_html(&mut a, &design, &format!("#{board}")).await;
    let (section, button) = (id_of(&html, "section"), id_of(&html, "button"));

    // A person pins a comment on the button.
    let req = Request::post(format!("/api/designs/{design}/comments"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "author": { "id": "u1", "name": "Per" }, "body": "Say Upgrade",
                    "artboardId": board, "nodeId": button, "x": 10, "y": 10 })
            .to_string(),
        ))
        .unwrap();
    api(&app, req).await;

    // A reads the section, then B rounds the button.
    let read = read_html(&mut a, &design, &format!("#{section}")).await;
    assert!(read.contains("data-read-at=\""), "{read}");
    b.edit(
        &design,
        json!([{ "op": "css", "select": format!("#{button}"), "css": "border-radius: 999px" }]),
    )
    .await;

    // A writes its old copy back with only the text changed.
    let stale = read
        .split("\n\n")
        .next()
        .unwrap()
        .replace(">Buy<", ">Upgrade<");
    let wrote = a
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{section}"), "mode": "replace", "html": stale }]),
        )
        .await;
    assert!(wrote.contains("in place"), "{wrote}");
    assert!(
        wrote.contains(&format!(
            "kept border-radius: 999px on button \"Buy\" #{button}"
        )),
        "{wrote}"
    );

    let after = read_html(&mut a, &design, &format!("#{section}")).await;
    assert_eq!(id_of(&after, "button"), button, "{after}");
    assert!(after.contains("border-radius: 999px"), "{after}");
    assert!(after.contains(">Upgrade<"), "{after}");

    let req = Request::get(format!("/api/designs/{design}"))
        .body(Body::empty())
        .unwrap();
    let snapshot = api(&app, req).await;
    assert_eq!(snapshot["comments"][0]["nodeId"], button.as_str());

    // B undoes its own edit, and A's rewrite stays.
    b.ok("undo", json!({ "designId": design })).await;
    let after = read_html(&mut a, &design, &format!("#{section}")).await;
    assert!(!after.contains("border-radius"), "{after}");
    assert!(after.contains(">Upgrade<"), "{after}");
}

#[tokio::test]
async fn a_stale_rewrite_keeps_an_element_another_agent_added() {
    let app = test_app();
    let mut a = Agent::connect(&app, "Alice").await;
    let mut b = Agent::connect(&app, "Bob").await;
    let design = a.design("Plans").await;
    let board = a.artboard(&design, "Page", 600, 400).await;
    a.edit(
        &design,
        json!([{ "op": "html", "select": format!("#{board}"),
                 "html": "<ul data-name=\"Plans\"><li>Free</li><li>Pro</li></ul>" }]),
    )
    .await;
    let list = id_of(
        &read_html(&mut a, &design, &format!("#{board}")).await,
        "ul",
    );

    // A reads the list, then B adds a plan.
    let read = read_html(&mut a, &design, &format!("#{list}")).await;
    let added = b
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{list}"), "html": "<li>Enterprise</li>" }]),
        )
        .await;
    // "li #<id> "Enterprise"" in its outline.
    let enterprise = added
        .split("li #")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap()
        .to_owned();

    // A writes its old copy back with one text change.
    let stale = read
        .split("\n\n")
        .next()
        .unwrap()
        .replace(">Pro<", ">Pro+<");
    let wrote = a
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{list}"), "mode": "replace", "html": stale }]),
        )
        .await;
    let after = read_html(&mut a, &design, &format!("#{list}")).await;
    assert!(after.contains(">Pro+<"), "{after}");
    assert!(
        after.contains(&format!("data-id=\"{enterprise}\">Enterprise<")),
        "{after}"
    );
    assert!(
        wrote.contains(&format!(
            "kept li #{enterprise} \"Enterprise\", which another agent added after you read it."
        )),
        "{wrote}"
    );

    b.ok("undo", json!({ "designId": design })).await;
    let after = read_html(&mut a, &design, &format!("#{list}")).await;
    assert!(!after.contains("Enterprise"), "{after}");
    assert!(after.contains(">Pro+<"), "{after}");
}
