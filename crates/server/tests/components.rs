//! Components over MCP, the way an agent uses them: build two screens with
//! the same top bar, make it a component, and change it once for both.

mod agent;

use agent::{Agent, id_after, test_app};
use serde_json::json;

/// A top bar like an agent writes for each screen.
fn top_bar(title: &str) -> String {
    format!(
        r#"<header data-name="Top bar" style="display: flex; padding: 16px; background: #ffffff"><h1 data-name="Title" style="margin: 0">{title}</h1><button data-name="Menu">Menu</button></header>"#
    )
}

async fn html(agent: &mut Agent, design: &str, select: &str) -> String {
    agent
        .ok(
            "read",
            json!({ "designId": design, "select": select, "as": "html" }),
        )
        .await
}

#[tokio::test]
async fn a_component_changes_every_screen_in_one_edit() {
    let app = test_app();
    let mut agent = Agent::connect(&app, "Ada").await;
    let design = agent.design("App").await;
    let mut screens = Vec::new();
    let mut bars = Vec::new();
    for title in ["Home", "Settings"] {
        let made = agent
            .edit(
                &design,
                json!([{ "op": "artboard", "name": title, "width": 390, "height": 844,
                         "html": format!("{}<p>{title} content</p>", top_bar(title)) }]),
            )
            .await;
        screens.push(id_after(&made, "Created artboard"));
        bars.push(id_after(&made, "\"Top bar\""));
    }

    // The first bar becomes the component, the second an instance of it.
    let made = agent
        .edit(
            &design,
            json!([{ "op": "component", "select": format!("#{}, #{}", bars[0], bars[1]),
                     "name": "Top bar" }]),
        )
        .await;
    assert!(
        made.contains("is a component") && made.contains("1 override"),
        "{made}"
    );
    assert!(
        !made.contains("styled by <style> blocks"),
        "inline styles: {made}"
    );
    let shown = html(&mut agent, &design, &format!("#{}", screens[1])).await;
    assert!(
        shown.contains(&format!(
            r#"data-id="{}" data-instance-of="{}""#,
            bars[1], bars[0]
        )),
        "{shown}"
    );
    assert!(
        shown.contains(">Settings</h1>"),
        "the copy's title is an override: {shown}"
    );
    assert!(
        shown.contains(&format!(r#"data-id="{}/"#, bars[1])),
        "{shown}"
    );

    // One edit to the component changes both screens, and says so.
    let edited = agent
        .edit(
            &design,
            json!([{ "op": "css", "select": format!("#{}", bars[0]), "css": "background: #111827" }]),
        )
        .await;
    assert!(edited.contains("all 1 instance show it too"), "{edited}");
    let shown = html(&mut agent, &design, &format!("#{}", screens[1])).await;
    assert!(shown.contains("background: #111827"), "{shown}");

    // An edit inside the instance changes only it.
    let title = {
        let needle = r#"<h1 data-id=""#;
        let start = shown.find(&format!("{needle}{}/", bars[1])).unwrap() + needle.len();
        shown[start..start + shown[start..].find('"').unwrap()].to_owned()
    };
    let text = agent
        .edit(
            &design,
            json!([{ "op": "replace", "find": "Settings", "replace": "Preferences", "in": "text" }]),
        )
        .await;
    assert!(
        text.contains(&format!("Only instance #{}", bars[1])),
        "{text}"
    );
    let home = html(&mut agent, &design, &format!("#{}", screens[0])).await;
    assert!(
        home.contains(">Home</h1>") && !home.contains("Preferences"),
        "{home}"
    );
    let found = agent
        .ok(
            "read",
            json!({ "designId": design, "contains": "Preferences" }),
        )
        .await;
    assert!(
        found.contains(&title),
        "search sees inside instances: {found}"
    );

    // Structure inside an instance is refused, with what to do instead.
    let (refused, error) = agent
        .call(
            "edit",
            json!({ "designId": design, "check": false,
                    "ops": [{ "op": "remove", "select": format!("#{title}") }] }),
        )
        .await;
    assert!(error && refused.contains("detach"), "{refused}");

    // A third screen gets an instance from html.
    let third = agent
        .edit(
            &design,
            json!([{ "op": "artboard", "name": "Profile", "width": 390, "height": 844,
                     "html": format!(r#"<header data-instance-of="{}"></header><p>Mail</p>"#, bars[0]) }]),
        )
        .await;
    assert!(third.contains("(instance of \"Top bar\""), "{third}");

    // Changing a color everywhere changes the component, not each instance.
    agent
        .edit(
            &design,
            json!([{ "op": "replace", "find": "#111827", "replace": "#7c3aed" }]),
        )
        .await;
    let shown = html(&mut agent, &design, &format!("#{}", screens[1])).await;
    assert!(
        shown.contains("#7c3aed") && !shown.contains("#111827"),
        "{shown}"
    );

    // Detaching makes a plain copy; undo makes it an instance again.
    let detached = agent
        .edit(
            &design,
            json!([{ "op": "component", "select": format!("#{}", bars[1]), "detach": true }]),
        )
        .await;
    assert!(
        detached.contains("Detached 1 instance") && !detached.contains("Only instance"),
        "{detached}"
    );
    let plain = html(&mut agent, &design, &format!("#{}", screens[1])).await;
    assert!(
        !plain.contains("data-instance-of") && plain.contains("Preferences"),
        "{plain}"
    );
    agent.ok("undo", json!({ "designId": design })).await;
    let back = html(&mut agent, &design, &format!("#{}", screens[1])).await;
    assert!(back.contains("data-instance-of"), "{back}");

    // Exports and JSX show the instance as the elements it shows, with its
    // override: a file has no component for it to point at, and an instance
    // has no children of its own to read. They say so.
    assert!(
        back.contains("shown expanded") && back.contains("remove the data-instance-of"),
        "{back}"
    );
    let jsx = agent
        .ok(
            "read",
            json!({ "designId": design, "select": format!("#{}", screens[1]), "as": "jsx" }),
        )
        .await;
    assert!(
        jsx.contains("Preferences") && jsx.contains("Menu") && !jsx.contains("instanceOf"),
        "{jsx}"
    );
    for format in ["html", "finite", "figma", "jsx"] {
        let exported = agent
            .ok(
                "read",
                json!({ "designId": design, "export": format,
                        "select": format!("#{}", screens[1]) }),
            )
            .await;
        assert!(
            exported.contains("Preferences") && exported.contains("Menu"),
            "{format} lost the instance's content: {exported}"
        );
        assert!(
            !exported.contains("data-instance-of") && !exported.contains("instanceOf"),
            "{format} points at a component: {exported}"
        );
        assert!(
            exported.contains("1 instance(s) of \"Top bar\""),
            "{format} didn't say so: {exported}"
        );
    }
    // The whole design as a bundle, too, keeps the content.
    let bundle = agent
        .ok("read", json!({ "designId": design, "export": "finite" }))
        .await;
    assert!(
        bundle.contains("Preferences") && bundle.contains("Mail"),
        "{bundle}"
    );

    // A component styled by its artboard's <style> block hears that
    // instances elsewhere won't get those rules.
    let wrote = agent
        .edit(
            &design,
            json!([{ "op": "html", "select": format!("#{}", screens[0]),
                     "html": r#"<style>.pill { color: red } .pillbox { gap: 2px }</style><span data-name="Pill" class="pill">Hi</span>"# }]),
        )
        .await;
    let pill = id_after(&wrote, "\"Pill\"");
    let made = agent
        .edit(
            &design,
            json!([{ "op": "component", "select": format!("#{pill}"), "name": "Pill" }]),
        )
        .await;
    assert!(made.contains("Its classes .pill are styled"), "{made}");

    // An instance can't go inside its own component.
    let (refused, error) = agent
        .call(
            "edit",
            json!({ "designId": design, "check": false,
                    "ops": [{ "op": "html", "select": format!("#{}", bars[0]),
                              "html": format!("<div data-instance-of=\"{}\"></div>", bars[0]) }] }),
        )
        .await;
    assert!(error && refused.contains("contain itself"), "{refused}");
}
