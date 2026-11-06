//! Artboards into a Figma payload, from how they rendered.
//!
//! Each artboard is measured first, so this reads the browser's answer
//! (boxes and computed styles, a [`Scene`]) instead of the design's CSS. An
//! element becomes a frame, a text node a text layer, an `<img>` a
//! rectangle with an image fill, and an `<svg>` a vector holding its
//! markup. A flex container becomes auto layout when auto layout would put
//! its children where the browser did. Anything else keeps the positions it
//! was measured at, and a diagnostic says what was lost.

mod css;
mod layout;

use std::collections::BTreeMap;

use base64::{Engine, engine::general_purpose::STANDARD};
use finite_design::{Node, NodeKind, html, import::BlobHash};

use self::css::{Background, Transform};
use super::payload::{
    Effect, FigNode, File, KIND, Measure, Offset, PAYLOAD, Paint, Payload, Rgba, Text,
};
use crate::{
    Diagnostic, Error, Exported, Feature, Revision, Scope, Score, assets, file_stem,
    scene::{Resolved, Scene},
};

pub fn write(revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
    let boards = revision.artboards(scope)?;
    let mut images = BTreeMap::new();
    let mut diagnostics = Vec::new();
    let mut nodes = Vec::new();
    for board in &boards {
        let scene = revision.measure.scene(revision.doc, &board.id)?;
        let mut walk = Walk {
            revision,
            scene: &scene,
            images: &mut images,
            diagnostics: &mut diagnostics,
        };
        nodes.push(walk.artboard(board)?);
    }
    let payload = Payload {
        kind: KIND.into(),
        file: File {
            name: revision.name.to_owned(),
            key: None,
        },
        nodes,
        images,
    };
    let json = PAYLOAD
        .encode(&payload)
        .map_err(|e| Error(format!("couldn't write the payload: {e}")))?;
    let stem = match scope {
        Scope::Design => revision.name.to_owned(),
        Scope::Artboard(_) => boards[0].display_name(),
    };
    Ok(Exported {
        file_name: format!("{}.figma.json", file_stem(&stem)),
        media_type: "application/json",
        bytes: json.into_bytes(),
        diagnostics,
    })
}

/// A node's box in the artboard's coordinates, as it is before it's turned:
/// its center, its size, and how far it and its ancestors turn it,
/// clockwise in radians.
#[derive(Clone, Copy, Debug)]
struct Placed {
    cx: f64,
    cy: f64,
    width: f64,
    height: f64,
    angle: f64,
}

impl Placed {
    /// From a measured box, which bounds the node as turned by `angle`.
    /// `false` when the size can't be told: near 45° a box's bounds are
    /// square whatever its sides, so it's taken as a square.
    fn measured(r: &Resolved, angle: f64) -> (Self, bool) {
        let (c, s) = (angle.cos().abs(), angle.sin().abs());
        let det = c * c - s * s;
        let ((width, height), exact) = if s < 1e-9 {
            ((r.width, r.height), true)
        } else if det.abs() < 0.1 {
            let side = r.width.min(r.height) / (c + s);
            ((side, side), false)
        } else {
            let width = (r.width * c - r.height * s) / det;
            let height = (r.height * c - r.width * s) / det;
            ((width.max(0.0), height.max(0.0)), true)
        };
        let placed = Placed {
            cx: r.x + r.width / 2.0,
            cy: r.y + r.height / 2.0,
            width,
            height,
            angle,
        };
        (placed, exact)
    }

    /// Where `child`'s top left corner is in this box's own coordinates,
    /// which is where Figma places a layer, turned or not.
    fn local(&self, child: &Placed) -> (f64, f64) {
        let (dx, dy) = (child.cx - self.cx, child.cy - self.cy);
        let (sin, cos) = self.angle.sin_cos();
        let center = (
            dx * cos + dy * sin + self.width / 2.0,
            -dx * sin + dy * cos + self.height / 2.0,
        );
        let (sin, cos) = (child.angle - self.angle).sin_cos();
        let (hx, hy) = (-child.width / 2.0, -child.height / 2.0);
        (
            center.0 + hx * cos - hy * sin,
            center.1 + hx * sin + hy * cos,
        )
    }
}

/// A converted node, with what its parent's layout needs to know about it.
struct Kid<'a> {
    node: FigNode,
    /// Its computed styles; a text node's are its parent's.
    res: &'a Resolved,
    text: bool,
    transformed: bool,
}

/// Converts one artboard.
struct Walk<'a, 'r> {
    revision: &'a Revision<'r>,
    scene: &'a Scene,
    images: &'a mut BTreeMap<String, String>,
    diagnostics: &'a mut Vec<Diagnostic>,
}

impl<'a> Walk<'a, '_> {
    fn artboard(&mut self, board: &Node) -> Result<FigNode, Error> {
        let res =
            self.scene.nodes.get(&board.id).ok_or_else(|| {
                Error(format!("artboard {:?} didn't render", board.display_name()))
            })?;
        let (origin, _) = Placed::measured(res, 0.0);
        let mut node = self
            .element(board, &origin)?
            .expect("a rendered artboard converts")
            .node;
        // Figma has no canvas to turn an artboard on.
        node.rotation = 0.0;
        node.x = board.x.unwrap_or(0.0);
        node.y = board.y.unwrap_or(0.0);
        Ok(node)
    }

    fn element(&mut self, node: &Node, parent: &Placed) -> Result<Option<Kid<'a>>, Error> {
        let scene = self.scene;
        let (Some(res), Some(tag)) = (scene.nodes.get(&node.id), node.tag()) else {
            return Ok(None);
        };
        let tag = tag.to_ascii_lowercase();
        let (turn, transformed) = match css::transform(res.style("transform")) {
            Transform::None => (0.0, false),
            Transform::Rotate(angle) => (angle, true),
            Transform::Other => {
                self.lost(
                    node,
                    "transform",
                    res.style("transform"),
                    Feature::Frame,
                    "only a rotation exports; the layer has the box it was drawn in",
                    [Score::No, Score::Unknown, Score::Yes],
                );
                (0.0, true)
            }
        };
        let (placed, exact) = Placed::measured(res, parent.angle + turn);
        if !exact {
            self.lost(
                node,
                "transform",
                res.style("transform"),
                Feature::Frame,
                "near 45° its size can't be told from where it rendered, so it's exported square",
                [Score::No, Score::No, Score::Yes],
            );
        }
        let (x, y) = parent.local(&placed);
        let mut fig = layer(node, "FRAME", x, y, &placed);
        fig.rotation = -turn.to_degrees();
        fig.visible = !matches!(res.style("visibility"), "hidden" | "collapse");
        fig.opacity = css::number(res.style("opacity")).unwrap_or(1.0);
        let kid = |node| {
            Ok(Some(Kid {
                node,
                res,
                text: false,
                transformed,
            }))
        };
        if tag == "svg" {
            fig.kind = "VECTOR".into();
            fig.svg = html::export(self.revision.doc, &node.id, false);
            return kid(fig);
        }
        self.paint(node, res, &mut fig)?;
        if tag == "img" {
            fig.kind = "RECTANGLE".into();
            fig.clips_content = false;
            let src = node.attrs.get("src");
            if let Some(src) = src
                && let Some(hash) = self.image(node, "src", src)?
            {
                let scale_mode = match res.style("object-fit") {
                    "contain" => "FIT",
                    _ => "FILL",
                };
                fig.fills.push(Paint {
                    kind: "IMAGE".into(),
                    image_hash: Some(hash),
                    scale_mode: Some(scale_mode.into()),
                    ..paint()
                });
            }
            return kid(fig);
        }
        let mut kids = Vec::new();
        for child in self.revision.doc.children(Some(&node.id)) {
            let converted = match child.kind {
                NodeKind::Text => self.text(child, &placed),
                NodeKind::Element { .. } => self.element(child, &placed)?,
            };
            kids.extend(converted);
        }
        fig.layout = self.layout(node, res, &placed, &mut kids);
        fig.children = kids.into_iter().map(|k| k.node).collect();
        kid(fig)
    }

    fn text(&mut self, node: &Node, parent: &Placed) -> Option<Kid<'a>> {
        let scene = self.scene;
        let res = scene.nodes.get(&node.id)?;
        let characters = characters(node.text.as_deref()?, res.style("white-space"))?;
        let (placed, _) = Placed::measured(res, parent.angle);
        let (x, y) = parent.local(&placed);
        let mut fig = layer(node, "TEXT", x, y, &placed);
        fig.rotation = -(placed.angle - parent.angle).to_degrees();
        if let Some(color) = self.color(node, "color", res.style("color")) {
            fig.fills.push(solid(color));
        }
        let weight = css::number(res.style("font-weight")).unwrap_or(400.0);
        let italic = res.style("font-style") != "normal";
        let line_height = match res.style("line-height") {
            "normal" => Some(Measure {
                unit: "AUTO".into(),
                value: 0.0,
            }),
            value => css::px(value).map(|value| Measure {
                unit: "PIXELS".into(),
                value,
            }),
        };
        let letter_spacing = css::px(res.style("letter-spacing")).map(|value| Measure {
            unit: "PIXELS".into(),
            value,
        });
        let align = match res.style("text-align") {
            "center" => "CENTER",
            "right" | "end" => "RIGHT",
            "justify" => "JUSTIFIED",
            _ => "LEFT",
        };
        let line = res.style("text-decoration-line");
        let decoration = if line.contains("underline") {
            Some("UNDERLINE")
        } else if line.contains("line-through") {
            Some("STRIKETHROUGH")
        } else {
            None
        };
        let case = match res.style("text-transform") {
            "uppercase" => Some("UPPER"),
            "lowercase" => Some("LOWER"),
            "capitalize" => Some("TITLE"),
            _ => None,
        };
        fig.text = Some(Text {
            characters,
            font_family: css::first_family(res.style("font-family")),
            font_style: font_style(weight, italic),
            font_weight: weight,
            font_size: css::px(res.style("font-size")).unwrap_or(16.0),
            italic,
            line_height,
            letter_spacing: letter_spacing.filter(|m| m.value != 0.0),
            align: align.into(),
            decoration: decoration.map(Into::into),
            case: case.map(Into::into),
            runs: Vec::new(),
            extra: BTreeMap::new(),
        });
        Some(Kid {
            node: fig,
            res,
            text: true,
            transformed: false,
        })
    }

    /// An element's fills, strokes, corners, shadows and clipping.
    fn paint(&mut self, node: &Node, res: &Resolved, fig: &mut FigNode) -> Result<(), Error> {
        let background = res.style("background-color");
        if let Some(color) = self.color(node, "background-color", background)
            && color.a > 0.0
        {
            fig.fills.push(solid(color));
        }
        // CSS lists background layers top first; Figma, bottom first.
        let layers = css::backgrounds(res.style("background-image"));
        for layer in layers.into_iter().rev() {
            match layer {
                Background::Url(url) => {
                    let Some(hash) = self.image(node, "background-image", &url)? else {
                        continue;
                    };
                    let size = res.style("background-size");
                    let scale_mode = match size {
                        "cover" => "FILL",
                        "contain" => "FIT",
                        "auto" | "auto auto" => "TILE",
                        "100% 100%" => "FILL",
                        other => {
                            self.lost(
                                node,
                                "background-size",
                                other,
                                Feature::Image,
                                "Figma's scale modes are cover, contain and tile, so it fills the layer",
                                [Score::No, Score::No, Score::Yes],
                            );
                            "FILL"
                        }
                    };
                    fig.fills.push(Paint {
                        kind: "IMAGE".into(),
                        image_hash: Some(hash),
                        scale_mode: Some(scale_mode.into()),
                        ..paint()
                    });
                }
                Background::Other(value) => self.lost(
                    node,
                    "background-image",
                    value,
                    Feature::SolidFill,
                    "gradients don't export yet",
                    [Score::No, Score::No, Score::No],
                ),
            }
        }

        let widths = ["top", "right", "bottom", "left"]
            .map(|side| css::px(res.style(&format!("border-{side}-width"))).unwrap_or(0.0));
        let style = res.style("border-top-style");
        if widths.iter().any(|w| *w > 0.0) && !matches!(style, "none" | "hidden") {
            if widths.iter().all(|w| *w == widths[0]) {
                if let Some(color) = self.color(node, "border-color", res.style("border-top-color"))
                {
                    fig.strokes.push(solid(color));
                    fig.stroke_weight = widths[0];
                    fig.stroke_align = Some("INSIDE".into());
                }
                if style != "solid" {
                    self.lost(
                        node,
                        "border-style",
                        style,
                        Feature::Frame,
                        "only solid borders export, so it's drawn solid",
                        [Score::No, Score::No, Score::Yes],
                    );
                }
            } else {
                self.lost(
                    node,
                    "border-width",
                    widths.map(|w| format!("{w}px")).join(" "),
                    Feature::Frame,
                    "Figma strokes are the same on every side, so it has none",
                    [Score::No, Score::No, Score::No],
                );
            }
        }

        let radii = ["top-left", "top-right", "bottom-right", "bottom-left"].map(|corner| {
            css::radius(
                res.style(&format!("border-{corner}-radius")),
                res.width,
                res.height,
            )
            .unwrap_or(0.0)
        });
        if radii.iter().any(|r| *r > 0.0) {
            fig.corner_radii = Some(radii);
        }

        let shadow = res.style("box-shadow");
        match css::shadows(shadow) {
            Some(shadows) => fig.effects = shadows.into_iter().map(effect).collect(),
            None => self.lost(
                node,
                "box-shadow",
                shadow,
                Feature::Frame,
                "the shadow couldn't be read",
                [Score::No, Score::No, Score::No],
            ),
        }

        fig.clips_content = res
            .style("overflow")
            .split_whitespace()
            .any(|axis| axis != "visible");
        Ok(())
    }

    /// A computed color, or `None` with a diagnostic if it isn't sRGB.
    fn color(&mut self, node: &Node, property: &str, value: &str) -> Option<Rgba> {
        let color = css::color(value);
        if color.is_none() && !value.is_empty() {
            self.lost(
                node,
                property,
                value,
                Feature::SolidFill,
                "only sRGB colors export",
                [Score::No, Score::No, Score::No],
            );
        }
        color
    }

    /// The key in the payload's images for the file at `url`, with its
    /// bytes added: a blob in the design's store, or a `data:` URL. `None`
    /// with a diagnostic when there is no such file; a store that fails
    /// fails the export.
    fn image(&mut self, node: &Node, property: &str, url: &str) -> Result<Option<String>, Error> {
        // The measured page is a file, so a computed `url()` that started
        // at `/api/designs/…` resolved against `file://`.
        let local = url.strip_prefix("file://").unwrap_or(url);
        let (_, found) = assets::portable(local);
        let bytes = if let Some(hash) = found.first() {
            match self.revision.blobs.get(hash)? {
                Some(bytes) => Some(bytes),
                None => {
                    let missing =
                        Diagnostic::missing_file(property, format!("{}{hash}", assets::SCHEME));
                    self.diagnostics.push(missing.on(&node.id));
                    return Ok(None);
                }
            }
        } else {
            url.strip_prefix("data:")
                .and_then(|data| data.split_once(";base64,"))
                .and_then(|(_, base64)| STANDARD.decode(base64.trim()).ok())
        };
        let Some(bytes) = bytes else {
            let reason = if url.starts_with("https:") || url.starts_with("http:") {
                "images from other sites aren't fetched yet"
            } else {
                "it isn't a file in the design"
            };
            self.lost(
                node,
                property,
                url,
                Feature::Image,
                reason,
                [Score::No, Score::No, Score::Yes],
            );
            return Ok(None);
        };
        let hash = BlobHash::of(&bytes).as_str().to_owned();
        self.images
            .entry(hash.clone())
            .or_insert_with(|| STANDARD.encode(&bytes));
        Ok(Some(hash))
    }

    fn lost(
        &mut self,
        node: &Node,
        property: &str,
        value: impl Into<String>,
        feature: Feature,
        reason: impl Into<String>,
        scores: [Score; 3],
    ) {
        let diagnostic = Diagnostic::new(feature, value, reason, scores).at(property);
        self.diagnostics.push(diagnostic.on(&node.id));
    }
}

/// A layer at `x`, `y` in its parent with `placed`'s size, and nothing else.
fn layer(node: &Node, kind: &str, x: f64, y: f64, placed: &Placed) -> FigNode {
    FigNode {
        id: node.id.clone(),
        kind: kind.into(),
        name: node.display_name(),
        x: round(x),
        y: round(y),
        width: round(placed.width),
        height: round(placed.height),
        visible: true,
        opacity: 1.0,
        rotation: 0.0,
        fills: Vec::new(),
        strokes: Vec::new(),
        stroke_weight: 0.0,
        stroke_align: None,
        corner_radii: None,
        effects: Vec::new(),
        clips_content: false,
        layout: None,
        child: None,
        text: None,
        svg: None,
        children: Vec::new(),
        extra: BTreeMap::new(),
    }
}

/// To a thousandth of a pixel, which drops the noise turning adds.
fn round(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn paint() -> Paint {
    Paint {
        visible: true,
        opacity: 1.0,
        ..Paint::default()
    }
}

/// A solid paint. The color keeps its alpha; the plugin folds it into the
/// paint's opacity.
fn solid(color: Rgba) -> Paint {
    Paint {
        kind: "SOLID".into(),
        color: Some(color),
        ..paint()
    }
}

fn effect(shadow: css::Shadow) -> Effect {
    Effect {
        kind: if shadow.inset {
            "INNER_SHADOW"
        } else {
            "DROP_SHADOW"
        }
        .into(),
        visible: true,
        color: Some(shadow.color),
        offset: Some(Offset {
            x: shadow.x,
            y: shadow.y,
        }),
        radius: shadow.blur,
        spread: shadow.spread,
        extra: BTreeMap::new(),
    }
}

/// A text node's characters as they render under `white-space`, or `None`
/// if it renders nothing.
fn characters(text: &str, white_space: &str) -> Option<String> {
    let collapse = |line: &str| line.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = match white_space {
        "pre" | "pre-wrap" | "break-spaces" => text.to_owned(),
        "pre-line" => text.lines().map(collapse).collect::<Vec<_>>().join("\n"),
        _ => collapse(text),
    };
    (!out.trim().is_empty()).then_some(out)
}

/// Figma's style name for a weight, like `Semi Bold Italic`.
fn font_style(weight: f64, italic: bool) -> String {
    let name = match weight.round() as u32 {
        ..=149 => "Thin",
        150..=249 => "Extra Light",
        250..=349 => "Light",
        350..=449 => "Regular",
        450..=549 => "Medium",
        550..=649 => "Semi Bold",
        650..=749 => "Bold",
        750..=849 => "Extra Bold",
        _ => "Black",
    };
    match (name, italic) {
        ("Regular", true) => "Italic".into(),
        (name, true) => format!("{name} Italic"),
        (name, false) => name.into(),
    }
}

#[cfg(test)]
mod tests {
    use finite_design::Document;

    use super::*;
    use crate::{Blobs, scene::COMPUTED};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    struct Store;

    impl Blobs for Store {
        fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
            Ok((*hash == BlobHash::of(PNG)).then(|| PNG.to_vec()))
        }
    }

    /// Measures every artboard as the same canned scene.
    struct Canned(Scene);

    impl crate::scene::Measure for Canned {
        fn scene(&self, _doc: &Document, _artboard: &str) -> Result<Scene, Error> {
            Ok(self.0.clone())
        }
    }

    /// A document holding one artboard written as `html` at (100, 50), and
    /// its node ids by layer name, a text node named after its parent with
    /// `/text`.
    fn design(html: &str) -> (Document, BTreeMap<String, String>) {
        let mut ops = Vec::new();
        let mut n = 0;
        html::parse(html).unwrap().remove(0).create_ops(
            None,
            "V".into(),
            Some((100.0, 50.0)),
            &mut || {
                n += 1;
                format!("n{n}")
            },
            &mut ops,
        );
        let mut doc = Document::default();
        doc.apply_all(&ops);
        let mut names = BTreeMap::new();
        for node in doc.subtree("n1") {
            if let Some(name) = &node.name {
                names.insert(name.clone(), node.id.clone());
                for child in doc.children(Some(&node.id)) {
                    if child.tag().is_none() {
                        names.insert(format!("{name}/text"), child.id.clone());
                    }
                }
            }
        }
        (doc, names)
    }

    /// A box with Chrome's computed defaults for a block, overridden by `styles`.
    fn at(x: f64, y: f64, width: f64, height: f64, styles: &[(&str, &str)]) -> Resolved {
        let mut style: BTreeMap<String, String> = COMPUTED
            .iter()
            .map(|name| {
                let value = match *name {
                    "display" => "block",
                    "position" => "static",
                    "visibility" => "visible",
                    "opacity" | "flex-grow" => "1",
                    "overflow" => "visible",
                    "flex-direction" => "row",
                    "flex-wrap" => "nowrap",
                    "align-self" => "auto",
                    "justify-content" | "align-items" | "row-gap" | "column-gap" => "normal",
                    "background-color" => "rgba(0, 0, 0, 0)",
                    "background-image" | "box-shadow" | "transform" | "text-transform" => "none",
                    "background-size" => "auto",
                    "color" | "border-top-color" => "rgb(0, 0, 0)",
                    "font-family" => "Inter, sans-serif",
                    "font-size" => "16px",
                    "font-weight" => "400",
                    "font-style" | "line-height" | "letter-spacing" | "white-space" => "normal",
                    "text-align" => "start",
                    "text-decoration-line" | "border-top-style" => "none",
                    "object-fit" => "fill",
                    _ => "0px",
                };
                (name.to_string(), value.to_owned())
            })
            .collect();
        style.insert("flex-grow".into(), "0".into());
        for (name, value) in styles {
            style.insert(name.to_string(), value.to_string());
        }
        Resolved {
            x,
            y,
            width,
            height,
            style,
        }
    }

    fn export(doc: &Document, scene: Scene) -> (Payload, Exported) {
        let revision = Revision {
            name: "Home",
            doc,
            imports: &[],
            blobs: &Store,
            measure: &Canned(scene),
        };
        let exported = write(&revision, &Scope::Design).unwrap();
        let payload = PAYLOAD
            .decode(std::str::from_utf8(&exported.bytes).unwrap())
            .unwrap();
        (payload, exported)
    }

    fn find<'a>(node: &'a FigNode, id: &str) -> &'a FigNode {
        fn walk<'a>(node: &'a FigNode, id: &str) -> Option<&'a FigNode> {
            if node.id == id {
                return Some(node);
            }
            node.children.iter().find_map(|c| walk(c, id))
        }
        walk(node, id).unwrap_or_else(|| panic!("no layer {id}"))
    }

    #[test]
    fn a_card_exports_as_auto_layout_with_its_paint() {
        let png = assets::url("d", &BlobHash::of(PNG));
        let (doc, names) = design(&format!(
            r#"<div data-name="Board"><div data-name="Card"><p data-name="Title">Hello
  there</p><img data-name="Photo" src="{png}"><div data-name="Badge"></div></div><div data-name="Grid"><div data-name="A"></div><div data-name="B"><img data-name="Remote" src="https://example.com/a.png"></div></div></div>"#
        ));
        let flex_column = [
            ("display", "flex"),
            ("flex-direction", "column"),
            ("background-color", "rgb(255, 255, 255)"),
            ("overflow", "hidden"),
        ];
        let card = [
            ("display", "flex"),
            ("background-color", "rgb(255, 255, 255)"),
            ("align-items", "center"),
            ("column-gap", "12px"),
            ("padding-top", "16px"),
            ("padding-right", "16px"),
            ("padding-bottom", "16px"),
            ("padding-left", "16px"),
            ("border-top-width", "1px"),
            ("border-right-width", "1px"),
            ("border-bottom-width", "1px"),
            ("border-left-width", "1px"),
            ("border-top-style", "solid"),
            ("border-top-color", "rgb(0, 0, 255)"),
            ("border-top-left-radius", "8px"),
            ("border-top-right-radius", "8px"),
            ("border-bottom-right-radius", "8px"),
            ("border-bottom-left-radius", "8px"),
            ("box-shadow", "rgba(0, 0, 0, 0.25) 0px 4px 12px 0px"),
            ("background-image", &format!("url(\"file://{png}\")")),
            ("background-size", "cover"),
        ];
        let title = [
            ("font-family", "\"Inter Display\", sans-serif"),
            ("font-weight", "600"),
            ("line-height", "24px"),
            ("color", "rgb(255, 0, 0)"),
            ("text-transform", "uppercase"),
        ];
        let scene = Scene {
            nodes: BTreeMap::from([
                (
                    names["Board"].clone(),
                    at(0.0, 0.0, 400.0, 300.0, &flex_column),
                ),
                (names["Card"].clone(), at(0.0, 0.0, 400.0, 120.0, &card)),
                (names["Title"].clone(), at(17.0, 48.0, 100.0, 24.0, &title)),
                (
                    names["Title/text"].clone(),
                    at(17.0, 48.0, 90.0, 24.0, &title),
                ),
                (
                    names["Photo"].clone(),
                    at(129.0, 20.0, 80.0, 80.0, &[("object-fit", "cover")]),
                ),
                (
                    names["Badge"].clone(),
                    at(360.0, 4.0, 30.0, 16.0, &[("position", "absolute")]),
                ),
                (
                    names["Grid"].clone(),
                    at(0.0, 120.0, 400.0, 100.0, &[("display", "grid")]),
                ),
                (names["A"].clone(), at(0.0, 120.0, 200.0, 100.0, &[])),
                (names["B"].clone(), at(200.0, 120.0, 200.0, 100.0, &[])),
                (names["Remote"].clone(), at(210.0, 130.0, 20.0, 20.0, &[])),
            ]),
        };
        let (payload, exported) = export(&doc, scene);
        assert_eq!(exported.file_name, "home.figma.json");
        assert_eq!(exported.media_type, "application/json");
        assert!(
            std::str::from_utf8(&exported.bytes)
                .unwrap()
                .starts_with(r#"{"v":1,"kind":"figma-payload""#)
        );
        assert_eq!(payload.file.name, "Home");

        let board = &payload.nodes[0];
        assert_eq!(
            (
                board.kind.as_str(),
                board.x,
                board.y,
                board.width,
                board.height
            ),
            ("FRAME", 100.0, 50.0, 400.0, 300.0)
        );
        assert!(board.clips_content);
        assert_eq!(board.layout.as_ref().unwrap().mode, "VERTICAL");

        let card = find(board, &names["Card"]);
        // It fills the artboard's width, as `align-items: normal` stretches it.
        assert_eq!(
            card.child.as_ref().unwrap().align.as_deref(),
            Some("STRETCH")
        );
        let layout = card.layout.as_ref().unwrap();
        assert_eq!(
            (
                layout.mode.as_str(),
                layout.gap,
                layout.padding,
                layout.primary_align.as_str(),
                layout.counter_align.as_str()
            ),
            ("HORIZONTAL", 12.0, [17.0; 4], "MIN", "CENTER")
        );
        let hash = BlobHash::of(PNG).as_str().to_owned();
        assert_eq!(card.fills.len(), 2, "{:?}", exported.diagnostics);
        assert_eq!(
            card.fills[0].color,
            Some(Rgba {
                r: 1.0,
                g: 1.0,
                b: 1.0,
                a: 1.0
            })
        );
        assert_eq!(card.fills[1].image_hash.as_deref(), Some(hash.as_str()));
        assert_eq!(card.fills[1].scale_mode.as_deref(), Some("FILL"));
        assert_eq!(
            card.strokes[0].color,
            Some(Rgba {
                r: 0.0,
                g: 0.0,
                b: 1.0,
                a: 1.0
            })
        );
        assert_eq!(
            (card.stroke_weight, card.stroke_align.as_deref()),
            (1.0, Some("INSIDE"))
        );
        assert_eq!(card.corner_radii, Some([8.0; 4]));
        let shadow = &card.effects[0];
        assert_eq!(shadow.kind, "DROP_SHADOW");
        assert_eq!(shadow.offset, Some(Offset { x: 0.0, y: 4.0 }));
        assert_eq!((shadow.radius, shadow.color.unwrap().a), (12.0, 0.25));

        let text = find(card, &names["Title/text"]);
        assert_eq!(text.kind, "TEXT");
        let style = text.text.as_ref().unwrap();
        assert_eq!(style.characters, "Hello there");
        assert_eq!(
            (
                style.font_family.as_str(),
                style.font_style.as_str(),
                style.font_size
            ),
            ("Inter Display", "Semi Bold", 16.0)
        );
        assert_eq!(
            style.line_height,
            Some(Measure {
                unit: "PIXELS".into(),
                value: 24.0
            })
        );
        assert_eq!(style.case.as_deref(), Some("UPPER"));
        assert_eq!(
            text.fills[0].color,
            Some(Rgba {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 1.0
            })
        );

        let photo = find(card, &names["Photo"]);
        assert_eq!(photo.kind, "RECTANGLE");
        assert_eq!(photo.fills[0].image_hash.as_deref(), Some(hash.as_str()));
        assert_eq!(payload.images[&hash], STANDARD.encode(PNG));
        assert_eq!(payload.images.len(), 1);

        let badge = find(card, &names["Badge"]);
        assert_eq!(
            badge.child.as_ref().unwrap().positioning.as_deref(),
            Some("ABSOLUTE")
        );
        assert_eq!((badge.x, badge.y), (360.0, 4.0));

        // A grid has no auto layout, so its cells are where they rendered.
        let grid = find(board, &names["Grid"]);
        assert!(grid.layout.is_none());
        let b = find(grid, &names["B"]);
        assert_eq!((b.x, b.y, b.child.is_none()), (200.0, 0.0, true));
        assert_eq!(find(b, &names["Remote"]).fills, []);

        let lost: Vec<_> = exported
            .diagnostics
            .iter()
            .map(|d| (d.node.as_deref().unwrap(), d.path.as_str(), d.feature))
            .collect();
        assert_eq!(
            lost,
            [
                (names["Remote"].as_str(), "src", Feature::Image),
                (names["Grid"].as_str(), "display", Feature::FlexLayout),
            ]
        );

        // The export imports back into Finite, with its image: the artboard
        // is still a flex column, and the card a flex row.
        let again = crate::figma::import::read(&crate::Input {
            bytes: &exported.bytes,
            file_name: None,
        })
        .unwrap();
        assert_eq!(again.boards.len(), 1);
        assert_eq!(again.blobs, [PNG.to_vec()]);
        let board = &again.boards[0];
        assert_eq!(board.styles["flex-direction"], "column");
        let card = &board.content[0];
        assert_eq!(card.name.as_deref(), Some("Card"));
        assert_eq!(card.styles["display"], "flex");
        assert_ne!(
            card.styles.get("flex-direction").map(String::as_str),
            Some("column")
        );
        assert_eq!(card.styles["gap"], "12px");
    }

    #[test]
    fn flex_that_auto_layout_cant_follow_keeps_its_positions() {
        let (doc, names) = design(
            r#"<div data-name="Board"><div data-name="A"></div><div data-name="B"></div><div data-name="Turned"><span data-name="Label">Hi</span></div></div>"#,
        );
        // B has a margin: auto layout would put it right after A.
        let row = [("display", "flex")];
        let turn = [("transform", "matrix(0, 1, -1, 0, 0, 0)")];
        let scene = Scene {
            nodes: BTreeMap::from([
                (names["Board"].clone(), at(0.0, 0.0, 400.0, 300.0, &row)),
                (names["A"].clone(), at(0.0, 0.0, 50.0, 50.0, &[])),
                (names["B"].clone(), at(70.0, 0.0, 50.0, 50.0, &[])),
                // 100 × 40, turned a quarter around its center (220, 100).
                (names["Turned"].clone(), at(200.0, 50.0, 40.0, 100.0, &turn)),
                (names["Label"].clone(), at(200.0, 60.0, 40.0, 20.0, &[])),
                (
                    names["Label/text"].clone(),
                    at(200.0, 60.0, 40.0, 20.0, &[]),
                ),
            ]),
        };
        let (payload, exported) = export(&doc, scene);
        let board = &payload.nodes[0];
        assert!(board.layout.is_none());
        assert_eq!(exported.diagnostics[0].path, "display");
        assert!(
            exported.diagnostics[0].reason.contains("transformed"),
            "{:?}",
            exported.diagnostics
        );
        assert_eq!(find(board, &names["B"]).x, 70.0);

        // Figma places a turned layer by its own top left corner.
        let turned = find(board, &names["Turned"]);
        assert_eq!(
            (turned.width, turned.height, turned.rotation),
            (100.0, 40.0, -90.0)
        );
        let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(near(turned.x, 240.0) && near(turned.y, 50.0), "{turned:?}");
        // Its children are in its own, unturned coordinates.
        let label = find(turned, &names["Label"]);
        assert!(near(label.x, 10.0) && near(label.y, 0.0), "{label:?}");
        assert_eq!(
            (label.width, label.height, label.rotation),
            (20.0, 40.0, 0.0)
        );
    }

    #[test]
    fn wrapped_flex_out_of_order_keeps_its_positions() {
        let (doc, names) = design(
            r#"<div data-name="Board"><div data-name="A"></div><div data-name="B"></div></div>"#,
        );
        let wrap = [("display", "flex"), ("flex-wrap", "wrap")];
        let scene = |a: f64, b: f64| Scene {
            nodes: BTreeMap::from([
                (names["Board"].clone(), at(0.0, 0.0, 400.0, 300.0, &wrap)),
                (names["A"].clone(), at(a, 0.0, 20.0, 20.0, &[])),
                (names["B"].clone(), at(b, 0.0, 20.0, 20.0, &[])),
            ]),
        };
        // `order` put B before A: auto layout would swap them back.
        let (payload, exported) = export(&doc, scene(20.0, 0.0));
        assert!(payload.nodes[0].layout.is_none());
        assert!(exported.diagnostics[0].reason.contains("out of order"));
        // In order, it wraps as auto layout.
        let (payload, exported) = export(&doc, scene(0.0, 20.0));
        assert!(payload.nodes[0].layout.as_ref().unwrap().wrap);
        assert!(
            exported.diagnostics.is_empty(),
            "{:?}",
            exported.diagnostics
        );
    }
}
