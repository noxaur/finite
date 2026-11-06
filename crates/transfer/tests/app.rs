//! The app export: a Vite + React project from a prototype's flow.
//!
//! `a_small_flow_exports_the_same_project` compares the project with
//! `fixtures/app/shop.txt`, and the TanStack one with
//! `shop-tanstack-router.txt`; regenerate them with `FINITE_UPDATE_FIXTURES=1`.
//! `the_project_builds` unpacks the archive of each router and runs
//! `vite build` on it.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use finite_design::{
    Design, DesignMeta, Document, Op, PropKey,
    edit::{self, NewArtboard, TokenChange, WriteMode},
    import::BlobHash,
};
use finite_transfer::{
    Blobs, Codec, Error, Exported, Feature, NoBlobs, Revision, Scope,
    app::{self, File, Package, Page, Router, RouterKind},
    assets, scene, tar,
};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc`\xf8\xcf\xc0\0\0\x03\x01\x01\0\x18\xdd\x8d\xb0\0\0\0\0IEND\xaeB`\x82";

struct Store;

impl Blobs for Store {
    fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
        Ok((*hash == BlobHash::of(PNG)).then(|| PNG.to_vec()))
    }
}

fn design() -> Design {
    Design::new(DesignMeta {
        id: "d".into(),
        name: "Shop".into(),
        created_at: 0,
        updated_at: 0,
    })
}

fn commit(design: &mut Design, build: impl FnOnce(&Document) -> edit::Result<Vec<Op>>) {
    let ops = build(design.doc()).unwrap();
    design.commit("agent", "Edit", &ops, 0).unwrap();
}

/// An artboard `width` wide on `route` holding `html`.
fn screen(design: &mut Design, id: &str, name: &str, width: f64, route: Option<&str>, html: &str) {
    let spec = NewArtboard {
        name: name.into(),
        width,
        height: Some(600.0),
        position: None,
        page: None,
        styles: BTreeMap::new(),
    };
    commit(design, |doc| edit::create_artboard(doc, id.into(), spec));
    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("{id}-{n}")
    };
    commit(design, |doc| {
        let (ops, _) = edit::write_html(doc, id, html, WriteMode::Append, None, &mut new_id)?;
        Ok(ops)
    });
    if route.is_some() {
        commit(design, |doc| edit::set_route(doc, id, route));
    }
}

fn export(design: &Design, router: &dyn Router) -> Result<Exported, Error> {
    app::write_with(&revision(design), &Scope::Design, router)
}

fn revision(design: &Design) -> Revision<'_> {
    Revision {
        name: "Shop",
        doc: design.doc(),
        imports: design.imports(),
        blobs: &Store,
        measure: &scene::NoMeasure,
    }
}

fn react_router() -> &'static dyn Router {
    RouterKind::ReactRouter.router()
}

/// How `kind`'s `router.tsx` writes the route at `path`, when `path` needs
/// no escapes.
fn route_at(kind: RouterKind, path: &str) -> String {
    match kind {
        RouterKind::ReactRouter => format!("path=\"{path}\""),
        RouterKind::TanStackRouter => format!("path: \"{path}\""),
    }
}

/// The files of an export, by path, as text.
fn files(exported: &Exported) -> BTreeMap<String, String> {
    tar::read(&exported.bytes)
        .unwrap()
        .into_iter()
        .map(|e| (e.path, String::from_utf8_lossy(&e.bytes).into_owned()))
        .collect()
}

/// Home links to the cart and to an artboard that was deleted. The cart is
/// at 1440 and 390 on one route, the mobile one in a Dark mode. There is a
/// token, and an image.
fn shop() -> Design {
    let mut d = design();
    let image = assets::url("d", &BlobHash::of(PNG));
    screen(
        &mut d,
        "home",
        "Home",
        1440.0,
        None,
        &format!(
            r##"<a href="#finite-artboard=cart" data-name="Cart link">Cart</a><a href="#finite-artboard=gone">Gone</a><img src="{image}" alt="Logo"><p style="color: var(--brand)">Welcome</p>"##
        ),
    );
    screen(
        &mut d,
        "cart",
        "Cart",
        1440.0,
        Some("/cart"),
        r##"<a href="#finite-artboard=home">Back</a>"##,
    );
    screen(
        &mut d,
        "cart-m",
        "Cart mobile",
        390.0,
        Some("/cart"),
        r##"<a href="#finite-artboard=home">Back</a><script>go()</script>"##,
    );
    let names = ["Light".to_owned(), "Dark".to_owned()];
    let mut n = 0;
    commit(&mut d, |doc| {
        let (ops, _) = edit::set_modes(doc, &names, &mut || {
            n += 1;
            format!("m{n}")
        })?;
        Ok(ops)
    });
    let changes = [(
        "--brand".to_owned(),
        TokenChange::Modes(BTreeMap::from([
            ("Light".to_owned(), Some("#1a73e8".to_owned())),
            ("Dark".to_owned(), Some("#8ab4f8".to_owned())),
        ])),
    )];
    commit(&mut d, |doc| {
        edit::set_tokens(doc, &edit::mode_list(doc), &changes)
    });
    commit(&mut d, |doc| {
        edit::set_artboard_mode(doc, &["cart-m".into()], Some("Dark"))
    });
    d
}

/// The project as text, to compare with a fixture: each file, then the diagnostics.
fn golden(exported: &Exported) -> String {
    let mut golden = String::new();
    for entry in tar::read(&exported.bytes).unwrap() {
        match std::str::from_utf8(&entry.bytes) {
            Ok(text) => golden.push_str(&format!("=== {}\n{text}\n", entry.path)),
            Err(_) => golden.push_str(&format!(
                "=== {} ({} bytes)\n\n",
                entry.path,
                entry.bytes.len()
            )),
        }
    }
    golden.push_str("=== diagnostics\n");
    for d in &exported.diagnostics {
        golden.push_str(&format!("{:?}: {} ({})\n", d.feature, d.what, d.reason));
    }
    golden
}

/// Compares `golden` with `fixtures/app/<fixture>`, or rewrites it.
fn check_fixture(fixture: &str, golden: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/app")
        .join(fixture);
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, golden).unwrap();
        return;
    }
    let saved = fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        saved, golden,
        "fixtures/app/{fixture} is stale: run with FINITE_UPDATE_FIXTURES=1"
    );
}

#[test]
fn a_small_flow_exports_the_same_project() {
    let exported = export(&shop(), react_router()).unwrap();
    assert_eq!(exported.file_name, "shop-app.tar");
    assert_eq!(exported.media_type, "application/x-tar");
    check_fixture("shop.txt", &golden(&exported));
}

#[test]
fn a_small_flow_exports_the_same_tanstack_project() {
    let exported = export(&shop(), RouterKind::TanStackRouter.router()).unwrap();
    check_fixture("shop-tanstack-router.txt", &golden(&exported));
}

#[test]
fn links_become_the_routers_link_and_broken_ones_stay_plain() {
    let files = files(&export(&shop(), react_router()).unwrap());
    let home = &files["src/pages/PageHome.tsx"];
    // The link to the cart goes to the cart's route, and keeps its other attributes.
    assert!(
        home.contains("<Link to=\"/cart\" data-name=\"Cart link\">Cart</Link>"),
        "{home}"
    );
    // The link to a deleted artboard is a plain `<a>` with no finite href.
    assert!(home.contains("<a>Gone</a>"), "{home}");
    assert!(!home.contains("finite-artboard"), "{home}");
    // The cart links to the first route, which is served at `/`.
    let cart = &files["src/pages/PageCart.tsx"];
    assert!(cart.contains("<Link to=\"/\">Back</Link>"), "{cart}");

    let exported = export(&shop(), react_router()).unwrap();
    let broken: Vec<_> = exported
        .diagnostics
        .iter()
        .filter(|d| d.what.contains("gone"))
        .collect();
    assert_eq!(broken.len(), 1, "{:?}", exported.diagnostics);
    assert!(broken[0].reason.contains("there is no artboard \"gone\""));
}

/// A design with one artboard per width, all on the route `/x`.
fn widths(widths: &[f64]) -> Design {
    let mut d = design();
    for (i, width) in widths.iter().enumerate() {
        screen(
            &mut d,
            &format!("s{i}"),
            &format!("Screen {i}"),
            *width,
            Some("/x"),
            "<p>Hi</p>",
        );
    }
    d
}

fn global_css(design: &Design) -> String {
    files(&export(design, react_router()).unwrap())
        .remove("src/global.css")
        .unwrap()
}

#[test]
fn a_route_shows_the_screen_that_fits_the_window() {
    let files = files(&export(&shop(), react_router()).unwrap());
    // Both screens are in the component, the narrower one first, and it
    // shows until the window is as wide as the other.
    let cart = &files["src/pages/PageCart.tsx"];
    assert!(cart.contains("<div className=\"finite-screen PageCart-0\" data-finite-mode=\"1\">"));
    assert!(cart.contains("<div className=\"finite-screen PageCart-1\">"));
    assert!(files["src/global.css"].ends_with(
        ".PageCart-1 { display: none; }\n@media (width >= 1440px) { .PageCart-0 { display: none; } }\n@media (width >= 1440px) { .PageCart-1 { display: block; } }\n"
    ));
    // A route with one screen shows it always, so it has no rules.
    assert!(!files["src/global.css"].contains("PageHome"));

    // Each screen shows from its own width up to the next one's.
    let css = global_css(&widths(&[1440.0, 390.0, 768.0]));
    assert!(
        css.ends_with(
            ".PageX-1 { display: none; }\n.PageX-2 { display: none; }\n@media (width >= 768px) { .PageX-0 { display: none; } }\n@media (width >= 768px) and (width < 1440px) { .PageX-1 { display: block; } }\n@media (width >= 1440px) { .PageX-2 { display: block; } }\n"
        ),
        "{css}"
    );
}

#[test]
fn screens_that_cant_be_told_apart_are_left_out_and_reported() {
    // Two screens as wide as each other: the first shows.
    let exported = export(&widths(&[1440.0, 1440.0]), react_router()).unwrap();
    let page = files(&exported).remove("src/pages/PageX.tsx").unwrap();
    assert!(page.contains("PageX-0") && !page.contains("PageX-1"));
    let [note] = exported.diagnostics.as_slice() else {
        panic!("{:?}", exported.diagnostics);
    };
    assert_eq!(note.node.as_deref(), Some("s1"));
    assert!(note.reason.contains("as wide"), "{}", note.reason);

    // A screen without a pixel width fits any window, so it shows instead.
    let mut d = widths(&[390.0, 1440.0]);
    commit(&mut d, |_| {
        Ok(vec![Op::Set {
            id: "s1".into(),
            key: PropKey::Style("width".into()),
            value: Some("100%".into()),
        }])
    });
    let exported = export(&d, react_router()).unwrap();
    let page = &files(&exported)["src/pages/PageX.tsx"];
    assert!(
        page.contains("PageX-0") && !page.contains("PageX-1"),
        "{page}"
    );
    assert_eq!(exported.diagnostics.len(), 1);
    assert!(
        exported.diagnostics[0]
            .reason
            .contains("without a pixel width")
    );
}

#[test]
fn only_the_whole_prototype_exports() {
    let d = shop();
    let error = app::write_with(
        &revision(&d),
        &Scope::Artboard("cart".into()),
        react_router(),
    )
    .unwrap_err();
    assert!(error.0.contains("export the design instead"), "{error}");
    let empty = design();
    let error = export(&empty, react_router()).unwrap_err();
    assert!(error.0.contains("no artboards"), "{error}");
}

#[test]
fn routes_make_distinct_component_names_and_paths() {
    let mut d = design();
    for (id, route) in [("a", "/"), ("b", "/a-b"), ("c", "/a_b"), ("d", "/404")] {
        screen(&mut d, id, id, 800.0, Some(route), "<p>Hi</p>");
    }
    for kind in RouterKind::ALL {
        let files = files(&export(&d, kind.router()).unwrap());
        let pages: Vec<&str> = files
            .keys()
            .filter(|p| p.starts_with("src/pages/"))
            .map(String::as_str)
            .collect();
        assert_eq!(
            pages,
            [
                "src/pages/Page404.tsx",
                "src/pages/PageAB.tsx",
                "src/pages/PageAB2.tsx",
                "src/pages/PageIndex.tsx",
            ]
        );
        // A route that is `/` already stays where it is, and nothing else moves there.
        let router = &files["src/router.tsx"];
        for path in ["/", "/a-b", "/a_b", "/404"] {
            assert_eq!(
                router.matches(&route_at(kind, path)).count(),
                1,
                "{kind:?}: {router}"
            );
        }
    }
}

/// Routes that differ only by case, a route that browsers would rewrite,
/// an id and name that make nothing safe to write as a path or a file name,
/// and text that JSX, a template literal and an attribute each need escaped.
fn awkward() -> Design {
    let mut d = design();
    screen(&mut d, "home", "Home", 800.0, Some("/"), "<p>Home</p>");
    screen(&mut d, "a\"b", "✨", 800.0, None, "<p>Id</p>");
    screen(&mut d, "up", "Up", 800.0, Some("/Cart"), "<p>Upper</p>");
    screen(&mut d, "low", "Low", 800.0, Some("/cart"), "<p>Lower</p>");
    screen(
        &mut d,
        "camel",
        "Camel",
        800.0,
        Some("/fooBar"),
        "<p>Camel</p>",
    );
    screen(
        &mut d,
        "flat",
        "Flat",
        800.0,
        Some("/foobar"),
        "<p>Flat</p>",
    );
    screen(&mut d, "dots", "Dots", 800.0, None, "<p>Dots</p>");
    commit(&mut d, |doc| {
        edit::update_attributes(
            doc,
            &["dots".into()],
            &BTreeMap::from([("data-route".into(), Some("/a/../b".into()))]),
        )
    });
    screen(
        &mut d,
        "text",
        "Quote \" `tick` ${x} </style>",
        800.0,
        Some("/text"),
        "<p title=\"a &quot;q&quot; &amp; b \\ {c}\">{braces} `tick` ${x} \\ &lt;b&gt;</p>\
         <style>.a::after { content: \"`${x}\\\\\" }</style>",
    );
    // Names an HTML parser keeps but JSX can't write.
    screen(
        &mut d,
        "names",
        "Names",
        800.0,
        Some("/names"),
        "<div @click=\"x\" data-a.b=\"1\" 1x=\"4\" a$b=\"3\" class=\"a&amp;b\"><my-el foo=\"bar\">Kept</my-el><svg:rect>Inside</svg:rect></div>",
    );
    d
}

#[test]
fn routes_that_differ_by_case_stay_apart() {
    for kind in RouterKind::ALL {
        let files = files(&export(&awkward(), kind.router()).unwrap());
        let router = &files["src/router.tsx"];
        for path in ["/Cart", "/cart"] {
            let routes: Vec<&str> = router
                .lines()
                .filter(|l| l.contains(&route_at(kind, path)))
                .collect();
            assert_eq!(routes.len(), 1, "{kind:?}: {path} in {router}");
            match kind {
                // React Router matches case-insensitively unless told otherwise.
                RouterKind::ReactRouter => {
                    assert!(routes[0].contains("caseSensitive"), "{}", routes[0])
                }
                // TanStack Router has one switch for the whole tree.
                RouterKind::TanStackRouter => assert!(
                    router.contains("createRouter({\n  routeTree: rootRoute.addChildren([")
                        && router.contains("  caseSensitive: true,\n"),
                    "{router}"
                ),
            }
        }
    }
}

#[test]
fn tanstack_keeps_a_route_named_like_its_root() {
    let pages = [
        Page {
            path: "/".into(),
            component: "PageIndex".into(),
            module: "./pages/PageIndex".into(),
        },
        Page {
            path: "/__root__".into(),
            component: "PageRoot".into(),
            module: "./pages/PageRoot".into(),
        },
    ];
    let router = RouterKind::TanStackRouter
        .router()
        .files(&pages)
        .into_iter()
        .find(|f| f.path == "src/router.tsx")
        .unwrap()
        .text;
    assert!(router.contains("path: \"/__root__/\""), "{router}");
    assert!(router.contains("path: \"/\""), "{router}");
}

#[test]
fn a_path_is_written_as_a_string_literal() {
    let pages = [Page {
        path: "/a\"b\\c&d".into(),
        component: "PageA".into(),
        module: "./pages/PageA".into(),
    }];
    for kind in RouterKind::ALL {
        let router = kind
            .router()
            .files(&pages)
            .into_iter()
            .find(|f| f.path == "src/router.tsx")
            .unwrap()
            .text;
        let literal = match kind {
            RouterKind::ReactRouter => "path={\"/a\\\"b\\\\c&d\"}",
            RouterKind::TanStackRouter => "path: \"/a\\\"b\\\\c&d\"",
        };
        assert!(router.contains(literal), "{kind:?}: {router}");
        // Routes made from an id are paths a router can serve.
        let exported = export(&awkward(), kind.router()).unwrap();
        let router = &files(&exported)["src/router.tsx"];
        assert!(router.contains(&route_at(kind, "/a-b")), "{router}");
        assert!(!router.contains("a\"b"), "{router}");
        // A route a browser would rewrite falls back to the artboard's name, and says so.
        assert!(router.contains(&route_at(kind, "/dots")), "{router}");
        assert!(
            exported
                .diagnostics
                .iter()
                .any(|d| d.what == "data-route=\"/a/../b\""),
            "{:?}",
            exported.diagnostics
        );
    }
}

/// The cart at 390 and 1440 wide, each with a `.title` of its own color. The
/// wide one also styles the page, with `display` that must not show it at 390,
/// and a selector that holds a comment mark in a string.
fn cart_with_styles() -> Design {
    let mut d = design();
    screen(
        &mut d,
        "m",
        "Cart mobile",
        390.0,
        Some("/cart"),
        "<style>.title{color:red}</style><p class=\"title\">Mobile</p>",
    );
    screen(
        &mut d,
        "w",
        "Cart",
        1440.0,
        Some("/cart"),
        "<style>.title{color:blue} body{margin:4px;display:flex !important} :root{--gap:4px} :is(body,.x) .title{font-weight:700} [data-x=\"/*\"]{color:green}</style><p class=\"title\" data-x=\"/*\">Wide</p>",
    );
    d
}

#[test]
fn a_screens_css_only_reaches_that_screen() {
    let files = files(&export(&cart_with_styles(), react_router()).unwrap());
    let cart = &files["src/pages/PageCart.tsx"];
    // Both screens are in the document at once, so each style is limited to its wrapper.
    assert!(
        cart.contains("{`:where(.PageCart-0-page) .title{color:red}`}"),
        "{cart}"
    );
    assert!(
        cart.contains(
            "{`:where(.PageCart-1-page) .title{color:blue} :where(.PageCart-1-page){margin:4px;display:flex !important} .PageCart-1-page{--gap:4px} :is(:where(.PageCart-1-page),:where(.PageCart-1-page) .x) .title{font-weight:700} :where(.PageCart-1-page) [data-x=\"/*\"]{color:green}`}"
        ),
        "{cart}"
    );
}

#[test]
fn a_screens_css_cant_show_a_screen_that_is_hidden() {
    let files = files(&export(&cart_with_styles(), react_router()).unwrap());
    let cart = &files["src/pages/PageCart.tsx"];
    // The wrapper that the media queries hide has no author rule on it: the
    // design's `body` is the page inside it.
    assert!(files["src/global.css"].contains(".PageCart-1 { display: none; }"));
    assert!(
        cart.contains(
            "<div className=\"finite-screen PageCart-1\">\n        <div className=\"finite-page PageCart-1-page\">"
        ),
        "{cart}"
    );
    assert!(!cart.contains(":where(.PageCart-1)"), "{cart}");
}

#[test]
fn names_jsx_cant_write_are_left_out_and_reported() {
    let exported = export(&awkward(), react_router()).unwrap();
    let names = &files(&exported)["src/pages/PageNames.tsx"];
    assert!(names.contains("<div className=\"a&amp;b\">"), "{names}");
    assert!(names.contains("<my-el foo=\"bar\">Kept</my-el>"), "{names}");
    // The element goes but its text stays.
    assert!(
        names.contains("Inside") && !names.contains("svg:rect"),
        "{names}"
    );
    for gone in ["@click", "1x", "a$b", "a.b"] {
        assert!(!names.contains(gone), "{gone} in {names}");
    }
    let what: Vec<&str> = exported
        .diagnostics
        .iter()
        .map(|d| d.what.as_str())
        .collect();
    for lost in [
        "the attribute \"@click\"",
        "the attribute \"data-a.b\"",
        "the element <svg:rect>",
    ] {
        assert!(what.contains(&lost), "{lost} in {what:?}");
    }
}

#[test]
fn files_differ_by_more_than_case() {
    for kind in RouterKind::ALL {
        let files = files(&export(&awkward(), kind.router()).unwrap());
        let pages: Vec<&String> = files
            .keys()
            .filter(|p| p.starts_with("src/pages/"))
            .collect();
        let mut lower: Vec<String> = pages.iter().map(|p| p.to_ascii_lowercase()).collect();
        lower.sort();
        lower.dedup();
        // A default macOS or Windows disk keeps one file for both.
        assert_eq!(lower.len(), pages.len(), "{pages:?}");
        assert_eq!(pages.len(), 9, "{pages:?}");
        let router = &files["src/router.tsx"];
        let imports: Vec<&str> = router.lines().filter(|l| l.contains("./pages/")).collect();
        assert_eq!(imports.len(), pages.len(), "{kind:?}: {router}");
    }
}

#[test]
fn a_file_the_store_lacks_is_reported() {
    let mut d = design();
    let image = assets::url("d", &BlobHash::of(b"gone"));
    screen(
        &mut d,
        "a",
        "A",
        800.0,
        None,
        &format!("<img src=\"{image}\">"),
    );
    let exported = app::write_with(
        &Revision {
            blobs: &NoBlobs,
            ..revision(&d)
        },
        &Scope::Design,
        react_router(),
    )
    .unwrap();
    assert!(files(&exported).keys().all(|p| !p.starts_with("public/")));
    assert_eq!(exported.diagnostics[0].feature, Feature::Image);
}

/// A second router: the project changes only where the router decides.
struct Next;

impl Router for Next {
    fn name(&self) -> &'static str {
        "next"
    }

    fn packages(&self) -> &'static [Package] {
        &[Package {
            name: "next",
            version: "1.0.0",
        }]
    }

    fn link_prop(&self) -> &'static str {
        "href"
    }

    fn files(&self, pages: &[Page]) -> Vec<File> {
        let paths: Vec<&str> = pages.iter().map(|p| p.path.as_str()).collect();
        vec![File {
            path: "src/router.tsx".into(),
            text: paths.join(","),
        }]
    }
}

#[test]
fn another_router_changes_only_its_files_and_the_link_prop() {
    let d = shop();
    let one = files(&export(&d, react_router()).unwrap());
    let two = files(&export(&d, &Next).unwrap());
    assert_eq!(two["src/router.tsx"], "/,/cart");
    assert!(two["package.json"].contains("\"next\": \"1.0.0\""));
    assert!(
        two["src/pages/PageHome.tsx"].contains("<Link href=\"/cart\" data-name=\"Cart link\">")
    );
    for same in [
        "src/global.css",
        "src/main.tsx",
        "index.html",
        "vite.config.ts",
    ] {
        assert_eq!(one[same], two[same], "{same}");
    }
    assert_eq!(
        RouterKind::named("react-router"),
        Some(RouterKind::ReactRouter)
    );
    assert_eq!(RouterKind::named("next"), None);
}

#[test]
fn tanstack_router_writes_a_route_tree_and_registers_it() {
    let router = RouterKind::TanStackRouter.router();
    assert_eq!(
        RouterKind::named("tanstack-router"),
        Some(RouterKind::TanStackRouter)
    );
    assert_eq!(RouterKind::default(), RouterKind::ReactRouter);
    let files = files(&export(&shop(), router).unwrap());
    let tree = &files["src/router.tsx"];
    for path in ["/", "/cart"] {
        assert_eq!(
            tree.matches(&format!("path: \"{path}\"")).count(),
            1,
            "{tree}"
        );
    }
    assert!(
        tree.contains("rootRoute.addChildren([route0, route1])"),
        "{tree}"
    );
    assert!(tree.contains("interface Register"), "{tree}");
    assert_eq!(
        files["src/link.ts"],
        "export { Link } from \"@tanstack/react-router\";\n"
    );
    assert!(files["package.json"].contains("\"@tanstack/react-router\": \"1.170.46\""));
    assert!(!files["package.json"].contains("react-router\": \"7"));
}

#[test]
fn the_codec_is_an_export_only_format() {
    let exported = app::App.write(&revision(&shop()), &Scope::Design).unwrap();
    assert_eq!(exported.file_name, "shop-app.tar");
    assert!(
        app::App
            .read(&finite_transfer::Input {
                bytes: b"",
                file_name: None
            })
            .is_err()
    );
}

#[test]
fn the_project_builds() {
    if std::env::var_os("FINITE_SKIP_APP_BUILD").is_some_and(|v| v == "1") {
        eprintln!("skipping the app build: FINITE_SKIP_APP_BUILD=1");
        return;
    }
    let work = Path::new(env!("CARGO_TARGET_TMPDIR"));
    if !Command::new("npm")
        .arg("--version")
        .current_dir(work)
        .output()
        .is_ok_and(|o| o.status.success())
    {
        eprintln!("skipping the app build: npm isn't on PATH");
        return;
    }
    for (name, design) in [
        ("shop", shop()),
        ("awkward", awkward()),
        ("styles", cart_with_styles()),
    ] {
        for kind in RouterKind::ALL {
            builds(work, name, &design, kind.router());
        }
    }
}

/// Unpacks `design`'s export for `router` in a project of its own and runs
/// `npm run build`.
fn builds(work: &Path, design_name: &str, design: &Design, router: &dyn Router) {
    let name = format!("{design_name}-{}", router.name());
    let exported = export(design, router).unwrap();
    let project = work.join(format!("app-project-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&project);
    for entry in tar::read(&exported.bytes).unwrap() {
        let path = project.join(&entry.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, entry.bytes).unwrap();
    }
    let package = fs::read(project.join("package.json")).unwrap();
    let modules = installed(work, &package);
    std::os::unix::fs::symlink(&modules, project.join("node_modules")).unwrap();

    let build = Command::new("npm")
        .args(["run", "build"])
        .current_dir(&project)
        .output()
        .unwrap();
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&build.stdout),
        String::from_utf8_lossy(&build.stderr)
    );
    assert!(
        build.status.success(),
        "{name}: npm run build failed:\n{log}"
    );
    eprintln!("{name}:\n{log}");
    assert!(project.join("dist/index.html").exists(), "{name}: {log}");
    if design_name == "shop" {
        let png = format!("dist/assets/{}.png", BlobHash::of(PNG));
        assert!(project.join(png).exists(), "{name}: {log}");
    }
    let _ = fs::remove_dir_all(&project);
}

/// The `node_modules` folder for a `package.json`, installed once under
/// the target folder and reused by every run with the same file.
fn installed(work: &Path, package: &[u8]) -> PathBuf {
    let cache = work
        .join("app-node-modules")
        .join(BlobHash::of(package).to_string());
    let modules = cache.join("node_modules");
    if modules.exists() {
        return modules;
    }
    let staging = cache.with_extension(format!("tmp-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("package.json"), package).unwrap();
    let install = Command::new("npm")
        .args(["install", "--no-audit", "--no-fund", "--loglevel=error"])
        .current_dir(&staging)
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "npm install failed:\n{}{}",
        String::from_utf8_lossy(&install.stdout),
        String::from_utf8_lossy(&install.stderr)
    );
    fs::create_dir_all(cache.parent().unwrap()).unwrap();
    // Another run may have finished first; either copy is the same.
    if fs::rename(&staging, &cache).is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    modules
}
