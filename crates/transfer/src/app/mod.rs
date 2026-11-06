//! A prototype as a standalone Vite + React project, packed as a tar
//! archive. Export only.
//!
//! The routes and links come from [`finite_design::flow::flow`]. Each route
//! is one component that holds all its screens and shows one by viewport
//! width. The scaffold, screens, CSS and images are the same for every
//! router; only the files a [`Router`] writes differ, and each router is a
//! [`RouterKind`].
//!
//! The first route is served at `/`, so opening the project shows it,
//! unless a route is `/` already.

mod router;

use std::collections::{BTreeMap, HashMap, HashSet};

use finite_design::{
    Document, Node,
    flow::{self, Flow, Route, Screen},
    html, tokens,
};

use crate::{
    Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input, Revision, Scope,
    Score, Support, assets, file_stem,
    jsx::{self, Link, Links},
    tar,
};
pub use router::{File, Package, Page, Router, RouterKind};

/// The name a screen imports the router's link component by.
const LINK: &str = "Link";

/// The prop of the link component that holds where to go.
const LINK_PROP: &str = "to";

pub struct App;

impl Codec for App {
    fn name(&self) -> &'static str {
        "app"
    }

    fn support(&self, feature: Feature, direction: Direction) -> Support {
        use {Direction::*, Support::*};
        match (feature, direction) {
            (_, Import) => Unsupported,
            // Images are files in the project, text is text.
            (Feature::Text | Feature::Image, Export) => Exact,
            // Styles are inline style objects, as in JSX, which can't carry `!important`.
            (Feature::Frame | Feature::SolidFill | Feature::FlexLayout, Export) => Approximate,
            // An instance is written as the elements it shows.
            (Feature::Instance, Export) => Approximate,
            // A component can't hold a script, so it's left out.
            (Feature::Script | Feature::Embed | Feature::ImportHistory, Export) => Unsupported,
        }
    }

    fn read(&self, _input: &Input<'_>) -> Result<Imported, Error> {
        Err(Error(
            "an app can only be exported; import HTML instead".into(),
        ))
    }

    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
        write_with(revision, scope, RouterKind::default().router())
    }
}

/// The whole prototype in `revision` as a project that routes with `router`.
pub fn write_with(
    revision: &Revision<'_>,
    scope: &Scope,
    router: &dyn Router,
) -> Result<Exported, Error> {
    if let Scope::Artboard(id) = scope {
        return Err(Error(format!(
            "an app holds the whole prototype, because its links go between artboards; export the design instead of just artboard {id:?}"
        )));
    }
    let doc = revision.doc;
    let flow = flow::flow(doc);
    if flow.routes.is_empty() {
        return Err(Error(
            "the design has no artboards, so there is no screen to export".into(),
        ));
    }
    let names = component_names(&flow);
    let served = served_paths(&flow);
    let to_served: HashMap<&str, &str> = flow
        .routes
        .iter()
        .zip(&served)
        .map(|(route, path)| (route.path.as_str(), path.as_str()))
        .collect();
    let routed: HashMap<&str, &str> = flow
        .links
        .iter()
        .map(|l| (l.element.as_str(), to_served[l.route.as_str()]))
        .collect();
    let broken: HashMap<&str, String> = flow
        .broken
        .iter()
        .map(|b| {
            let why = if b.not_artboard {
                format!("{:?} isn't an artboard", b.to)
            } else {
                format!("there is no artboard {:?}", b.to)
            };
            (b.element.as_str(), why)
        })
        .collect();
    let resolve = |node: &Node| match routed.get(node.id.as_str()) {
        Some(_) if node.tag() != Some("a") => {
            Link::Plain("an <area> can't be a router link, so it lost its href".into())
        }
        Some(path) => Link::To((*path).to_owned()),
        None => Link::Plain(format!(
            "{}, so it's a plain element without its href",
            broken
                .get(node.id.as_str())
                .map_or("its target isn't an artboard", String::as_str)
        )),
    };
    let links = Links {
        component: LINK,
        prop: LINK_PROP,
        resolve: &resolve,
    };

    let mut diagnostics = Vec::new();
    for bad in &flow.bad_routes {
        diagnostics.push(
            Diagnostic::new(
                Feature::Frame,
                format!("data-route={:?}", bad.route),
                "it isn't a path like /cart, so the artboard's route is made from its name",
                [Score::No, Score::Yes, Score::Yes],
            )
            .at(format!("#{}", bad.artboard))
            .on(&bad.artboard),
        );
    }
    let mut css = String::new();
    let mut pages = Vec::new();
    let mut entries = Vec::new();
    for ((route, name), path) in flow.routes.iter().zip(&names).zip(&served) {
        let (screens, dropped) = shown(route);
        for (screen, reason) in dropped {
            diagnostics.push(
                Diagnostic::new(
                    Feature::Frame,
                    format!("the screen {}", artboard_name(doc, &screen.artboard)),
                    format!("{reason}, so it was left out of the route {}", route.path),
                    [Score::No, Score::No, Score::Yes],
                )
                .at(format!("#{}", screen.artboard))
                .on(&screen.artboard),
            );
        }
        let page = write_page(doc, name, &screens, &links);
        diagnostics.extend(page.diagnostics);
        css.push_str(&page.css);
        entries.push((format!("src/pages/{name}.tsx"), page.text));
        pages.push(Page {
            path: path.clone(),
            component: name.clone(),
            module: format!("./pages/{name}"),
        });
    }

    let mut stylesheet = global_css(doc, &flow);
    stylesheet.push_str(&css);
    let mut files = scaffold(revision.name, router);
    files.push(File {
        path: "src/global.css".into(),
        text: stylesheet,
    });
    files.extend(router.files(&pages));
    files.extend(entries.into_iter().map(|(path, text)| File { path, text }));

    // Images go to `public/assets/` and the text points at them.
    let mut images = BTreeMap::new();
    for file in &mut files {
        let (text, found) = assets::extract(&file.text, revision.blobs, "/assets", &mut images)?;
        file.text = text;
        diagnostics.extend(found);
    }
    let mut archive: Vec<tar::Entry> = files
        .into_iter()
        .map(|f| tar::Entry {
            path: f.path,
            bytes: f.text.into_bytes(),
        })
        .collect();
    archive.extend(images.into_iter().map(|(name, bytes)| tar::Entry {
        path: format!("public/assets/{name}"),
        bytes,
    }));
    Ok(Exported {
        file_name: format!("{}-app.tar", file_stem(revision.name)),
        media_type: "application/x-tar",
        bytes: tar::write(&archive)?,
        diagnostics,
    })
}

/// The component for each route, in route order: `Page` and the route's
/// words (`/order-placed` is `PageOrderPlaced`, `/` is `PageIndex`), and a
/// number after the first when two routes make the same name. Names that
/// differ only by case count as the same, since each is a file and a default
/// macOS or Windows disk keeps one file for `PageFooBar.tsx` and
/// `PageFoobar.tsx`.
fn component_names(flow: &Flow) -> Vec<String> {
    let mut used = HashSet::new();
    flow.routes
        .iter()
        .map(|route| {
            let words = if route.path == "/" {
                "index"
            } else {
                &route.path
            };
            let base: String = jsx::component_name(&format!("page {words}"))
                .chars()
                .take(48)
                .collect();
            let mut name = base.clone();
            let mut n = 2;
            while !used.insert(name.to_ascii_lowercase()) {
                name = format!("{base}{n}");
                n += 1;
            }
            name
        })
        .collect()
}

/// Where each route is served, in route order: the first at `/` unless
/// another route already is `/`.
fn served_paths(flow: &Flow) -> Vec<String> {
    let has_index = flow.routes.iter().any(|r| r.path == "/");
    flow.routes
        .iter()
        .enumerate()
        .map(|(i, route)| {
            if i == 0 && !has_index {
                "/".to_owned()
            } else {
                route.path.clone()
            }
        })
        .collect()
}

fn artboard_name(doc: &Document, id: &str) -> String {
    format!(
        "{:?}",
        doc.get(id).map(Node::display_name).unwrap_or_default()
    )
}

/// The screens of `route` a viewer can reach, narrowest first, and the
/// others with why not. One screen shows at a time: the widest whose width
/// is at most the viewport's, or the narrowest below that. A screen without
/// a pixel width counts as the widest and fits any viewport, so it hides
/// every other. Of two screens as wide as each other, the first shows.
fn shown(route: &Route) -> (Vec<&Screen>, Vec<(&Screen, &'static str)>) {
    let mut kept: Vec<&Screen> = Vec::new();
    let mut dropped = Vec::new();
    for screen in &route.screens {
        if kept.last().is_some_and(|k| k.width == screen.width) {
            dropped.push((screen, "another screen is as wide, and the first one shows"));
        } else {
            kept.push(screen);
        }
    }
    if kept.len() > 1 && kept.last().is_some_and(|s| s.width.is_none()) {
        let fluid = kept.pop();
        dropped.extend(kept.drain(..).map(|s| {
            (
                s,
                "the route has a screen without a pixel width, which fits any viewport and shows instead",
            )
        }));
        kept.extend(fluid);
    }
    (kept, dropped)
}

struct Written {
    text: String,
    css: String,
    diagnostics: Vec<Diagnostic>,
}

/// The component for `screens`, and the CSS that shows one of them.
fn write_page(doc: &Document, name: &str, screens: &[&Screen], links: &Links<'_>) -> Written {
    let modes = doc.modes();
    let mut diagnostics = Vec::new();
    let mut text = format!(
        "import {{ {LINK} }} from \"../link\";\n\nexport default function {name}() {{\n  return (\n    <>\n"
    );
    for (i, screen) in screens.iter().enumerate() {
        let mode = doc
            .get(&screen.artboard)
            .map(|board| doc.mode_of(board))
            .filter(|mode| *mode != doc.first_mode())
            .and_then(|mode| modes.iter().position(|(id, _)| *id == mode));
        let mode = mode.map_or(String::new(), |n| format!(" data-finite-mode=\"{n}\""));
        // Two elements, so the design's CSS can't undo the media queries: the
        // outer one is only styled by `screens_css`, and the inner one is the
        // page that the design's `html`, `body` and `:root` rules style.
        let page = format!("{name}-{i}-page");
        text.push_str(&format!(
            "      <div className=\"finite-screen {name}-{i}\"{mode}>\n        <div className=\"finite-page {page}\">\n"
        ));
        let options = jsx::Options {
            scope: Some(&page),
            ..Default::default()
        };
        if let Some(converted) = jsx::convert_with(doc, &screen.artboard, &options, Some(links), 5)
        {
            text.push_str(&converted.jsx);
            text.push('\n');
            diagnostics.extend(converted.diagnostics);
        }
        text.push_str("        </div>\n      </div>\n");
    }
    text.push_str("    </>\n  );\n}\n");
    Written {
        text,
        css: screens_css(name, screens),
        diagnostics,
    }
}

/// The rules that show the screen for the viewport's width. They are the only
/// rules on a screen's outer element, so the design's own CSS can't show a
/// screen they hide. The first
/// screen shows below the second's width, and each other screen from its own
/// width up to the next screen's.
fn screens_css(name: &str, screens: &[&Screen]) -> String {
    let widths: Vec<f64> = screens.iter().filter_map(|s| s.width).collect();
    if screens.len() < 2 || widths.len() != screens.len() {
        return String::new();
    }
    let mut css = String::new();
    for i in 1..widths.len() {
        css.push_str(&format!(".{name}-{i} {{ display: none; }}\n"));
    }
    css.push_str(&format!(
        "@media (width >= {}px) {{ .{name}-0 {{ display: none; }} }}\n",
        widths[1]
    ));
    for (i, width) in widths.iter().enumerate().skip(1) {
        let upper = widths
            .get(i + 1)
            .map_or(String::new(), |next| format!(" and (width < {next}px)"));
        css.push_str(&format!(
            "@media (width >= {width}px){upper} {{ .{name}-{i} {{ display: block; }} }}\n"
        ));
    }
    css
}

/// The stylesheet every screen shares: the base styles artboards render
/// with, the first mode's tokens on `:root`, and each other mode's on the
/// screens that use it.
fn global_css(doc: &Document, flow: &Flow) -> String {
    let mut css = format!(
        "@layer {} {{\n  {}\n  html, body {{ margin: 0; }}\n  .finite-page > * {{ margin-inline: auto; }}\n}}\n",
        html::BASE_LAYER,
        html::BASE_CSS
    );
    let used: HashSet<&str> = flow
        .routes
        .iter()
        .flat_map(|r| &r.screens)
        .filter_map(|s| doc.get(&s.artboard))
        .map(|board| doc.mode_of(board))
        .collect();
    for (n, (mode, _)) in doc.modes().into_iter().enumerate() {
        let rule = if mode == doc.first_mode() {
            tokens::style_at(doc, mode, ":root")
        } else if used.contains(mode) {
            tokens::style_at(doc, mode, &format!("[data-finite-mode=\"{n}\"]"))
        } else {
            continue;
        };
        if !rule.is_empty() {
            css.push_str(&rule);
            css.push('\n');
        }
    }
    css
}

/// The files every project has, whichever router it uses.
fn scaffold(name: &str, router: &dyn Router) -> Vec<File> {
    let mut packages: BTreeMap<&str, &str> =
        BTreeMap::from([("react", "19.3.1"), ("react-dom", "19.3.1")]);
    packages.extend(router.packages().iter().map(|p| (p.name, p.version)));
    let dependencies = packages
        .iter()
        .map(|(name, version)| format!("    \"{name}\": \"{version}\""))
        .collect::<Vec<_>>()
        .join(",\n");
    let file = |path: &str, text: String| File {
        path: path.into(),
        text,
    };
    vec![
        file(
            "package.json",
            format!(
                "{{\n  \"name\": {},\n  \"private\": true,\n  \"version\": \"0.0.0\",\n  \"type\": \"module\",\n  \"scripts\": {{\n    \"dev\": \"vite\",\n    \"build\": \"vite build\",\n    \"preview\": \"vite preview\"\n  }},\n  \"dependencies\": {{\n{dependencies}\n  }},\n  \"devDependencies\": {{\n    \"@types/react\": \"19.3.0\",\n    \"@types/react-dom\": \"19.3.0\",\n    \"@vitejs/plugin-react\": \"6.2.1\",\n    \"vite\": \"8.3.6\"\n  }}\n}}\n",
                serde_json::to_string(&format!("{}-app", file_stem(name)))
                    .expect("strings serialize")
            ),
        ),
        file(
            "index.html",
            format!(
                "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>{}</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/main.tsx\"></script>\n  </body>\n</html>\n",
                html::escape(name, false)
            ),
        ),
        file(
            "vite.config.ts",
            "import react from \"@vitejs/plugin-react\";\nimport { defineConfig } from \"vite\";\n\nexport default defineConfig({ plugins: [react()] });\n".into(),
        ),
        file(
            "tsconfig.json",
            "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"lib\": [\"ES2022\", \"DOM\", \"DOM.Iterable\"],\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"bundler\",\n    \"jsx\": \"react-jsx\",\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": true,\n    \"isolatedModules\": true,\n    \"types\": [\"vite/client\"]\n  },\n  \"include\": [\"src\"]\n}\n".into(),
        ),
        file(".gitignore", "node_modules\ndist\n".into()),
        file(
            "src/main.tsx",
            "import { StrictMode } from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport { App } from \"./router\";\nimport \"./global.css\";\n\ncreateRoot(document.getElementById(\"root\")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n".into(),
        ),
        file(
            "README.md",
            format!(
                "# {name}\n\nA clickable prototype exported from Finite. It uses Vite, React and {}.\n\n```sh\nnpm install\nnpm run dev      # http://localhost:5173\nnpm run build    # writes dist/\n```\n\nEach route is a file in `src/pages/` that holds the route's screens (one per artboard width) and shows the one that fits the window. The first route is served at `/`. Images are in `public/assets/`, and the design's tokens are CSS variables in `src/global.css`.\n",
                router.name()
            ),
        ),
    ]
}
