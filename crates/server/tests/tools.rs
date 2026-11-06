//! The six tools, served at `/mcp`, driven over MCP the way
//! an agent drives it: every tool, and every op of `edit`.

mod agent;

use std::{sync::Arc, time::Duration};

use agent::{Agent, id_after};
use axum::Router;
use finite_design::comment::{Anchor, Audience, Author, AuthorKind};
use finite_server::{Hub, app, store::MemoryStore};
use serde_json::{Value, json};

/// A server.
fn server() -> (Router, Arc<Hub>) {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    (app(hub.clone(), None), hub)
}

/// A new design's id.
async fn design(agent: &mut Agent, name: &str) -> String {
    let created = agent.ok("designs", json!({ "create": name })).await;
    created
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 10)
        .expect("a design id")
        .to_owned()
}

/// Runs `ops` as one edit without the layout check, which needs a browser.
async fn edit(agent: &mut Agent, design: &str, ops: Value) -> String {
    agent
        .ok(
            "edit",
            json!({ "designId": design, "ops": ops, "check": false }),
        )
        .await
}

/// The same, expecting the edit to fail.
async fn refused(agent: &mut Agent, design: &str, ops: Value) -> String {
    let (text, error) = agent
        .call(
            "edit",
            json!({ "designId": design, "ops": ops, "check": false }),
        )
        .await;
    assert!(error, "the edit should have failed: {text}");
    text
}

async fn html(agent: &mut Agent, design: &str, select: &str) -> String {
    agent
        .ok(
            "read",
            json!({ "designId": design, "select": select, "as": "html" }),
        )
        .await
}

/// A design with a 600 × 400 artboard holding a heading and two cards.
async fn landing(agent: &mut Agent) -> (String, String) {
    let id = design(agent, "Landing").await;
    let made = edit(
        agent,
        &id,
        json!([{ "op": "artboard", "name": "Home", "width": 600, "height": 400,
                 "html": "<h1 data-name=\"Title\" style=\"color: #3b82f6\">Hello</h1>\
                          <div class=\"card\" data-name=\"One\"><p>First</p></div>\
                          <div class=\"card\" data-name=\"Two\"><p>Second</p></div>" }]),
    )
    .await;
    (id, id_after(&made, "Created artboard"))
}

#[tokio::test]
async fn it_serves_exactly_six_tools_and_their_instructions() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Six").await;
    let tools = agent.rpc("tools/list", None).await;
    let mut names: Vec<&str> = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["comments", "designs", "edit", "read", "render", "undo"]
    );
    let mut fresh = Agent::connect(&app, "Fresh").await;
    let init = fresh
        .rpc(
            "initialize",
            Some(json!({ "protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": { "name": "test", "version": "1" } })),
        )
        .await;
    let text = init["instructions"].as_str().unwrap();
    assert!(text.contains("There are six tools"), "{text}");
    assert!(!text.contains("write_html"), "{text}");
}

#[tokio::test]
async fn designs_are_listed_created_renamed_and_deleted() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Lister").await;
    let id = design(&mut agent, "Acme site").await;
    assert!(
        agent
            .ok("designs", json!({ "query": "acme" }))
            .await
            .contains(&id)
    );
    let renamed = agent
        .ok("designs", json!({ "designId": id, "rename": "Acme home" }))
        .await;
    assert!(renamed.contains("Acme home"), "{renamed}");
    let deleted = agent.ok("designs", json!({ "delete": "acme HOME" })).await;
    assert!(deleted.contains("permanently"), "{deleted}");
    let (gone, error) = agent.call("read", json!({ "designId": id })).await;
    assert!(error, "{gone}");
}

/// in: "text" changes what people read and leaves links, ids and titles
/// alone, which a rename through a long article needs.
#[tokio::test]
async fn replace_in_text_leaves_attributes_alone() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Replacer").await;
    let id = design(&mut agent, "Article").await;
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Page", "width": 600,
                 "html": "<p>Every typeface <a href=\"/wiki/typeface_design\" title=\"typeface design\">typeface</a></p>" }]),
    )
    .await;
    let done = edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "typeface", "replace": "font", "in": "text" }]),
    )
    .await;
    assert!(done.contains("Replaced"), "{done}");
    let page = html(&mut agent, &id, "p").await;
    assert!(
        page.contains("Every font") && page.contains(">font</a>"),
        "{page}"
    );
    assert!(
        page.contains("href=\"/wiki/typeface_design\"")
            && page.contains("title=\"typeface design\""),
        "{page}"
    );
    let wrong = refused(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "a", "replace": "b", "in": "everywhere" }]),
    )
    .await;
    assert!(wrong.contains("isn't a place to replace in"), "{wrong}");
}

/// in: "text" changes what people read and leaves <script> and <style> alone,
/// including an SVG <style>. in: "code" is what reaches that code.
#[tokio::test]
async fn replace_in_text_skips_script_and_style() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Replacer").await;
    let id = design(&mut agent, "Rates").await;
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Page", "width": 600,
                 "html": "<p>Timepris</p><script>h('Timepris'); h('Timepris')</script><svg><style>.z { content: \"Timepris\" }</style></svg>" }]),
    )
    .await;
    let found = agent
        .ok("read", json!({ "designId": id, "contains": "Timepris" }))
        .await;
    let text = found.split("In text:").nth(1).unwrap_or("");
    assert!(
        text.starts_with(" 1 element") && !text.contains("script") && !text.contains("style"),
        "{found}"
    );
    assert!(
        found.contains("In styles") && found.contains("script"),
        "{found}"
    );
    let done = edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "Timepris", "replace": "Timepris arbeid", "in": "text" }]),
    )
    .await;
    assert!(done.contains("Replaced 1 use"), "{done}");
    let page = html(&mut agent, &id, ":root").await;
    assert!(
        page.contains("Timepris arbeid")
            && page.contains("h('Timepris')")
            && page.contains("content: \"Timepris\""),
        "{page}"
    );
    let refused_code = refused(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "Timepris", "replace": "Rate", "in": "code" }]),
    )
    .await;
    assert!(
        refused_code.contains("matches") && refused_code.contains("nothing changed"),
        "{refused_code}"
    );
    let code = edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "Timepris", "replace": "Rate", "in": "code", "all": true }]),
    )
    .await;
    assert!(code.contains("Replaced"), "{code}");
    let page = html(&mut agent, &id, ":root").await;
    assert!(
        page.contains("h('Rate')")
            && page.contains("content: \"Rate\"")
            && page.contains("Timepris arbeid"),
        "{page}"
    );
}

/// Deleting can't be undone, so the start of an id, which every other
/// tool accepts, isn't enough.
/// A copy is what x, y, page and mode place, not its original.
#[tokio::test]
async fn move_with_copy_places_the_copy() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Copier").await;
    let id = design(&mut agent, "Copies").await;
    let made = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Home", "width": 400, "height": 300, "x": 0, "y": 0 }]),
    )
    .await;
    let board = id_after(&made, "artboard");
    edit(
        &mut agent,
        &id,
        json!([{ "op": "move", "select": format!("#{board}"), "copy": true, "x": 2000, "y": 0 }]),
    )
    .await;
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains(&format!("#{board} (artboard at 0, 0)")),
        "the original stays: {overview}"
    );
    assert!(overview.contains("(artboard at 2000, 0)"), "{overview}");
}

#[tokio::test]
async fn delete_takes_only_an_exact_id_or_name() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Deleter").await;
    let id = design(&mut agent, "Keep me").await;
    let (refused, error) = agent.call("designs", json!({ "delete": &id[..6] })).await;
    assert!(
        error && refused.contains("nothing was deleted") && refused.contains(&id),
        "{refused}"
    );
    agent.ok("read", json!({ "designId": id })).await;
    let deleted = agent.ok("designs", json!({ "delete": id })).await;
    assert!(deleted.contains("permanently"), "{deleted}");
}

#[tokio::test]
async fn design_ids_take_a_name_or_the_start_of_an_id() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Namer").await;
    let id = design(&mut agent, "Checkout flow").await;
    for given in ["Checkout flow", "checkout FLOW", &id, &id[..6]] {
        let read = agent.ok("read", json!({ "designId": given })).await;
        assert!(
            read.contains(&format!("designId {id:?}")),
            "{given}: {read}"
        );
    }
    design(&mut agent, "Twin").await;
    design(&mut agent, "twin").await;
    let (twins, error) = agent.call("read", json!({ "designId": "Twin" })).await;
    assert!(error && twins.contains("several have it"), "{twins}");
    let (missing, error) = agent.call("read", json!({ "designId": "Checkout" })).await;
    assert!(
        error && missing.contains("Did you mean \"Checkout flow\""),
        "{missing}"
    );
}

#[tokio::test]
async fn read_shows_an_overview_outline_html_css_and_search() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Reader").await;
    let (id, board) = landing(&mut agent).await;
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains("1 artboard,") && overview.contains("\"Title\""),
        "{overview}"
    );
    let outline = agent
        .ok("read", json!({ "designId": id, "select": ".card" }))
        .await;
    assert!(
        outline.contains("<!-- 1 of 2") && outline.contains("\"Two\""),
        "{outline}"
    );
    let html = html(&mut agent, &id, "[data-name=One]").await;
    assert!(
        html.contains("data-read-at") && html.contains("<p data-id="),
        "{html}"
    );
    let found = agent
        .ok(
            "read",
            json!({ "designId": id, "contains": "rgb(59, 130, 246)" }),
        )
        .await;
    assert!(
        found.contains("In styles") && found.contains("\"Title\""),
        "{found}"
    );
    let inside = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ".card", "contains": "Second" }),
        )
        .await;
    assert!(inside.contains("In text: 1 element"), "{inside}");
    // States aren't elements, and the error says where they go.
    let (state, error) = agent
        .call("read", json!({ "designId": id, "select": ".card:hover" }))
        .await;
    assert!(
        error && state.contains("use a css op with to: \"style\""),
        "{state}"
    );
    let (nothing, error) = agent
        .call("read", json!({ "designId": id, "select": ".missing" }))
        .await;
    assert!(error && nothing.contains("matches no element"), "{nothing}");
    // The css view: inline styles, the rules that match, and what beats them.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "css": ".card { padding: 8px } h1 { color: red }", "to": "style" }]),
    )
    .await;
    let css = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "h1", "as": "css" }),
        )
        .await;
    assert!(
        css.contains("h1 { color: red }")
            && css.contains("Inline styles beat sheet rules for: color"),
        "{css}"
    );
    let sheet = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "style", "as": "css" }),
        )
        .await;
    assert!(sheet.contains("rule: .card { padding: 8px }"), "{sheet}");
    let sheets = agent
        .ok("read", json!({ "designId": id, "as": "css" }))
        .await;
    assert!(
        sheets.contains("no tokens") && sheets.contains("2 rules"),
        "{sheets}"
    );
    let _ = board;
}

#[tokio::test]
async fn every_op_runs_in_one_edit() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Builder").await;
    let (id, board) = landing(&mut agent).await;
    let text = edit(
        &mut agent,
        &id,
        json!([
            { "op": "html", "select": format!("#{board}"), "html": "<footer data-name=\"Footer\">Bye</footer>", "as": "f" },
            { "op": "html", "select": "@f", "mode": "before", "html": "<hr data-name=\"Rule\">" },
            { "op": "html", "select": "h1", "mode": "inner", "html": "Welcome" },
            { "op": "html", "select": ".card", "mode": "prepend", "html": "<span class=\"tag\">New</span>" },
            { "op": "css", "select": ".card", "css": "border-radius: 12px" },
            { "op": "css", "css": ".tag { color: green } .card:hover { opacity: 0.9 }", "to": "style" },
            { "op": "attrs", "select": "@f", "set": { "data-name": "Page footer", "role": "contentinfo" } },
            { "op": "move", "select": "[data-name=Two]", "to": "[data-name=One]", "position": "before" },
            { "op": "remove", "select": "[data-name=Rule]" },
            { "op": "replace", "find": "#3b82f6", "replace": "#f97316" },
            { "op": "page", "create": "Drafts", "as": "d" },
            { "op": "artboard", "name": "Draft", "width": 300, "page": "@d", "as": "b" },
            { "op": "move", "select": "[data-name=One]", "copy": true, "to": "@b", "as": "c" },
            { "op": "tokens", "set": { "--brand": "#f97316", "--bg": { "Light": "#ffffff", "Dark": "#000000" } }, "modes": ["Light", "Dark"] },
            { "op": "move", "select": "@b", "mode": "Dark" },
            { "op": "import", "name": "about.html", "content": "<html><body><h2>About</h2></body></html>", "page": "Drafts" },
        ]),
    )
    .await;
    assert!(
        text.starts_with("Changed the design in one step (16 ops)"),
        "{text}"
    );
    for section in 1..=16 {
        assert!(
            text.contains(&format!("\n{section}. ")),
            "section {section}: {text}"
        );
    }
    let page = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ":root", "as": "outline", "depth": 6 }),
        )
        .await;
    assert!(
        page.contains("\"Page footer\" #") && page.contains("\"Welcome\""),
        "{page}"
    );
    assert!(!page.contains("\"Rule\""), "{page}");
    let home = html(&mut agent, &id, &format!("#{board}")).await;
    let (two, one) = (home.find("\"Two\"").unwrap(), home.find("\"One\"").unwrap());
    assert!(two < one, "Two moved before One: {home}");
    assert!(
        home.contains("border-radius: 12px") && home.contains("#f97316"),
        "{home}"
    );
    assert!(
        home.contains(".tag { color: green }") && home.contains(":hover"),
        "{home}"
    );
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains("Pages: \"Page 1\"") && overview.contains("\"Drafts\""),
        "{overview}"
    );
    assert!(
        overview.contains("\"About\"") || overview.contains("About"),
        "{overview}"
    );
    let tokens = agent
        .ok("read", json!({ "designId": id, "as": "css" }))
        .await;
    assert!(
        tokens.contains("\"--brand\": \"#f97316\"") && tokens.contains("\"Dark\": \"#000000\""),
        "{tokens}"
    );
    assert!(
        tokens.contains("artboardModes"),
        "the draft is in Dark: {tokens}"
    );
    // replace changes token values too.
    let replaced = edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "#000000", "replace": "#111111" }]),
    )
    .await;
    assert!(
        replaced.contains("--bg (Dark): #000000 → #111111"),
        "{replaced}"
    );
    let found = agent
        .ok("read", json!({ "designId": id, "contains": "#111" }))
        .await;
    assert!(
        found.contains("In tokens") && found.contains("--bg (Dark)"),
        "{found}"
    );
    // Rename and remove pages, and turn an element into an artboard.
    let pages = edit(
        &mut agent,
        &id,
        json!([
            { "op": "page", "rename": "Drafts", "name": "Archive" },
            { "op": "move", "select": "[data-name=Footer], [data-name='Page footer']", "to": "canvas" },
            { "op": "page", "remove": "archive" },
        ]),
    )
    .await;
    assert!(
        pages.contains("Renamed page \"Drafts\" to \"Archive\""),
        "{pages}"
    );
    assert!(pages.contains("Deleted page \"archive\""), "{pages}");
    let after = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        !after.contains("Archive") && after.contains("\"Page footer\""),
        "{after}"
    );
}

#[tokio::test]
async fn a_flat_op_and_old_habits_work() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Habits").await;
    let (id, _) = landing(&mut agent).await;
    let flat = agent
        .ok(
            "edit",
            json!({ "designId": id, "op": "replace", "find": "Hello", "replace": "Hi",
                    "includeText": true, "check": false }),
        )
        .await;
    assert!(flat.contains("Replaced 1 use"), "{flat}");
    let h1 = agent
        .ok("read", json!({ "designId": id, "select": "h1" }))
        .await;
    let h1_id = id_after(&h1, "h1");
    // nodeIds instead of select, and update_styles' name for the op.
    let styled = edit(
        &mut agent,
        &id,
        json!([{ "op": "update_styles", "nodeIds": [h1_id], "styles": { "font-size": "40px" } }]),
    )
    .await;
    assert!(styled.contains("1 value changed"), "{styled}");
}

#[tokio::test]
async fn an_edit_is_one_undo_step_and_one_broadcast() {
    let (app, hub) = server();
    let mut agent = Agent::connect(&app, "Atomic").await;
    let (id, board) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let (_, seq, mut changes) = handle.subscribe();
    let text = agent
        .ok(
            "edit",
            json!({ "designId": id, "status": "Restyling the cards", "check": false, "ops": [
                { "op": "css", "select": ".card", "css": "padding: 24px" },
                { "op": "html", "select": ".card", "html": "<em>!</em>" },
                { "op": "attrs", "select": "h1", "set": { "title": "Hi" } },
            ] }),
        )
        .await;
    assert!(text.contains("one step (3 ops)"), "{text}");
    let mut broadcasts = Vec::new();
    while let Ok(message) = changes.try_recv() {
        if message.seq.is_some() {
            broadcasts.push(message);
        }
    }
    assert_eq!(broadcasts.len(), 1, "one change for the whole edit");
    assert_eq!(broadcasts[0].seq, Some(seq + 1));
    assert!(broadcasts[0].json.contains("Restyling the cards"));
    // People see the status on the artboard.
    let presence = handle.presence();
    assert!(
        presence
            .iter()
            .any(|p| p.status.as_deref() == Some("Restyling the cards")
                && p.node_ids.contains(&board)),
        "{presence:?}"
    );
    let undone = agent.ok("undo", json!({ "designId": id })).await;
    assert_eq!(undone, "Undid your last edit (Restyling the cards).");
    let after = html(&mut agent, &id, ".card").await;
    assert!(
        !after.contains("24px") && !after.contains("<em>"),
        "{after}"
    );
    let redone = agent
        .ok("undo", json!({ "designId": id, "redo": true }))
        .await;
    assert!(redone.starts_with("Redid your last edit"), "{redone}");
    // Without a status, the label sums up the ops.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "#3b82f6", "replace": "#f97316" },
               { "op": "css", "select": ".card", "css": "margin: 0" }]),
    )
    .await;
    let undone = agent
        .ok("undo", json!({ "designId": id, "steps": 2 }))
        .await;
    assert_eq!(
        undone,
        "Undid your last 2 edits (Replace #3b82f6 → #f97316, CSS on .card, Restyling the cards)."
    );
}

#[tokio::test]
async fn a_failing_op_changes_nothing_and_nobody_sees_it() {
    let (app, hub) = server();
    let mut agent = Agent::connect(&app, "Careful").await;
    let (id, _) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let before = handle.read(|d| d.seq());
    let (_, _, mut changes) = handle.subscribe();
    let error = refused(
        &mut agent,
        &id,
        json!([
            { "op": "css", "select": "h1", "css": "color: red" },
            { "op": "html", "select": ".nothing", "html": "<p>x</p>" },
        ]),
    )
    .await;
    assert!(
        error.starts_with("op 2 (html): select \".nothing\" matches no element")
            && error.ends_with("Nothing was changed."),
        "{error}"
    );
    assert_eq!(handle.read(|d| d.seq()), before);
    assert!(changes.try_recv().is_err(), "nothing was broadcast");
    assert!(!html(&mut agent, &id, "h1").await.contains("red"));
    assert_eq!(
        agent.ok("undo", json!({ "designId": id })).await,
        "Undid your last edit (Artboard \"Home\")."
    );
    // Errors name the edit ops.
    let unknown = refused(&mut agent, &id, json!([{ "op": "paint" }])).await;
    assert!(unknown.contains("Ops are artboard, html, css"), "{unknown}");
    let missing = refused(&mut agent, &id, json!([{ "op": "attrs", "select": "h1" }])).await;
    assert!(
        missing.contains("\"attrs\" needs set, like {\"op\": \"attrs\""),
        "{missing}"
    );
}

#[tokio::test]
async fn a_dry_run_changes_nothing() {
    let (app, hub) = server();
    let mut agent = Agent::connect(&app, "Dry").await;
    let (id, _) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let before = handle.read(|d| d.seq());
    let (_, _, mut changes) = handle.subscribe();
    let text = agent
        .ok(
            "edit",
            json!({ "designId": id, "dryRun": true, "ops": [
                { "op": "remove", "select": ".card" },
                { "op": "replace", "find": "#3b82f6", "replace": "red" },
            ] }),
        )
        .await;
    assert!(text.starts_with("Dry run: nothing was changed"), "{text}");
    assert!(text.contains("Deleted 2 nodes"), "{text}");
    assert_eq!(handle.read(|d| d.seq()), before);
    assert!(changes.try_recv().is_err());
    assert!(html(&mut agent, &id, ".card").await.contains("First"));
}

#[tokio::test]
async fn refs_name_what_earlier_ops_made() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Refs").await;
    let id = design(&mut agent, "Refs").await;
    // A ref inside a quoted string is text, not a ref.
    edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Mobile", "width": 390, "html": "<header>Top</header>", "as": "m" },
            { "op": "html", "select": "@m", "html": "<section data-name=\"Body\"><p>me@example.com</p></section>", "as": "s" },
            { "op": "css", "css": "@s { padding: 16px } @m > header { color: blue }" },
            { "op": "html", "select": "@s p:contains(\"me@example.com\")", "html": "<i>x</i>" },
        ]),
    )
    .await;
    let body = html(&mut agent, &id, "[data-name=Body]").await;
    assert!(
        body.contains("padding: 16px") && body.contains("<i "),
        "{body}"
    );
    let header = html(&mut agent, &id, "header").await;
    assert!(header.contains("color: blue"), "{header}");
    let error = refused(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": "@nope", "html": "<p>x</p>" }]),
    )
    .await;
    assert!(
        error.contains(
            "\"@nope\" isn't defined. Give an earlier op in the same edit \"as\": \"nope\""
        ),
        "{error}"
    );
}

#[tokio::test]
async fn remove_refuses_matches_nested_inside_each_other() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Guard").await;
    let (id, _) = landing(&mut agent).await;
    // :has(p) matches the artboard and both cards.
    let error = refused(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": ":has(p)" }]),
    )
    .await;
    assert!(
        error.contains("nested inside each other, so it would remove div \"Home\"")
            && error.contains("Nothing was changed."),
        "{error}"
    );
    let removed = edit(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": ":has(> p)" }]),
    )
    .await;
    assert!(removed.contains("Deleted 2 nodes"), "{removed}");
}

#[tokio::test]
async fn html_inner_and_replace_apply_to_every_match() {
    let (app, _) = server();
    let mut alice = Agent::connect(&app, "Alice").await;
    let mut bob = Agent::connect(&app, "Bob").await;
    let (id, _) = landing(&mut alice).await;
    // A match inside another would be deleted by the outer replace.
    let nested = refused(
        &mut alice,
        &id,
        json!([{ "op": "html", "select": ":has(p)", "mode": "inner", "html": "x" }]),
    )
    .await;
    assert!(
        nested.contains("nested inside each other") && nested.contains("Nothing was changed."),
        "{nested}"
    );
    let cards = html(&mut alice, &id, ".card").await;
    assert!(
        cards.contains("First") && cards.contains("Second"),
        "{cards}"
    );

    let mark = "MARKPATHDATA-should-not-be-echoed-in-the-result";
    let written = edit(
        &mut alice,
        &id,
        json!([{
            "op": "html",
            "select": ".card",
            "mode": "inner",
            "html": format!("<b data-name=\"Mark\"><i data-name=\"{mark}\">x</i></b>")
        }]),
    )
    .await;
    // Matches that got the same are one section, showing the first's tree once.
    assert!(
        written.contains("inner 2 elements") && written.matches(mark).count() == 1,
        "many matches don't each echo their subtree: {written}"
    );
    let cards = html(&mut alice, &id, ".card").await;
    assert!(cards.contains("Mark") && cards.contains(mark), "{cards}");
    let bold_ids = tag_ids(&cards, "b");
    assert_eq!(bold_ids.len(), 2, "{cards}");
    assert_ne!(
        bold_ids[0], bold_ids[1],
        "each copy gets its own id: {cards}"
    );

    // outer is replace. One line per match, then undo restores both cards.
    let replaced = edit(
        &mut alice,
        &id,
        json!([{
            "op": "html",
            "select": ".card",
            "mode": "outer",
            "html": "<p data-name=\"Only\">Z</p>"
        }]),
    )
    .await;
    assert!(
        replaced.contains("replace") && !replaced.contains("<p"),
        "{replaced}"
    );
    let after = html(&mut alice, &id, "[data-name=Only]").await;
    assert!(after.matches(">Z<").count() >= 2, "{after}");
    alice.ok("undo", json!({ "designId": id })).await;
    let cards = html(&mut alice, &id, ".card").await;
    assert!(
        cards.contains("Mark") && !cards.contains("Only"),
        "undo puts the inner copies back: {cards}"
    );
    alice.ok("undo", json!({ "designId": id })).await;
    let cards = html(&mut alice, &id, ".card").await;
    assert!(
        cards.contains("First") && cards.contains("Second") && !cards.contains("Mark"),
        "{cards}"
    );

    // Bob's edit stays when Alice undoes a multi-match write.
    let (alice_edit, bob_edit) = (
        json!([{
            "op": "html",
            "select": ".card",
            "mode": "prepend",
            "html": "<span data-name=\"Tag\"><b data-name=\"Deep\">t</b></span>"
        }]),
        json!([{ "op": "css", "select": "h1", "css": "color: purple" }]),
    );
    let (ra, _) = tokio::join!(
        alice.ok(
            "edit",
            json!({ "designId": id, "check": false, "ops": alice_edit }),
        ),
        bob.ok(
            "edit",
            json!({ "designId": id, "check": false, "ops": bob_edit }),
        ),
    );
    assert!(
        ra.contains("prepend 2 elements") && ra.matches("Deep").count() == 1,
        "prepend on many matches is one section: {ra}"
    );
    assert!(ra.contains("prepend"), "{ra}");
    alice.ok("undo", json!({ "designId": id })).await;
    let home = html(&mut alice, &id, "h1").await;
    assert!(
        home.contains("purple") && !html(&mut alice, &id, ".card").await.contains("Deep"),
        "{home}"
    );
}

/// The `data-id` of each `<tag ` in `html`.
fn tag_ids(html: &str, tag: &str) -> Vec<String> {
    let mut found = Vec::new();
    let open = format!("<{tag} ");
    let mut rest = html;
    while let Some(at) = rest.find(&open) {
        rest = &rest[at..];
        let end = rest.find('>').unwrap_or(rest.len());
        let piece = &rest[..end];
        if let Some(start) = piece.find("data-id=\"") {
            let id: String = piece[start + 9..]
                .chars()
                .take_while(|c| *c != '"')
                .collect();
            found.push(id);
        }
        rest = &rest[end..];
    }
    found
}

#[tokio::test]
async fn path_ids_and_instance_edits_take_either_slash() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Paths").await;
    let (id, _) = landing(&mut agent).await;
    // A slash in a value, and a color hash, are not path ids.
    let styled = edit(
        &mut agent,
        &id,
        json!([{
            "op": "css",
            "css": "h1 { font: 16px/1.5 sans-serif; background-image: url(https://example.com/a.png); color: #112233 }"
        }]),
    )
    .await;
    assert!(styled.contains("h1 matched"), "{styled}");
    let heading = html(&mut agent, &id, "h1").await;
    assert!(
        heading.contains("16px/1.5")
            && heading.contains("example.com/a.png")
            && heading.contains("#112233"),
        "{heading}"
    );

    let nav = |title: &str| {
        format!("<header data-name=\"Nav\"><h1 data-name=\"Title\">{title}</h1></header>")
    };
    let made = edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Settings", "width": 400, "height": 200, "html": nav("Settings") },
            { "op": "artboard", "name": "Profile", "width": 400, "height": 200, "html": nav("Profile") },
            { "op": "artboard", "name": "Account", "width": 400, "height": 200, "html": nav("Account") },
            { "op": "component", "select": "[data-name=Nav]", "name": "Top bar" },
        ]),
    )
    .await;
    assert!(made.contains("Replaced 2 copies"), "{made}");
    let mut instances = Vec::new();
    for line in made.lines() {
        let Some(rest) = line.trim().strip_prefix('#') else {
            continue;
        };
        if let Some(id) = rest.split(':').next()
            && id.len() == 8
            && line.contains("override")
        {
            instances.push(id.to_owned());
        }
    }
    assert_eq!(instances.len(), 2, "{made}");
    let mut titles = Vec::new();
    for instance in &instances {
        let shown = html(&mut agent, &id, &format!("#{instance}")).await;
        let marker = format!("data-id=\"{instance}/");
        let at = shown.find(&marker).expect("a node inside the instance") + marker.len();
        let part: String = shown[at..]
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        titles.push(format!("{instance}/{part}"));
    }

    // Writing new elements inside an instance is refused for one match and
    // for every match, and nothing is written. Styles on those nodes still
    // go through, below, as overrides.
    let select = titles
        .iter()
        .map(|title| format!("#{title}"))
        .collect::<Vec<_>>()
        .join(", ");
    let one = refused(
        &mut agent,
        &id,
        json!([{
            "op": "html",
            "select": format!("#{}", titles[0]),
            "mode": "inner",
            "html": "<b>nope</b>"
        }]),
    )
    .await;
    let both = refused(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": select, "mode": "inner", "html": "<b>nope</b>" }]),
    )
    .await;
    assert!(
        one.contains("Nothing was changed.") && both.contains("Nothing was changed."),
        "{one}\n{both}"
    );
    let phrase = if one.contains("nothing can be added") {
        "nothing can be added"
    } else {
        "mode inner replaces its children"
    };
    assert!(
        one.contains(phrase) && both.contains(phrase),
        "{one}\n{both}"
    );
    let still = html(&mut agent, &id, &format!("#{}", titles[0])).await;
    assert!(
        (still.contains("Profile") || still.contains("Account")) && !still.contains("nope"),
        "{still}"
    );

    let path = &titles[0];
    let escaped = path.replace('/', r"\/");
    let component = made[..made.find(" is a component").expect("the component")]
        .rsplit(|c: char| !c.is_ascii_alphanumeric())
        .next()
        .expect("the component id")
        .to_owned();
    let suggestion = format!(r##"{{"op":"css","select":"#{path}","css":"…"}}"##);

    // select styles the part, as an override. Both spellings name it.
    let by_select = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": format!("#{path}"), "css": "color: #123456" }]),
    )
    .await;
    assert!(
        by_select.contains("1 element") || by_select.contains("matched 1"),
        "{by_select}"
    );
    let by_escaped = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": format!("#{escaped}"), "css": "font-weight: 700" }]),
    )
    .await;
    assert!(
        by_escaped.contains("1 element") || by_escaped.contains("matched 1"),
        "{by_escaped}"
    );
    let shown = html(&mut agent, &id, &format!("#{path}")).await;
    assert!(
        shown.contains("#123456") && shown.contains("700"),
        "the select op sets the part's style: {shown}"
    );
    let via_escaped = html(&mut agent, &id, &format!("#{escaped}")).await;
    assert!(via_escaped.contains("#123456"), "{via_escaped}");

    // A stylesheet rule can't reach the part, in either spelling.
    let raw = refused(
        &mut agent,
        &id,
        json!([{ "op": "css", "css": format!("#{path} {{ letter-spacing: 1px }}") }]),
    )
    .await;
    let escaped_rule = refused(
        &mut agent,
        &id,
        json!([{ "op": "css", "css": format!(r"#{escaped} {{ outline-color: #abcdef }}") }]),
    )
    .await;
    for error in [&raw, &escaped_rule] {
        assert!(
            error.contains("can't reach a part inside an instance")
                && error.contains(&suggestion)
                && error.contains(&format!("component #{component}"))
                && error.contains("Nothing was changed."),
            "{error}"
        );
    }
    let shown = html(&mut agent, &id, &format!("#{path}")).await;
    assert!(
        shown.contains("#123456") && shown.contains("700") && !shown.contains("1px"),
        "{shown}"
    );

    // A path that doesn't start at an instance is an ordinary id, which
    // matches nothing here. The part's style stays.
    let bad = refused(
        &mut agent,
        &id,
        json!([{ "op": "css", "css": "#nope00/missing { color: red }" }]),
    )
    .await;
    assert!(
        bad.contains("matches no element") && bad.contains("Nothing was changed."),
        "{bad}"
    );
    let shown = html(&mut agent, &id, &format!("#{path}")).await;
    assert!(
        shown.contains("#123456") && !shown.contains("color: red"),
        "{shown}"
    );

    // A `/*` inside an unquoted url() stays part of the url. A path selector
    // after it is still seen, and refused, rather than stored.
    let url_only = edit(
        &mut agent,
        &id,
        json!([{
            "op": "css",
            "to": "style",
            "css": "h1 { background-image: url(https://cdn.example/*) }"
        }]),
    )
    .await;
    assert!(!url_only.contains("can't reach"), "{url_only}");
    let after_url = refused(
        &mut agent,
        &id,
        json!([{
            "op": "css",
            "to": "style",
            "css": format!(
                "h1 {{ background-image: url(https://cdn.example/*) }} #{path} {{ background-color: rgb(255, 0, 0) }}"
            )
        }]),
    )
    .await;
    assert!(
        after_url.contains(&suggestion) && after_url.contains("Nothing was changed."),
        "{after_url}"
    );
    let sheet = html(&mut agent, &id, "style").await;
    assert!(
        sheet.contains("url(https://cdn.example/*)")
            && !sheet.contains(&escaped)
            && !sheet.contains("255, 0, 0"),
        "{sheet}"
    );
}

#[tokio::test]
async fn a_stale_rewrite_keeps_another_agents_change() {
    let (app, _) = server();
    let mut alice = Agent::connect(&app, "Alice").await;
    let mut bob = Agent::connect(&app, "Bob").await;
    let (id, _) = landing(&mut alice).await;
    let read = html(&mut alice, &id, "[data-name=One]").await;
    let card = read.trim().to_owned();
    // Bob changes the paragraph after Alice read it.
    edit(
        &mut bob,
        &id,
        json!([{ "op": "css", "select": "[data-name=One] p", "css": "color: purple" }]),
    )
    .await;
    // Alice writes her copy back with her own change to the card.
    let mine = card
        .replace("<p ", "<p title=\"mine\" ")
        .replace("class=\"card\"", "class=\"card wide\"");
    let text = edit(
        &mut alice,
        &id,
        json!([{ "op": "html", "select": "[data-name=One]", "mode": "replace", "html": mine }]),
    )
    .await;
    assert!(text.contains("Rewrote it in place"), "{text}");
    assert!(text.contains("kept color: purple"), "{text}");
    let after = html(&mut alice, &id, "[data-name=One]").await;
    assert!(
        after.contains("color: purple") && after.contains("card wide") && after.contains("mine"),
        "{after}"
    );
}

#[tokio::test]
async fn two_agents_edit_at_once() {
    let (app, _) = server();
    let mut alice = Agent::connect(&app, "Alice").await;
    let mut bob = Agent::connect(&app, "Bob").await;
    let (id, _) = landing(&mut alice).await;
    let a = json!({ "designId": id, "check": false, "ops": [
        { "op": "html", "select": "[data-name=One]", "html": "<b>alice</b>" },
        { "op": "css", "select": "[data-name=One]", "css": "color: red" } ] });
    let b = json!({ "designId": id, "check": false, "ops": [
        { "op": "html", "select": "[data-name=Two]", "html": "<b>bob</b>" },
        { "op": "css", "select": "[data-name=Two]", "css": "color: blue" } ] });
    let (ra, rb) = tokio::join!(alice.ok("edit", a), bob.ok("edit", b));
    assert!(
        ra.contains("one step") && rb.contains("one step"),
        "{ra}\n{rb}"
    );
    let cards = html(&mut alice, &id, ".card").await;
    assert!(cards.contains("alice") && cards.contains("bob"), "{cards}");
    // Each undoes only its own edit.
    bob.ok("undo", json!({ "designId": id })).await;
    let cards = html(&mut alice, &id, ".card").await;
    assert!(cards.contains("alice") && !cards.contains("bob"), "{cards}");
    assert!(
        cards.contains("color: red") && !cards.contains("color: blue"),
        "{cards}"
    );
}

#[tokio::test]
async fn jsx_and_export_are_read_views() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Exporter").await;
    let (id, board) = landing(&mut agent).await;
    let jsx = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "h1", "as": "jsx" }),
        )
        .await;
    assert!(jsx.contains("<h1") && jsx.contains("style={{"), "{jsx}");
    let exported = agent
        .ok("read", json!({ "designId": id, "export": "finite" }))
        .await;
    assert!(exported.contains("\"Title\""), "{exported}");
    let one = agent
        .ok(
            "read",
            json!({ "designId": id, "select": format!("#{board}"), "export": "jsx" }),
        )
        .await;
    assert!(
        one.contains("export default") || one.contains("function"),
        "{one}"
    );
    let (error, failed) = agent
        .call("read", json!({ "designId": id, "export": "jsx" }))
        .await;
    assert!(failed && error.contains("takes one artboard"), "{error}");
    // `app` is a tar of the whole design, so the result says where to
    // download it, and one artboard is refused.
    let text = agent
        .ok("read", json!({ "designId": id, "export": "app" }))
        .await;
    assert!(
        text.contains("-app.tar") && text.contains("not text"),
        "{text}"
    );
    let text = agent
        .ok(
            "read",
            json!({ "designId": id, "export": "app", "router": "tanstack-router" }),
        )
        .await;
    assert!(text.contains("router=tanstack-router"), "{text}");
    let (error, failed) = agent
        .call(
            "read",
            json!({ "designId": id, "export": "app", "router": "nope" }),
        )
        .await;
    assert!(
        failed && error.contains("react-router") && error.contains("tanstack-router"),
        "{error}"
    );
    let (error, failed) = agent
        .call(
            "read",
            json!({ "designId": id, "select": format!("#{board}"), "export": "app" }),
        )
        .await;
    assert!(failed && error.contains("whole prototype"), "{error}");
}

#[tokio::test]
async fn comments_are_listed_awaited_and_answered() {
    let (app, hub) = server();
    let mut agent = Agent::connect(&app, "Helper").await;
    let (id, board) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let h1 = handle.read(|d| {
        d.view()
            .subtree(&board)
            .iter()
            .find(|n| n.tag() == Some("h1"))
            .unwrap()
            .id
            .clone()
    });
    let person = Author {
        id: "user:ada".into(),
        name: "Ada".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some(board.clone()),
        node_id: Some(h1.clone()),
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 10.0,
    };
    let comment = handle
        .add_comment(person, anchor, Audience::Agents, "Make it orange")
        .unwrap();
    let listed = agent.ok("comments", json!({ "designId": id })).await;
    assert!(
        listed.contains("Make it orange") && listed.contains(&format!("\"select\": \"#{h1}\"")),
        "{listed}"
    );
    assert!(!listed.contains("\"nodeId\""), "{listed}");
    let waited = agent
        .ok("comments", json!({ "designId": id, "wait": 5 }))
        .await;
    assert!(waited.contains("Make it orange"), "{waited}");
    agent
        .ok(
            "edit",
            json!({ "designId": id, "status": "Making the title orange", "check": false,
                    "op": "css", "select": "h1", "css": "color: orange" }),
        )
        .await;
    let replied = agent
        .ok(
            "comments",
            json!({ "designId": id, "reply": [{ "commentId": comment.id,
                    "message": "Made it orange.", "resolve": true }] }),
        )
        .await;
    assert!(
        replied.contains("resolved") && replied.contains("Making the title orange"),
        "{replied}"
    );
    let none = agent
        .ok("comments", json!({ "designId": id, "wait": 1 }))
        .await;
    assert!(
        none.contains("No comments arrived in 1 seconds. Call again to keep listening."),
        "{none}"
    );
}

/// A wait past 55 seconds is what Claude Code drops with "The operation timed
/// out". The server waits 55 and says to call again. The clock is paused, and
/// the test jumps those 55 seconds in one step: SSE keep-alives sit at 15
/// seconds and reset from the wall clock, so auto-advance would crawl.
#[tokio::test(start_paused = true)]
async fn a_comment_wait_over_55_seconds_is_clamped() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Helper").await;
    let id = design(&mut agent, "Wait").await;
    let again = "Call again to keep listening.";
    let one = agent
        .ok("comments", json!({ "designId": id, "wait": 1 }))
        .await;
    assert_eq!(one, format!("No comments arrived in 1 seconds. {again}"));
    let zero = agent
        .ok("comments", json!({ "designId": id, "wait": 0 }))
        .await;
    assert_eq!(zero, format!("No comments arrived in 1 seconds. {again}"));

    let mut waits = Vec::new();
    for (name, wait) in [
        ("long", json!(300)),
        ("mid", json!(120)),
        ("flag", json!(true)),
    ] {
        let app = app.clone();
        let id = id.clone();
        waits.push(tokio::spawn(async move {
            let mut agent = Agent::connect(&app, name).await;
            let started = tokio::time::Instant::now();
            let text = agent
                .ok("comments", json!({ "designId": id, "wait": wait.clone() }))
                .await;
            (wait, text, started.elapsed())
        }));
    }
    // Yielding does not advance the clock, so each call stays parked on the cap.
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
    for wait in &waits {
        assert!(
            !wait.is_finished(),
            "a capped wait returned before the clock reached 55 seconds"
        );
    }
    // One second short of the cap, every call is still waiting.
    tokio::time::advance(Duration::from_secs(54)).await;
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
    for wait in &waits {
        assert!(
            !wait.is_finished(),
            "a capped wait returned before 55 seconds"
        );
    }
    tokio::time::advance(Duration::from_secs(1)).await;
    let capped = format!("No comments arrived in 55 seconds. {again}");
    for wait in waits {
        let (asked, text, elapsed) = wait.await.unwrap();
        assert_eq!(text, capped, "wait {asked}");
        assert!(
            elapsed >= Duration::from_secs(55) && elapsed < Duration::from_secs(70),
            "wait {asked} took {elapsed:?}"
        );
    }
}

/// What `render` says about an artboard's layout, or `None` without a browser.
async fn layout_of(agent: &mut Agent, design: &str) -> Option<String> {
    let (text, _) = agent
        .call(
            "render",
            json!({ "designId": design, "output": "layout", "settleMs": 200 }),
        )
        .await;
    if text.contains("no Chrome") {
        assert!(
            std::env::var_os("FINITE_REQUIRE_BROWSER").is_none(),
            "FINITE_REQUIRE_BROWSER is set but there is no browser: {text}"
        );
        eprintln!("SKIPPED, NOTHING WAS TESTED: no Chrome, Chromium or Edge found");
        return None;
    }
    Some(text)
}

/// Content that an ancestor clips isn't cut off by the artboard, whether the
/// clip is a scroller or an SVG's viewport or `clip-path`. Content that
/// nothing clips still is, and the fix is suggested only for what a taller
/// artboard makes room for. A script makes the artboard render in the
/// viewer's iframe, and the check measures it the same way.
#[tokio::test]
async fn clipped_content_is_not_cut_off_by_the_artboard() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Clipper").await;
    for script in [false, true] {
        let id = design(&mut agent, "Clips").await;
        let script = if script { "<script>1 + 1</script>" } else { "" };
        let made = edit(
            &mut agent,
            &id,
            json!([{ "op": "artboard", "name": "Mock", "width": 400, "height": 300,
                     "html": format!(
                        "{script}\
                         <div data-name=\"Pane\" style=\"height: 120px; flex-shrink: 0; overflow: auto\">\
                           <div data-name=\"Rows\" style=\"height: 900px; flex-shrink: 0\">Rows</div>\
                         </div>\
                         <div data-name=\"Hidden\" style=\"position: relative; height: 60px; flex-shrink: 0; overflow: hidden\">\
                           <div style=\"position: absolute; top: 400px; height: 50px\">Deep</div>\
                           <div data-name=\"Plain\" style=\"height: 700px; flex-shrink: 0\">Plain</div>\
                         </div>\
                         <svg data-name=\"Overlay\" width=\"400\" height=\"80\" style=\"overflow: visible; flex-shrink: 0\">\
                           <defs><clipPath id=\"c\"><rect width=\"400\" height=\"80\"/></clipPath></defs>\
                           <g data-name=\"Clipped group\" clip-path=\"url(#c)\"><circle data-name=\"Strekk\" cx=\"200\" cy=\"40\" r=\"600\"/></g>\
                         </svg>\
                         <svg data-name=\"Viewport\" width=\"400\" height=\"40\" style=\"flex-shrink: 0\">\
                           <circle data-name=\"Spill\" cx=\"200\" cy=\"20\" r=\"900\"/>\
                         </svg>") }]),
        )
        .await;
        let board = id_after(&made, "Created artboard");
        let Some(clean) = layout_of(&mut agent, &id).await else {
            return;
        };
        assert!(clean.contains("Layout: nothing is cut off"), "{clean}");

        // Content nothing clips is cut off, and a taller artboard makes room for it.
        let tall = "<div data-name=\"Tall\" style=\"height: 900px; flex-shrink: 0\">Tall</div>";
        agent
            .ok(
                "edit",
                json!({ "designId": id, "check": false, "op": "html",
                                 "select": format!("#{board}"), "html": tall }),
            )
            .await;
        let cut = layout_of(&mut agent, &id).await.unwrap();
        assert!(cut.contains("cut off by the artboard's edge"), "{cut}");
        assert!(cut.contains("\"Tall\""), "{cut}");
        let sticking = cut.split("Sticking out:").nth(1).unwrap_or_default();
        for clipped in ["Rows", "Plain", "Deep", "Strekk", "Clipped group", "Spill"] {
            assert!(
                !sticking.contains(clipped),
                "{clipped} is clipped: {sticking}"
            );
        }
        assert!(
            cut.contains("{ height:"),
            "a flow child gets the fix: {cut}"
        );
        // Text a scroller clips overlaps nothing below the artboard's edge.
        assert!(!cut.contains("overlap"), "{cut}");
        agent.ok("undo", json!({ "designId": id })).await;

        // Out of the flow, a taller artboard wouldn't make room for it.
        let badge = "<div data-name=\"Badge\" style=\"position: absolute; top: 280px; height: 80px; width: 80px\">New</div>";
        agent
            .ok(
                "edit",
                json!({ "designId": id, "check": false, "op": "html",
                                 "select": format!("#{board}"), "html": badge }),
            )
            .await;
        let floating = layout_of(&mut agent, &id).await.unwrap();
        let sticking = floating.split("Sticking out:").nth(1).unwrap_or_default();
        assert!(sticking.contains("\"Badge\""), "{floating}");
        assert!(!floating.contains("make the artboard taller"), "{floating}");
    }
}

/// A `clip-path` clips to its own bounds: a box that reaches past the
/// artboard under `inset(0)` is still cut off, and one the path crops short
/// of the edge isn't. A script makes the artboard render in the viewer's
/// iframe, and the check measures it the same way.
#[tokio::test]
async fn clip_path_clips_only_to_its_own_bounds() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Clipper").await;
    for script in [false, true] {
        let id = design(&mut agent, "Paths").await;
        let script = if script { "<script>1 + 1</script>" } else { "" };
        edit(
            &mut agent,
            &id,
            json!([{ "op": "artboard", "name": "Mock", "width": 400, "height": 300,
                     "html": format!(
                        "{script}\
                         <div data-name=\"Whole\" style=\"position: absolute; top: 0; left: 0; width: 100px; height: 600px; clip-path: inset(0)\">\
                           <div data-name=\"Inside\" style=\"height: 700px\"></div>\
                         </div>\
                         <div data-name=\"Cropped\" style=\"position: absolute; top: 0; left: 120px; width: 100px; height: 600px; clip-path: inset(0 0 500px 0)\"></div>\
                         <div data-name=\"Narrow\" style=\"position: absolute; top: 0; left: 240px; width: 100px; height: 100px; clip-path: polygon(0 0, 50% 0, 50% 100%, 0 100%)\"></div>\
                         <div data-name=\"Wide\" style=\"position: absolute; top: 120px; left: 0; width: 600px; height: 20px; clip-path: inset(0 0 0 100px)\"></div>\
                         <div data-name=\"Short\" style=\"position: absolute; top: 160px; left: 0; width: 600px; height: 20px; clip-path: inset(0 400px 0 0)\"></div>") }]),
        )
        .await;
        let Some(cut) = layout_of(&mut agent, &id).await else {
            return;
        };
        let sticking = cut.split("Sticking out:").nth(1).unwrap_or_default();
        assert!(sticking.contains("\"Whole\""), "{cut}");
        // Past the right edge too: what the path keeps still reaches it.
        assert!(sticking.contains("\"Wide\""), "{cut}");
        for cropped in ["Cropped", "Narrow", "Short", "Inside"] {
            assert!(
                !sticking.contains(cropped),
                "{cropped} is cropped to the artboard: {sticking}"
            );
        }
    }
}

/// A `clip-path` whose bounds can't be worked out exactly never hides
/// content: a `calc()` inset, and a path on a transformed element or inside
/// a transformed one, are taken to crop nothing, so the overflow is reported.
#[tokio::test]
async fn clip_path_bounds_that_cant_be_worked_out_hide_nothing() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Clipper").await;
    for script in [false, true] {
        let id = design(&mut agent, "Unread").await;
        let script = if script { "<script>1 + 1</script>" } else { "" };
        edit(
            &mut agent,
            &id,
            json!([{ "op": "artboard", "name": "Mock", "width": 400, "height": 300,
                     "html": format!(
                        "{script}\
                         <div data-name=\"Calc\" style=\"position: absolute; top: 0; left: 0; width: 100px; height: 600px; clip-path: inset(0 0 calc(10% + 5px) 0)\"></div>\
                         <div data-name=\"Scaled\" style=\"position: absolute; top: 0; left: 120px; width: 100px; height: 1200px; transform: scale(0.5); transform-origin: 0 0; clip-path: inset(0 0 400px 0)\"></div>\
                         <div data-name=\"Frame\" style=\"position: absolute; top: 0; left: 240px; width: 100px; height: 100px; transform: scale(0.5); transform-origin: 0 0\">\
                           <div data-name=\"Inner\" style=\"position: absolute; top: 0; left: 0; width: 100px; height: 1200px; clip-path: inset(0 0 400px 0)\"></div>\
                         </div>") }]),
        )
        .await;
        let Some(cut) = layout_of(&mut agent, &id).await else {
            return;
        };
        let sticking = cut.split("Sticking out:").nth(1).unwrap_or_default();
        for reported in ["Calc", "Scaled", "Inner"] {
            assert!(sticking.contains(reported), "{reported} is hidden: {cut}");
        }
    }
}

/// A `clip-path` crops everything inside it, including a descendant that is
/// positioned against something outside it.
#[tokio::test]
async fn clip_path_crops_descendants_whatever_positions_them() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Clipper").await;
    for script in [false, true] {
        let id = design(&mut agent, "Escapees").await;
        let script = if script { "<script>1 + 1</script>" } else { "" };
        edit(
            &mut agent,
            &id,
            json!([{ "op": "artboard", "name": "Mock", "width": 400, "height": 300,
                     "html": format!(
                        "{script}\
                         <div data-name=\"Cropper\" style=\"height: 100px; flex-shrink: 0; clip-path: inset(0)\">\
                           <div data-name=\"Escapee\" style=\"position: absolute; top: 0; left: 0; width: 100px; height: 700px\"></div>\
                         </div>\
                         <div data-name=\"Tall\" style=\"height: 900px; flex-shrink: 0\">Tall</div>") }]),
        )
        .await;
        let Some(cut) = layout_of(&mut agent, &id).await else {
            return;
        };
        let sticking = cut.split("Sticking out:").nth(1).unwrap_or_default();
        assert!(sticking.contains("\"Tall\""), "{cut}");
        assert!(!sticking.contains("Escapee"), "Escapee is cropped: {cut}");
    }
}

/// Only what shows counts toward an overlap: what a wrapper clips on one
/// axis only (`overflow-x: clip`) and what a `clip-path` crops away.
#[tokio::test]
async fn overlaps_count_only_what_shows() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Clipper").await;
    for script in [false, true] {
        let id = design(&mut agent, "Overlaps").await;
        let script = if script { "<script>1 + 1</script>" } else { "" };
        let text = |name: &str, style: &str| {
            format!("<div data-name=\"{name}\" style=\"position: absolute; {style}\">{name}</div>")
        };
        let clip_x = "overflow-x: clip; overflow-y: visible; width: 100px; height: 30px";
        let stage = [
            // Clips across only: text below the wrapper still shows.
            format!(
                "<div style=\"position: absolute; left: 0; top: 0; {clip_x}\">{}</div>",
                text("Alpha", "top: 60px; left: 0")
            ),
            text("Beta", "top: 60px; left: 0"),
            // Text right of the wrapper is clipped.
            format!(
                "<div style=\"position: absolute; left: 0; top: 120px; {clip_x}\">{}</div>",
                text("Gamma", "top: 0; left: 150px")
            ),
            text("Delta", "top: 120px; left: 150px"),
            // A clip-path crops away the part where they would overlap.
            format!(
                "<div style=\"position: absolute; left: 0; top: 200px; width: 200px; height: 30px; clip-path: inset(0 0 0 100px)\">{}</div>",
                text("Hidden", "top: 0; left: 0")
            ),
            text("Under", "top: 200px; left: 0"),
            text(
                "Own",
                "top: 240px; left: 0; width: 200px; clip-path: inset(0 0 0 100px)",
            ),
            text("Beneath", "top: 240px; left: 0; width: 80px"),
            // What the path keeps still overlaps.
            text(
                "Kept",
                "top: 280px; left: 0; width: 200px; clip-path: inset(0 100px 0 0)",
            ),
            text("Over", "top: 280px; left: 50px; width: 100px"),
        ]
        .concat();
        edit(
            &mut agent,
            &id,
            json!([{ "op": "artboard", "name": "Mock", "width": 400, "height": 400,
                     "html": format!("{script}{stage}") }]),
        )
        .await;
        let Some(layout) = layout_of(&mut agent, &id).await else {
            return;
        };
        let pairs = layout.split("overlap.").nth(1).unwrap_or_default();
        let named = |a: &str, b: &str| pairs.contains(a) && pairs.contains(b);
        assert!(pairs.contains("Alpha"), "{layout}");
        assert!(pairs.contains("Beta"), "{layout}");
        assert!(named("Kept", "Over"), "{layout}");
        for hidden in ["Gamma", "Delta", "Hidden", "Under", "Own", "Beneath"] {
            assert!(!pairs.contains(hidden), "{hidden} is hidden: {layout}");
        }
    }
}

/// An edit's result with its layout check. A slow check arrives with the next
/// result, so ask until one has.
async fn checked(agent: &mut Agent, id: &str, args: Value) -> String {
    let mut text = agent.ok("edit", args).await;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !text.contains("Layout:") && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        text = agent.ok("comments", json!({ "designId": id })).await;
    }
    text
}

/// An edit's result lists what the edit changed: findings that are new, or
/// about nodes it touched, and counts the rest in a line. Repeating the same
/// finding on every edit taught agents to turn the check off.
#[tokio::test]
async fn an_edit_reports_what_it_changed_and_counts_the_rest() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Checker").await;
    let (id, board) = landing(&mut agent).await;
    // Warms the browser, so each check beats the edit's wait.
    if layout_of(&mut agent, &id).await.is_none() {
        return;
    }
    let edit_checked = |ops: Value| json!({ "designId": id, "ops": ops });

    // The first check has nothing to compare with, so it lists everything.
    let badge = "<div data-name=\"Badge\" style=\"position: absolute; top: 380px; height: 80px; width: 80px\">New</div>";
    let first = checked(
        &mut agent,
        &id,
        edit_checked(json!([{ "op": "html", "select": format!("#{board}"), "html": badge }])),
    )
    .await;
    assert!(first.contains("\"Badge\""), "{first}");

    // An edit elsewhere doesn't repeat it.
    let other = checked(
        &mut agent,
        &id,
        edit_checked(json!([{ "op": "css", "select": "h1", "css": "letter-spacing: 1px" }])),
    )
    .await;
    assert!(!other.contains("Sticking out"), "{other}");
    assert!(
        other.contains("1 earlier note on artboard") && other.contains("unchanged by this edit"),
        "{other}"
    );

    // A new finding is listed, and the old one is still only counted.
    let tall = "<div data-name=\"Tall\" style=\"height: 900px; flex-shrink: 0\"></div>";
    let worse = checked(
        &mut agent,
        &id,
        edit_checked(json!([{ "op": "html", "select": format!("#{board}"), "html": tall }])),
    )
    .await;
    assert!(worse.contains("\"Tall\""), "{worse}");
    assert!(!worse.contains("\"Badge\""), "{worse}");
    assert!(worse.contains("1 earlier note"), "{worse}");

    // Touching the node a finding is about lists it again.
    let again = checked(
        &mut agent,
        &id,
        edit_checked(json!([{ "op": "css", "select": "[data-name=Badge]", "css": "width: 90px" }])),
    )
    .await;
    assert!(again.contains("\"Badge\""), "{again}");
    assert!(!again.contains("\"Tall\""), "{again}");
}

/// An edit to an artboard's `<style>` block restyles elements without
/// touching them, so it lists the artboard's findings again: one it made
/// worse isn't "unchanged by this edit".
#[tokio::test]
async fn a_stylesheet_edit_lists_the_findings_it_restyles() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Styler").await;
    let (id, board) = landing(&mut agent).await;
    // Warms the browser, so each check beats the edit's wait.
    if layout_of(&mut agent, &id).await.is_none() {
        return;
    }
    let badge = "<style>.badge { height: 80px }</style><div class=\"badge\" data-name=\"Badge\" style=\"position: absolute; top: 380px; width: 80px\">New</div>";
    let first = checked(
        &mut agent,
        &id,
        json!({ "designId": id, "ops": [{ "op": "html", "select": format!("#{board}"), "html": badge }] }),
    )
    .await;
    assert!(first.contains("\"Badge\""), "{first}");

    // The sheet makes it taller; the badge itself is not among the nodes edited.
    let worse = checked(
        &mut agent,
        &id,
        json!({ "designId": id, "ops": [{ "op": "css", "select": format!("#{board}"),
                "css": ".badge { height: 200px }", "to": "style" }] }),
    )
    .await;
    assert!(
        worse.contains("Sticking out:") && worse.contains("\"Badge\""),
        "{worse}"
    );
}

/// `as: "computed"` asks the browser, so a token shows the value its
/// artboard's mode gives it, on a plain artboard and on one that runs a
/// script, and the outline shows a size token as the size.
#[tokio::test]
async fn computed_values_follow_the_artboards_mode() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Prober").await;
    let id = design(&mut agent, "Modes").await;
    let button = "<button class=\"btn\" style=\"background-color: var(--bg); width: 100%; height: var(--button-h); color: var(--fg)\">Go</button>";
    let made = edit(
        &mut agent,
        &id,
        json!([
            { "op": "tokens", "set": {
                "--bg": { "Light": "#fafcfb", "Dark": "#0b0f0d" },
                "--fg": "#123456",
                "--button-h": "44px" }, "modes": ["Light", "Dark"] },
            { "op": "artboard", "name": "Light", "width": 300, "height": 200, "html": button },
            { "op": "artboard", "name": "Dark", "width": 300, "height": 200, "mode": "Dark", "html": button },
            { "op": "artboard", "name": "Scripted", "width": 300, "height": 200, "mode": "Dark",
              "html": format!("{button}<script>document.title = 'ran'</script>") },
        ]),
    )
    .await;
    let outline = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ":root", "depth": 3 }),
        )
        .await;
    assert!(
        !made.is_empty() && !outline.contains("var(--button-h)"),
        "{outline}"
    );
    assert!(outline.contains("[100% × 44px]"), "{outline}");
    // Like render, it takes at most ten matches.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Spare", "width": 100, "html": "<p>One</p><p>Two</p><p>Three</p><p>Four</p>" }]),
    )
    .await;
    let (many, error) = agent
        .call(
            "read",
            json!({ "designId": id, "select": "*", "as": "computed" }),
        )
        .await;
    assert!(error && many.contains("takes at most 10"), "{many}");
    let (probe, _) = agent
        .call("render", json!({ "designId": id, "output": "layout" }))
        .await;
    if probe.contains("no Chrome") {
        assert!(
            std::env::var_os("FINITE_REQUIRE_BROWSER").is_none(),
            "FINITE_REQUIRE_BROWSER is set but there is no browser: {probe}"
        );
        eprintln!("SKIPPED, NOTHING WAS TESTED: no Chrome, Chromium or Edge found");
        return;
    }
    let read = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ".btn", "as": "computed",
                    "properties": ["backgroundColor", "--bg", "--fg", "height", "--missing"] }),
        )
        .await;
    let sections: Vec<&str> = read.split("<!-- ").skip(1).collect();
    assert_eq!(sections.len(), 3, "{read}");
    let value = |section: &str, name: &str| -> String {
        section
            .lines()
            .find_map(|l| l.trim().strip_prefix(&format!("{name}: ")))
            .unwrap_or_else(|| panic!("{name} in {section}"))
            .to_owned()
    };
    let light = sections.iter().find(|s| s.contains("\"Light\"")).unwrap();
    assert_eq!(value(light, "background-color"), "rgb(250, 252, 251)");
    assert_eq!(value(light, "--bg"), "#fafcfb");
    assert!(light.contains("(mode \"Light\")"), "{light}");
    // Both renderers: a plain artboard and one that runs a script.
    for name in ["Dark", "Scripted"] {
        let dark = sections
            .iter()
            .find(|s| s.contains(&format!("\"{name}\"")))
            .unwrap();
        assert_eq!(value(dark, "background-color"), "rgb(11, 15, 13)", "{dark}");
        assert_eq!(value(dark, "--bg"), "#0b0f0d");
        assert_eq!(value(dark, "--fg"), "#123456");
        assert_eq!(value(dark, "height"), "44px");
        assert_eq!(value(dark, "--missing"), "(not set)");
        assert!(dark.contains("(mode \"Dark\")"), "{dark}");
    }
    // The default set, and a bad name.
    let short = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "[data-name=Dark] .btn", "as": "computed" }),
        )
        .await;
    for name in [
        "color",
        "font",
        "padding",
        "gap",
        "border-radius",
        "display",
    ] {
        assert!(short.contains(&format!("  {name}: ")), "{name}: {short}");
    }
    let (bad, error) = agent
        .call(
            "read",
            json!({ "designId": id, "select": ".btn", "as": "computed", "properties": ["a;b"] }),
        )
        .await;
    assert!(error && bad.contains("isn't a CSS property"), "{bad}");
}

/// The browser measures the artboard as it was when the read began. If the
/// design changes meanwhile, the result keeps the labels and mode of that
/// snapshot and says to read again, instead of pairing a new mode with old
/// values or showing a deleted element's values as current.
#[tokio::test]
async fn computed_values_say_when_the_design_changed_meanwhile() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Prober").await;
    let mut editor = Agent::connect(&app, "Editor").await;
    let id = design(&mut agent, "Race").await;
    // The animation makes the browser wait out the settle delay, so there is time to edit.
    let board = "<style>@keyframes fade { to { opacity: .5 } } .fade { animation: fade 10s infinite }</style><div class=\"fade\">…</div><button class=\"btn\" style=\"background-color: var(--bg)\">Go</button>";
    edit(
        &mut agent,
        &id,
        json!([
            { "op": "tokens", "set": { "--bg": { "Light": "#fafcfb", "Dark": "#0b0f0d" } }, "modes": ["Light", "Dark"] },
            { "op": "artboard", "name": "Flip", "width": 300, "height": 200, "mode": "Dark", "html": board },
            { "op": "artboard", "name": "Gone", "width": 300, "height": 200, "mode": "Dark", "html": board },
        ]),
    )
    .await;
    let (probe, _) = agent
        .call("render", json!({ "designId": id, "output": "layout" }))
        .await;
    if probe.contains("no Chrome") {
        assert!(
            std::env::var_os("FINITE_REQUIRE_BROWSER").is_none(),
            "FINITE_REQUIRE_BROWSER is set but there is no browser: {probe}"
        );
        eprintln!("SKIPPED, NOTHING WAS TESTED: no Chrome, Chromium or Edge found");
        return;
    }
    let read = json!({ "designId": id, "select": ".btn", "as": "computed", "properties": ["background-color"] });
    // A mode switch while the browser measures.
    let (read_now, _) = tokio::join!(agent.ok("read", read.clone()), async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        edit(
            &mut editor,
            &id,
            json!([{ "op": "move", "select": "[data-name=Flip]", "mode": "Light" }]),
        )
        .await
    });
    let flip = read_now
        .split("<!-- ")
        .find(|s| s.contains("\"Flip\""))
        .unwrap_or_else(|| panic!("{read_now}"));
    assert!(flip.contains("rgb(11, 15, 13)"), "{read_now}");
    assert!(
        flip.contains("(mode \"Dark\")") && !flip.contains("(mode \"Light\")"),
        "the Dark values must not be labeled Light: {read_now}"
    );
    assert!(read_now.contains("Read again"), "{read_now}");
    // An element deleted while the browser measures.
    let (read_now, _) = tokio::join!(agent.ok("read", read), async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        edit(
            &mut editor,
            &id,
            json!([{ "op": "remove", "select": "[data-name=Gone] .btn" }]),
        )
        .await
    });
    assert!(read_now.contains("Read again"), "{read_now}");
}

/// The outline shows a token's value for `var()` only where nothing nearer
/// sets that custom property: an ancestor or the element itself in a style
/// attribute, or a `<style>` block, which the outline doesn't evaluate.
#[tokio::test]
async fn the_outline_keeps_var_where_the_cascade_sets_it() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Sizer").await;
    let id = design(&mut agent, "Cascade").await;
    edit(
        &mut agent,
        &id,
        json!([
            { "op": "tokens", "set": { "--button-h": "44px" } },
            { "op": "artboard", "name": "Sizes", "width": 300, "height": 300, "html": concat!(
                "<button data-name=\"Own\" style=\"--button-h:60px;width:100px;height:var(--button-h)\">Own</button>",
                "<button data-name=\"Fallback\" style=\"--local:60px;width:100px;height:var(--local,8px)\">Fallback</button>",
                "<div style=\"--button-h:70px\"><button data-name=\"Inherited\" style=\"width:100px;height:var(--button-h)\">Inherited</button></div>",
                "<button data-name=\"Token\" style=\"width:100px;height:var(--button-h)\">Token</button>",
            ) },
        ]),
    )
    .await;
    let outline = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ":root", "depth": 3 }),
        )
        .await;
    let line = |name: &str| {
        outline
            .lines()
            .find(|l| l.contains(&format!("\"{name}\"")))
            .unwrap_or_else(|| panic!("{name} in {outline}"))
            .to_owned()
    };
    assert!(
        line("Own").contains("[100px × var(--button-h)]"),
        "{outline}"
    );
    assert!(
        line("Fallback").contains("[100px × var(--local,8px)]"),
        "{outline}"
    );
    assert!(
        line("Inherited").contains("[100px × var(--button-h)]"),
        "{outline}"
    );
    assert!(line("Token").contains("[100px × 44px]"), "{outline}");
    // A stylesheet might set it anywhere, so it stays as written too.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Sheet", "width": 300, "height": 100, "html":
            "<style>.big { --button-h: 90px }</style><button class=\"big\" data-name=\"Classed\" style=\"width:100px;height:var(--button-h)\">Big</button>" }]),
    )
    .await;
    let outline = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "[data-name=Sheet]", "depth": 3 }),
        )
        .await;
    assert!(outline.contains("[100px × var(--button-h)]"), "{outline}");
    // A longer name that ends the same way doesn't set it.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Suffix", "width": 300, "height": 100, "html":
            "<style>.x { --big--button-h: 90px }</style><button data-name=\"Plain\" style=\"width:100px;height:var(--button-h)\">Plain</button>" }]),
    )
    .await;
    let outline = agent
        .ok(
            "read",
            json!({ "designId": id, "select": "[data-name=Suffix]", "depth": 3 }),
        )
        .await;
    assert!(outline.contains("[100px × 44px]"), "{outline}");
}

/// A component op makes one top bar the component and its copies on the
/// other screens instances, in the same edit that built the screens, and an
/// edit to the component reaches every instance.
#[tokio::test]
async fn components_are_made_used_and_detached_in_edits() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Builder").await;
    let id = design(&mut agent, "App").await;
    let nav = |title: &str| {
        format!(
            "<header data-name=\"Nav\" style=\"background: #111827\"><h1 data-name=\"Title\">{title}</h1></header>"
        )
    };
    let made = edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Home", "width": 400, "height": 300, "html": nav("Home") },
            { "op": "artboard", "name": "Settings", "width": 400, "height": 300, "html": nav("Settings") },
            { "op": "component", "select": "[data-name=Nav]", "name": "Top bar", "as": "bar" },
            { "op": "css", "select": "@bar", "css": "background: #f97316" },
        ]),
    )
    .await;
    assert!(made.contains("is a component"), "{made}");
    assert!(!made.contains("New in the component"), "{made}");
    assert!(made.contains("Replaced 1 copy with instances"), "{made}");
    assert!(
        made.contains("#") && made.contains(": 1 override"),
        "{made}"
    );
    let home = id_after(&made, "Created artboard");
    let bar = id_after(&made, "3. component: header");
    let instance = id_after(&made, "Replaced 1 copy with instances, keeping their ids:");

    // The overview lists it, and the instance shows the component's new
    // color with its own title.
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains(&format!("Components: \"Top bar\" #{bar} (1 instance)")),
        "{overview}"
    );
    let shown = html(&mut agent, &id, &format!("#{instance}")).await;
    assert!(
        shown.contains("#f97316") && shown.contains("Settings"),
        "{shown}"
    );
    assert!(
        shown.contains("Elements with data-instance-of are instances"),
        "{shown}"
    );
    let root = html(&mut agent, &id, &format!("#{bar}")).await;
    assert!(root.contains("which 1 instance shows"), "{root}");

    // An edit to the component says it reached the instance, and one
    // inside the instance says only it changed.
    let recolored = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": &format!("#{bar}"), "css": "color: #fff" }]),
    )
    .await;
    assert!(
        recolored.contains("so all 1 instance show it too"),
        "{recolored}"
    );
    let marker = format!("data-id=\"{instance}/");
    let at = shown.find(&marker).expect("a node inside the instance") + marker.len();
    let title: String = shown[at..]
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    let own = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": &format!("#{instance}/{title}"), "css": "color: #22c55e" }]),
    )
    .await;
    assert!(own.contains(&format!("Only instance #{instance}")), "{own}");

    // data-instance-of in html adds another instance.
    let added = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Profile", "width": 400, "height": 300,
                 "html": format!("<header data-instance-of=\"{bar}\"></header>") }]),
    )
    .await;
    assert!(
        added.contains(&format!("instance of \"Top bar\" #{bar}")),
        "{added}"
    );

    // Detach makes it a plain copy, and undo makes it an instance again.
    let detached = edit(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": &format!("#{instance}"), "detach": true }]),
    )
    .await;
    assert!(detached.contains("Detached 1 instance"), "{detached}");
    let plain = html(&mut agent, &id, &format!("#{instance}")).await;
    assert!(
        !plain.contains("data-instance-of") && plain.contains("Settings"),
        "{plain}"
    );
    agent.ok("undo", json!({ "designId": id })).await;
    let back = html(&mut agent, &id, &format!("#{instance}")).await;
    assert!(back.contains("data-instance-of"), "{back}");

    // A copy built differently can't become an instance, and nothing changes.
    let refusal = refused(
        &mut agent,
        &id,
        json!([
            { "op": "html", "select": format!("#{home}"), "html": "<header data-name=\"Nav\"><p>Other</p></header>" },
            { "op": "component", "select": "[data-name=\"Top bar\"], [data-name=Nav]" },
        ]),
    )
    .await;
    assert!(
        refusal.contains("op 2 (component)") && refusal.contains("Nothing was changed"),
        "{refusal}"
    );
}

/// A design whose "Top bar" component is on two artboards, "Home" and "Settings".
async fn two_screens(agent: &mut Agent) -> (String, String, String) {
    let id = design(agent, "App").await;
    let nav = |title: &str| {
        format!("<header data-name=\"Nav\"><h1 data-name=\"Title\">{title}</h1></header>")
    };
    let made = edit(
        agent,
        &id,
        json!([
            { "op": "artboard", "name": "Home", "width": 400, "height": 300, "html": nav("Home") },
            { "op": "artboard", "name": "Settings", "width": 400, "height": 300, "html": nav("Settings") },
            { "op": "component", "select": "[data-name=Nav]", "name": "Top bar", "as": "bar" },
        ]),
    )
    .await;
    let home = id_after(&made, "Created artboard");
    let bar = id_after(&made, "3. component: header");
    (id, home, bar)
}

#[tokio::test]
async fn a_copy_can_be_frozen_so_component_edits_leave_it_alone() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Snapshot").await;
    let (id, home, bar) = two_screens(&mut agent).await;

    // A plain copy still follows the component, and says so.
    let live = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "from": format!("#{home}"), "name": "Live copy" }]),
    )
    .await;
    assert!(
        live.contains(
            "1 instance still follows its component; pass detach: true for a frozen copy"
        ),
        "{live}"
    );
    let live_board = id_after(&live, " as #");

    let frozen = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "from": format!("#{home}"), "name": "Before", "detach": true }]),
    )
    .await;
    assert!(
        frozen.contains("Detached 1 instance in the copy") && !frozen.contains("still follow"),
        "{frozen}"
    );
    let frozen_board = id_after(&frozen, " as #");

    // The move op's copy takes the flag too, and only with copy.
    let moved = edit(
        &mut agent,
        &id,
        json!([{ "op": "move", "select": format!("#{home}"), "copy": true, "detach": true, "x": 3000, "y": 0 }]),
    )
    .await;
    assert!(moved.contains("Detached 1 instance in the copy"), "{moved}");
    let kept = refused(
        &mut agent,
        &id,
        json!([{ "op": "move", "select": format!("#{home}"), "detach": true, "x": 3000, "y": 0 }]),
    )
    .await;
    assert!(kept.contains("needs copy: true"), "{kept}");

    // Edit the component: the live copy follows, the frozen one doesn't.
    edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": format!("#{bar}"), "css": "background: #f97316" }]),
    )
    .await;
    assert!(
        html(&mut agent, &id, &format!("#{live_board}"))
            .await
            .contains("#f97316")
    );
    let snapshot = html(&mut agent, &id, &format!("#{frozen_board}")).await;
    assert!(
        !snapshot.contains("#f97316")
            && !snapshot.contains("data-instance-of")
            && snapshot.contains("Home"),
        "{snapshot}"
    );

    // Undo reverses the css edit, the move's copy, then the frozen copy with
    // its detaching in one step.
    agent
        .ok("undo", json!({ "designId": id, "steps": 3 }))
        .await;
    let overview = agent.ok("read", json!({ "designId": id })).await;
    assert!(!overview.contains("Before"), "{overview}");
    assert!(overview.contains("Live copy"), "{overview}");
}

#[tokio::test]
async fn detach_takes_an_artboard_and_frees_every_instance_inside_it() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Detacher").await;
    let (id, home, _) = two_screens(&mut agent).await;
    let settings = id_after(
        &agent.ok("read", json!({ "designId": id })).await,
        "Settings",
    );
    let detached = edit(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": ":root", "detach": true }]),
    )
    .await;
    assert!(detached.contains("Detached 1 instance"), "{detached}");
    for board in [&home, &settings] {
        assert!(
            !html(&mut agent, &id, &format!("#{board}"))
                .await
                .contains("data-instance-of"),
        );
    }
    let none = refused(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": &format!("#{home}"), "detach": true }]),
    )
    .await;
    assert!(none.contains("matches no instance"), "{none}");
}

#[tokio::test]
async fn detaching_a_screen_freezes_nested_components_and_spares_definitions() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Freezer").await;
    let id = design(&mut agent, "Nested").await;
    let made = edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Parts", "width": 400, "height": 300,
              "html": "<span data-component=\"Logo\">Finite</span>" },
            { "op": "artboard", "name": "Screen", "width": 400, "height": 300 },
        ]),
    )
    .await;
    let parts = id_after(&made, "Created artboard");
    let screen = id_after(&agent.ok("read", json!({ "designId": id })).await, "Screen");
    // Each part holds an instance of the one before it.
    let mut inner = String::new();
    for (name, tag) in [("Logo", "span"), ("Bar", "header"), ("Page", "main")] {
        if name != "Logo" {
            let source = format!(
                "<{tag} data-component=\"{name}\"><div data-instance-of=\"{inner}\"></div></{tag}>"
            );
            edit(
                &mut agent,
                &id,
                json!([{ "op": "html", "select": format!("#{parts}"), "html": source }]),
            )
            .await;
        }
        let found = html(&mut agent, &id, &format!("[data-name={name}]")).await;
        inner = found
            .split("data-id=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("the component's id")
            .to_owned();
    }
    edit(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": format!("#{screen}"), "html": format!("<main data-instance-of=\"{inner}\"></main>") }]),
    )
    .await;

    // Freezing the screen leaves one copy of each part, and the parts alone.
    let before = html(&mut agent, &id, &format!("#{parts}")).await;
    let detached = edit(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": &format!("#{screen}"), "detach": true }]),
    )
    .await;
    assert!(detached.contains("Detached 3 instances"), "{detached}");
    let frozen = html(&mut agent, &id, &format!("#{screen}")).await;
    assert_eq!(frozen.matches("Finite").count(), 1, "{frozen}");
    assert!(!frozen.contains("data-instance-of"), "{frozen}");

    // The board that holds the definitions has no instance of its own to
    // detach, and the Logo instance inside Bar stays one.
    let none = refused(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": &format!("#{parts}"), "detach": true }]),
    )
    .await;
    assert!(none.contains("matches no instance"), "{none}");
    let after = html(&mut agent, &id, &format!("#{parts}")).await;
    let from_name = |text: &str| text[text.find("data-name").unwrap()..].to_owned();
    assert_eq!(from_name(&after), from_name(&before));

    agent.ok("undo", json!({ "designId": id })).await;
    let restored = html(&mut agent, &id, &format!("#{screen}")).await;
    assert!(restored.contains("data-instance-of"), "{restored}");
}

#[tokio::test]
async fn removing_a_screen_warns_about_comments_and_pin_moves_them() {
    let (app, hub) = server();
    let mut agent = Agent::connect(&app, "Rebuilder").await;
    let (id, board) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let title = handle.read(|d| {
        d.view()
            .subtree(&board)
            .iter()
            .find(|n| n.tag() == Some("h1"))
            .unwrap()
            .id
            .clone()
    });
    let person = || Author {
        id: "user:ada".into(),
        name: "Ada".into(),
        kind: AuthorKind::User,
    };
    let comment = |node: &str| {
        handle
            .add_comment(
                person(),
                Anchor {
                    artboard_id: Some(board.clone()),
                    node_id: Some(node.into()),
                    extra_node_ids: Vec::new(),
                    x: 10.0,
                    y: 10.0,
                },
                Audience::Agents,
                "Make it orange",
            )
            .unwrap()
            .id
    };
    let (on_title, on_board) = (comment(&title), comment(&board));

    // Removing the title only costs the first comment its element.
    let dry = agent
        .ok(
            "edit",
            json!({ "designId": id, "dryRun": true, "op": "remove", "select": format!("#{title}") }),
        )
        .await;
    assert!(
        dry.contains("1 open comment is pinned to elements inside")
            && dry.contains(&on_title)
            && dry.contains("node: null"),
        "{dry}"
    );

    // Removing the artboard orphans both.
    let removed = edit(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": format!("#{board}") }]),
    )
    .await;
    assert!(
        removed.contains("2 open comments are pinned inside")
            && removed.contains("artboardDeleted: true")
            && removed.contains("pin: [")
            && removed.contains(&on_title)
            && removed.contains(&on_board),
        "{removed}"
    );
    let listed = agent.ok("comments", json!({ "designId": id })).await;
    assert!(listed.contains("\"artboardDeleted\": true"), "{listed}");

    // The screen is rebuilt and the comments are pinned to it.
    let rebuilt = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Home", "width": 600, "height": 400,
                 "html": "<h1 data-name=\"Title\">Hello</h1>" }]),
    )
    .await;
    let new_board = id_after(&rebuilt, "Created artboard");
    let pinned = agent
        .ok(
            "comments",
            json!({ "designId": id, "pin": [
                { "commentId": on_title, "select": "h1" },
                { "commentId": on_board, "select": format!("#{new_board}") }] }),
        )
        .await;
    assert!(
        pinned.contains(&format!("Pinned {on_title}, {on_board}")),
        "{pinned}"
    );
    let listed = agent.ok("comments", json!({ "designId": id })).await;
    assert!(
        listed.contains("\"artboardDeleted\": false")
            && !listed.contains("\"artboardDeleted\": true")
            && listed.contains(&format!("\"artboardId\": \"{new_board}\"")),
        "{listed}"
    );
    // The viewer is told: the comment it holds has the new artboard.
    let pinned = handle.comments();
    assert!(
        pinned
            .iter()
            .all(|c| c.artboard_id.as_deref() == Some(new_board.as_str()))
    );
    assert!(pinned.iter().all(|c| c.detached_at.is_none()));

    // A selector that matches several elements, or none, changes nothing.
    let (many, error) = agent
        .call(
            "comments",
            json!({ "designId": id, "pin": [{ "commentId": on_title, "select": "*" }] }),
        )
        .await;
    assert!(error && many.contains("pin takes one"), "{many}");
}

/// The name of a tool that no longer exists, if `text` mentions one.
fn old_tool_name(text: &str) -> Option<&'static str> {
    [
        "update_styles",
        "write_html",
        "set_attributes",
        "replace_values",
        "detach_instance",
        "set_text_content",
        "move_nodes",
        "delete_nodes",
        "get_html",
        "get_screenshot",
        "create_component",
        "insert_instance",
    ]
    .into_iter()
    .find(|name| text.contains(name))
}

/// A failed edit says what to do with an edit op, and never names a tool that no longer exists.
#[tokio::test]
async fn errors_tell_agents_which_op_to_use() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Errors").await;
    let (id, board) = landing(&mut agent).await;

    let style = refused(
        &mut agent,
        &id,
        json!([{ "op": "attrs", "select": "h1", "set": { "style": null } }]),
    )
    .await;
    assert!(
        style.contains("style isn't an attribute") && style.contains("\"op\": \"css\""),
        "{style}"
    );
    let styled = style
        .split('#')
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_alphanumeric()).next())
        .expect("the node the style was refused on");
    assert!(
        style.contains(&format!("\"select\": \"#{styled}\"")),
        "{style}"
    );
    assert_eq!(old_tool_name(&style), None, "{style}");

    let replaced = refused(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": format!("#{board}"), "mode": "replace", "html": "<div>x</div>" }]),
    )
    .await;
    assert!(replaced.contains("mode \"inner\""), "{replaced}");
    assert!(!replaced.contains("replace-children"), "{replaced}");
    assert_eq!(old_tool_name(&replaced), None, "{replaced}");

    let nav = |title: &str| {
        format!("<header data-name=\"Nav\"><h1 data-name=\"Title\">{title}</h1></header>")
    };
    let made = edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Home", "width": 400, "height": 300, "html": nav("Home") },
            { "op": "artboard", "name": "Settings", "width": 400, "height": 300, "html": nav("Settings") },
            { "op": "component", "select": "[data-name=Nav]", "name": "Top bar", "as": "bar" },
        ]),
    )
    .await;
    let bar = id_after(&made, "3. component:");
    let instance = id_after(&made, "Replaced 1 copy");
    let shown = html(&mut agent, &id, &format!("#{instance}")).await;
    let marker = format!("data-id=\"{instance}/");
    let at = shown.find(&marker).expect("a node inside the instance") + marker.len();
    let title: String = shown[at..]
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    let part = format!("{instance}/{title}");

    // inner html replaces the heading's children. The refusal names the
    // heading, not the text node under it, and says how to set its text.
    let inner = refused(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": format!("#{part}"), "mode": "inner", "html": "Inbox" }]),
    )
    .await;
    assert!(
        inner.contains(&format!("#{part} is inside instance #{instance}"))
            && inner.contains("mode inner replaces its children")
            && inner.contains("\"in\": \"text\"")
            && inner.contains(&format!("\"select\": \"#{part}\""))
            && inner.contains(&format!("\"select\": \"#{instance}\""))
            && inner.contains("\"detach\": true"),
        "{inner}"
    );
    assert!(
        !inner.contains(&format!("{part}/")),
        "names a child of the selection: {inner}"
    );
    let other_part = inner.split('#').skip(1).any(|tail| {
        let id: String = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '/' || *c == '_' || *c == '-')
            .collect();
        id.contains('/') && id != part
    });
    assert!(
        !other_part,
        "names a node other than the selection: {inner}"
    );
    assert_eq!(old_tool_name(&inner), None, "{inner}");

    let deep = refused(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": format!("#{part}"), "detach": true }]),
    )
    .await;
    assert!(
        deep.contains(&format!("\"select\": \"#{instance}\"")) && deep.contains("\"detach\": true"),
        "{deep}"
    );
    assert_eq!(old_tool_name(&deep), None, "{deep}");

    let removed = refused(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": format!("#{part}") }]),
    )
    .await;
    assert!(
        removed.contains(&format!("\"select\": \"#{instance}\""))
            && removed.contains("\"detach\": true"),
        "{removed}"
    );
    assert_eq!(old_tool_name(&removed), None, "{removed}");

    let nested = refused(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": format!("#{part}"), "name": "Title" }]),
    )
    .await;
    assert!(
        nested.contains(&format!("\"select\": \"#{instance}\""))
            && nested.contains("\"detach\": true"),
        "{nested}"
    );
    assert_eq!(old_tool_name(&nested), None, "{nested}");

    let plain = edit(
        &mut agent,
        &id,
        json!([{ "op": "html", "select": format!("#{board}"), "html": "<div data-name=\"Plain\">x</div>" }]),
    )
    .await;
    let plain_id = id_after(&plain, "div");
    let not_component = refused(
        &mut agent,
        &id,
        json!([{
            "op": "html",
            "select": format!("#{board}"),
            "html": format!("<div data-instance-of=\"{plain_id}\"></div>")
        }]),
    )
    .await;
    assert!(
        not_component.contains("isn't a component")
            && not_component.contains(&format!("\"select\": \"#{plain_id}\"")),
        "{not_component}"
    );
    assert_eq!(old_tool_name(&not_component), None, "{not_component}");

    let extra = refused(
        &mut agent,
        &id,
        json!([{
            "op": "html",
            "select": format!("#{board}"),
            "html": format!("<header data-instance-of=\"{bar}\"><p>Extra</p></header>")
        }]),
    )
    .await;
    assert!(extra.contains("read with as: \"html\""), "{extra}");
    assert_eq!(old_tool_name(&extra), None, "{extra}");

    // The advice above is the edit that actually sets one instance's text.
    let changed = edit(
        &mut agent,
        &id,
        json!([{
            "op": "replace",
            "select": format!("#{part}"),
            "find": "Settings",
            "replace": "Inbox",
            "in": "text"
        }]),
    )
    .await;
    assert!(changed.contains("Replaced 1 use"), "{changed}");
    let instance_html = html(&mut agent, &id, &format!("#{instance}")).await;
    let component_html = html(&mut agent, &id, &format!("#{bar}")).await;
    assert!(instance_html.contains(">Inbox<"), "{instance_html}");
    assert!(
        component_html.contains(">Home<") && !component_html.contains("Inbox"),
        "{component_html}"
    );

    // A <script> inside an instance isn't visible text. inner names that
    // node and says to replace in code, and following that changes only
    // this instance.
    let widget = "<div data-name=\"Widget\"><script>var marker = home</script></div>";
    let coded = edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Code", "width": 400, "height": 200, "html": widget },
            { "op": "artboard", "name": "Code copy", "width": 400, "height": 200, "html": widget },
            { "op": "component", "select": "[data-name=Widget]", "name": "Widget" },
        ]),
    )
    .await;
    let widget_component = id_after(&coded, "3. component:");
    let widget_instance = id_after(&coded, "Replaced 1 copy");
    let widget_html = html(&mut agent, &id, &format!("#{widget_instance}")).await;
    let script_at = widget_html
        .find("<script")
        .expect("a script in the instance");
    let script_tag =
        &widget_html[script_at..script_at + widget_html[script_at..].find('>').unwrap()];
    let marker = "data-id=\"";
    let at = script_tag.find(marker).expect("the script's data-id") + marker.len();
    let script: String = script_tag[at..].chars().take_while(|c| *c != '"').collect();
    let script_inner = refused(
        &mut agent,
        &id,
        json!([{
            "op": "html",
            "select": format!("#{script}"),
            "mode": "inner",
            "html": "var marker = inbox"
        }]),
    )
    .await;
    assert!(
        script_inner.contains(&format!("#{script} is inside instance #{widget_instance}"))
            && script_inner.contains("\"in\": \"code\"")
            && script_inner.contains(&format!("\"select\": \"#{script}\""))
            && !script_inner.contains("\"in\": \"text\""),
        "{script_inner}"
    );
    assert_eq!(old_tool_name(&script_inner), None, "{script_inner}");
    let script_changed = edit(
        &mut agent,
        &id,
        json!([{
            "op": "replace",
            "select": format!("#{script}"),
            "find": "home",
            "replace": "inbox",
            "in": "code"
        }]),
    )
    .await;
    assert!(
        script_changed.contains("Replaced 1 use"),
        "{script_changed}"
    );
    let instance_code = html(&mut agent, &id, &format!("#{widget_instance}")).await;
    let component_code = html(&mut agent, &id, &format!("#{widget_component}")).await;
    assert!(
        instance_code.contains("var marker = inbox"),
        "{instance_code}"
    );
    assert!(
        component_code.contains("var marker = home") && !component_code.contains("inbox"),
        "{component_code}"
    );
}

/// Detach and read find instances by the `data-instance-of` marker read's
/// HTML writes, including under an artboard.
#[tokio::test]
async fn detach_finds_instances_by_data_instance_of() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Builder").await;
    let id = design(&mut agent, "App").await;
    let made = edit(
        &mut agent,
        &id,
        json!([{
            "op": "artboard",
            "name": "Home",
            "width": 400,
            "height": 300,
            "html": "<header data-component=\"Top bar\"><h1>Home</h1></header><header data-component=\"Top bar\"><h1>Settings</h1></header>"
        }]),
    )
    .await;
    let board = id_after(&made, "Created artboard");
    let shown = html(&mut agent, &id, &format!("#{board}")).await;
    let marker = "data-instance-of=\"";
    let at = shown
        .find(marker)
        .unwrap_or_else(|| panic!("an instance in {shown}"))
        + marker.len();
    let component: String = shown[at..].chars().take_while(|c| *c != '"').collect();
    assert!(!component.is_empty(), "{shown}");

    let by_value = html(
        &mut agent,
        &id,
        &format!("[data-instance-of=\"{component}\"]"),
    )
    .await;
    assert!(
        by_value.contains(&format!("data-instance-of=\"{component}\""))
            && !by_value.contains("data-component"),
        "{by_value}"
    );
    let root = html(&mut agent, &id, "[data-component=\"Top bar\"]").await;
    assert!(
        root.contains("data-component=\"Top bar\"") && !root.contains("data-instance-of"),
        "{root}"
    );

    let detached = edit(
        &mut agent,
        &id,
        json!([{
            "op": "component",
            "select": format!("#{board} [data-instance-of]"),
            "detach": true
        }]),
    )
    .await;
    assert!(detached.contains("Detached 1 instance"), "{detached}");
    let plain = html(&mut agent, &id, &format!("#{board}")).await;
    assert!(
        !plain.contains("data-instance-of") && plain.contains("Settings"),
        "{plain}"
    );

    agent.ok("undo", json!({ "designId": id })).await;
    let back = html(&mut agent, &id, &format!("#{board}")).await;
    assert!(back.contains("data-instance-of"), "{back}");
    let again = edit(
        &mut agent,
        &id,
        json!([{
            "op": "component",
            "select": format!("[data-instance-of=\"{component}\"]"),
            "detach": true
        }]),
    )
    .await;
    assert!(again.contains("Detached 1 instance"), "{again}");
}

#[tokio::test]
async fn each_comment_goes_to_one_agent() {
    let (app, hub) = server();
    let mut ada = Agent::connect(&app, "Ada").await;
    let mut bo = Agent::connect(&app, "Bo").await;
    let (id, board) = landing(&mut ada).await;
    edit(&mut ada, &id, json!([{ "op": "page", "create": "Drafts" }])).await;
    let handle = hub.open(&id).await.unwrap();
    let person = Author {
        id: "user:cy".into(),
        name: "Cy".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some(board.clone()),
        node_id: None,
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 10.0,
    };
    let post = |audience, body| {
        handle
            .add_comment(person.clone(), anchor.clone(), audience, body)
            .unwrap()
    };
    let wait = json!({ "designId": id, "wait": 1 });

    let none = |reply: String| {
        reply.contains("No comments arrived in 1 seconds. Call again to keep listening.")
    };
    // Both agents listen. Ada made the board, so its comments go to Ada.
    assert!(none(ada.ok("comments", wait.clone()).await));
    assert!(none(bo.ok("comments", wait.clone()).await));
    let orange = post(Audience::Agents, "Make it orange");
    assert!(none(bo.ok("comments", wait.clone()).await));
    let mine = ada.ok("comments", wait.clone()).await;
    assert!(
        mine.contains("Make it orange") && mine.contains("\"for\": \"you\""),
        "{mine}"
    );
    let listed = bo.ok("comments", json!({ "designId": id })).await;
    assert!(
        listed.contains("\"for\": \"Ada (another agent)\""),
        "{listed}"
    );

    // Passing hands it to the other agent, and a person's follow-up goes
    // back to the agent that took it.
    let passed = ada
        .ok(
            "comments",
            json!({ "designId": id, "pass": [orange.id], "wait": 1 }),
        )
        .await;
    assert!(
        passed.contains("Passed on") && none(passed.clone()),
        "{passed}"
    );
    let theirs = bo.ok("comments", wait.clone()).await;
    assert!(
        theirs.contains("Make it orange") && theirs.contains("passedBy"),
        "{theirs}"
    );
    handle
        .reply(&orange.id, person.clone(), "Darker, please", None)
        .unwrap();
    assert!(none(ada.ok("comments", wait.clone()).await));
    assert!(
        bo.ok("comments", wait.clone())
            .await
            .contains("Darker, please")
    );

    // A person's pick wins.
    handle
        .set_audience(
            &orange.id,
            Audience::Agent {
                id: "agent:Ada".into(),
                name: "Ada".into(),
            },
        )
        .unwrap();
    assert!(none(bo.ok("comments", wait.clone()).await));
    let mentions = json!({ "designId": id, "mentions": true, "wait": 1 });
    assert!(
        ada.ok("comments", mentions)
            .await
            .contains("Darker, please")
    );

    // An agent marks a note between people, and then nobody gets it.
    let note = post(Audience::Agents, "Ask the client about blue");
    let marked = ada
        .ok(
            "comments",
            json!({ "designId": id, "forPeople": [note.id], "wait": 1 }),
        )
        .await;
    assert!(
        marked.contains("Marked") && !marked.contains("Ask the client"),
        "{marked}"
    );
    let listed = bo.ok("comments", json!({ "designId": id })).await;
    assert!(listed.contains("\"for\": \"people\""), "{listed}");
    let overview = bo.ok("read", json!({ "designId": id })).await;
    assert!(
        overview.contains("2 open comments (0 waiting for you)"),
        "{overview}"
    );
    assert!(
        !overview.contains("waiting for you: call comments"),
        "{overview}"
    );

    // Filters narrow what an agent hears.
    handle
        .reply(&orange.id, person.clone(), "Even darker", None)
        .unwrap();
    let drafts = json!({ "designId": id, "page": "Drafts", "wait": 1 });
    assert!(none(ada.ok("comments", drafts).await));
    let home = json!({ "designId": id, "select": format!("#{board}"), "wait": 1 });
    assert!(ada.ok("comments", home).await.contains("Even darker"));

    // An agent listening to another page doesn't hold up comments here.
    let drafts = json!({ "designId": id, "page": "Drafts", "wait": 1 });
    assert!(none(ada.ok("comments", drafts).await));
    post(Audience::Agents, "Make it pink");
    assert!(
        bo.ok("comments", wait.clone())
            .await
            .contains("Make it pink")
    );
}

/// Instances that changed the same way are one note, not a line each.
#[tokio::test]
async fn component_notes_name_many_instances_in_one_line() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Rows").await;
    let id = design(&mut agent, "Rows").await;
    let rows =
        "<div data-component=\"Sum row\" class=\"row\"><span class=\"v\">0</span></div>".repeat(7);
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Sums", "width": 400, "height": 400, "html": rows }]),
    )
    .await;
    // The span inside each instance, as instanceId/nodeId.
    let outline = agent
        .ok(
            "read",
            json!({ "designId": id, "select": ".v", "as": "outline" }),
        )
        .await;
    let inside: Vec<&str> = outline
        .split_whitespace()
        .filter_map(|word| word.strip_prefix('#'))
        .filter(|id| id.contains('/'))
        .collect();
    assert_eq!(inside.len(), 6, "{outline}");
    let select = inside
        .iter()
        .map(|id| format!("#{id}"))
        .collect::<Vec<_>>()
        .join(", ");

    let result = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": select, "css": "color: #22c55e" }]),
    )
    .await;
    assert!(
        result.contains("6 instances of \"Sum row\"")
            && result.contains("got 1 override each (#")
            && result.contains(", … +3)"),
        "{result}"
    );
    assert!(!result.contains("Only instance"), "{result}");

    // The component's own edit names its instances once, a few at a time.
    let component = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": ".row", "css": "padding: 4px" }]),
    )
    .await;
    assert_eq!(
        component.matches("This edited component").count(),
        1,
        "{component}"
    );
    assert!(
        component.contains("so all 6 instances show it too (#") && component.contains(", … +3)"),
        "{component}"
    );
}

/// A replace preview shows the changed text once for identical copies, and
/// its refusal says where the matches are.
#[tokio::test]
async fn replace_groups_identical_matches() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Copies").await;
    let id = design(&mut agent, "Copies").await;
    let sheet = "<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');\n.card { border: 1px solid #ccc }</style><p>x</p>";
    for name in ["A", "B", "C", "D", "E"] {
        edit(
            &mut agent,
            &id,
            json!([{ "op": "artboard", "name": name, "width": 200, "height": 100, "html": sheet }]),
        )
        .await;
    }

    let refusal = refused(
        &mut agent,
        &id,
        json!([{ "op": "replace", "find": "1px", "replace": "2px" }]),
    )
    .await;
    assert!(
        refusal.contains("matches 5 times, in <style> code ×5 (on style #")
            && refusal.contains(", … +2)"),
        "{refusal}"
    );
    assert_eq!(
        refusal.matches("border: 1px solid #ccc →").count(),
        1,
        "{refusal}"
    );
    assert!(refusal.contains("(×5)"), "{refusal}");

    let preview = agent
        .ok(
            "edit",
            json!({ "designId": id, "check": false, "dryRun": true,
                    "ops": [{ "op": "replace", "find": "Mono", "replace": "Code", "all": true }] }),
        )
        .await;
    assert!(
        preview.contains("5 identical <style> copies: #") && preview.contains(", … +2"),
        "{preview}"
    );
    // The changed text, not the start of the stylesheet.
    assert!(preview.contains("JetBrains+Code"), "{preview}");
    assert!(
        !preview.contains("style #") || !preview.contains("@import"),
        "{preview}"
    );
    assert_eq!(preview.matches("JetBrains+Code").count(), 1, "{preview}");
}

/// An html op over many elements reports the same result once.
#[tokio::test]
async fn html_dry_run_collapses_equal_results() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Spans").await;
    let id = design(&mut agent, "Spans").await;
    let spans = "<span>a</span>".repeat(6);
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Spans", "width": 300, "height": 100,
                 "html": format!("<div data-name=\"Row\">{spans}</div>") }]),
    )
    .await;
    let preview = agent
        .ok(
            "edit",
            json!({ "designId": id, "check": false, "dryRun": true,
                    "ops": [{ "op": "html", "select": "[data-name=Row] span", "mode": "before", "html": "<i>x</i>" }] }),
        )
        .await;
    assert_eq!(preview.matches("Wrote 1 root node").count(), 1, "{preview}");
    assert!(
        preview.contains("before 6 elements (span #") && preview.contains(", … +3)"),
        "{preview}"
    );
}

/// A whole artboard's HTML hides long stylesheets, which read gives on request.
#[tokio::test]
async fn read_html_hides_long_stylesheets_in_an_artboard() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Big").await;
    let id = design(&mut agent, "Big").await;
    let css: String = (0..1500)
        .map(|i| format!(".c{i} {{ color: red }}\n"))
        .collect();
    let made = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Big", "width": 300, "height": 100,
                 "html": format!("<style>{css}</style><style>.small {{ color: blue }}</style><p>Hi</p>") }]),
    )
    .await;
    let board = id_after(&made, "Created artboard");
    let whole = html(&mut agent, &id, &format!("#{board}")).await;
    assert!(whole.len() < 2_000, "{} characters: {whole}", whole.len());
    assert!(
        whole.contains("1500 lines")
            && whole.contains("of CSS not shown")
            && whole.contains(".small { color: blue }")
            && whole.contains("1 <style> or <script> body was replaced"),
        "{whole}"
    );
    let style = whole
        .split("<style data-id=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("the long style's id");
    // Selecting the element reads all of it.
    let alone = html(&mut agent, &id, &format!("#{style}")).await;
    assert!(
        alone.contains(".c1499 { color: red }") && !alone.contains("not shown"),
        "{}",
        &alone[..200]
    );
}

/// A stylesheet longer than a result reads in pieces that add up to all of it.
#[tokio::test]
async fn read_html_pages_through_a_stylesheet_longer_than_a_result() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Huge").await;
    let id = design(&mut agent, "Huge").await;
    let css: String = (0..2500)
        // Trailing spaces and tabs, and text past ASCII, must survive paging.
        .map(|i| format!(".c{i} {{ content: \"å\" }} \t\n"))
        .collect();
    assert!(css.len() > 40_000, "{} characters", css.len());
    let made = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Huge", "width": 300, "height": 100,
                 "html": format!("<style>{css}</style><p>Hi</p>") }]),
    )
    .await;
    let board = id_after(&made, "Created artboard");
    let whole = html(&mut agent, &id, &format!("#{board}")).await;
    let style = whole
        .split("<style data-id=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("the long style's id");
    let mut read = String::new();
    let mut offset = 0;
    for _ in 0..5 {
        let page = agent
            .ok(
                "read",
                json!({ "designId": id, "select": format!("#{style}"), "as": "html", "offset": offset }),
            )
            .await;
        assert!(!page.contains("Read one of its children"), "{page}");
        assert!(page.len() < 40_000, "{} characters", page.len());
        let (heading, code) = page.split_once('\n').expect("a heading line");
        let (code, _) = code.rsplit_once('⟨').expect("the piece's end mark");
        read.push_str(code);
        match heading.split("offset: ").nth(1) {
            Some(next) => offset = next.trim_end_matches('.').parse().expect("an offset"),
            None => break,
        }
    }
    // The pieces join back into exactly the stylesheet.
    assert_eq!(read, css);
}

/// Stylesheets that change alike but hold different rules are not copies.
#[tokio::test]
async fn replace_preview_groups_only_identical_stylesheets_and_names_their_rules() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Rules").await;
    let id = design(&mut agent, "Rules").await;
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Rules", "width": 300, "height": 100,
                 "html": "<style>.safe { color: red }</style><style>.danger { color: red }</style>\
                          <style>.same { color: red }</style><style>.same { color: red; margin: 0 }</style>" }]),
    )
    .await;
    let preview = agent
        .ok(
            "edit",
            json!({ "designId": id, "check": false, "dryRun": true,
                    "ops": [{ "op": "replace", "find": "red", "replace": "blue", "all": true }] }),
        )
        .await;
    assert!(!preview.contains("identical"), "{preview}");
    for rule in ["css .safe:", "css .danger:", "css .same:"] {
        assert!(preview.contains(rule), "{rule} in {preview}");
    }
}

/// A color is found in any notation, so the preview shows the code around
/// the notation that matched, not around the find.
#[tokio::test]
async fn replace_preview_shows_code_around_a_color_in_another_notation() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Gradient").await;
    let id = design(&mut agent, "Gradient").await;
    let stops = (0..8)
        .map(|i| format!("rgba(0, 0, {i}, 0.5) {}%", i * 10))
        .collect::<Vec<_>>()
        .join(", ");
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Gradient", "width": 300, "height": 100,
                 "html": format!("<style>.hero {{ background: linear-gradient(to right, {stops}, rgb(255 0 0)) }}</style>") }]),
    )
    .await;
    let preview = agent
        .ok(
            "edit",
            json!({ "designId": id, "check": false, "dryRun": true,
                    "ops": [{ "op": "replace", "find": "#ff0000", "replace": "#0000ff" }] }),
        )
        .await;
    assert!(
        preview.contains("rgb(255 0 0))") && preview.contains("#0000ff)"),
        "{preview}"
    );
}

#[tokio::test]
async fn a_reply_links_each_edit_once() {
    let (app, hub) = server();
    let mut agent = Agent::connect(&app, "Linker").await;
    let (id, board) = landing(&mut agent).await;
    let handle = hub.open(&id).await.unwrap();
    let person = Author {
        id: "user:cy".into(),
        name: "Cy".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some(board),
        node_id: None,
        extra_node_ids: Vec::new(),
        x: 0.0,
        y: 0.0,
    };
    let one = handle
        .add_comment(person.clone(), anchor.clone(), Audience::Agents, "First")
        .unwrap();
    let two = handle
        .add_comment(person, anchor, Audience::Agents, "Second")
        .unwrap();

    edit(
        &mut agent,
        &id,
        json!([
            { "op": "attrs", "select": ["h1", ".card"], "set": { "title": "Hi" } },
            { "op": "html", "select": "h1", "html": "<em>!</em>", "mode": "append" },
            { "op": "html", "select": "h1", "html": "<em>?</em>", "mode": "append" },
        ]),
    )
    .await;
    let replied = agent
        .ok(
            "comments",
            json!({ "designId": id, "reply": [
                { "commentId": one.id, "message": "Titled them", "resolve": true },
                { "commentId": two.id, "message": "Same edits", "resolve": true },
            ] }),
        )
        .await;
    let lines: Vec<&str> = replied.lines().collect();
    assert_eq!(lines.len(), 2, "{replied}");
    assert!(
        lines[0].contains("links your 1 change")
            && lines[0].contains("Attrs on h1, .card, HTML on h1")
            && !lines[0].contains('['),
        "{replied}"
    );
    assert!(
        lines[1].contains("links none of your changes"),
        "the second reply listed edits the first one already linked: {replied}"
    );

    edit(
        &mut agent,
        &id,
        json!([{
            "op": "replace",
            "find": "#3b82f6",
            "replace": "#f97316\n.ins svg { stroke-width: 2 }",
        }]),
    )
    .await;
    let again = agent
        .ok(
            "comments",
            json!({ "designId": id, "reply": [
                { "commentId": two.id, "message": "Recolored it", "resolve": true },
            ] }),
        )
        .await;
    assert!(
        again.contains("links your 1 change") && again.contains("Replace #3b82f6 → #f97316"),
        "{again}"
    );
    assert!(
        !again.contains('\n') && !again.contains("Attrs on"),
        "{again}"
    );
    assert!(
        again.chars().count() < 400,
        "the label should be a short line, got {again}"
    );
}

#[tokio::test]
async fn links_between_artboards_report_when_they_break() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Flow").await;
    let id = design(&mut agent, "Shop").await;
    edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Cart", "width": 390, "height": 844,
                 "html": "<a data-name=\"Pay\">Pay</a>" }]),
    )
    .await;
    let made = edit(
        &mut agent,
        &id,
        json!([{ "op": "artboard", "name": "Done", "width": 390, "height": 844 }]),
    )
    .await;
    let done = id_after(&made, "Created artboard");
    let linked = edit(
        &mut agent,
        &id,
        json!([{ "op": "attrs", "select": "[data-name=Pay]",
                 "set": { "href": format!("#finite-artboard={done}") } }]),
    )
    .await;
    assert!(!linked.contains("Links:"), "{linked}");

    let removed = edit(
        &mut agent,
        &id,
        json!([{ "op": "remove", "select": format!("#{done}") }]),
    )
    .await;
    assert!(
        removed.contains("Links: 1 link goes to no artboard"),
        "{removed}"
    );
    assert!(removed.contains("\"Pay\""), "{removed}");
    assert!(removed.contains("undo brings it back"), "{removed}");

    // The artboard comes back with its id, so the link works again.
    let undone = agent.ok("undo", json!({ "designId": id })).await;
    assert!(!undone.contains("Links:"), "{undone}");
    let redone = agent
        .ok("undo", json!({ "designId": id, "redo": true }))
        .await;
    assert!(redone.contains("Links: 1"), "{redone}");

    let bad = edit(
        &mut agent,
        &id,
        json!([{ "op": "attrs", "select": ":root", "set": { "data-route": "cart" } }]),
    )
    .await;
    assert!(bad.contains("isn't a path like /checkout"), "{bad}");
}

#[tokio::test]
async fn the_flow_note_covers_instances_and_screens_that_share_a_width() {
    let (app, _) = server();
    let mut agent = Agent::connect(&app, "Flow").await;
    let id = design(&mut agent, "Shop").await;
    let nav = "<header data-name=\"Nav\"><a data-name=\"Pay\" href=\"#finite-artboard=cart\">Pay</a></header>";
    edit(
        &mut agent,
        &id,
        json!([
            { "op": "artboard", "name": "Cart", "width": 390, "height": 200, "html": nav },
            { "op": "artboard", "name": "Cart wide", "width": 1440, "height": 200, "html": nav },
            { "op": "artboard", "name": "Cart copy", "width": 390, "height": 200, "html": nav },
        ]),
    )
    .await;

    // Every artboard is on /cart: two screens at 390.
    let routed = edit(
        &mut agent,
        &id,
        json!([{ "op": "attrs", "select": ":root", "set": { "data-route": "/cart" } }]),
    )
    .await;
    assert!(
        routed.contains("Route: /cart has") && routed.contains("390px wide"),
        "{routed}"
    );
    assert!(
        routed.contains("Give one of them its own data-route"),
        "{routed}"
    );
    assert!(routed.contains("\"Cart copy\""), "{routed}");

    // Widening one clears it, and narrowing it again brings it back.
    let wide = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": "[data-name=\"Cart copy\"]", "css": "width: 600px" }]),
    )
    .await;
    assert!(!wide.contains("Route:"), "{wide}");
    let narrow = edit(
        &mut agent,
        &id,
        json!([{ "op": "css", "select": "[data-name=\"Cart copy\"]", "css": "width: 390px" }]),
    )
    .await;
    assert!(narrow.contains("Route: /cart has"), "{narrow}");

    // An instance's override of a link counts, named by its virtual id.
    let made = edit(
        &mut agent,
        &id,
        json!([{ "op": "component", "select": "[data-name=Nav]", "name": "Top bar" }]),
    )
    .await;
    assert!(made.contains("Replaced 2 copies"), "{made}");
    let broken = edit(
        &mut agent,
        &id,
        json!([{ "op": "attrs", "select": "[data-name=Pay]", "set": { "href": "#finite-artboard=nowhere" } }]),
    )
    .await;
    assert!(broken.contains("Links: "), "{broken}");
    assert!(broken.contains("\"nowhere\" doesn't exist"), "{broken}");
    // The instances' links are named by their virtual ids.
    let virtual_links = broken
        .lines()
        .filter(|l| l.starts_with("- ") && l.split(" on ").next().is_some_and(|e| e.contains('/')))
        .count();
    assert_eq!(virtual_links, 2, "{broken}");
}
