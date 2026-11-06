//! The layout note on `edit` results. An edit waits for its check, so with a
//! warm browser the note is on the edit's own result.

use super::{
    agent::Agent,
    common::{board, clip, edit, note_after, read, waiting_app},
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn an_edit_that_clips_content_gets_a_note() {
    let app = waiting_app(15_000);
    let mut agent = Agent::connect(&app, "Checker").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };
    let on_board = format!("#{}", b.board);

    // The probe warmed the browser, so the check beats the edit's wait.
    let written = clip(&mut agent, &b, 600).await;
    assert!(written.contains("Wrote 1 root node"), "{written}");
    assert!(
        written.contains("cut off by the artboard's edge") && written.contains("\"Tall\""),
        "the note should be on the edit's own result: {written}"
    );
    assert!(written.contains("height: 618px"), "{written}");
    // Having been given it, the agent isn't told again.
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // Fixing the overflow leaves nothing to report.
    let fixed = agent
        .ok(
            "edit",
            json!({ "designId": b.design, "op": "css", "select": on_board,
                    "css": "height: 2000px" }),
        )
        .await;
    assert!(!fixed.contains("cut off by the artboard's edge"), "{fixed}");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // An edit that clips again gets a note too.
    let clipped = agent
        .ok(
            "edit",
            json!({ "designId": b.design, "op": "css", "select": on_board,
                    "css": "height: 100px" }),
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
        let made = edit(
            &mut agent,
            &b.design,
            json!([{ "op": "artboard", "name": format!("Extra {n}"), "width": 300, "height": 200 }]),
        )
        .await;
        ids.push(super::agent::id_after(&made, "Created artboard"));
    }
    let select: Vec<String> = ids.iter().map(|id| format!("#{id}")).collect();
    let wide = agent
        .ok(
            "edit",
            json!({ "designId": b.design, "op": "css", "select": select,
                    "css": "background: #eee" }),
        )
        .await;
    assert!(
        wide.contains("touched 4 artboards and only the first 3 were checked"),
        "{wide}"
    );
}
