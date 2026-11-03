//! A Figma payload into artboards.
//!
//! Each top-level layer becomes an artboard, and each layer inside it a
//! `<div>` with CSS that draws it the way Figma does: auto layout as
//! flexbox, other children positioned absolutely, fills as backgrounds.
//! Text becomes a `<div>` with spans for its styled runs, and vectors the
//! SVG the plugin exported for them, parsed like any imported HTML so
//! nothing in it can run.
//!
//! What has no CSS equivalent is reported, never dropped: the original
//! bytes keep the whole payload, fields this version doesn't know included.

mod layout;
mod paints;
mod text;

use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine, engine::general_purpose::STANDARD};
use finite_design::{
    NodeKind,
    html::{self, Dropped, Fragment, Policy},
    import::{BlobHash, Dependency},
    label,
    version::VersionError,
};
use serde_json::Value;

use super::payload::{FigNode, KIND, PAYLOAD, Paint, Payload};
use crate::{Anchor, Board, Diagnostic, Error, Feature, Imported, Input, Score, assets};

/// Styles for one node, as CSS property names and values.
type Styles = BTreeMap<String, String>;

pub fn read(input: &Input<'_>) -> Result<Imported, Error> {
    let json = std::str::from_utf8(input.bytes)
        .map_err(|_| Error("the file isn't UTF-8 text, so it can't be a Figma payload".into()))?;
    // Each layer nests an object and its children's array, and a layer's
    // paints and text runs nest a few levels more.
    let limit = 2 * finite_design::MAX_DEPTH + 16;
    let payload: Payload = PAYLOAD.decode_nested(json, limit).map_err(|e| match e {
        VersionError::Json(e) => Error(format!("this isn't a Figma payload: {e}")),
        other => Error(other.to_string()),
    })?;
    if payload.kind != KIND {
        return Err(Error(format!(
            "this isn't a Figma payload: its kind is {:?}",
            payload.kind
        )));
    }
    let (images, blobs) = images(&payload)?;
    let mut diagnostics = Vec::new();
    let mut reported = BTreeSet::new();
    let boards = payload
        .nodes
        .into_iter()
        .enumerate()
        .map(|(i, node)| {
            let walk = Walk {
                board: i,
                images: &images,
                paths: Vec::new(),
                diagnostics: &mut diagnostics,
                reported: &mut reported,
            };
            walk.board(node)
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
        pages: Vec::new(),
        format: "figma",
        input_kind: format!("figma-plugin-payload v{}", PAYLOAD.version),
        boards,
        css: None,
        blobs: blobs.into_iter().map(|(_, bytes)| bytes).collect(),
        dependencies,
        diagnostics,
    })
}

/// The payload's images, decoded, by Figma's image hash, after checking
/// that every image paint's hash is among them. The blobs are each stored
/// once, however many Figma hashes share their bytes.
#[allow(clippy::type_complexity)]
fn images(
    payload: &Payload,
) -> Result<(BTreeMap<String, BlobHash>, Vec<(BlobHash, Vec<u8>)>), Error> {
    fn walk<'a>(node: &'a FigNode, out: &mut Vec<&'a str>) {
        let runs = node.text.iter().flat_map(|t| &t.runs);
        let paints = node
            .fills
            .iter()
            .chain(&node.strokes)
            .chain(runs.flat_map(|r| &r.fills));
        out.extend(paints.filter_map(|p| p.image_hash.as_deref()));
        node.children.iter().for_each(|child| walk(child, out));
    }
    let mut referenced = Vec::new();
    payload
        .nodes
        .iter()
        .for_each(|node| walk(node, &mut referenced));
    if let Some(missing) = referenced
        .iter()
        .find(|h| !payload.images.contains_key(**h))
    {
        return Err(Error(format!(
            "an image fill refers to an image the payload doesn't contain: {missing}"
        )));
    }
    let mut hashes = BTreeMap::new();
    let mut blobs: Vec<(BlobHash, Vec<u8>)> = Vec::new();
    for (figma, base64) in &payload.images {
        let bytes = STANDARD
            .decode(base64)
            .map_err(|_| Error(format!("the payload's image {figma} isn't valid base64")))?;
        let hash = BlobHash::of(&bytes);
        if !blobs.iter().any(|(h, _)| *h == hash) {
            blobs.push((hash.clone(), bytes));
        }
        hashes.insert(figma.clone(), hash);
    }
    Ok((hashes, blobs))
}

/// How a layer sits in its parent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    /// It's the artboard, which places itself.
    Board,
    /// At its `x` and `y`: its parent has no auto layout, or it opts out.
    Absolute,
    /// In its parent's auto layout, along a row or a column.
    Flow { horizontal: bool },
}

/// Node types drawn by the SVG the plugin exports, not by fills.
const VECTORS: &[&str] = &[
    "VECTOR",
    "BOOLEAN_OPERATION",
    "STAR",
    "LINE",
    "POLYGON",
    "REGULAR_POLYGON",
];

/// Node types that become a plain `<div>`, drawn from their fills.
const BOXES: &[&str] = &[
    "FRAME",
    "GROUP",
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
    "SECTION",
    "RECTANGLE",
    "ELLIPSE",
    "TEXT",
];

/// Turns one artboard's layers into fragments.
struct Walk<'a> {
    board: usize,
    /// Figma's image hashes, to the blobs that hold their bytes.
    images: &'a BTreeMap<String, BlobHash>,
    /// The Figma path of each fragment, numbered like [`Anchor::node`].
    paths: Vec<String>,
    diagnostics: &'a mut Vec<(Anchor, Diagnostic)>,
    /// Unknown fields already reported, across the whole import.
    reported: &'a mut BTreeSet<String>,
}

impl Walk<'_> {
    fn board(mut self, mut node: FigNode) -> Board {
        let (mut width, mut height) = (node.width, node.height);
        if !(width >= 1.0 && height >= 1.0) {
            self.report(
                None,
                &node.id,
                "the frame's size",
                Feature::Frame,
                "an artboard is at least 1 × 1 pixels",
                [Score::Yes, Score::No, Score::Yes],
            );
            (width, height) = (width.max(1.0), height.max(1.0));
        }
        let name = std::mem::take(&mut node.name);
        let position = Some((node.x, node.y));
        let source = node.id.clone();
        let (mut styles, content) = self.contents(node, Place::Board, None);
        // An artboard is white unless told otherwise, and a Figma frame
        // without fills is transparent.
        if !styles.keys().any(|k| k.starts_with("background")) {
            styles.insert("background-color".into(), "transparent".into());
        }
        Board {
            page: None,
            name,
            width,
            height,
            auto_height: false,
            position,
            styles,
            attrs: BTreeMap::new(),
            content,
            source: Some(source),
            paths: self.paths,
        }
    }

    fn fragment(&mut self, node: FigNode, place: Place) -> Fragment {
        let me = self.paths.len();
        self.paths.push(node.id.clone());
        let name = Some(label::clip(&node.name, label::LAYER_NAME));
        let (styles, children) = self.contents(node, place, Some(me));
        Fragment {
            kind: NodeKind::Element { tag: "div".into() },
            name,
            text: None,
            styles,
            attrs: BTreeMap::new(),
            children,
            ..Fragment::empty(NodeKind::Text)
        }
    }

    /// The styles and children of the element `node` becomes. `me` numbers
    /// it like [`Anchor::node`], or is `None` for the artboard.
    fn contents(
        &mut self,
        mut node: FigNode,
        place: Place,
        me: Option<usize>,
    ) -> (Styles, Vec<Fragment>) {
        let id = node.id.clone();
        self.unknown(me, &id, &node.extra, Feature::Frame);
        let kind = node.kind.as_str();
        let vector = VECTORS.contains(&kind);
        if !vector && !BOXES.contains(&kind) {
            self.report(
                me,
                &id,
                format!("a {kind} layer"),
                Feature::Frame,
                "this version of Finite doesn't know this kind of layer, so it's an empty box",
                [Score::Yes, Score::Unknown, Score::No],
            );
        }
        let mut styles = Styles::new();
        let flow = node
            .layout
            .as_ref()
            .and_then(|layout| self.flow(me, &id, layout));
        self.place(&node, place, flow, &mut styles);
        if let Some(horizontal) = flow
            && let Some(layout) = &node.layout
        {
            self.container(me, &id, layout, horizontal, &mut styles);
        }
        if kind == "TEXT" {
            self.text_paints(me, &node, &mut styles);
        } else if !vector {
            self.fills(me, &id, &node.fills, &mut styles);
            self.strokes(me, &node, &mut styles);
        }
        if !vector {
            self.effects(me, &node, kind == "TEXT", &mut styles);
        }
        if kind == "ELLIPSE" {
            styles.insert("border-radius".into(), "50%".into());
        } else if let Some(radii) = node.corner_radii.filter(|r| r.iter().any(|&r| r > 0.0)) {
            styles.insert("border-radius".into(), corners(radii));
        }
        if node.opacity < 1.0 {
            styles.insert("opacity".into(), num(node.opacity));
        }
        if node.rotation != 0.0 {
            // Figma turns layers counterclockwise about their top left corner.
            styles.insert(
                "transform".into(),
                format!("rotate({}deg)", num(-node.rotation)),
            );
            styles.insert("transform-origin".into(), "0 0".into());
        }
        if !node.visible {
            styles.insert("visibility".into(), "hidden".into());
        }
        if node.clips_content {
            styles.insert("overflow".into(), "hidden".into());
        }

        let children = if let Some(text) = node.text.take() {
            self.text(me, &id, text, &mut styles)
        } else if let Some(svg) = node.svg.take() {
            self.svg(me, &id, &svg)
        } else {
            if vector {
                self.report(
                    me,
                    &id,
                    format!("a {kind} layer"),
                    Feature::Image,
                    "the plugin didn't send this shape as SVG, so it isn't drawn",
                    [Score::Yes, Score::No, Score::No],
                );
            }
            let children = std::mem::take(&mut node.children);
            if place != Place::Board
                && !styles.contains_key("position")
                && children
                    .iter()
                    .any(|c| child_place(flow, c) == Place::Absolute)
            {
                styles.insert("position".into(), "relative".into());
            }
            children
                .into_iter()
                .map(|child| {
                    let place = child_place(flow, &child);
                    self.fragment(child, place)
                })
                .collect()
        };
        (styles, children)
    }

    /// The SVG the plugin exported for a vector, parsed like an imported
    /// file, with what could run code quarantined.
    fn svg(&mut self, me: Option<usize>, id: &str, svg: &str) -> Vec<Fragment> {
        let parsed = match html::parse_with(svg, Policy::Import) {
            Ok(parsed) => parsed,
            Err(e) => {
                self.report(
                    me,
                    &format!("{id}/svg"),
                    "the layer's SVG",
                    Feature::Image,
                    &e.to_string(),
                    [Score::Yes, Score::No, Score::No],
                );
                return Vec::new();
            }
        };
        let base = self.paths.len();
        self.paths
            .extend(parsed.paths.iter().map(|p| format!("{id}/svg{p}")));
        for dropped in parsed.dropped {
            self.quarantine(me, base, id, dropped);
        }
        parsed.fragments
    }

    /// Reports what the SVG parser left out, on the nearest node it kept.
    fn quarantine(&mut self, me: Option<usize>, base: usize, id: &str, dropped: Dropped) {
        let script = dropped.what == "<script>" || !dropped.what.starts_with('<');
        let (feature, visual) = if script {
            (Feature::Script, Score::Unknown)
        } else {
            (Feature::Embed, Score::No)
        };
        self.diagnostics.push((
            Anchor {
                board: self.board,
                node: dropped.anchor.map(|a| base + a).or(me),
            },
            Diagnostic {
                node: None,
                path: format!("{id}/svg{}", dropped.path),
                what: dropped.what,
                feature,
                reason: dropped.reason.to_owned(),
                preserved: Score::Yes,
                visual,
                editable: Score::No,
                quarantined: true,
            },
        ));
    }

    /// Reports each field in `extra`, once per field name in the import.
    fn unknown(
        &mut self,
        me: Option<usize>,
        path: &str,
        extra: &BTreeMap<String, Value>,
        feature: Feature,
    ) {
        for name in extra.keys() {
            if self.reported.insert(name.clone()) {
                self.report(
                    me,
                    &format!("{path}/{name}"),
                    name.clone(),
                    feature,
                    "this version of Finite doesn't know this field",
                    [Score::Yes, Score::Unknown, Score::No],
                );
            }
        }
    }

    /// Records a diagnostic on node `me`, scored preserved, visual, editable.
    fn report(
        &mut self,
        me: Option<usize>,
        path: &str,
        what: impl Into<String>,
        feature: Feature,
        reason: &str,
        [preserved, visual, editable]: [Score; 3],
    ) {
        self.diagnostics.push((
            Anchor {
                board: self.board,
                node: me,
            },
            Diagnostic {
                node: None,
                path: path.to_owned(),
                what: what.into(),
                feature,
                reason: reason.to_owned(),
                preserved,
                visual,
                editable,
                quarantined: false,
            },
        ));
    }
}

/// How `child` sits in a parent laid out along `flow`.
fn child_place(flow: Option<bool>, child: &FigNode) -> Place {
    let absolute = child.child.as_ref().and_then(|c| c.positioning.as_deref()) == Some("ABSOLUTE");
    match flow {
        Some(horizontal) if !absolute => Place::Flow { horizontal },
        _ => Place::Absolute,
    }
}

/// `[top left, top right, bottom right, bottom left]` as `border-radius`.
fn corners(radii: [f64; 4]) -> String {
    if radii.iter().all(|&r| r == radii[0]) {
        px(radii[0])
    } else {
        radii.map(px).join(" ")
    }
}

/// A number for CSS, to three decimals and without a trailing `.0`.
fn num(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    // Formats -0 as 0.
    format!("{}", rounded + 0.0)
}

/// A length in pixels, like `12px` or `1.5px`.
fn px(value: f64) -> String {
    format!("{}px", num(value))
}

/// A Figma paint's image, as a CSS `url()` of the blob that holds it.
fn image_url(images: &BTreeMap<String, BlobHash>, paint: &Paint) -> Option<String> {
    let hash = images.get(paint.image_hash.as_deref()?)?;
    Some(format!("url(\"{}{hash}\")", assets::SCHEME))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use finite_design::{Design, DesignMeta, Document, import::ImportRecord};
    use serde_json::json;

    use super::*;
    use crate::{Placed, Receipt};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    fn fixture() -> String {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/figma/basic.figma.json");
        fs::read_to_string(path).unwrap()
    }

    fn import(json: &str) -> Result<Imported, Error> {
        read(&Input {
            bytes: json.as_bytes(),
            file_name: Some("basic.figma.json"),
        })
    }

    fn ids(prefix: &'static str) -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("{prefix}{n}")
        }
    }

    fn place(imported: Imported) -> (Design, ImportRecord, Placed) {
        let mut design = Design::new(DesignMeta {
            id: "d".into(),
            name: "Home".into(),
            created_at: 0,
            updated_at: 0,
        });
        let receipt = Receipt {
            page: None,
            id: "i1".into(),
            design: "d".into(),
            artifact: BlobHash::of(b"payload"),
            file_name: None,
            received_at: 0,
        };
        let mut new_id = ids("n");
        let (_, (record, placed)) = design
            .import("agent", "Import", 1, |tx| {
                let (record, placed) = imported.place(tx, receipt, &mut new_id)?;
                Ok::<_, Error>((record.clone(), (record, placed)))
            })
            .unwrap();
        (design, record, placed)
    }

    /// The node the record says came from Figma path `path`.
    fn from<'a>(doc: &'a Document, record: &ImportRecord, path: &str) -> &'a finite_design::Node {
        let (id, _) = record
            .nodes
            .iter()
            .find(|(_, p)| *p == path)
            .unwrap_or_else(|| panic!("no node came from {path}"));
        doc.get(id).unwrap()
    }

    fn style<'a>(node: &'a finite_design::Node, name: &str) -> Option<&'a str> {
        node.styles.get(name).map(String::as_str)
    }

    #[test]
    fn a_payload_becomes_artboards() {
        let imported = import(&fixture()).unwrap();
        assert_eq!(imported.input_kind, "figma-plugin-payload v1");
        // Two Figma hashes share one image's bytes, which are stored once.
        assert_eq!(imported.blobs, [PNG.to_vec()]);
        let hash = BlobHash::of(PNG);
        assert_eq!(
            imported.dependencies,
            [Dependency {
                url: format!("finite-asset:{hash}"),
                blob: Some(hash.clone()),
            }]
        );
        let (design, record, placed) = place(imported);
        let doc = design.doc();
        assert_eq!(placed.artboards.len(), 1);

        let board = doc.get(&placed.artboards[0]).unwrap();
        assert_eq!(record.nodes[&board.id], "1:1");
        assert_eq!(board.name.as_deref(), Some("Home"));
        assert_eq!((board.x, board.y), (Some(100.0), Some(-40.0)));
        assert_eq!(style(board, "width"), Some("400px"));
        assert_eq!(style(board, "background-color"), Some("rgb(245, 245, 245)"));

        let card = from(doc, &record, "1:2");
        assert_eq!(card.name.as_deref(), Some("Card"));
        assert_eq!(card.parent.as_deref(), Some(board.id.as_str()));
        for (name, value) in [
            ("display", "flex"),
            ("flex-direction", "column"),
            ("gap", "12px"),
            ("padding", "16px 24px 16px 24px"),
            ("justify-content", "flex-start"),
            ("align-items", "center"),
            ("position", "absolute"),
            ("left", "20px"),
            ("top", "30px"),
            ("width", "320px"),
            ("border-radius", "8px"),
            ("box-shadow", "0px 4px 12px 0px rgba(0, 0, 0, 0.25)"),
            ("border", "1.5px solid rgb(0, 0, 0)"),
            ("overflow", "hidden"),
        ] {
            assert_eq!(style(card, name), Some(value), "{name}");
        }
        // It hugs its content vertically.
        assert_eq!(style(card, "height"), None);
        assert_eq!(
            style(card, "background"),
            Some(
                format!(
                    "url(\"/api/designs/d/assets/{hash}\") center / cover no-repeat, rgb(255, 255, 255)"
                )
                .as_str()
            )
        );

        let title = from(doc, &record, "1:3");
        for (name, value) in [
            ("font-family", "\"Inter\""),
            ("font-size", "16px"),
            ("font-weight", "400"),
            ("line-height", "150%"),
            ("letter-spacing", "0.5px"),
            ("text-align", "center"),
            ("color", "rgb(17, 17, 17)"),
            ("flex-shrink", "0"),
            ("align-self", "stretch"),
        ] {
            assert_eq!(style(title, name), Some(value), "{name}");
        }
        assert_eq!(style(title, "width"), None);
        let parts: Vec<_> = doc.children(Some(&title.id));
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].text.as_deref(), Some("Hello "));
        assert_eq!(parts[1].tag(), Some("span"));
        assert_eq!(style(parts[1], "font-weight"), Some("700"));
        assert_eq!(
            doc.children(Some(&parts[1].id))[0].text.as_deref(),
            Some("bold")
        );
        assert_eq!(parts[2].text.as_deref(), Some(" world"));

        let photo = from(doc, &record, "1:4");
        // It fills the card's column, so its height is the card's to give.
        assert_eq!(style(photo, "flex-grow"), Some("1"));
        assert_eq!(style(photo, "height"), None);
        assert_eq!(style(photo, "width"), Some("272px"));
        assert_eq!(
            style(photo, "background"),
            Some(
                format!("url(\"/api/designs/d/assets/{hash}\") center / contain no-repeat")
                    .as_str()
            )
        );

        let badge = from(doc, &record, "1:5");
        for (name, value) in [
            ("position", "absolute"),
            ("left", "290px"),
            ("top", "-6px"),
            ("width", "12px"),
            ("height", "12px"),
            ("border-radius", "50%"),
            ("background-color", "rgba(255, 0, 0, 0.5)"),
        ] {
            assert_eq!(style(badge, name), Some(value), "{name}");
        }

        let gradient = from(doc, &record, "1:6");
        assert_eq!(
            style(gradient, "background"),
            Some("linear-gradient(180deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)")
        );
        assert_eq!(style(gradient, "transform"), Some("rotate(-45deg)"));
        assert_eq!(style(gradient, "visibility"), Some("hidden"));

        let icon = from(doc, &record, "1:7");
        let svg = doc.children(Some(&icon.id))[0];
        assert_eq!(svg.tag(), Some("svg"));
        assert_eq!(record.nodes[&svg.id], "1:7/svg/0");
        assert!(!svg.attrs.contains_key("onload"));
        assert_eq!(
            svg.attrs.get("viewBox").map(String::as_str),
            Some("0 0 24 24")
        );
        let path = doc.children(Some(&svg.id));
        assert_eq!(path.len(), 1);
        assert_eq!(path[0].tag(), Some("path"));
        assert!(doc.nodes().all(|n| n.tag() != Some("script")));

        // The quarantine is on the SVG element, where the code was.
        let mut what: Vec<_> = record.quarantined.iter().map(|q| q.what.as_str()).collect();
        what.sort();
        assert_eq!(what, ["<script>", "onload"]);
        assert!(
            record
                .quarantined
                .iter()
                .all(|q| q.node.as_deref() == Some(svg.id.as_str()))
        );

        // Each node maps back to its Figma layer, pre-order.
        let mut figma: Vec<_> = record
            .nodes
            .values()
            .filter(|p| !p.contains('/'))
            .cloned()
            .collect();
        figma.sort();
        assert_eq!(
            figma,
            ["1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "1:7", "1:8"]
        );
        assert_eq!(record.nodes.len(), doc.len());
    }

    #[test]
    fn what_doesnt_map_is_reported() {
        let imported = import(&fixture()).unwrap();
        let (_, record, placed) = place(imported);
        let mut summary: Vec<_> = placed
            .diagnostics
            .iter()
            .map(|d| {
                (
                    d.what.as_str(),
                    d.feature,
                    [d.preserved, d.visual, d.editable],
                )
            })
            .collect();
        summary.sort_by_key(|(what, ..)| *what);
        use Score::*;
        assert_eq!(
            summary,
            [
                ("<script>", Feature::Script, [Yes, Unknown, No]),
                ("a VECTOR layer", Feature::Image, [Yes, No, No]),
                ("a linear gradient", Feature::SolidFill, [Yes, Unknown, Yes]),
                ("blendMode", Feature::Image, [Yes, Unknown, No]),
                ("onload", Feature::Script, [Yes, Unknown, No]),
                ("textAutoResize", Feature::Text, [Yes, Unknown, No]),
                ("vibe", Feature::Frame, [Yes, Unknown, No]),
            ]
        );
        let vibe = placed
            .diagnostics
            .iter()
            .find(|d| d.what == "vibe")
            .unwrap();
        assert_eq!(vibe.path, "1:2/vibe");
        let card = record.nodes.iter().find(|(_, p)| *p == "1:2").unwrap().0;
        assert_eq!(vibe.node.as_ref(), Some(card));
        // A field the import has seen once isn't reported again.
        assert_eq!(
            placed
                .diagnostics
                .iter()
                .filter(|d| d.what == "vibe")
                .count(),
            1
        );
    }

    #[test]
    fn colors_and_lengths_are_css() {
        assert_eq!(px(12.0), "12px");
        assert_eq!(px(1.5), "1.5px");
        assert_eq!(px(0.1 + 0.2), "0.3px");
        assert_eq!(num(-0.0), "0");
        assert_eq!(corners([4.0, 4.0, 0.0, 0.0]), "4px 4px 0px 0px");
    }

    #[test]
    fn other_files_newer_payloads_and_missing_images_are_refused() {
        assert!(import("{}").is_err());
        let other = json!({ "kind": "something-else", "file": { "name": "x" }, "nodes": [] });
        let error = import(&other.to_string()).unwrap_err();
        assert!(error.0.contains("kind"), "{error}");

        let newer =
            json!({ "v": 2, "kind": "figma-payload", "file": { "name": "x" }, "nodes": [] });
        let error = import(&newer.to_string()).unwrap_err();
        assert!(error.0.contains("version 2"), "{error}");

        let missing = json!({
            "kind": "figma-payload",
            "file": { "name": "x" },
            "nodes": [{
                "id": "1:1", "type": "FRAME", "name": "F", "x": 0, "y": 0, "width": 10, "height": 10,
                "fills": [{ "type": "IMAGE", "imageHash": "abc", "scaleMode": "FILL" }]
            }]
        });
        let error = import(&missing.to_string()).unwrap_err();
        assert!(error.0.contains("abc"), "{error}");

        let mut found = missing;
        found["images"] = json!({ "abc": STANDARD.encode(PNG) });
        assert!(import(&found.to_string()).is_ok());
    }
}
