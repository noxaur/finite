//! What happens to a layout note that isn't ready when its edit answers.
//! `FINITE_LAYOUT_WAIT_MS=0` makes every note come that way, so each case
//! knows a note is waiting before it acts. The first case is the control:
//! the same steps with a plain read show the note really was waiting, so the
//! cases that expect none aren't passing for lack of one.

mod agent;
mod layout_common;

use agent::{Agent, test_app};
use layout_common::{Board, board, clip, enable_group, read};
use serde_json::json;
use std::time::Duration;

/// Clips the artboard, waits out the check, and says whether it is waiting.
/// It is waiting if the edit's own result has no note and a plain read finds
/// one, so this takes the note: use it only to set up the control.
async fn clipped_and_checked(agent: &mut Agent, b: &Board) {
    let written = clip(agent, b, 600).await;
    assert!(
        !written.contains("Layout:"),
        "waited despite wait 0: {written}"
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
}

#[tokio::test]
async fn a_deferred_note_is_given_once_and_dropped_when_it_goes_stale() {
    enable_group(Some(0));
    let app = test_app();
    let mut agent = Agent::connect(&app, "Checker").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };

    // Control: the next result carries the note, once.
    clipped_and_checked(&mut agent, &b).await;
    let text = read(&mut agent, &b).await;
    assert!(text.contains("cut off by the artboard's edge"), "{text}");
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // The layout tools report the layout themselves, so they drop it.
    for tool in ["get_layout", "get_screenshot"] {
        clipped_and_checked(&mut agent, &b).await;
        let args = if tool == "get_layout" {
            json!({ "designId": b.design, "nodeId": b.board })
        } else {
            json!({ "designId": b.design, "nodeIds": [b.board] })
        };
        agent.ok(tool, args).await;
        let after = read(&mut agent, &b).await;
        assert!(
            !after.contains("Layout:"),
            "{tool} left a stale note: {after}"
        );
    }

    // Any other edit makes it stale.
    let edits = [
        (
            "set_text_content",
            json!({ "designId": b.design, "nodeId": b.title, "text": "Still fits" }),
        ),
        (
            "set_tokens",
            json!({ "designId": b.design, "tokens": { "--x": "red" } }),
        ),
        (
            "replace_values",
            json!({ "designId": b.design, "find": "Still fits", "replace": "Fits" }),
        ),
        (
            "set_attributes",
            json!({ "designId": b.design,
                    "updates": [{ "nodeIds": [b.title], "attributes": { "title": "t" } }] }),
        ),
        (
            "move_nodes",
            json!({ "designId": b.design, "nodeIds": [b.title], "parentId": b.board, "index": 0 }),
        ),
    ];
    for (tool, args) in edits {
        clipped_and_checked(&mut agent, &b).await;
        let (result, failed) = agent.call(tool, args).await;
        assert!(!failed, "{tool}: {result}");
        let after = read(&mut agent, &b).await;
        assert!(
            !after.contains("Layout:"),
            "{tool} left a stale note: {after}"
        );
    }
    let (undone, failed) = agent.call("undo", json!({ "designId": b.design })).await;
    assert!(!failed, "{undone}");
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // A call that fails changes nothing, so it doesn't spend the note.
    clipped_and_checked(&mut agent, &b).await;
    let (error, failed) = agent
        .call(
            "update_styles",
            json!({ "designId": b.design,
                    "updates": [{ "nodeIds": ["nosuchnode"], "styles": { "color": "red" } }] }),
        )
        .await;
    assert!(failed, "{error}");
    let (error, failed) = agent
        .call(
            "get_html",
            json!({ "designId": b.design, "nodeId": "nosuchnode" }),
        )
        .await;
    assert!(failed, "{error}");
    let kept = read(&mut agent, &b).await;
    assert!(kept.contains("cut off by the artboard's edge"), "{kept}");
}
