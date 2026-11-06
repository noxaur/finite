//! A note waiting on an artboard must not ride on the result of the edit that
//! fixes it. A layout wait of 0 leaves the note waiting when the fix arrives.

use super::{
    agent::{Agent, id_after},
    common::{board, clip, waiting_app},
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn an_edit_that_fixes_the_problem_does_not_return_the_note_about_it() {
    let app = waiting_app(0);
    let mut agent = Agent::connect(&app, "Fixer").await;
    let Some(b) = board(&mut agent).await else {
        return;
    };
    let written = clip(&mut agent, &b, 600).await;
    let tall = id_after(&written, "\"Tall\"");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let fixed = agent
        .ok(
            "edit",
            json!({ "designId": b.design, "op": "css", "select": format!("#{tall}"),
                    "css": "height: 20px" }),
        )
        .await;
    assert!(
        !fixed.contains("cut off by the artboard's edge"),
        "the fixing edit returned the note about what it fixed: {fixed}"
    );
}
