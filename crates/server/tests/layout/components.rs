//! The layout note measures an artboard as people see it, with its
//! instances expanded, and an edit that lands on an instance as an override
//! still gets one.

use super::{
    agent::Agent,
    common::{board, note_after, waiting_app},
};
use serde_json::json;

#[tokio::test]
async fn an_edit_redirected_to_an_instance_gets_a_note_about_what_it_shows() {
    let app = waiting_app(15_000);
    let mut agent = Agent::connect(&app, "Instancer").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };
    let on_board = format!("#{}", b.board);
    let bar = r#"<div data-component="Bar" data-name="Bar" style="height: 20px; flex-shrink: 0">Bar</div>"#;
    for _ in 0..2 {
        let written = agent
            .ok(
                "edit",
                json!({ "designId": b.design, "op": "html", "select": on_board, "html": bar }),
            )
            .await;
        assert!(!written.contains("cut off by"), "{written}");
    }
    let tree = agent
        .ok(
            "read",
            json!({ "designId": b.design, "select": on_board, "as": "html" }),
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
            "edit",
            json!({ "designId": b.design, "op": "css", "select": format!("#{instance}"),
                    "css": "height: 600px" }),
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
