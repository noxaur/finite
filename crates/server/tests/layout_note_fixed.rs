//! A note waiting on an artboard must not ride on the result of the edit that
//! fixes it. `FINITE_LAYOUT_WAIT_MS=0` leaves the note waiting when the fix
//! arrives. Its own process, since the environment is read once.

mod agent;
mod layout_common;

use agent::{Agent, id_after, test_app};
use layout_common::{board, clip, set_wait};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn an_edit_that_fixes_the_problem_does_not_return_the_note_about_it() {
    set_wait(0);
    let app = test_app();
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
