//! The JSON the Finite Figma plugin and the server exchange, both ways.
//!
//! The plugin reads a selection into a [`Payload`] and posts it as an
//! import; an export is a [`Payload`] the plugin turns into Figma nodes. One
//! schema serves both directions, and `apps/figma-plugin/src/payload.ts`
//! mirrors it field for field. Fields follow the Figma Plugin API's names
//! and units, so the plugin copies values without converting them; all
//! conversion lives in the codec.
//!
//! Anything the plugin sends that this version doesn't name lands in
//! `extra`. The codec reports each such field, and the original bytes keep
//! it, so a newer plugin never loses data on an older server.

use std::collections::BTreeMap;

use finite_design::version::Schema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The payload's format and version. See `finite_design::version`.
pub const PAYLOAD: Schema = Schema {
    name: "Figma payload",
    version: 1,
    upgrades: &[],
};

/// What a payload's `kind` says.
pub const KIND: &str = "figma-payload";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub kind: String,
    pub file: File,
    /// Top-level frames. Each becomes an artboard, and each artboard one.
    pub nodes: Vec<FigNode>,
    /// Image fills' bytes as base64. On import they're keyed by Figma's
    /// image hash; on export by sha256.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub images: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub name: String,
    /// Figma's file key, when the plugin knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// One Figma layer. Positions and sizes are in pixels, relative to the parent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigNode {
    /// Figma's node id, like `12:34`, on import; Finite's node id on export.
    pub id: String,
    /// Figma's node type: `FRAME`, `GROUP`, `TEXT`, `RECTANGLE`, `ELLIPSE`,
    /// `VECTOR`, `INSTANCE`, and so on.
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    pub visible: bool,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub opacity: f64,
    /// Degrees, counterclockwise, as Figma reports it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotation: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fills: Vec<Paint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub strokes: Vec<Paint>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub stroke_weight: f64,
    /// `INSIDE`, `OUTSIDE` or `CENTER`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_align: Option<String>,
    /// Top left, top right, bottom right, bottom left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radii: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clips_content: bool,
    /// Auto layout, for a frame that has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<AutoLayout>,
    /// How the node sits in its auto-layout parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child: Option<LayoutChild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<Text>,
    /// Vector shapes as SVG markup, exported by the plugin, for shapes the
    /// codec doesn't draw from fills alone: vectors, boolean operations,
    /// stars, lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub svg: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<FigNode>,
    /// Fields this version doesn't know.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paint {
    /// `SOLID`, `IMAGE`, `GRADIENT_LINEAR`, `GRADIENT_RADIAL`, …
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    pub visible: bool,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub opacity: f64,
    /// For `SOLID`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Rgba>,
    /// For `IMAGE`: the key into [`Payload::images`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_hash: Option<String>,
    /// For `IMAGE`: `FILL`, `FIT`, `CROP` or `TILE`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_mode: Option<String>,
    /// For gradients.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gradient_stops: Vec<Stop>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A color with channels from 0 to 1, as Figma has them.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub a: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stop {
    pub position: f64,
    pub color: Rgba,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    /// `DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR` or `BACKGROUND_BLUR`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    pub visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Rgba>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<Offset>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub radius: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub spread: f64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Offset {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLayout {
    /// `HORIZONTAL` or `VERTICAL`.
    pub mode: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wrap: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub gap: f64,
    /// Between wrapped rows or columns.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub counter_gap: f64,
    /// Top, right, bottom, left.
    #[serde(default)]
    pub padding: [f64; 4],
    /// `MIN`, `CENTER`, `MAX` or `SPACE_BETWEEN`.
    #[serde(default = "min")]
    pub primary_align: String,
    /// `MIN`, `CENTER`, `MAX` or `BASELINE`.
    #[serde(default = "min")]
    pub counter_align: String,
    /// How the frame sizes itself on each axis: `FIXED` or `AUTO` (hug).
    #[serde(default = "fixed")]
    pub primary_sizing: String,
    #[serde(default = "fixed")]
    pub counter_sizing: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutChild {
    /// `ABSOLUTE` for a child that ignores its parent's auto layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positioning: Option<String>,
    /// How much of the free space along the parent's axis it takes, like `flex-grow`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub grow: f64,
    /// `STRETCH` to fill the parent's other axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub characters: String,
    pub font_family: String,
    /// Figma's style name, like `Semi Bold Italic`.
    #[serde(default)]
    pub font_style: String,
    pub font_weight: f64,
    pub font_size: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<Measure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<Measure>,
    /// `LEFT`, `CENTER`, `RIGHT` or `JUSTIFIED`.
    #[serde(default = "left")]
    pub align: String,
    /// `NONE`, `UNDERLINE` or `STRIKETHROUGH`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoration: Option<String>,
    /// `NONE`, `UPPER`, `LOWER` or `TITLE`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case: Option<String>,
    /// Runs of characters styled unlike the rest, when there are any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<TextRun>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A value in Figma's units: `PIXELS`, `PERCENT`, or `AUTO` with no value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    pub unit: String,
    #[serde(default)]
    pub value: f64,
}

/// Characters `start..end` of a text layer, with what differs from its base style.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fills: Vec<Paint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoration: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn yes() -> bool {
    true
}
fn is_yes(v: &bool) -> bool {
    *v
}
fn one() -> f64 {
    1.0
}
fn is_one(v: &f64) -> bool {
    *v == 1.0
}
fn is_zero(v: &f64) -> bool {
    *v == 0.0
}
fn min() -> String {
    "MIN".into()
}
fn fixed() -> String {
    "FIXED".into()
}
fn left() -> String {
    "LEFT".into()
}
