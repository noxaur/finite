//! The layout note on `write_html` and `update_styles` results, which
//! `FINITE_MCP_EXTRA=layout` turns on.

mod agent;

use agent::{Agent, id_after, test_app};
use serde_json::json;
use std::time::{Duration, Instant};

/// Whether the note for an edit arrives: on its own result if the check is
/// quick, else on the agent's next one. Polls `get_comments`, which any tool
/// but the layout ones would do for, since the check runs after the edit.
async fn note_after(agent: &mut Agent, design: &str, edit: &str) -> Option<String> {
    if edit.contains("Layout:") {
        return Some(edit.to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let text = agent
            .ok("get_comments", json!({ "designId": design }))
            .await;
        if text.contains("Layout:") {
            return Some(text);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    None
}

#[tokio::test]
async fn an_edit_that_clips_content_gets_a_note_on_the_next_result() {
    // Read once, when the first tool runs, so set it before any call.
    // SAFETY: this test binary has one test, so nothing else reads the environment.
    unsafe { std::env::set_var("FINITE_MCP_EXTRA", "layout") };
    let app = test_app();
    let mut agent = Agent::connect(&app, "Checker").await;
    let created = agent.ok("create_design", json!({ "name": "Notes" })).await;
    let design = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let made = agent
        .ok(
            "create_artboard",
            json!({ "designId": design, "name": "Card", "width": 300, "height": 200,
                    "html": "<div data-name=\"Title\">Fits</div>" }),
        )
        .await;
    let board = id_after(&made, "Created artboard");

    let written = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board,
                    "html": "<div data-name=\"Tall\" style=\"height: 600px; flex-shrink: 0\">Too tall</div>" }),
        )
        .await;
    let Some(text) = note_after(&mut agent, &design, &written).await else {
        // Without a browser there is nothing to measure.
        eprintln!("skipped: no browser");
        return;
    };
    assert!(text.contains("cut off by the artboard's edge"), "{text}");
    assert!(text.contains("\"Tall\""), "{text}");
    assert!(text.contains("\"height\": \"618px\""), "{text}");
    // A note is spent once the agent has it.
    let again = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    assert!(!again.contains("Layout:"), "{again}");

    // With the browser warm, a clipping edit usually carries its own note.
    // Either way, the note comes by the next result.
    let second = agent
        .ok(
            "write_html",
            json!({ "designId": design, "targetId": board,
                    "html": "<div style=\"height: 900px; flex-shrink: 0\">Taller</div>" }),
        )
        .await;
    assert!(second.contains("Wrote 1 root node"), "{second}");
    let text = note_after(&mut agent, &design, &second)
        .await
        .expect("a note");
    assert!(text.contains("cut off"), "{text}");
    let spent = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    assert!(!spent.contains("Layout:"), "{spent}");

    // Fixing the overflow with update_styles leaves nothing to report.
    let fixed = agent
        .ok(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": [board], "styles": { "height": "2000px" } }] }),
        )
        .await;
    assert!(!fixed.contains("Layout:"), "{fixed}");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let clean = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    assert!(!clean.contains("Layout:"), "{clean}");

    // update_styles that clips again gets a note too, and get_layout drops it.
    let clipped = agent
        .ok(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": [board], "styles": { "height": "100px" } }] }),
        )
        .await;
    assert!(note_after(&mut agent, &design, &clipped).await.is_some());
    agent
        .ok(
            "update_styles",
            json!({ "designId": design,
                    "updates": [{ "nodeIds": [board], "styles": { "height": "90px" } }] }),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let layout = agent
        .ok("get_layout", json!({ "designId": design, "nodeId": board }))
        .await;
    assert!(layout.contains("Layout:"), "{layout}");
    let after = agent
        .ok("get_comments", json!({ "designId": design }))
        .await;
    assert!(!after.contains("Layout:"), "{after}");
}
