//! Shared by the layout note tests, which each run in their own process
//! because `FINITE_MCP_EXTRA` and `FINITE_LAYOUT_WAIT_MS` are read once.

#![allow(dead_code, reason = "each test binary uses some of these")]

use super::agent::{Agent, id_after};
use serde_json::json;
use std::time::{Duration, Instant};

/// A design with one 300 × 200 artboard holding a "Title", and the ids.
pub struct Board {
    pub design: String,
    pub board: String,
    pub title: String,
}

/// Turns the layout group on and connects. Call before anything else.
pub fn enable_group(wait_ms: Option<u64>) {
    // SAFETY: each test binary has one test, and this runs first, so no other
    // thread reads the environment yet.
    unsafe {
        std::env::set_var("FINITE_MCP_EXTRA", "layout");
        if let Some(ms) = wait_ms {
            std::env::set_var("FINITE_LAYOUT_WAIT_MS", ms.to_string());
        }
    }
}

/// Sets up the design, or says why the test can't run. Without a browser
/// there is nothing to measure: that is announced on stderr and the test
/// passes, unless `FINITE_REQUIRE_BROWSER` is set, as CI can, to fail instead.
pub async fn board(agent: &mut Agent) -> Option<Board> {
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
    let title = id_after(&made, "\"Title\"");
    let (probe, _) = agent
        .call("get_layout", json!({ "designId": design, "nodeId": board }))
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

/// Appends a block taller than the artboard.
pub async fn clip(agent: &mut Agent, b: &Board, px: u32) -> String {
    agent
        .ok(
            "write_html",
            json!({ "designId": b.design, "targetId": b.board,
                    "html": format!("<div data-name=\"Tall\" style=\"height: {px}px; flex-shrink: 0\">Too tall</div>") }),
        )
        .await
}

/// `get_comments` is a read that is neither of the layout tools.
pub async fn read(agent: &mut Agent, b: &Board) -> String {
    agent
        .ok("get_comments", json!({ "designId": b.design }))
        .await
}

/// The note for an edit: on its own result if the check was quick, else on
/// the next result, polled for since the check runs after the edit.
pub async fn note_after(agent: &mut Agent, b: &Board, edit: &str) -> Option<String> {
    if edit.contains("Layout:") {
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
