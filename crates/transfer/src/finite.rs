//! `.finite` bundles: a design in one self-contained JSON file, with the
//! files it points to inside, so it can move between servers and people.
//!
//! The bundle has its own wire types, [`Bundle`] and [`Layer`], instead of
//! `Snapshot`: a snapshot also carries server state like seq numbers and
//! undo history, and its node ids mean nothing in another design. Layers
//! nest, so a bundle needs no ids at all. Blob URLs become
//! [`assets::SCHEME`] references, and each referenced file is inside, as
//! base64.
//!
//! A bundle is a file anyone can write, so reading one applies the same
//! rules as an HTML import: anything that could run code is quarantined.

use std::collections::BTreeMap;

use base64::{Engine, engine::general_purpose::STANDARD};
use finite_design::{
    MAX_DEPTH, Node, NodeKind,
    edit::pixel_size,
    html::{self, Fragment},
    import::{BlobHash, Dependency},
    version::{Schema, VersionError},
};
use serde::{Deserialize, Serialize};

use crate::{
    Anchor, Board, Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input,
    Revision, Scope, Score, Support, Tokens, assets, file_stem,
};

/// The bundle's format and version. See `finite_design::version`.
pub const BUNDLE: Schema = Schema {
    name: "Finite bundle",
    version: 1,
    upgrades: &[],
};

/// What a bundle's `kind` says, so a stray JSON file isn't taken for one.
const KIND: &str = "finite-bundle";

/// Used for an artboard whose width or height isn't in pixels.
const FALLBACK: (f64, f64) = (1440.0, 900.0);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub kind: String,
    /// The design's name.
    pub name: String,
    /// The shared CSS of a bundle made before tokens. Importing it moves
    /// it into tokens (see [`Imported::css`]).
    #[serde(default, skip_serializing)]
    pub css: Option<String>,
    /// The design's modes, by name, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<String>,
    /// The design's tokens, each with its values by mode name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tokens: BTreeMap<String, BTreeMap<String, String>>,
    /// The name of the mode each artboard renders in, by its index in
    /// `artboards`, for those not in the first mode. It's here rather than
    /// in [`Layer`], since every layer of the deepest design is on the
    /// stack at once while it's read.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub artboard_modes: BTreeMap<usize, String>,
    /// The design's pages, by name, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<String>,
    pub artboards: Vec<Layer>,
    /// Every file a layer or the CSS refers to, as base64, by its sha256.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub blobs: BTreeMap<BlobHash, String>,
}

/// One layer and everything inside it. A layer without a tag is text.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The name of the page an artboard is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,

    /// Canvas position, for artboards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub styles: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Layer>,
}

pub struct Finite;

impl Codec for Finite {
    fn name(&self) -> &'static str {
        "finite"
    }

    fn support(&self, feature: Feature, direction: Direction) -> Support {
        use {Direction::*, Support::*};
        match (feature, direction) {
            (
                Feature::Frame
                | Feature::Text
                | Feature::SolidFill
                | Feature::Image
                | Feature::FlexLayout,
                Import | Export,
            ) => Exact,
            // Like HTML: a bundle's scripts are quarantined on the way in.
            (Feature::Script, Import) => Opaque,
            (Feature::Script, Export) => Exact,
            (Feature::Embed, Import) => Opaque,
            (Feature::Embed, Export) => Unsupported,
            // A bundle holds the design, not how it got there.
            (Feature::ImportHistory, Import | Export) => Unsupported,
            // A bundle has no components, so an instance is written as the
            // elements it shows.
            (Feature::Instance, Import) => Unsupported,
            (Feature::Instance, Export) => Approximate,
        }
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        let json = std::str::from_utf8(input.bytes)
            .map_err(|_| Error("the file isn't UTF-8 text, so it can't be a bundle".into()))?;
        // Each layer nests an object and its children's array.
        let limit = 2 * MAX_DEPTH + 8;
        let bundle: Bundle = BUNDLE.decode_nested(json, limit).map_err(|e| match e {
            VersionError::Json(e) => Error(format!("this isn't a Finite bundle: {e}")),
            other => Error(other.to_string()),
        })?;
        if bundle.kind != KIND {
            return Err(Error(format!(
                "this isn't a Finite bundle: its kind is {:?}",
                bundle.kind
            )));
        }
        let blobs = verified_blobs(&bundle)?;
        let mut diagnostics = Vec::new();
        let boards = bundle
            .artboards
            .into_iter()
            .enumerate()
            .map(|(i, layer)| Board {
                mode: bundle.artboard_modes.get(&i).cloned(),
                ..board(i, layer, &mut diagnostics)
            })
            .collect();
        let dependencies = blobs
            .iter()
            .map(|(hash, _)| Dependency {
                url: format!("{}{hash}", assets::SCHEME),
                blob: Some(hash.clone()),
            })
            .collect();
        Ok(Imported {
            pages: bundle.pages,
            format: self.name(),
            input_kind: format!("finite-bundle v{}", BUNDLE.version),
            boards,
            tokens: Tokens {
                modes: bundle.modes,
                values: bundle.tokens,
            },
            css: bundle.css,
            blobs: blobs.into_iter().map(|(_, bytes)| bytes).collect(),
            dependencies,
            diagnostics,
        })
    }

    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
        let mut hashes = Vec::new();
        let mut portable = |value: &str| {
            let (value, found) = assets::portable(value);
            hashes.extend(found);
            value
        };
        let artboards = revision
            .artboards(scope)?
            .into_iter()
            .map(|board| {
                let page = revision.doc.page(revision.doc.page_of(board));
                Layer {
                    page: page.map(|p| p.name.clone()),
                    ..layer(revision, board, &mut portable)
                }
            })
            .collect();
        let artboard_modes = revision
            .artboards(scope)?
            .into_iter()
            .enumerate()
            .filter_map(|(i, board)| Some((i, Tokens::mode_of(revision.doc, board)?)))
            .collect();
        let pages = match scope {
            Scope::Design => revision
                .doc
                .pages()
                .into_iter()
                .map(|(_, page)| page.name.clone())
                .collect(),
            Scope::Artboard(_) => Vec::new(),
        };
        let tokens = Tokens::of(revision.doc, &mut portable);
        let mut blobs = BTreeMap::new();
        let mut diagnostics = Vec::new();
        for hash in hashes {
            if blobs.contains_key(&hash) {
                continue;
            }
            match revision.blobs.get(&hash)? {
                Some(bytes) => {
                    blobs.insert(hash, STANDARD.encode(bytes));
                }
                None => diagnostics.push(Diagnostic {
                    node: None,
                    path: format!("{}{hash}", assets::SCHEME),
                    what: "a file".into(),
                    feature: Feature::Image,
                    reason: "the design points at a file its store doesn't have".into(),
                    preserved: Score::No,
                    visual: Score::No,
                    editable: Score::No,
                    quarantined: false,
                }),
            }
        }
        if *scope == Scope::Design && !revision.imports.is_empty() {
            diagnostics.push(Diagnostic {
                node: None,
                path: String::new(),
                what: format!("{} import record(s)", revision.imports.len()),
                feature: Feature::ImportHistory,
                reason: "a bundle doesn't carry the files the design was imported from".into(),
                preserved: Score::No,
                visual: Score::Yes,
                editable: Score::Yes,
                quarantined: false,
            });
        }
        let bundle = Bundle {
            kind: KIND.into(),
            name: revision.name.to_owned(),
            css: None,
            modes: tokens.modes,
            tokens: tokens.values,
            artboard_modes,
            pages,
            artboards,
            blobs,
        };
        let json = BUNDLE
            .encode(&bundle)
            .map_err(|e| Error(format!("couldn't write the bundle: {e}")))?;
        let stem = match scope {
            Scope::Design => revision.name.to_owned(),
            Scope::Artboard(_) => bundle.artboards[0].name.clone().unwrap_or_default(),
        };
        Ok(Exported {
            file_name: format!("{}.finite", file_stem(&stem)),
            media_type: "application/vnd.finite+json",
            bytes: json.into_bytes(),
            diagnostics,
        })
    }
}

/// The bundle's files, decoded, after checking the manifest both ways:
/// every file the content refers to is there, and every file's bytes hash
/// to the name it's filed under.
fn verified_blobs(bundle: &Bundle) -> Result<Vec<(BlobHash, Vec<u8>)>, Error> {
    let mut referenced = Vec::new();
    fn walk(layer: &Layer, out: &mut Vec<BlobHash>) {
        for value in layer.styles.values().chain(layer.attrs.values()) {
            out.extend(assets::referenced(value));
        }
        // A stylesheet's text can point at files too.
        if layer.tag.as_deref() == Some("style") {
            for child in &layer.children {
                out.extend(child.text.iter().flat_map(|t| assets::referenced(t)));
            }
        }
        layer.children.iter().for_each(|child| walk(child, out));
    }
    bundle
        .artboards
        .iter()
        .for_each(|layer| walk(layer, &mut referenced));
    for text in bundle
        .css
        .iter()
        .chain(bundle.tokens.values().flat_map(|v| v.values()))
    {
        referenced.extend(assets::referenced(text));
    }
    if let Some(missing) = referenced.iter().find(|h| !bundle.blobs.contains_key(*h)) {
        return Err(Error(format!(
            "the bundle refers to a file it doesn't contain: {missing}"
        )));
    }
    bundle
        .blobs
        .iter()
        .map(|(hash, base64)| {
            let bytes = STANDARD
                .decode(base64)
                .map_err(|_| Error(format!("the bundle's file {hash} isn't valid base64")))?;
            if BlobHash::of(&bytes) != *hash {
                return Err(Error(format!(
                    "the bundle's file {hash} doesn't match its hash"
                )));
            }
            Ok((hash.clone(), bytes))
        })
        .collect()
}

/// An artboard of a bundle, as a board to create.
fn board(i: usize, layer: Layer, diagnostics: &mut Vec<(Anchor, Diagnostic)>) -> Board {
    let path = format!("/artboards/{i}");
    let probe = Node {
        styles: layer.styles.clone(),
        ..Node::element("", "div")
    };
    let (width, height) = match pixel_size(&probe) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (w, h),
        _ => {
            diagnostics.push((
                Anchor {
                    board: i,
                    node: None,
                },
                Diagnostic {
                    node: None,
                    path: path.clone(),
                    what: "the artboard's size".into(),
                    feature: Feature::Frame,
                    reason: format!(
                        "it isn't in pixels, so the artboard is {} × {}",
                        FALLBACK.0, FALLBACK.1
                    ),
                    preserved: Score::No,
                    visual: Score::No,
                    editable: Score::Yes,
                    quarantined: false,
                },
            ));
            FALLBACK
        }
    };
    let mut walk = Walk {
        board: i,
        paths: Vec::new(),
        diagnostics,
    };
    let mut attrs = layer.attrs;
    walk.attrs(&mut attrs, None, &path);
    let content = walk.children(layer.children, &path, None);
    Board {
        page: layer.page,
        name: layer.name.unwrap_or_else(|| format!("Artboard {}", i + 1)),
        width,
        height,
        auto_height: false,
        mode: None,
        position: layer.x.zip(layer.y),
        styles: layer.styles,
        attrs,
        content,
        source: Some(path),
        paths: walk.paths,
    }
}

/// Turns a bundle's layers into fragments, quarantining what could run
/// code, the way `finite_design::html::parse_with` does for HTML.
struct Walk<'a> {
    board: usize,
    /// The source path of each kept fragment, numbered like [`Anchor::node`].
    paths: Vec<String>,
    diagnostics: &'a mut Vec<(Anchor, Diagnostic)>,
}

impl Walk<'_> {
    fn children(&mut self, layers: Vec<Layer>, path: &str, anchor: Option<usize>) -> Vec<Fragment> {
        layers
            .into_iter()
            .enumerate()
            .filter_map(|(i, layer)| self.layer(layer, format!("{path}/children/{i}"), anchor))
            .collect()
    }

    fn layer(&mut self, layer: Layer, path: String, anchor: Option<usize>) -> Option<Fragment> {
        let Some(tag) = layer.tag else {
            self.paths.push(path);
            return Some(Fragment {
                kind: NodeKind::Text,
                name: layer.name,
                text: Some(layer.text.unwrap_or_default()),
                styles: BTreeMap::new(),
                attrs: BTreeMap::new(),
                children: Vec::new(),
                ..Fragment::empty(NodeKind::Text)
            });
        };
        let lower = tag.to_ascii_lowercase();
        let refused = if !html::is_attr_name(&tag) {
            Some((Feature::Embed, "its tag isn't a valid element name"))
        } else if html::is_blocked_tag(&tag) {
            Some((
                Feature::Embed,
                "it loads another document or changes the page outside the artboard",
            ))
        } else if lower == "script" {
            Some((Feature::Script, "scripts in imported files don't run"))
        } else {
            None
        };
        if let Some((feature, reason)) = refused {
            self.quarantine(anchor, &path, format!("<{lower}>"), feature, reason);
            return None;
        }
        let me = self.paths.len();
        self.paths.push(path.clone());
        let mut attrs = layer.attrs;
        self.attrs(&mut attrs, Some(me), &path);
        let children = self.children(layer.children, &path, Some(me));
        Some(Fragment {
            kind: NodeKind::Element { tag },
            name: layer.name,
            text: layer.text,
            styles: layer.styles,
            attrs,
            children,
            ..Fragment::empty(NodeKind::Text)
        })
    }

    /// Removes attributes that could run code, or that couldn't be written
    /// back as HTML, and quarantines them.
    fn attrs(&mut self, attrs: &mut BTreeMap<String, String>, anchor: Option<usize>, path: &str) {
        let refused: Vec<String> = attrs
            .iter()
            .filter(|(name, value)| !html::is_attr_name(name) || !html::is_safe_attr(name, value))
            .map(|(name, _)| name.clone())
            .collect();
        for name in refused {
            attrs.remove(&name);
            self.quarantine(anchor, path, name, Feature::Script, "it could run code");
        }
    }

    fn quarantine(
        &mut self,
        anchor: Option<usize>,
        path: &str,
        what: String,
        feature: Feature,
        reason: &str,
    ) {
        let visual = match feature {
            Feature::Script => Score::Unknown,
            _ => Score::No,
        };
        self.diagnostics.push((
            Anchor {
                board: self.board,
                node: anchor,
            },
            Diagnostic {
                node: None,
                path: path.to_owned(),
                what,
                feature,
                reason: reason.to_owned(),
                preserved: Score::Yes,
                visual,
                editable: Score::No,
                quarantined: true,
            },
        ));
    }
}

/// A node and everything inside it, as a layer, with blob URLs made portable.
fn layer(revision: &Revision<'_>, node: &Node, portable: &mut impl FnMut(&str) -> String) -> Layer {
    let map = |values: &BTreeMap<String, String>, portable: &mut dyn FnMut(&str) -> String| {
        values
            .iter()
            .map(|(k, v)| (k.clone(), portable(v)))
            .collect()
    };
    // A stylesheet's text can point at files, like any style.
    let in_style = node
        .parent
        .as_deref()
        .and_then(|p| revision.doc.get(p))
        .is_some_and(|p| p.tag() == Some("style"));
    let text = match &node.text {
        Some(text) if in_style => Some(portable(text)),
        text => text.clone(),
    };
    Layer {
        page: None,
        tag: node.tag().map(str::to_owned),
        name: node.name.clone(),
        text,
        x: node.x,
        y: node.y,
        styles: map(&node.styles, portable),
        attrs: map(&node.attrs, portable),
        children: revision
            .doc
            .children(Some(&node.id))
            .into_iter()
            .map(|child| layer(revision, child, portable))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use finite_design::{
        Design, DesignMeta,
        edit::{self, TokenChange},
        html::export,
        import::ImportRecord,
    };
    use serde_json::json;

    use super::*;
    use crate::{Blobs, Placed, Receipt};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";
    /// Only a `<style>` element refers to this one.
    const GIF: &[u8] = b"GIF89a fake";

    struct Store(Vec<Vec<u8>>);

    impl Blobs for Store {
        fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
            Ok(self.0.iter().find(|b| BlobHash::of(b) == *hash).cloned())
        }
    }

    fn design(id: &str) -> Design {
        Design::new(DesignMeta {
            id: id.into(),
            name: "Home".into(),
            created_at: 0,
            updated_at: 0,
        })
    }

    fn ids(prefix: &'static str) -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("{prefix}{n}")
        }
    }

    fn read(json: &str) -> Result<Imported, Error> {
        Finite.read(&Input {
            bytes: json.as_bytes(),
            file_name: Some("home.finite"),
        })
    }

    fn place(design: &mut Design, imported: Imported) -> (ImportRecord, Placed) {
        let receipt = Receipt {
            page: None,
            id: "i1".into(),
            design: design.meta.id.clone(),
            artifact: BlobHash::of(b"bundle"),
            file_name: None,
            received_at: 0,
        };
        let mut new_id = ids("n");
        let (_, placed) = design
            .import("agent", "Import", 1, |tx| {
                let (record, placed) = imported.place(tx, receipt, &mut new_id)?;
                Ok::<_, Error>((record.clone(), (record, placed)))
            })
            .unwrap();
        placed
    }

    /// A design with one artboard holding a stored image, and tokens in two
    /// modes, one of them pointing at a stored image too.
    fn source() -> Design {
        let mut source = design("old");
        let html = format!(
            "<!doctype html><body class=\"page\" style=\"background: #eee\"><style>.x {{ background: url({}) }}</style><img src=\"{}\" data-name=\"Logo\"><p>Hi</p></body>",
            assets::url("old", &BlobHash::of(GIF)),
            assets::url("old", &BlobHash::of(PNG))
        );
        let imported = crate::html::Html
            .read(&Input {
                bytes: html.as_bytes(),
                file_name: Some("Home.html"),
            })
            .unwrap();
        place(&mut source, imported);
        let names = ["Light".to_owned(), "Dark".to_owned()];
        let mut n = 0;
        let (mut ops, modes) = edit::set_modes(source.doc(), &names, &mut || {
            n += 1;
            format!("m{n}")
        })
        .unwrap();
        let hero = format!("url({})", assets::url("old", &BlobHash::of(PNG)));
        let dark = TokenChange::Modes(
            [("Light", "#fff"), ("Dark", "#111")]
                .map(|(m, v)| (m.to_owned(), Some(v.to_owned())))
                .into(),
        );
        let changes = [
            ("--hero".to_owned(), TokenChange::All(hero)),
            ("--bg".to_owned(), dark),
        ];
        ops.extend(edit::set_tokens(source.doc(), &modes, &changes).unwrap());
        source.commit("agent", "Tokens", &ops, 2);
        let board = source.doc().artboards()[0].id.clone();
        let ops = edit::set_artboard_mode(source.doc(), &[board], Some("Dark")).unwrap();
        source.commit("agent", "Mode", &ops, 3);
        source
    }

    #[test]
    fn a_design_moves_through_a_bundle_with_its_files() {
        let source = source();
        let revision = Revision {
            name: "Home",
            doc: source.doc(),
            imports: source.imports(),
            blobs: &Store(vec![PNG.to_vec(), GIF.to_vec()]),
            measure: &crate::scene::NoMeasure,
        };
        let exported = Finite.write(&revision, &Scope::Design).unwrap();
        assert_eq!(exported.file_name, "home.finite");
        let json = String::from_utf8(exported.bytes).unwrap();
        assert!(
            json.starts_with(r#"{"v":1,"kind":"finite-bundle""#),
            "{json}"
        );
        assert!(!json.contains("/api/designs/old"), "{json}");
        // The import record isn't carried, and the export says so.
        assert_eq!(exported.diagnostics[0].feature, Feature::ImportHistory);

        let imported = read(&json).unwrap();
        let mut carried = imported.blobs.clone();
        carried.sort();
        assert_eq!(carried, [GIF.to_vec(), PNG.to_vec()]);
        let mut target = design("new");
        let (record, placed) = place(&mut target, imported);
        assert_eq!(record.dependencies.len(), 2);
        let old = source.doc().artboards()[0];
        let new = target.doc().get(&placed.artboards[0]).unwrap();
        assert_eq!((new.x, new.y, &new.attrs), (old.x, old.y, &old.attrs));
        assert_eq!(new.styles, old.styles);
        let html = |design: &Design, id: &str| export(design.doc(), id, false).unwrap();
        assert_eq!(
            html(&target, &new.id),
            html(&source, &old.id).replace("/api/designs/old/", "/api/designs/new/")
        );
        let names = |design: &Design| -> Vec<String> {
            design
                .doc()
                .modes()
                .iter()
                .map(|(_, m)| m.name.clone())
                .collect()
        };
        assert_eq!(names(&target), ["Light", "Dark"]);
        assert_eq!(Tokens::mode_of(target.doc(), new).as_deref(), Some("Dark"));
        let carried = Tokens::of(target.doc(), str::to_owned);
        let sent = Tokens::of(source.doc(), |v| {
            v.replace("/designs/old/", "/designs/new/")
        });
        assert_eq!(carried, sent);
    }

    #[test]
    fn an_artboard_in_the_first_mode_keeps_it_in_another_design() {
        let bundle = json!({
            "v": 1,
            "kind": "finite-bundle",
            "name": "Modes",
            "modes": ["Light", "Dark"],
            "tokens": { "--bg": { "Light": "white", "Dark": "black" } },
            "artboards": [{ "name": "Board", "styles": { "width": "100px", "height": "100px" } }]
        });
        let mut target = design("new");
        let changes = [("--bg".to_owned(), TokenChange::All("green".into()))];
        let ops = edit::set_tokens(target.doc(), &edit::mode_list(target.doc()), &changes).unwrap();
        target.commit("agent", "Tokens", &ops, 1);
        let (_, placed) = place(&mut target, read(&bundle.to_string()).unwrap());
        let doc = target.doc();
        let board = doc.get(&placed.artboards[0]).unwrap();
        assert_eq!(doc.mode_map()[doc.mode_of(board)].name, "Light");
        assert!(
            finite_design::tokens::style(doc, doc.mode_of(board), false).contains("--bg: white;")
        );
    }

    #[test]
    fn an_old_bundles_shared_css_becomes_tokens() {
        let bundle = json!({
            "v": 1,
            "kind": "finite-bundle",
            "name": "Old",
            "css": ":root { --ink: #111 } .x { color: var(--ink) }",
            "artboards": [{ "name": "Board", "styles": { "width": "100px", "height": "100px" } }]
        });
        let imported = read(&bundle.to_string()).unwrap();
        let mut target = design("new");
        let (_, placed) = place(&mut target, imported);
        assert_eq!(
            target.doc().tokens()["--ink"].values().next().unwrap(),
            "#111"
        );
        let board = &placed.artboards[0];
        let style = target.doc().children(Some(board))[0];
        assert_eq!(style.tag(), Some("style"));
        let text = target.doc().children(Some(&style.id))[0]
            .text
            .clone()
            .unwrap();
        assert!(
            text.contains("@layer finite-shared {\n.x { color: var(--ink) }"),
            "{text}"
        );
    }

    #[test]
    fn a_hostile_bundle_is_quarantined() {
        let bundle = json!({
            "v": 1,
            "kind": "finite-bundle",
            "name": "Evil",
            "artboards": [{
                "name": "Board",
                "styles": { "width": "100px", "height": "100px" },
                "attrs": { "onclick": "a()" },
                "children": [
                    { "tag": "button", "attrs": { "onmouseover": "b()", "href": "javascript:c()" }, "children": [{ "text": "Go" }] },
                    { "tag": "script", "children": [{ "text": "d()" }] },
                    { "tag": "iframe", "attrs": { "src": "https://x" } },
                    { "tag": "img src=x onerror=e()" },
                    { "tag": "p", "attrs": { "x\" onload=\"f()": "1" } }
                ]
            }]
        });
        let imported = read(&bundle.to_string()).unwrap();
        let mut target = design("t");
        let (record, placed) = place(&mut target, imported);
        let board = &placed.artboards[0];
        // Only the button, its text and the <p> are left, with no handlers.
        let doc = target.doc();
        assert_eq!(doc.len(), 4);
        assert!(doc.nodes().all(|n| n.attrs.is_empty()));
        let mut what: Vec<_> = record.quarantined.iter().map(|q| q.what.as_str()).collect();
        what.sort();
        assert_eq!(
            what,
            [
                "<iframe>",
                "<img src=x onerror=e()>",
                "<script>",
                "href",
                "onclick",
                "onmouseover",
                "x\" onload=\"f()"
            ]
        );
        assert!(
            record
                .quarantined
                .iter()
                .any(|q| q.node.as_deref() == Some(board.as_str()))
        );
    }

    #[test]
    fn the_manifest_must_match() {
        let hash = BlobHash::of(PNG);
        let refers = json!({
            "kind": "finite-bundle", "name": "x",
            "artboards": [{ "styles": { "width": "1px", "height": "1px" },
                "children": [{ "tag": "img", "attrs": { "src": format!("finite-asset:{hash}") } }] }]
        });
        let error = read(&refers.to_string()).unwrap_err();
        assert!(error.0.contains("doesn't contain"), "{error}");
        let in_stylesheet = json!({
            "kind": "finite-bundle", "name": "x",
            "artboards": [{ "styles": { "width": "1px", "height": "1px" },
                "children": [{ "tag": "style", "children": [{ "text": format!(".a {{ background: url(finite-asset:{hash}) }}") }] }] }]
        });
        let error = read(&in_stylesheet.to_string()).unwrap_err();
        assert!(error.0.contains("doesn't contain"), "{error}");

        let mut wrong = refers.clone();
        wrong["blobs"] = json!({ hash.as_str(): STANDARD.encode(b"other bytes") });
        let error = read(&wrong.to_string()).unwrap_err();
        assert!(error.0.contains("doesn't match its hash"), "{error}");

        let mut right = refers;
        right["blobs"] = json!({ hash.as_str(): STANDARD.encode(PNG) });
        assert!(read(&right.to_string()).is_ok());
    }

    /// A design as deep as Finite allows exports and imports again, on a
    /// thread with the stack Tokio gives its blocking pool.
    #[test]
    fn the_deepest_design_round_trips() {
        let run = || {
            let deepest = MAX_DEPTH - 1;
            let html = "<div>".repeat(deepest) + &"</div>".repeat(deepest);
            let mut source = design("old");
            let imported = crate::html::Html
                .read(&Input {
                    bytes: html.as_bytes(),
                    file_name: None,
                })
                .unwrap();
            place(&mut source, imported);
            let revision = Revision {
                name: "Deep",
                doc: source.doc(),
                imports: source.imports(),
                blobs: &Store(Vec::new()),
                measure: &crate::scene::NoMeasure,
            };
            let json = Finite.write(&revision, &Scope::Design).unwrap().bytes;
            let mut target = design("new");
            place(
                &mut target,
                read(std::str::from_utf8(&json).unwrap()).unwrap(),
            );
            assert_eq!(target.doc().len(), source.doc().len());
        };
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(run)
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn other_files_and_newer_bundles_are_refused() {
        assert!(read("{}").is_err());
        assert!(read(r#"{"kind":"something-else","name":"x","artboards":[]}"#).is_err());
        let newer = r#"{"v":2,"kind":"finite-bundle","name":"x","artboards":[]}"#;
        let error = read(newer).unwrap_err();
        assert!(error.0.contains("version 2"), "{error}");
    }
}

#[cfg(test)]
mod page_tests {
    use finite_design::{Design, DesignMeta, edit};

    use super::*;
    use crate::{NoBlobs, Receipt};

    fn design(id: &str) -> Design {
        Design::new(DesignMeta {
            id: id.into(),
            name: "Pages".into(),
            created_at: 0,
            updated_at: 0,
        })
    }

    fn import(design: &mut Design, html: &str, page: Option<String>) -> Result<NodeIdList, Error> {
        let imported = crate::html::Html.read(&Input {
            bytes: html.as_bytes(),
            file_name: Some("a.html"),
        })?;
        let receipt = Receipt {
            page,
            id: format!("i{}", design.imports().len()),
            design: design.meta.id.clone(),
            artifact: BlobHash::of(html.as_bytes()),
            file_name: None,
            received_at: 0,
        };
        let mut n = design.doc().len();
        let mut new_id = move || {
            n += 1;
            format!("n{n}")
        };
        let (_, placed) = design.import("agent", "Import", 1, |tx| {
            let (record, placed) = imported.place(tx, receipt, &mut new_id)?;
            Ok::<_, Error>((record, placed))
        })?;
        Ok(placed.artboards)
    }

    type NodeIdList = Vec<String>;

    #[test]
    fn imports_land_on_the_page_asked_for() {
        let mut source = design("d");
        let ops = edit::create_page(source.doc(), "drafts".into(), "Drafts").unwrap();
        source.commit("agent", "Page", &ops, 1);
        let board = import(&mut source, "<p>Hi</p>", Some("drafts".into())).unwrap();
        let node = source.doc().get(&board[0]).unwrap();
        assert_eq!(source.doc().page_of(node), "drafts");
        let error = import(&mut source, "<p>Hi</p>", Some("nope".into())).unwrap_err();
        assert!(error.0.contains("no page"), "{error}");
    }

    #[test]
    fn a_bundle_keeps_its_pages() {
        let mut source = design("old");
        let ops = edit::create_page(source.doc(), "drafts".into(), "Drafts").unwrap();
        source.commit("agent", "Page", &ops, 1);
        let ops = edit::create_page(source.doc(), "empty".into(), "Empty").unwrap();
        source.commit("agent", "Page", &ops, 1);
        import(&mut source, "<p>Home</p>", None).unwrap();
        import(&mut source, "<p>Draft</p>", Some("drafts".into())).unwrap();

        let revision = Revision {
            name: "Pages",
            doc: source.doc(),
            imports: source.imports(),
            blobs: &NoBlobs,
            measure: &crate::scene::NoMeasure,
        };
        let json = Finite.write(&revision, &Scope::Design).unwrap().bytes;
        let imported = Finite
            .read(&Input {
                bytes: &json,
                file_name: None,
            })
            .unwrap();
        assert_eq!(imported.pages, ["Page 1", "Drafts", "Empty"]);

        let mut target = design("new");
        let receipt = Receipt {
            page: None,
            id: "b".into(),
            design: "new".into(),
            artifact: BlobHash::of(&json),
            file_name: None,
            received_at: 0,
        };
        let mut n = 0;
        let mut new_id = move || {
            n += 1;
            format!("m{n}")
        };
        target
            .import("agent", "Import", 1, |tx| {
                let (record, _) = imported.place(tx, receipt, &mut new_id)?;
                Ok::<_, Error>((record, ()))
            })
            .unwrap();
        let names: Vec<_> = target
            .doc()
            .pages()
            .into_iter()
            .map(|(_, p)| p.name.clone())
            .collect();
        assert_eq!(names, ["Page 1", "Drafts", "Empty"]);
        let on = |page: &str| {
            let doc = target.doc();
            let id = doc
                .pages()
                .into_iter()
                .find(|(_, p)| p.name == page)
                .unwrap()
                .0;
            doc.artboards_on(id).len()
        };
        assert_eq!((on("Page 1"), on("Drafts"), on("Empty")), (1, 1, 0));
    }
}
