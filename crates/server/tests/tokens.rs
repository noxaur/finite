//! The token tools, and old shared CSS moving into tokens when a design loads.

mod agent;

use std::sync::Arc;

use agent::{Agent, id_after, test_app};
use finite_design::{Design, DesignMeta, Op, edit::NewArtboard};
use finite_server::{
    Hub, app,
    store::{MemoryStore, Store},
};
use serde_json::json;

#[tokio::test]
async fn an_agent_sets_tokens_in_two_modes_and_undoes_them() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Alice").await;
    let design = agent.design("Flow").await;

    let saved = agent
        .edit(
            &design,
            json!([{ "op": "tokens", "modes": ["Light", "Dark"],
                     "set": { "--brand": "#f97316", "--bg": { "Light": "#fff", "Dark": "#111" } } }]),
        )
        .await;
    assert!(saved.contains("2 tokens"), "{saved}");
    assert!(saved.contains("Light, Dark"), "{saved}");

    let board = agent
        .edit(
            &design,
            json!([{ "op": "artboard", "name": "Night", "width": 390, "height": 844, "mode": "dark",
                     "html": "<button style=\"background: var(--brand)\">Go</button>" }]),
        )
        .await;
    let board = id_after(&board, "Created artboard");
    let overview = agent.ok("read", json!({ "designId": design })).await;
    assert!(overview.contains("2 tokens"), "{overview}");

    // The css view lists the tokens the way the tokens op takes them.
    let sheets = agent
        .ok("read", json!({ "designId": design, "as": "css" }))
        .await;
    assert!(
        sheets.contains("--bg") && sheets.contains("#111") && sheets.contains("--brand"),
        "{sheets}"
    );

    for (bad, why) in [
        (json!({ "--brand": "red; color: blue" }), "outside a string"),
        (json!({ "brand": "red" }), "start with --"),
        (
            json!({ "--brand": { "Sepia": "red" } }),
            "no mode \"Sepia\"",
        ),
    ] {
        let (error, failed) = agent
            .call(
                "edit",
                json!({ "designId": design, "check": false,
                        "ops": [{ "op": "tokens", "set": bad }] }),
            )
            .await;
        assert!(failed && error.contains(why), "{error}");
    }
    let (error, failed) = agent
        .call(
            "edit",
            json!({ "designId": design, "check": false,
                    "ops": [{ "op": "move", "select": format!("#{board}"), "mode": "Sepia" }] }),
        )
        .await;
    assert!(
        failed && error.contains("its modes are Light, Dark"),
        "{error}"
    );

    // They're edits like any other, so undo takes them back.
    agent.ok("undo", json!({ "designId": design })).await;
    let undone = agent.ok("undo", json!({ "designId": design })).await;
    assert!(undone.contains("Undid"), "{undone}");
    let sheets = agent
        .ok("read", json!({ "designId": design, "as": "css" }))
        .await;
    assert!(sheets.contains("no tokens"), "{sheets}");
}

/// A design saved with shared CSS gets tokens the first time it loads, and
/// its artboards keep the rest of the CSS in their own `<style>`.
#[tokio::test]
async fn shared_css_becomes_tokens_when_a_design_loads() {
    let mut old = Design::new(DesignMeta {
        id: "oldcss0001".into(),
        name: "Old".into(),
        created_at: 0,
        updated_at: 0,
    });
    let spec = NewArtboard {
        name: "Home".into(),
        width: 100.0,
        height: Some(100.0),
        position: None,
        page: None,
        styles: Default::default(),
        ..Default::default()
    };
    let mut ops = finite_design::edit::create_artboard(old.doc(), "home".into(), spec).unwrap();
    ops.push(Op::Css {
        css: Some(":root { --ink: #111 } .btn { color: var(--ink) }".into()),
    });
    old.commit("agent", "Old", &ops, 0).unwrap();
    let store = Arc::new(MemoryStore::default());
    store.save(&old.snapshot_to_save(), 0).unwrap();

    let app = app(Hub::new(store.clone()).unwrap(), None);
    let mut agent = Agent::connect(&app, "Alice").await;
    let tokens = agent
        .ok("read", json!({ "designId": "oldcss0001", "as": "css" }))
        .await;
    assert!(
        tokens.contains("--ink") && tokens.contains("#111"),
        "{tokens}"
    );
    let html = agent
        .ok(
            "read",
            json!({ "designId": "oldcss0001", "select": "#home", "as": "html" }),
        )
        .await;
    assert!(html.contains(".btn { color: var(--ink) }"), "{html}");
    // Nobody can undo back to the old CSS.
    assert_eq!(
        agent.ok("undo", json!({ "designId": "oldcss0001" })).await,
        "Nothing to undo."
    );
}
