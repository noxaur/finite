//! Shared by the layout note tests, which each run in their own process
//! because `FINITE_LAYOUT_WAIT_MS` is read once.

#![allow(dead_code, reason = "each test binary uses some of these")]

use super::agent::{Agent, id_after};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// A design with one 300 × 200 artboard holding a "Title", and the ids.
pub struct Board {
    pub design: String,
    pub board: String,
    pub title: String,
}

/// Sets how long an edit waits for its layout check, in milliseconds. Call
/// before anything else.
pub fn set_wait(ms: u64) {
    // SAFETY: each test binary has one test, and this runs first, so no other
    // thread reads the environment yet.
    unsafe { std::env::set_var("FINITE_LAYOUT_WAIT_MS", ms.to_string()) };
}

/// Runs `ops` as one edit without the layout check.
pub async fn edit(agent: &mut Agent, design: &str, ops: Value) -> String {
    agent
        .ok(
            "edit",
            json!({ "designId": design, "ops": ops, "check": false }),
        )
        .await
}

/// Sets up the design, or says why the test can't run. Without a browser
/// there is nothing to measure: that is announced on stderr and the test
/// passes, unless `FINITE_REQUIRE_BROWSER` is set, as CI can, to fail instead.
pub async fn board(agent: &mut Agent) -> Option<Board> {
    let created = agent.ok("designs", json!({ "create": "Notes" })).await;
    let design = created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned();
    let made = edit(
        agent,
        &design,
        json!([{ "op": "artboard", "name": "Card", "width": 300, "height": 200,
                 "html": "<div data-name=\"Title\">Fits</div>" }]),
    )
    .await;
    let board = id_after(&made, "Created artboard");
    let title = id_after(&made, "\"Title\"");
    let (probe, _) = agent
        .call(
            "render",
            json!({ "designId": design, "select": format!("#{board}"), "output": "layout" }),
        )
        .await;
    if probe.contains("no Chrome") {
        assert!(
            std::env::var_os("FINITE_REQUIRE_BROWSER").is_none(),
            "FINITE_REQUIRE_BROWSER is set but there is no browser: {probe}"
        );
        eprintln!(
            "SKIPPED, NOTHING WAS TESTED: no Chrome, Chromium or Edge found (set FINITE_CHROME)"
        );
        return None;
    }
    Some(Board {
        design,
        board,
        title,
    })
}

/// Appends a block taller than the artboard, with the layout check on.
pub async fn clip(agent: &mut Agent, b: &Board, px: u32) -> String {
    agent
        .ok(
            "edit",
            json!({ "designId": b.design, "op": "html", "select": format!("#{}", b.board),
                    "html": format!("<div data-name=\"Tall\" style=\"height: {px}px; flex-shrink: 0\">Too tall</div>") }),
        )
        .await
}

/// `comments` is a read that is neither of the layout tools.
pub async fn read(agent: &mut Agent, b: &Board) -> String {
    agent.ok("comments", json!({ "designId": b.design })).await
}

/// The note for an edit: on its own result if the check was quick, else on
/// the next result, polled for since the check runs after the edit.
pub async fn note_after(agent: &mut Agent, b: &Board, edit: &str) -> Option<String> {
    if edit.contains("Layout:") && !edit.contains("Layout: nothing is cut off") {
        return Some(edit.to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let text = read(agent, b).await;
        if text.contains("Layout:") {
            return Some(text);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    None
}
