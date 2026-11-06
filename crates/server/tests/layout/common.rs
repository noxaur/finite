//! Shared by the layout tests.

use super::agent::{Agent, id_after};
use axum::Router;
use finite_server::{Hub, app, config::Settings, store::MemoryStore, testing::require_browser};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// A design with one 300 × 200 artboard holding a "Title", and the ids.
pub struct Board {
    pub design: String,
    pub board: String,
    pub title: String,
}

/// A server whose edits wait `ms` milliseconds for their layout check. 0
/// leaves every note for the next result. A wait that is long enough to
/// outlast other tests' Chrome measurements, which queue behind one another,
/// is what lets a clean check or an overlap note reach the edit's own result.
pub fn waiting_app(ms: u64) -> Router {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    hub.configure(Settings {
        layout_wait: Duration::from_millis(ms),
        ..Settings::default()
    });
    app(hub, None)
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

/// Sets up the design, or `None` when there is no browser to measure with
/// (see [`require_browser`]).
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
    if !require_browser(&probe) {
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
