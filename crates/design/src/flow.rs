//! A prototype's flow: which screens make up each route, and where each link
//! goes. Both are ordinary attributes, so ops, undo, the stores and every
//! tool already carry them:
//!
//! - `<a href="#finite-artboard=<id>">` links to that artboard, which
//!   interactive mode flies to. Ids don't change, so renaming the target
//!   keeps the link.
//! - `data-route="/checkout"` on an artboard puts it on that route. A desktop
//!   and a mobile artboard with the same route are one page at two widths.
//!   An artboard without one has a route of its own, made from its name.
//!
//! [`flow`] reads them once and resolves every link to a route, so preview
//! and export share one answer and one list of broken links. It's
//! router-neutral: an export writes these routes for whichever router.
//!
//! Links inside components count where they are shown. Pass the design as
//! it renders ([`crate::components::expand`], or `Design::view`), and a link
//! in a component's definition counts there and in each instance, with the
//! instance's overrides of `href` applied. An instance's links have virtual
//! ids (`instance/node`), so a broken one names the instance that shows it.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;

use crate::{Document, Node, NodeId, edit::pixel_size};

/// What a link's `href` starts with when it goes to an artboard, followed
/// by the artboard's id. The viewer reads the same prefix.
pub const ARTBOARD_LINK: &str = "#finite-artboard=";
/// The attribute that puts an artboard on a route.
pub const ROUTE_ATTR: &str = "data-route";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    /// In page order, then artboard order.
    pub routes: Vec<Route>,
    pub links: Vec<Link>,
    /// Links whose target isn't an artboard, such as one that was deleted.
    pub broken: Vec<Broken>,
    /// `data-route` values that aren't a path; those artboards get a route
    /// from their name instead.
    pub bad_routes: Vec<BadRoute>,
    /// Routes with two or more screens of the same pixel width. A link can
    /// only open one of them, and an export can't tell them apart.
    pub shared_widths: Vec<SharedWidth>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub path: String,
    /// Whether an artboard set it with `data-route`.
    pub explicit: bool,
    /// Narrowest first. A screen without a pixel width comes last.
    pub screens: Vec<Screen>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub artboard: NodeId,
    pub width: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// The link, and the artboard it's on.
    pub element: NodeId,
    pub from: NodeId,
    pub to: NodeId,
    pub route: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Broken {
    pub element: NodeId,
    pub from: NodeId,
    pub to: String,
    /// Whether `to` names a node that isn't an artboard, rather than nothing.
    pub not_artboard: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWidth {
    pub route: String,
    pub width: f64,
    /// In artboard order.
    pub artboards: Vec<NodeId>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BadRoute {
    pub artboard: NodeId,
    pub route: String,
}

/// The artboard `node` links to, when it's a link (`<a>` or `<area>`)
/// whose `href` starts with [`ARTBOARD_LINK`].
pub fn link_target(node: &Node) -> Option<&str> {
    if !matches!(node.tag(), Some("a" | "area")) {
        return None;
    }
    node.attrs
        .get("href")?
        .trim()
        .strip_prefix(ARTBOARD_LINK)
        .map(str::trim)
}

/// The `href` of a link to artboard `id`.
pub fn link_href(id: &str) -> String {
    format!("{ARTBOARD_LINK}{id}")
}

/// Whether `route` is a path a router can serve: `/`, or `/` and segments
/// of letters, digits and `-._~`, with no trailing slash.
pub fn is_route(route: &str) -> bool {
    route == "/"
        || route.strip_prefix('/').is_some_and(|rest| {
            rest.split('/').all(|segment| {
                !segment.is_empty()
                    && segment
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
            })
        })
}

/// The route an artboard named `name` gets when it doesn't set one:
/// lowercase words joined by `-`, or `fallback` when the name has none.
fn slug(name: &str, fallback: &str) -> String {
    let words: Vec<String> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    if words.is_empty() {
        format!("/{fallback}")
    } else {
        format!("/{}", words.join("-"))
    }
}

/// Reads the design's routes and links. Give it the design as it renders
/// (instances expanded) so links inside instances count.
pub fn flow(doc: &Document) -> Flow {
    let mut boards = Vec::new();
    for (page, _) in doc.pages() {
        boards.extend(doc.artboards_on(page));
    }
    let mut bad_routes = Vec::new();
    let explicit: Vec<Option<&str>> = boards
        .iter()
        .map(|board| {
            let route = board.attrs.get(ROUTE_ATTR)?.trim();
            if is_route(route) {
                Some(route)
            } else {
                bad_routes.push(BadRoute {
                    artboard: board.id.clone(),
                    route: route.to_owned(),
                });
                None
            }
        })
        .collect();
    let mut taken: HashSet<String> = explicit.iter().flatten().map(|r| (*r).to_owned()).collect();
    let mut routes: Vec<Route> = Vec::new();
    let mut route_of: BTreeMap<&str, String> = BTreeMap::new();
    for (board, explicit) in boards.iter().zip(&explicit) {
        let path = match explicit {
            Some(route) => (*route).to_owned(),
            None => {
                let base = slug(&board.display_name(), &board.id);
                let mut path = base.clone();
                let mut n = 2;
                while !taken.insert(path.clone()) {
                    path = format!("{base}-{n}");
                    n += 1;
                }
                path
            }
        };
        let screen = Screen {
            artboard: board.id.clone(),
            width: pixel_size(board).0,
        };
        match routes.iter_mut().find(|r| r.path == path) {
            Some(route) => route.screens.push(screen),
            None => routes.push(Route {
                path: path.clone(),
                explicit: explicit.is_some(),
                screens: vec![screen],
            }),
        }
        route_of.insert(&board.id, path);
    }
    let mut shared_widths = Vec::new();
    for route in &mut routes {
        // Stable, so screens of one width stay in artboard order.
        route.screens.sort_by(|a, b| {
            a.width
                .unwrap_or(f64::MAX)
                .total_cmp(&b.width.unwrap_or(f64::MAX))
        });
        for same in route.screens.chunk_by(|a, b| a.width == b.width) {
            if let (Some(width), true) = (same[0].width, same.len() > 1) {
                shared_widths.push(SharedWidth {
                    route: route.path.clone(),
                    width,
                    artboards: same.iter().map(|s| s.artboard.clone()).collect(),
                });
            }
        }
    }

    let mut links = Vec::new();
    let mut broken = Vec::new();
    for (page, _) in doc.pages() {
        for board in doc.artboards_on(page) {
            for node in doc.subtree(&board.id) {
                let Some(to) = link_target(node) else {
                    continue;
                };
                match route_of.get(to) {
                    Some(route) => links.push(Link {
                        element: node.id.clone(),
                        from: board.id.clone(),
                        to: to.to_owned(),
                        route: route.clone(),
                    }),
                    None => broken.push(Broken {
                        element: node.id.clone(),
                        from: board.id.clone(),
                        to: to.to_owned(),
                        not_artboard: doc.contains(to),
                    }),
                }
            }
        }
    }
    Flow {
        routes,
        links,
        broken,
        bad_routes,
        shared_widths,
    }
}

impl Flow {
    /// The route artboard `id` is on.
    pub fn route_of(&self, id: &str) -> Option<&Route> {
        self.routes
            .iter()
            .find(|r| r.screens.iter().any(|s| s.artboard == id))
    }

    /// Where a link to artboard `to` goes from a screen `width` pixels wide:
    /// the screen on `to`'s route closest to that width, and `to` itself
    /// among screens as close. So a link drawn on the desktop artboard
    /// opens the mobile one when you're on mobile.
    pub fn target(&self, to: &str, width: Option<f64>) -> Option<&str> {
        let route = self.route_of(to)?;
        let Some(width) = width else {
            return route
                .screens
                .iter()
                .find(|s| s.artboard == to)
                .map(|s| s.artboard.as_str());
        };
        let distance = |s: &Screen| s.width.map_or(f64::MAX, |w| (w - width).abs());
        let best = route.screens.iter().map(distance).fold(f64::MAX, f64::min);
        route
            .screens
            .iter()
            .filter(|s| distance(s) == best)
            .find(|s| s.artboard == to)
            .or_else(|| route.screens.iter().find(|s| distance(s) == best))
            .map(|s| s.artboard.as_str())
    }
}
