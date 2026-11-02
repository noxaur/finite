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
    Node, NodeKind,
    edit::pixel_size,
    html::{self, Fragment},
    import::{BlobHash, Dependency},
    version::{Schema, VersionError},
};
use serde::{Deserialize, Serialize};

use crate::{
    Anchor, Board, Codec, Diagnostic, Direction, Error, Exported, Feature, Imported, Input,
    Revision, Scope, Score, Support, assets, file_stem,
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
    /// The shared CSS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
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
        }
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        let json = std::str::from_utf8(input.bytes)
            .map_err(|_| Error("the file isn't UTF-8 text, so it can't be a bundle".into()))?;
        let bundle: Bundle = BUNDLE.decode(json).map_err(|e| match e {
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
            .map(|(i, layer)| board(i, layer, &mut diagnostics))
            .collect();
        let dependencies = blobs
            .iter()
            .map(|(hash, _)| Dependency {
                url: format!("{}{hash}", assets::SCHEME),
                blob: Some(hash.clone()),
            })
            .collect();
        Ok(Imported {
            format: self.name(),
            input_kind: format!("finite-bundle v{}", BUNDLE.version),
            boards,
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
            .map(|board| layer(revision, board, &mut portable))
            .collect();
        let css = revision.doc.css().map(&mut portable);
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
            css,
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
        layer.children.iter().for_each(|child| walk(child, out));
    }
    bundle
        .artboards
        .iter()
        .for_each(|layer| walk(layer, &mut referenced));
    if let Some(css) = &bundle.css {
        referenced.extend(assets::referenced(css));
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
        name: layer.name.unwrap_or_else(|| format!("Artboard {}", i + 1)),
        width,
        height,
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
    Layer {
        tag: node.tag().map(str::to_owned),
        name: node.name.clone(),
        text: node.text.clone(),
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
    use finite_design::{Design, DesignMeta, html::export, import::ImportRecord};
    use serde_json::json;

    use super::*;
    use crate::{Blobs, Placed, Receipt};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

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

    /// A design with one artboard holding a stored image, and shared CSS.
    fn source() -> Design {
        let mut source = design("old");
        let html = format!(
            "<!doctype html><body class=\"page\" style=\"background: #eee\"><img src=\"{}\" data-name=\"Logo\"><p>Hi</p></body>",
            assets::url("old", &BlobHash::of(PNG))
        );
        let imported = crate::html::Html
            .read(&Input {
                bytes: html.as_bytes(),
                file_name: Some("Home.html"),
            })
            .unwrap();
        place(&mut source, imported);
        let css = format!(
            ".page {{ background: url({}) }}",
            assets::url("old", &BlobHash::of(PNG))
        );
        source.commit(
            "agent",
            "CSS",
            &finite_design::edit::set_css(&css).unwrap(),
            2,
        );
        source
    }

    #[test]
    fn a_design_moves_through_a_bundle_with_its_files() {
        let source = source();
        let revision = Revision {
            name: "Home",
            doc: source.doc(),
            imports: source.imports(),
            blobs: &Store(vec![PNG.to_vec()]),
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
        assert_eq!(imported.blobs, [PNG.to_vec()]);
        let mut target = design("new");
        let (record, placed) = place(&mut target, imported);
        assert_eq!(record.dependencies[0].blob, Some(BlobHash::of(PNG)));
        let old = source.doc().artboards()[0];
        let new = target.doc().get(&placed.artboards[0]).unwrap();
        assert_eq!((new.x, new.y, &new.attrs), (old.x, old.y, &old.attrs));
        assert_eq!(new.styles, old.styles);
        let html = |design: &Design, id: &str| export(design.doc(), id, false).unwrap();
        assert_eq!(
            html(&target, &new.id),
            html(&source, &old.id).replace("/api/designs/old/", "/api/designs/new/")
        );
        assert_eq!(
            target.doc().css(),
            source
                .doc()
                .css()
                .map(|css| css.replace("/designs/old/", "/designs/new/"))
                .as_deref()
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

        let mut wrong = refers.clone();
        wrong["blobs"] = json!({ hash.as_str(): STANDARD.encode(b"other bytes") });
        let error = read(&wrong.to_string()).unwrap_err();
        assert!(error.0.contains("doesn't match its hash"), "{error}");

        let mut right = refers;
        right["blobs"] = json!({ hash.as_str(): STANDARD.encode(PNG) });
        assert!(read(&right.to_string()).is_ok());
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
