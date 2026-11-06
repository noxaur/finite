//! A prototype's flow: `#finite-artboard=<id>` links between artboards and the
//! `data-route` that groups artboards into pages at several widths.

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, Document, Op, components,
    edit::{self, InstanceValues, NewArtboard, WriteMode},
    flow::{self, Flow, SharedWidth},
    user_edit::{self, UserEdit},
};

fn design() -> Design {
    Design::new(DesignMeta {
        id: "d".into(),
        name: "Flow".into(),
        created_at: 0,
        updated_at: 0,
    })
}

fn commit(design: &mut Design, build: impl FnOnce(&Document) -> edit::Result<Vec<Op>>) {
    let ops = build(design.doc()).unwrap();
    design.commit("agent", "Edit", &ops, 0).unwrap();
}

fn ids() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("n{n}")
    }
}

/// An artboard `width` wide holding `html`.
fn screen(design: &mut Design, id: &str, name: &str, width: f64, html: &str) {
    let spec = NewArtboard {
        name: name.into(),
        width,
        height: Some(600.0),
        position: None,
        page: None,
        styles: BTreeMap::new(),
    };
    commit(design, |doc| edit::create_artboard(doc, id.into(), spec));
    if html.is_empty() {
        return;
    }
    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("{id}-{n}")
    };
    let ops = edit::write_html(design.doc(), id, html, WriteMode::Append, None, &mut new_id)
        .unwrap()
        .0;
    design.commit("agent", "Write", &ops, 0).unwrap();
}

fn route(design: &mut Design, id: &str, path: &str) {
    commit(design, |doc| edit::set_route(doc, id, Some(path)));
}

/// Three screens, home → cart → done, at 1440 and 390 wide. The mobile
/// links point at the desktop artboards, as a mobile copy made before the
/// links were drawn would.
fn shop() -> Design {
    let mut d = design();
    screen(
        &mut d,
        "home",
        "Home",
        1440.0,
        r##"<a href="#finite-artboard=cart">Cart</a>"##,
    );
    screen(
        &mut d,
        "cart",
        "Cart",
        1440.0,
        r##"<a href="#finite-artboard=done">Pay</a>"##,
    );
    screen(&mut d, "done", "Done", 1440.0, "<p>Thanks</p>");
    screen(
        &mut d,
        "home-m",
        "Home mobile",
        390.0,
        r##"<a href="#finite-artboard=cart">Cart</a>"##,
    );
    screen(
        &mut d,
        "cart-m",
        "Cart mobile",
        390.0,
        r##"<div><a href="#finite-artboard=done"><span>Pay</span></a></div>"##,
    );
    for (id, path) in [
        ("home", "/"),
        ("home-m", "/"),
        ("cart", "/cart"),
        ("cart-m", "/cart"),
    ] {
        route(&mut d, id, path);
    }
    d
}

fn paths(flow: &Flow) -> Vec<(&str, Vec<&str>)> {
    flow.routes
        .iter()
        .map(|r| {
            (
                r.path.as_str(),
                r.screens.iter().map(|s| s.artboard.as_str()).collect(),
            )
        })
        .collect()
}

#[test]
fn artboards_with_one_route_are_one_page_at_several_widths() {
    let d = shop();
    let flow = flow::flow(d.doc());
    // Narrowest first; "Done" sets no route, so it gets one from its name.
    assert_eq!(
        paths(&flow),
        [
            ("/", vec!["home-m", "home"]),
            ("/cart", vec!["cart-m", "cart"]),
            ("/done", vec!["done"]),
        ]
    );
    assert!(!flow.routes[2].explicit);
    let links: Vec<(&str, &str)> = flow
        .links
        .iter()
        .map(|l| (l.from.as_str(), l.route.as_str()))
        .collect();
    assert_eq!(
        links,
        [
            ("home", "/cart"),
            ("cart", "/done"),
            ("home-m", "/cart"),
            ("cart-m", "/done")
        ]
    );
    assert!(flow.broken.is_empty());
}

#[test]
fn a_link_opens_its_route_at_the_closest_width() {
    let flow = flow::flow(shop().doc());
    assert_eq!(flow.target("cart", Some(1440.0)), Some("cart"));
    // Drawn to the desktop cart, followed on mobile.
    assert_eq!(flow.target("cart", Some(390.0)), Some("cart-m"));
    assert_eq!(flow.target("cart", Some(800.0)), Some("cart-m"));
    // A route with one screen opens it at any width.
    assert_eq!(flow.target("done", Some(390.0)), Some("done"));
    assert_eq!(flow.target("cart", None), Some("cart"));
    assert_eq!(flow.target("nothing", Some(390.0)), None);
}

#[test]
fn a_link_survives_renaming_its_target() {
    let mut d = shop();
    commit(&mut d, |doc| {
        edit::rename(doc, "done", Some("Order placed"))
    });
    let flow = flow::flow(d.doc());
    assert!(flow.broken.is_empty());
    // The name-made route follows the name; the link follows the id.
    assert_eq!(flow.target("done", Some(1440.0)), Some("done"));
    assert_eq!(flow.links[1].route, "/order-placed");
}

#[test]
fn deleting_a_target_breaks_its_links_until_undo() {
    let mut d = shop();
    commit(&mut d, |doc| edit::delete(doc, &["done".into()]));
    let broken: Vec<(String, String)> = flow::flow(d.doc())
        .broken
        .into_iter()
        .map(|b| (b.from, b.to))
        .collect();
    assert_eq!(
        broken,
        [
            ("cart".to_owned(), "done".to_owned()),
            ("cart-m".to_owned(), "done".to_owned())
        ]
    );
    d.undo("agent", 0).unwrap();
    assert!(flow::flow(d.doc()).broken.is_empty());
}

#[test]
fn a_link_to_a_node_inside_an_artboard_is_broken() {
    let mut d = shop();
    let links = flow::flow(d.doc()).links;
    let (link, other) = (links[0].element.clone(), links[1].element.clone());
    commit(&mut d, |doc| {
        edit::update_attributes(
            doc,
            &[link],
            &BTreeMap::from([("href".into(), Some(flow::link_href(&other)))]),
        )
    });
    let flow = flow::flow(d.doc());
    assert_eq!(flow.broken.len(), 1);
    assert!(flow.broken[0].not_artboard);
}

#[test]
fn a_link_reads_its_href_the_way_a_click_does() {
    let mut d = design();
    screen(&mut d, "abc", "Abc", 390.0, "");
    // Each link, the `to` it should name (`None` when it isn't a link), and
    // whether it resolves to the artboard.
    let cases: [(&str, Option<&str>, bool); 7] = [
        ("#finite-artboard=abc", Some("abc"), true),
        // Percent-escapes are decoded, as the click handlers do.
        ("#finite-artboard=a%62c", Some("abc"), true),
        ("#finite-artboard=a%2fb", Some("a/b"), false),
        // Nothing is trimmed: a click tests the raw attribute.
        (" #finite-artboard=abc", None, false),
        ("#finite-artboard=abc ", Some("abc "), false),
        // A malformed escape or invalid UTF-8 would throw in the handlers.
        ("#finite-artboard=a%zzc", Some("a%zzc"), false),
        ("#finite-artboard=%ff", Some("%ff"), false),
    ];
    let html: String = cases
        .iter()
        .map(|(href, ..)| format!(r#"<a href="{href}">x</a>"#))
        .collect();
    screen(&mut d, "home", "Home", 390.0, &html);
    let flow = flow::flow(d.doc());
    let seen: Vec<(&str, bool)> = flow
        .links
        .iter()
        .map(|l| (l.to.as_str(), true))
        .chain(flow.broken.iter().map(|b| (b.to.as_str(), false)))
        .collect();
    for (_, to, resolves) in cases {
        if let Some(to) = to {
            assert!(seen.contains(&(to, resolves)), "{to:?} in {seen:?}");
        }
    }
    assert_eq!(seen.len(), cases.iter().filter(|c| c.1.is_some()).count());
}

#[test]
fn duplicating_a_flow_links_the_copies_to_each_other() {
    let d = shop();
    let mut new_id = ids();
    let (ops, roots) = edit::duplicate(
        d.doc(),
        &["home".into(), "cart".into(), "done".into()],
        &mut new_id,
    )
    .unwrap();
    let mut doc = d.doc().clone();
    for op in &ops {
        doc.apply(op).unwrap();
    }
    let flow = flow::flow(&doc);
    let from_copies: Vec<&str> = flow
        .links
        .iter()
        .filter(|l| roots.contains(&l.from))
        .map(|l| l.to.as_str())
        .collect();
    assert_eq!(from_copies, [roots[1].as_str(), roots[2].as_str()]);
    // A copy of one screen keeps its link to the original's target.
    let (ops, roots) = edit::duplicate(d.doc(), &["home".into()], &mut new_id).unwrap();
    let mut doc = d.doc().clone();
    for op in &ops {
        doc.apply(op).unwrap();
    }
    let flow = flow::flow(&doc);
    let link = flow.links.iter().find(|l| l.from == roots[0]).unwrap();
    assert_eq!(link.to, "cart");
}

/// The document after duplicating `ids` from the design as it renders,
/// which is what every tool builds edits against, and the copies' ids.
fn duplicated(design: &Design, ids: &[&str]) -> (Document, Vec<String>) {
    let ids: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("copy{n}")
    };
    let (ops, roots) = edit::duplicate(design.view(), &ids, &mut new_id).unwrap();
    let mut doc = design.doc().clone();
    for op in &ops {
        doc.apply(op).unwrap();
    }
    (doc, roots)
}

#[test]
fn a_copy_of_one_screen_keeps_its_route_and_shared_widths_are_reported() {
    let d = shop();
    assert!(flow::flow(d.doc()).shared_widths.is_empty());
    let (doc, roots) = duplicated(&d, &["home-m"]);
    assert_eq!(doc.get(&roots[0]).unwrap().attrs["data-route"], "/");
    // The copy is on "/" at 390 wide, like the original: a link can only
    // open one of them, so the flow says which two.
    let flow = flow::flow(&doc);
    let [
        SharedWidth {
            route,
            width,
            artboards,
        },
    ] = &flow.shared_widths[..]
    else {
        panic!("{:?}", flow.shared_widths);
    };
    assert_eq!((route.as_str(), *width), ("/", 390.0));
    let mut artboards = artboards.clone();
    artboards.sort();
    let mut expected = vec!["home-m".to_owned(), roots[0].clone()];
    expected.sort();
    assert_eq!(artboards, expected);
    assert_eq!(
        serde_json::to_value(&flow).unwrap()["sharedWidths"][0]["width"],
        390.0
    );
}

#[test]
fn copies_of_several_screens_fall_back_to_their_own_routes() {
    let d = shop();
    let (doc, roots) = duplicated(&d, &["home", "home-m", "cart", "cart-m", "done"]);
    for copy in &roots {
        assert!(!doc.get(copy).unwrap().attrs.contains_key("data-route"));
    }
    // The originals keep theirs.
    assert_eq!(doc.get("home").unwrap().attrs["data-route"], "/");
    let flow = flow::flow(&doc);
    assert!(flow.shared_widths.is_empty(), "{:?}", flow.shared_widths);
    for copy in &roots {
        assert!(!flow.route_of(copy).unwrap().explicit);
        assert_eq!(flow.route_of(copy).unwrap().screens.len(), 1);
    }
    // Their links still reach the copies, at the copies' own routes.
    let from_copies: Vec<&str> = flow
        .links
        .iter()
        .filter(|l| roots.contains(&l.from))
        .map(|l| l.to.as_str())
        .collect();
    assert_eq!(from_copies.len(), 4);
    assert!(from_copies.iter().all(|to| roots.iter().any(|r| r == to)));
}

/// A component holding a link to "cart" on its own artboard, and its
/// instances: one on "home" with the link overridden to "done", one on
/// "cart" as is, and one on "done" overridden to a "gone" artboard. Returns
/// the design, the link's id in the component and the instances by the
/// board they're on.
fn linked_component() -> (Design, String, BTreeMap<&'static str, String>) {
    let mut d = shop();
    screen(&mut d, "gone", "Gone", 390.0, "");
    screen(
        &mut d,
        "lib",
        "Library",
        390.0,
        r##"<div><a href="#finite-artboard=cart">Buy</a></div>"##,
    );
    let link = d
        .doc()
        .subtree("lib")
        .into_iter()
        .find(|n| flow::link_target(n).is_some())
        .unwrap()
        .id
        .clone();
    let card = d.doc().get(&link).unwrap().parent.clone().unwrap();
    commit(&mut d, |doc| edit::create_component(doc, &card, None, &[]));
    let mut new_id = ids();
    let mut instances = BTreeMap::new();
    for (board, href) in [
        ("home", Some("done")),
        ("cart", None),
        ("done", Some("gone")),
    ] {
        let values: Vec<InstanceValues> = href
            .map(|to| InstanceValues {
                node_id: Some(link.clone()),
                attributes: BTreeMap::from([("href".into(), Some(flow::link_href(to)))]),
                ..InstanceValues::default()
            })
            .into_iter()
            .collect();
        let (ops, id) =
            edit::insert_instance(d.doc(), &card, board, None, None, &values, &mut new_id).unwrap();
        d.commit("agent", "Instance", &ops, 0).unwrap();
        instances.insert(board, id);
    }
    (d, link, instances)
}

#[test]
fn links_in_components_and_their_instances_count_with_overridden_hrefs() {
    let (mut d, link, instances) = linked_component();
    let at = |board: &str| format!("{}/{link}", instances[board]);
    let flow = flow::flow(d.view());
    let seen: Vec<(&str, &str, &str)> = flow
        .links
        .iter()
        .map(|l| (l.from.as_str(), l.element.as_str(), l.to.as_str()))
        .filter(|(from, _, _)| ["lib", "home", "cart", "done"].contains(from))
        .collect();
    // The definition, then each instance with its own href.
    assert!(seen.contains(&("lib", link.as_str(), "cart")), "{seen:?}");
    for (board, to) in [("home", "done"), ("cart", "cart"), ("done", "gone")] {
        assert!(seen.contains(&(board, at(board).as_str(), to)), "{seen:?}");
    }
    assert!(flow.broken.is_empty());
    // Without expanding instances, only the definition is there.
    let plain = flow::flow(d.doc());
    assert!(plain.links.iter().all(|l| !l.element.contains('/')));
    assert_eq!(plain.links.iter().filter(|l| l.from == "lib").count(), 1);

    // Delete "gone": the instance that overrode the link to it is broken,
    // and named by its virtual id.
    commit(&mut d, |doc| edit::delete(doc, &["gone".into()]));
    let flow = flow::flow(d.view());
    let broken: Vec<(&str, &str, &str)> = flow
        .broken
        .iter()
        .map(|b| (b.from.as_str(), b.element.as_str(), b.to.as_str()))
        .collect();
    assert_eq!(broken, [("done", at("done").as_str(), "gone")]);
    d.undo("agent", 0).unwrap();
    assert!(flow::flow(d.view()).broken.is_empty());
}

#[test]
fn duplicating_a_flow_repoints_links_inside_instances() {
    let (d, _, instances) = linked_component();
    let (doc, roots) = duplicated(&d, &["home", "cart", "done"]);
    let (home, cart, done) = (&roots[0], &roots[1], &roots[2]);
    let flow = flow::flow(&components::expand(&doc));
    let inside = |board: &String| -> Vec<&str> {
        flow.links
            .iter()
            .filter(|l| l.element.contains('/') && &l.from == board)
            .map(|l| l.to.as_str())
            .collect()
    };
    // Home's instance overrode its link to "done" and cart's follows the
    // component to "cart": both go to the copies. Done's goes to "gone",
    // which wasn't copied.
    assert_eq!(inside(home), [done.as_str()]);
    assert_eq!(inside(cart), [cart.as_str()]);
    assert_eq!(inside(done), ["gone"]);
    // The originals are untouched.
    for (board, to) in [("home", "done"), ("cart", "cart"), ("done", "gone")] {
        let board = board.to_owned();
        assert_eq!(inside(&board), [to]);
    }
    // A copy is still an instance of the same component.
    let copy = doc
        .children(Some(home))
        .into_iter()
        .find(|n| n.is_instance())
        .unwrap();
    assert_eq!(
        copy.instance_of,
        d.doc().get(&instances["home"]).unwrap().instance_of
    );
}

#[test]
fn a_copy_of_one_screen_keeps_its_instances_links() {
    let (d, _, _) = linked_component();
    let (doc, roots) = duplicated(&d, &["home"]);
    let flow = flow::flow(&components::expand(&doc));
    let link = flow
        .links
        .iter()
        .find(|l| l.from == roots[0] && l.element.contains('/'))
        .unwrap();
    assert_eq!(link.to, "done");
}

#[test]
fn a_design_without_instances_has_the_same_flow_expanded_or_not() {
    let d = shop();
    assert_eq!(flow::flow(d.view()), flow::flow(d.doc()));
}

#[test]
fn names_make_unique_routes_and_bad_routes_are_reported() {
    let mut d = design();
    screen(&mut d, "a", "Sign in", 390.0, "");
    screen(&mut d, "b", "Sign in", 390.0, "");
    screen(&mut d, "c", "✨", 390.0, "");
    commit(&mut d, |doc| {
        edit::update_attributes(
            doc,
            &["c".into()],
            &BTreeMap::from([("data-route".into(), Some("no slash".into()))]),
        )
    });
    let flow = flow::flow(d.doc());
    assert_eq!(
        paths(&flow),
        [
            ("/sign-in", vec!["a"]),
            ("/sign-in-2", vec!["b"]),
            ("/c", vec!["c"])
        ]
    );
    assert_eq!(flow.bad_routes[0].route, "no slash");
}

#[test]
fn routes_must_be_paths() {
    for good in ["/", "/cart", "/cart/done", "/a-b_c.d~e", "/2"] {
        assert!(flow::is_route(good), "{good}");
    }
    for bad in ["", "cart", "/cart/", "//", "/a b", "/:id", "/é", "/a?b"] {
        assert!(!flow::is_route(bad), "{bad}");
    }
}

#[test]
fn people_link_and_set_routes_with_their_own_edits() {
    let d = shop();
    let doc = d.doc();
    let button = flow::flow(doc).links[0].element.clone();
    let mut new_id = ids();
    let plan = |edits: &[UserEdit], new_id: &mut dyn FnMut() -> String| {
        user_edit::plan(doc, doc, edits, &mut || new_id())
    };
    let ops = plan(
        &[UserEdit::SetLink {
            ids: vec![button.clone()],
            to: Some("done".into()),
        }],
        &mut new_id,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let refused = |edits: &[UserEdit], new_id: &mut dyn FnMut() -> String| {
        plan(edits, new_id).unwrap_err().to_string()
    };
    assert!(
        refused(
            &[UserEdit::SetLink {
                ids: vec![button.clone()],
                to: Some(button.clone()),
            }],
            &mut new_id
        )
        .contains("isn't an artboard")
    );
    assert!(
        refused(
            &[UserEdit::SetLink {
                ids: vec!["home".into()],
                to: Some("cart".into()),
            }],
            &mut new_id
        )
        .contains("only a link (<a>) can go to an artboard")
    );
    assert!(
        refused(
            &[UserEdit::SetRoute {
                id: "home".into(),
                route: Some("cart".into()),
            }],
            &mut new_id
        )
        .contains("isn't a route")
    );
    // An empty route clears it, back to one made from the name.
    let ops = plan(
        &[UserEdit::SetRoute {
            id: "home".into(),
            route: Some(" ".into()),
        }],
        &mut new_id,
    )
    .unwrap();
    let mut doc = doc.clone();
    doc.apply(&ops[0]).unwrap();
    assert_eq!(flow::flow(&doc).route_of("home").unwrap().path, "/home");
    assert_eq!(
        user_edit::label(&[UserEdit::SetLink {
            ids: vec![],
            to: None
        }]),
        "Link"
    );
}
