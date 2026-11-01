//! The shared-styles tools, which ship behind `FINITE_MCP_EXTRA`. The server
//! reads it once per process, so this file is its own test binary.

mod agent;

use agent::{Agent, id_after, test_app};
use serde_json::json;

#[tokio::test]
async fn an_agent_shares_css_across_artboards_and_undoes_it() {
    // SAFETY: this binary's only test sets it before the server reads it.
    unsafe { std::env::set_var("FINITE_MCP_EXTRA", "shared-styles") };
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;

    let created = agent.ok("create_design", json!({ "name": "Flow" })).await;
    let design = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let board = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Home", "width": 390, "height": 844,
                    "html": "<button class=\"btn\">Go</button>" }),
        )
        .await;
    let board = id_after(&board, "Created artboard");

    let css = ":root { --brand: #f97316; } .btn { background: var(--brand); }";
    let saved = agent
        .ok("set_shared_css", json!({ "designId": design, "css": css }))
        .await;
    assert!(saved.contains("Saved the shared CSS (2 rules)"), "{saved}");
    let info = agent
        .ok("get_basic_info", json!({ "designId": design }))
        .await;
    assert!(
        info.contains(&format!("\"sharedCssChars\": {}", css.len())),
        "{info}"
    );
    assert_eq!(
        agent
            .ok("get_shared_css", json!({ "designId": design }))
            .await,
        css
    );
    // get_html says the artboard depends on CSS it leaves out.
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(html.contains("class=\"btn\""), "{html}");
    assert!(html.contains("shared CSS"), "{html}");

    let (error, failed) = agent
        .call(
            "set_shared_css",
            json!({ "designId": design, "css": "</style><script>alert(1)</script>" }),
        )
        .await;
    assert!(failed && error.contains("without <style> tags"), "{error}");

    // It's an edit like any other, so undo takes it back.
    let undone = agent.ok("undo", json!({ "designId": design })).await;
    assert_eq!(undone, "Undid: Set shared CSS");
    assert_eq!(
        agent
            .ok("get_shared_css", json!({ "designId": design }))
            .await,
        "This design has no shared CSS."
    );
    let html = agent
        .ok("get_html", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(!html.contains("shared CSS"), "{html}");
}
