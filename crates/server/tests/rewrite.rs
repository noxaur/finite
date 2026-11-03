//! Two agents and a person on one design: agent A rewrites a section from a
//! stale read while agent B restyles its button (issue #68) or adds to it
//! (issue #72).

mod agent;

use agent::{Agent, id_after, test_app};
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

#[tokio::test]
async fn a_stale_rewrite_keeps_ids_pins_and_other_agents_work() {
    let app = test_app();
    let mut a = Agent::connect(&app, "Alice").await;
    let mut b = Agent::connect(&app, "Bob").await;
    let created = a.ok("create_design", json!({ "name": "Plan" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let board = a
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Page", "width": 600, "height": 400 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    a.ok(
        "write_html",
        json!({ "designId": design, "targetId": board,
                "html": "<section data-name=\"Plan\"><h2>Pro</h2><button data-name=\"Buy\" style=\"color: white\">Buy</button></section>" }),
    )
    .await;
    let html = a
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
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
    let read = a
        .ok("get_html", json!({ "designId": design, "nodeId": section }))
        .await;
    assert!(read.contains("data-read-at=\""), "{read}");
    b.ok(
        "update_styles",
        json!({ "designId": design,
                "updates": [{ "nodeIds": [button], "styles": { "border-radius": "999px" } }] }),
    )
    .await;

    // A writes its old copy back with only the text changed.
    let stale = read
        .split("\n\n")
        .next()
        .unwrap()
        .replace(">Buy<", ">Upgrade<");
    let wrote = a
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": section, "mode": "replace", "html": stale }),
        )
        .await;
    assert!(wrote.contains("in place"), "{wrote}");
    assert!(
        wrote.contains(&format!(
            "kept border-radius: 999px on button \"Buy\" #{button}"
        )),
        "{wrote}"
    );

    let after = a
        .ok("get_html", json!({ "designId": design, "nodeId": section }))
        .await;
    assert_eq!(id_of(&after, "button"), button, "{after}");
    assert!(after.contains("border-radius: 999px"), "{after}");
    assert!(after.contains(">Upgrade<"), "{after}");

    let req = Request::get(format!("/api/designs/{design}"))
        .body(Body::empty())
        .unwrap();
    let snapshot = api(&app, req).await;
    assert_eq!(snapshot["comments"][0]["nodeId"], button.as_str());

    let undone = b.ok("undo", json!({ "designId": design })).await;
    assert!(undone.contains("Update styles"), "{undone}");
    let after = a
        .ok("get_html", json!({ "designId": design, "nodeId": section }))
        .await;
    assert!(!after.contains("border-radius"), "{after}");
    assert!(after.contains(">Upgrade<"), "{after}");
}

#[tokio::test]
async fn a_stale_rewrite_keeps_an_element_another_agent_added() {
    let app = test_app();
    let mut a = Agent::connect(&app, "Alice").await;
    let mut b = Agent::connect(&app, "Bob").await;
    let created = a.ok("create_design", json!({ "name": "Plans" })).await;
    let design: String = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .unwrap()
        .to_owned();
    let board = a
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Page", "width": 600, "height": 400 }),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    a.ok(
        "write_html",
        json!({ "designId": design, "targetId": board,
                "html": "<ul data-name=\"Plans\"><li>Free</li><li>Pro</li></ul>" }),
    )
    .await;
    let list = a
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    let list = id_of(&list, "ul");

    // A reads the list, then B adds a plan.
    let read = a
        .ok("get_html", json!({ "designId": design, "nodeId": list }))
        .await;
    let added = b
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": list, "html": "<li>Enterprise</li>" }),
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
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": list, "mode": "replace", "html": stale }),
        )
        .await;
    let after = a
        .ok("get_html", json!({ "designId": design, "nodeId": list }))
        .await;
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

    let undone = b.ok("undo", json!({ "designId": design })).await;
    assert!(undone.contains("Write HTML"), "{undone}");
    let after = a
        .ok("get_html", json!({ "designId": design, "nodeId": list }))
        .await;
    assert!(!after.contains("Enterprise"), "{after}");
    assert!(after.contains(">Pro+<"), "{after}");
}
