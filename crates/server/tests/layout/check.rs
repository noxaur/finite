//! The layout check on an edit result, with a wait that fits a loaded
//! machine. A clean check and the overlap note are only said if the edit
//! waited for them, so the test must outwait the Chrome measurements that
//! queue behind one another.

use std::time::Duration;

use super::{
    agent::{Agent, id_after},
    common::waiting_app,
};
use finite_server::testing::require_browser;
use serde_json::{Value, json};

/// A new design's id.
async fn design(agent: &mut Agent, name: &str) -> String {
    let created = agent.ok("designs", json!({ "create": name })).await;
    created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned()
}

/// Runs `ops` as one edit without the layout check.
async fn edit(agent: &mut Agent, design: &str, ops: Value) -> String {
    agent
        .ok(
            "edit",
            json!({ "designId": design, "ops": ops, "check": false }),
        )
        .await
}

/// A design with one artboard holding a title and two cards, and the ids.
async fn landing(agent: &mut Agent) -> (String, String) {
    let id = design(agent, "Landing").await;
    let made = edit(
        agent,
        &id,
        json!([{ "op": "artboard", "name": "Home", "width": 600, "height": 400,
                 "html": "<h1 data-name=\"Title\" style=\"color: #3b82f6\">Hello</h1>\
                          <div class=\"card\" data-name=\"One\"><p>First</p></div>\
                          <div class=\"card\" data-name=\"Two\"><p>Second</p></div>" }]),
    )
    .await;
    (id, id_after(&made, "Created artboard"))
}

#[tokio::test]
async fn render_and_the_layout_check_after_an_edit() {
    // Longer than a measurement may take (8 seconds), so a slow Chrome start
    // cannot outlast the wait.
    let app = waiting_app(15_000);
    let mut agent = Agent::connect(&app, "Checker").await;
    let (id, board) = landing(&mut agent).await;
    let (probe, _) = agent
        .call("render", json!({ "designId": id, "output": "layout" }))
        .await;
    if !require_browser(&probe) {
        return;
    }
    assert!(
        probe.contains("Layout:") && probe.contains(&board),
        "{probe}"
    );
    // A clean check says so, so agents needn't render to find out.
    let clean = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "css", "select": "h1", "css": "letter-spacing: 1px" }),
        )
        .await;
    assert!(clean.contains("Layout: nothing is cut off"), "{clean}");
    // It checks overlapping text, as render's layout output does.
    let overlap = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "html", "select": format!("#{board}"),
                    "html": "<div data-name=\"Badge\" style=\"position: absolute; top: 30px; left: 0; font-size: 32px\">New Hello</div>" }),
        )
        .await;
    assert!(
        overlap.contains("pair of text elements overlap"),
        "{overlap}"
    );
    agent.ok("undo", json!({ "designId": id })).await;
    let tall = "<div data-name=\"Tall\" style=\"height: 900px; flex-shrink: 0\"></div>";
    // check: false leaves the check out.
    let unchecked = edit(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": format!("#{board}"), "html": tall }]),
    )
    .await;
    assert!(!unchecked.contains("Layout:"), "{unchecked}");
    agent.ok("undo", json!({ "designId": id })).await;
    // By default the edit waits for the check, as the layout note does.
    let mut checked = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "html", "select": format!("#{board}"), "html": tall }),
        )
        .await;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !checked.contains("Layout:") && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        checked = agent.ok("comments", json!({ "designId": id })).await;
    }
    assert!(
        checked.contains("cut off by the artboard's edge") && checked.contains("\"Tall\""),
        "{checked}"
    );
    assert!(
        checked.contains(&format!(
            "{{\"op\": \"css\", \"css\": \"#{board} {{ height:"
        )),
        "the fix is a css op: {checked}"
    );
    assert!(!checked.contains("update_styles"), "{checked}");
    let (shot, error) = agent
        .call("render", json!({ "designId": id, "select": "h1" }))
        .await;
    assert!(!error, "{shot}");
}
