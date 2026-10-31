//! The arguments of each MCP tool. rmcp derives each tool's JSON schema from
//! these types, and their doc comments become the argument descriptions.

use std::collections::BTreeMap;

use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesignParams {
    /// The design (canvas) id, from list_designs or create_design.
    pub(super) design_id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct CreateDesignParams {
    /// A short name, like "Checkout flow".
    pub(super) name: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameDesignParams {
    pub(super) design_id: String,
    pub(super) name: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TreeParams {
    pub(super) design_id: String,
    /// Root of the summary. Omit to summarize every artboard.
    #[serde(default)]
    pub(super) node_id: Option<String>,
    /// How many levels below the root to show. Defaults to 4.
    #[serde(default)]
    pub(super) depth: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodesParams {
    pub(super) design_id: String,
    pub(super) node_ids: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChildrenParams {
    pub(super) design_id: String,
    /// Parent node. Omit to list the artboards.
    #[serde(default)]
    pub(super) node_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeParams {
    pub(super) design_id: String,
    pub(super) node_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotParams {
    pub(super) design_id: String,
    /// An artboard, or any node inside one (the whole artboard is captured).
    pub(super) node_id: String,
    /// Device pixel ratio, 1 or 2. Defaults to 1.
    #[serde(default)]
    pub(super) scale: Option<f64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlacementParams {
    pub(super) design_id: String,
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtboardParams {
    pub(super) design_id: String,
    pub(super) name: String,
    /// Width in CSS pixels.
    pub(super) width: f64,
    /// Height in CSS pixels.
    pub(super) height: f64,
    /// Canvas position. Omit x and y to place it beside the existing artboards.
    #[serde(default)]
    pub(super) x: Option<f64>,
    #[serde(default)]
    pub(super) y: Option<f64>,
    /// Extra CSS for the artboard, like {"background-color": "#0b0b0b", "padding": "48px"}.
    #[serde(default)]
    pub(super) styles: BTreeMap<String, String>,
}

#[derive(Deserialize, JsonSchema, Clone, Copy, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WriteHtmlMode {
    /// Insert as children of the target (at `index`, or at the end).
    #[default]
    Append,
    /// Replace all of the target's children.
    ReplaceChildren,
    /// Replace the target node itself.
    Replace,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteHtmlParams {
    pub(super) design_id: String,
    /// The node to write into (an artboard or an element inside one).
    pub(super) target_id: String,
    /// HTML with inline styles, like `<div data-name="Hero" style="display: flex; gap: 24px">…</div>`.
    pub(super) html: String,
    #[serde(default)]
    pub(super) mode: WriteHtmlMode,
    /// Child position for "append" mode. 0 inserts first. Omit to append at the end.
    #[serde(default)]
    pub(super) index: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StyleUpdate {
    pub(super) node_ids: Vec<String>,
    /// CSS properties to set (kebab-case or camelCase). A null value removes the property.
    pub(super) styles: BTreeMap<String, Option<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStylesParams {
    pub(super) design_id: String,
    pub(super) updates: Vec<StyleUpdate>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttributeUpdate {
    pub(super) node_ids: Vec<String>,
    /// Attributes to set, like {"src": "https://…", "alt": "Logo"}. A null value removes it.
    pub(super) attributes: BTreeMap<String, Option<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetAttributesParams {
    pub(super) design_id: String,
    pub(super) updates: Vec<AttributeUpdate>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextUpdate {
    /// A text node, or an element whose content becomes this text.
    pub(super) node_id: String,
    pub(super) text: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetTextParams {
    pub(super) design_id: String,
    pub(super) updates: Vec<TextUpdate>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameUpdate {
    pub(super) node_id: String,
    /// The new layer name. Null clears it.
    pub(super) name: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameNodesParams {
    pub(super) design_id: String,
    pub(super) updates: Vec<RenameUpdate>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodesParams {
    pub(super) design_id: String,
    pub(super) node_ids: Vec<String>,
    /// The new parent. Null turns the nodes into artboards on the canvas.
    pub(super) parent_id: Option<String>,
    /// Child position under the new parent. 0 is first. Omit to append at the end.
    #[serde(default)]
    pub(super) index: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PositionUpdate {
    pub(super) node_id: String,
    pub(super) x: f64,
    pub(super) y: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PositionParams {
    pub(super) design_id: String,
    pub(super) updates: Vec<PositionUpdate>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepParams {
    pub(super) design_id: String,
    /// How many steps. Defaults to 1.
    #[serde(default)]
    pub(super) steps: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommentsParams {
    pub(super) design_id: String,
    /// Include resolved comments too. Defaults to false.
    #[serde(default)]
    pub(super) include_resolved: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplyParams {
    pub(super) design_id: String,
    pub(super) comment_id: String,
    /// What you changed, or a question if the request is unclear. Users read this.
    pub(super) message: String,
    /// true marks the comment done, false reopens it. Omit to leave it as is.
    #[serde(default)]
    pub(super) resolve: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkingParams {
    pub(super) design_id: String,
    /// The nodes (usually artboards) you're about to change.
    pub(super) node_ids: Vec<String>,
    /// A few words shown to users, like "Building the pricing section".
    #[serde(default)]
    pub(super) status: Option<String>,
}
