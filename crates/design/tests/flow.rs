//! A prototype's flow: `#finite-artboard=<id>` links between artboards and the
//! `data-route` that groups artboards into pages at several widths.

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, Document, Op,
    edit::{self, NewArtboard, WriteMode},
    flow::{self, Flow},
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
        r##"<a href=" #finite-artboard=done ">Pay</a>"##,
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
