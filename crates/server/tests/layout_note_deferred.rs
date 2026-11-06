//! What happens to a layout note that isn't ready when its edit answers.
//! `FINITE_LAYOUT_WAIT_MS=0` makes every note come that way, so each case
//! knows a note is waiting before it acts. The first case is the control:
//! the same steps with a plain read show the note really was waiting, so the
//! cases that expect none aren't passing for lack of one.

mod agent;
mod layout_common;

use agent::{Agent, test_app};
use layout_common::{Board, board, clip, read, set_wait};
use serde_json::json;
use std::time::Duration;

/// Clips the artboard and waits out the check. The edit's own result has no
/// note, so the note is waiting for the next one.
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
    set_wait(0);
    let app = test_app();
    let mut agent = Agent::connect(&app, "Checker").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };
    let on_board = format!("#{}", b.board);
    let on_title = format!("#{}", b.title);

    // Control: the next result carries the note, once.
    clipped_and_checked(&mut agent, &b).await;
    let text = read(&mut agent, &b).await;
    assert!(text.contains("cut off by the artboard's edge"), "{text}");
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // render reports the layout itself, so it drops the note.
    for args in [
        json!({ "designId": b.design, "select": on_board, "output": "layout" }),
        json!({ "designId": b.design, "select": on_board }),
    ] {
        clipped_and_checked(&mut agent, &b).await;
        agent.ok("render", args.clone()).await;
        let after = read(&mut agent, &b).await;
        assert!(
            !after.contains("Layout:"),
            "render {args} left a stale note: {after}"
        );
    }

    // Any other edit makes it stale.
    let edits = [
        json!({ "op": "replace", "find": "Fits", "replace": "Still fits", "in": "text" }),
        json!({ "op": "tokens", "set": { "--x": "red" } }),
        json!({ "op": "replace", "find": "Still fits", "replace": "Fits", "in": "text" }),
        json!({ "op": "attrs", "select": on_title, "set": { "title": "t" } }),
        json!({ "op": "move", "select": on_title, "to": on_board, "position": "prepend" }),
    ];
    for op in edits {
        clipped_and_checked(&mut agent, &b).await;
        let (result, failed) = agent
            .call(
                "edit",
                json!({ "designId": b.design, "ops": [op], "check": false }),
            )
            .await;
        assert!(!failed, "{op}: {result}");
        let after = read(&mut agent, &b).await;
        assert!(
            !after.contains("Layout:"),
            "{op} left a stale note: {after}"
        );
    }
    let (undone, failed) = agent.call("undo", json!({ "designId": b.design })).await;
    assert!(!failed, "{undone}");
    assert!(!read(&mut agent, &b).await.contains("Layout:"));

    // A call that fails changes nothing, so it doesn't spend the note.
    clipped_and_checked(&mut agent, &b).await;
    let (error, failed) = agent
        .call(
            "edit",
            json!({ "designId": b.design, "op": "css", "select": "#nosuchnode",
                    "css": "color: red", "check": false }),
        )
        .await;
    assert!(failed, "{error}");
    let (error, failed) = agent
        .call(
            "read",
            json!({ "designId": b.design, "select": "#nosuchnode" }),
        )
        .await;
    assert!(failed, "{error}");
    let kept = read(&mut agent, &b).await;
    assert!(kept.contains("cut off by the artboard's edge"), "{kept}");
}
