//! The layout note measures an artboard as people see it, with its
//! instances expanded, and an edit that lands on an instance as an override
//! still gets one. Its own process, since the environment is read once.

mod agent;
mod layout_common;

use agent::{Agent, test_app};
use layout_common::{board, enable_group, note_after};
use serde_json::json;

#[tokio::test]
async fn an_edit_redirected_to_an_instance_gets_a_note_about_what_it_shows() {
    enable_group(None);
    let app = test_app();
    let mut agent = Agent::connect(&app, "Instancer").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };
    let bar = r#"<div data-component="Bar" data-name="Bar" style="height: 20px; flex-shrink: 0">Bar</div>"#;
    for _ in 0..2 {
        let written = agent
            .ok(
                "write_html",
                json!({ "designId": b.design, "targetId": b.board, "html": bar }),
            )
            .await;
        assert!(!written.contains("Layout:"), "{written}");
    }
    let tree = agent
        .ok(
            "get_html",
            json!({ "designId": b.design, "nodeId": b.board }),
        )
        .await;
    let instance = {
        let at = tree.find("data-instance-of").expect("an instance");
        let id = tree[..at].rfind("data-id=\"").unwrap() + "data-id=\"".len();
        tree[id..id + tree[id..].find('"').unwrap()].to_owned()
    };

    // Its height is set on the instance, so the edit becomes an override.
    let edited = agent
        .ok(
            "update_styles",
            json!({ "designId": b.design,
                    "updates": [{ "nodeIds": [instance], "styles": { "height": "600px" } }] }),
        )
        .await;
    assert!(
        edited.contains(&format!("Only instance #{instance}")),
        "{edited}"
    );
    let note = note_after(&mut agent, &b, &edited).await.expect("a note");
    assert!(
        note.contains("cut off by the artboard's edge") && note.contains("\"Bar\""),
        "{note}"
    );
}
