//! The layout note on `write_html` and `update_styles` results, which
//! `FINITE_MCP_EXTRA=layout` turns on. An edit waits a second for its check,
//! so with a warm browser the note is on the edit's own result.

mod agent;
mod layout_common;

use agent::{Agent, test_app};
use layout_common::{board, clip, enable_group, note_after, read};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn an_edit_that_clips_content_gets_a_note() {
    enable_group(None);
    let app = test_app();
    let mut agent = Agent::connect(&app, "Checker").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };

    // The probe warmed the browser, so the check beats the edit's wait.
    let written = clip(&mut agent, &b, 600).await;
    assert!(written.contains("Wrote 1 root node"), "{written}");
    assert!(
        written.contains("cut off by the artboard's edge") && written.contains("\"Tall\""),
        "the note should be on the edit's own result: {written}"
    );
    assert!(written.contains("\"height\": \"618px\""), "{written}");
    // Having been given it, the agent isn't told again.
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // Fixing the overflow leaves nothing to report.
    let fixed = agent
        .ok(
            "update_styles",
            json!({ "designId": b.design,
                    "updates": [{ "nodeIds": [b.board], "styles": { "height": "2000px" } }] }),
        )
        .await;
    assert!(!fixed.contains("Layout:"), "{fixed}");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // update_styles that clips again gets a note too.
    let clipped = agent
        .ok(
            "update_styles",
            json!({ "designId": b.design,
                    "updates": [{ "nodeIds": [b.board], "styles": { "height": "100px" } }] }),
        )
        .await;
    // The content is 618 px tall in a 100 px artboard.
    let text = note_after(&mut agent, &b, &clipped).await.expect("a note");
    assert!(
        text.contains("It is 618 px tall, but the artboard is 100 px"),
        "{text}"
    );

    // An edit across more artboards than it checks says so, in its own result.
    let mut ids = vec![b.board.clone()];
    for n in 0..3 {
        let made = agent
            .ok(
                "create_artboard",
                json!({ "designId": b.design, "name": format!("Extra {n}"), "width": 300, "height": 200 }),
            )
            .await;
        ids.push(agent::id_after(&made, "Created artboard"));
    }
    let wide = agent
        .ok(
            "update_styles",
            json!({ "designId": b.design,
                    "updates": [{ "nodeIds": ids, "styles": { "background": "#eee" } }] }),
        )
        .await;
    assert!(
        wide.contains("touched 4 artboards and only the first 3 were checked"),
        "{wide}"
    );
}
