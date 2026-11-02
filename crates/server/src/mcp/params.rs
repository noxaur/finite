//! The arguments of each MCP tool. rmcp derives each tool's JSON schema from
//! these types, and their doc comments become the argument descriptions.

use std::collections::BTreeMap;

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Value;

/// Reads `T` the way agents tend to send it. An agent that calls a tool
/// before its client has loaded the schema guesses: it sends lists and
/// objects as JSON strings, and one id where a list goes. The intent is
/// clear, so accept it rather than make the agent retry (a third of the longer
/// AX runs in `e2e/ax` hit this).
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<T, D::Error> {
    let value = Value::deserialize(d)?;
    let first = match serde_json::from_value::<T>(value.clone()) {
        Ok(v) => return Ok(v),
        Err(error) => error,
    };
    if let Value::String(text) = &value {
        if let Ok(parsed) = serde_json::from_str::<Value>(text)
            && let Ok(v) = serde_json::from_value(parsed)
        {
            return Ok(v);
        }
        if let Ok(v) = serde_json::from_value(Value::Array(vec![value.clone()])) {
            return Ok(v);
        }
    }
    Err(serde::de::Error::custom(first))
}

/// [`lenient`] for an optional field.
fn lenient_opt<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    d: D,
) -> Result<Option<T>, D::Error> {
    lenient(d).map(Some)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesignParams {
    /// The design (canvas) id, from list_designs or create_design.
    pub(super) design_id: String,
}

#[derive(Deserialize, JsonSchema, Default)]
pub struct ListParams {
    /// Only designs whose name contains this (ignoring case), or whose id
    /// starts with it.
    #[serde(default)]
    pub(super) query: Option<String>,
    /// How many designs to return, most recently edited first. Defaults to
    /// 50; at most 200.
    #[serde(default)]
    pub(super) limit: Option<usize>,
}

impl ListParams {
    pub(crate) const DEFAULT_LIMIT: usize = 50;
    /// Names are cut at 120 characters, so an entry is at most about 230
    /// characters of JSON, and 200 of them fit in one tool result
    /// ([`super::format::OUTPUT_LIMIT`]). 500 didn't.
    pub(crate) const MAX_LIMIT: usize = 200;

    pub(crate) fn with_query(query: Option<String>) -> Self {
        Self { query, limit: None }
    }

    pub(super) fn limit(&self) -> usize {
        self.limit
            .unwrap_or(Self::DEFAULT_LIMIT)
            .clamp(1, Self::MAX_LIMIT)
    }

    /// Whether a design shows up for the query: its name contains it
    /// (ignoring case) or its id starts with it.
    pub(crate) fn matches(&self, id: &str, name: &str) -> bool {
        self.query
            .as_deref()
            .is_none_or(|q| name.to_lowercase().contains(&q.to_lowercase()) || id_matches(id, q))
    }

    /// Whether the query found designs only through their ids, none through
    /// a name. `designs` is every `(id, name)` that matched.
    pub(crate) fn only_by_id<'a>(
        &self,
        designs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> bool {
        let Some(q) = self.query.as_deref().filter(|q| !q.is_empty()) else {
            return false;
        };
        let q = q.to_lowercase();
        let mut any = false;
        for (id, name) in designs {
            if name.to_lowercase().contains(&q) {
                return false;
            }
            any |= id_matches(id, &q);
        }
        any
    }
}

fn id_matches(id: &str, query: &str) -> bool {
    !query.is_empty() && id.to_lowercase().starts_with(&query.to_lowercase())
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
    #[serde(alias = "nodeId", deserialize_with = "lenient")]
    pub(super) node_ids: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChildrenParams {
    pub(super) design_id: String,
    /// Parent node. Omit to list the artboards.
    #[serde(default)]
    pub(super) node_id: Option<String>,
    /// How many children to skip, to page through a long list.
    #[serde(default)]
    pub(super) offset: usize,
}

impl ChildrenParams {
    /// Children returned per call.
    pub(super) const PAGE: usize = 200;
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HtmlParams {
    pub(super) design_id: String,
    pub(super) node_id: String,
    /// How many levels below the node to show. Omit to show as much as fits.
    #[serde(default)]
    pub(super) depth: Option<usize>,
    /// Include inline styles. Defaults to true; false shows structure only.
    #[serde(default)]
    pub(super) include_styles: Option<bool>,
    /// Also show the artboard's <style> blocks, whose rules may style the node.
    #[serde(default)]
    pub(super) include_stylesheets: bool,
    /// Cut attribute values, text and code longer than this many characters.
    #[serde(default)]
    pub(super) max_value_length: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotParams {
    pub(super) design_id: String,
    /// An artboard, or a node inside one. The image is cropped to its box.
    #[serde(default)]
    pub(super) node_id: Option<String>,
    /// Several nodes to capture in one call, at most 10. One image each.
    #[serde(default, deserialize_with = "lenient")]
    pub(super) node_ids: Vec<String>,
    /// Part of the node to capture, relative to its top-left corner.
    #[serde(default)]
    pub(super) region: Option<RegionParam>,
    /// CSS pixels of surroundings to include on every side.
    #[serde(default)]
    pub(super) padding: Option<f64>,
    /// Device pixel ratio, 0.25 to 3. Defaults to 1.
    #[serde(default)]
    pub(super) scale: Option<f64>,
    /// Milliseconds after load when the image is taken, for pages with
    /// scripts or animations. Defaults to 3000; at most 10000.
    #[serde(default)]
    pub(super) settle_ms: Option<u64>,
    #[serde(default)]
    pub(super) format: ImageFormat,
    /// JPEG or WebP quality, 1 to 100. Defaults to 80.
    #[serde(default)]
    pub(super) quality: Option<u8>,
    /// Nodes to render invisible, keeping their space.
    #[serde(default)]
    pub(super) hide_node_ids: Vec<String>,
    /// Nodes to outline, to see their boxes.
    #[serde(default)]
    pub(super) highlight_node_ids: Vec<String>,
    /// Leave out the backgrounds behind the node. PNG or WebP only.
    #[serde(default)]
    pub(super) transparent: bool,
    /// Show content that overflows the artboard instead of cutting it off.
    #[serde(default)]
    pub(super) reveal_overflow: bool,
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
pub struct RegionParam {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Deserialize, JsonSchema, Clone, Copy, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    #[default]
    Png,
    Jpeg,
    Webp,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlacementParams {
    pub(super) design_id: String,
    pub(super) width: f64,
    pub(super) height: f64,
    /// The page to place it on. Omit for the first page.
    #[serde(default)]
    pub(super) page_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtboardParams {
    pub(super) design_id: String,
    pub(super) name: String,
    /// Width in CSS pixels.
    pub(super) width: f64,
    /// Height in CSS pixels. Omit it and the artboard grows to fit its content.
    #[serde(default)]
    pub(super) height: Option<f64>,
    /// Canvas position. Omit x and y to place it to the right of the existing
    /// artboards, top-aligned with them.
    #[serde(default)]
    pub(super) x: Option<f64>,
    #[serde(default)]
    pub(super) y: Option<f64>,
    /// The page to put it on, from get_basic_info or create_page. Omit for the first page.
    #[serde(default)]
    pub(super) page_id: Option<String>,
    /// Extra CSS for the artboard, like {"background-color": "#0b0b0b", "padding": "48px"}.
    #[serde(default)]
    pub(super) styles: BTreeMap<String, String>,
    /// Class names for the artboard's own element, like "screen dark", so
    /// a <style> block or the shared CSS can style the artboard itself.
    #[serde(default)]
    pub(super) class: Option<String>,
    /// Content to write into the new artboard, as write_html would, so a
    /// screen takes one call. Omit for an empty artboard.
    #[serde(default)]
    pub(super) html: Option<String>,
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
    #[serde(alias = "nodeId", deserialize_with = "lenient")]
    pub(super) node_ids: Vec<String>,
    /// CSS properties to set (kebab-case or camelCase). A null value removes the property.
    #[serde(deserialize_with = "lenient")]
    pub(super) styles: BTreeMap<String, Option<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
// `updates` has a default so a flat update parses, but the schema asks for it.
#[schemars(extend("required" = ["designId", "updates"]))]
pub struct UpdateStylesParams {
    pub(super) design_id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub(super) updates: Vec<StyleUpdate>,
    /// One update given flat, as `nodeIds` and `styles`. Not in the schema.
    #[serde(default, alias = "nodeId", deserialize_with = "lenient_opt")]
    #[schemars(skip)]
    pub(super) node_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lenient_opt")]
    #[schemars(skip)]
    pub(super) styles: Option<BTreeMap<String, Option<String>>>,
}

impl UpdateStylesParams {
    /// Every update, with a flat one last.
    pub(super) fn all(self) -> Result<Vec<StyleUpdate>, String> {
        let mut updates = self.updates;
        match (self.node_ids, self.styles) {
            (Some(node_ids), Some(styles)) => updates.push(StyleUpdate { node_ids, styles }),
            (None, None) => {}
            _ => return Err(r#"pass nodeIds with styles, like {"updates": [{"nodeIds": ["a1"], "styles": {"color": "red"}}]}"#.into()),
        }
        if updates.is_empty() {
            return Err(r#"pass updates, like {"updates": [{"nodeIds": ["a1"], "styles": {"color": "red"}}]}"#.into());
        }
        Ok(updates)
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttributeUpdate {
    #[serde(alias = "nodeId", deserialize_with = "lenient")]
    pub(super) node_ids: Vec<String>,
    /// Attributes to set, like {"src": "https://…", "alt": "Logo"}. A null value removes it.
    #[serde(deserialize_with = "lenient")]
    pub(super) attributes: BTreeMap<String, Option<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
// `updates` has a default so a flat update parses, but the schema asks for it.
#[schemars(extend("required" = ["designId", "updates"]))]
pub struct SetAttributesParams {
    pub(super) design_id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub(super) updates: Vec<AttributeUpdate>,
    /// One update given flat, as `nodeIds` and `attributes`. Not in the schema.
    #[serde(default, alias = "nodeId", deserialize_with = "lenient_opt")]
    #[schemars(skip)]
    pub(super) node_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lenient_opt")]
    #[schemars(skip)]
    pub(super) attributes: Option<BTreeMap<String, Option<String>>>,
}

impl SetAttributesParams {
    /// Every update, with a flat one last.
    pub(super) fn all(self) -> Result<Vec<AttributeUpdate>, String> {
        let mut updates = self.updates;
        match (self.node_ids, self.attributes) {
            (Some(node_ids), Some(attributes)) => updates.push(AttributeUpdate { node_ids, attributes }),
            (None, None) => {}
            _ => return Err(r#"pass nodeIds with attributes, like {"updates": [{"nodeIds": ["a1"], "attributes": {"alt": "Logo"}}]}"#.into()),
        }
        if updates.is_empty() {
            return Err(r#"pass updates, like {"updates": [{"nodeIds": ["a1"], "attributes": {"alt": "Logo"}}]}"#.into());
        }
        Ok(updates)
    }
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
// `updates` has a default so a flat update parses, but the schema asks for it.
#[schemars(extend("required" = ["designId", "updates"]))]
pub struct SetTextParams {
    pub(super) design_id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub(super) updates: Vec<TextUpdate>,
    /// One update given flat, as `nodeId` and `text`. Not in the schema.
    #[serde(default)]
    #[schemars(skip)]
    pub(super) node_id: Option<String>,
    #[serde(default)]
    #[schemars(skip)]
    pub(super) text: Option<String>,
}

impl SetTextParams {
    /// Every update, with a flat one last.
    pub(super) fn all(self) -> Result<Vec<TextUpdate>, String> {
        let mut updates = self.updates;
        match (self.node_id, self.text) {
            (Some(node_id), Some(text)) => updates.push(TextUpdate { node_id, text }),
            (None, None) => {}
            _ => return Err(
                r#"pass nodeId with text, like {"updates": [{"nodeId": "a1", "text": "Sign up"}]}"#
                    .into(),
            ),
        }
        if updates.is_empty() {
            return Err(
                r#"pass updates, like {"updates": [{"nodeId": "a1", "text": "Sign up"}]}"#.into(),
            );
        }
        Ok(updates)
    }
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
    #[serde(deserialize_with = "lenient")]
    pub(super) updates: Vec<RenameUpdate>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodesParams {
    pub(super) design_id: String,
    #[serde(alias = "nodeId", deserialize_with = "lenient")]
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
    #[serde(deserialize_with = "lenient")]
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
    /// How many comments to skip, to page through a long list.
    #[serde(default)]
    pub(super) offset: usize,
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
    #[serde(alias = "nodeId", deserialize_with = "lenient")]
    pub(super) node_ids: Vec<String>,
    /// A few words shown to users, like "Building the pricing section".
    #[serde(default)]
    pub(super) status: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitParams {
    pub(super) design_id: String,
    /// How long to wait, in seconds. Defaults to 60; at most 300.
    #[serde(default)]
    pub(super) timeout_seconds: Option<u64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FindParams {
    pub(super) design_id: String,
    /// Search only inside this node, such as an artboard. Omit to search every artboard.
    #[serde(default)]
    pub(super) within: Option<String>,
    /// Text the element contains, ignoring case.
    #[serde(default)]
    pub(super) text: Option<String>,
    /// Part of the layer name, ignoring case.
    #[serde(default)]
    pub(super) name: Option<String>,
    /// The tag, like "button" or "img".
    #[serde(default)]
    pub(super) tag: Option<String>,
    /// Part of a CSS declaration, like "#3b82f6", "border-radius" or "display: grid", ignoring case. Also searches the CSS in <style> blocks.
    #[serde(default)]
    pub(super) style: Option<String>,
    /// Part of an attribute, like "href" or "src=\"https://", ignoring case.
    #[serde(default)]
    pub(super) attribute: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceParams {
    pub(super) design_id: String,
    /// The text or value to find, matched exactly, like "300ms" or ".card". A color, like "#3b82f6" or "rgb(59, 130, 246)", matches that color in any notation outside a <script>. If replace is also a color, tints of it with their own alpha match too and keep their alpha; if replace is text like var(--brand), tints are left alone.
    pub(super) find: String,
    /// What to put in its place.
    pub(super) replace: String,
    /// Replace only inside this node, such as an artboard. Omit for every artboard.
    #[serde(default)]
    pub(super) within: Option<String>,
    /// Also replace it in text content, like a product name. Defaults to false: styles, attributes and the code in <style> and <script> only.
    #[serde(default)]
    pub(super) include_text: bool,
    /// Replace every match even when a non-color value matches more than once inside a <style> or <script>. Without it, that case is refused with the match count and the lines, so you can narrow it with within or a longer find. dryRun never refuses.
    #[serde(default)]
    pub(super) all: bool,
    /// List what would change without changing it.
    #[serde(default)]
    pub(super) dry_run: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SharedCssParams {
    pub(super) design_id: String,
    /// The whole stylesheet, like ":root { --brand: #f97316 } .btn { padding: 12px 20px; border-radius: 999px }". Replaces the current one; pass "" to clear it.
    pub(super) css: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutParams {
    pub(super) design_id: String,
    /// An artboard, or a node inside one to see just its part. Omit for every artboard (up to 10).
    #[serde(default)]
    pub(super) node_id: Option<String>,
    /// How many levels below the node to list. Defaults to 4.
    #[serde(default)]
    pub(super) depth: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportParams {
    pub(super) design_id: String,
    /// "html", "finite" (a Finite bundle) or "figma" (a .figma.json file from the Finite Figma plugin).
    pub(super) format: String,
    /// The file as text. Pass this or contentBase64, not both.
    #[serde(default)]
    pub(super) content: Option<String>,
    /// The file's bytes in base64, for a file that isn't text.
    #[serde(default)]
    pub(super) content_base64: Option<String>,
    /// The file's name, like "landing.html". Names the undo step and the download of the original.
    #[serde(default)]
    pub(super) file_name: Option<String>,
    /// The id of the page the new artboards go on, unless the file names its own pages (a .finite bundle does). Omit for the first page.
    #[serde(default)]
    pub(super) page_id: Option<String>,
    /// Refuse the import if anything scores no or unknown on these axes: "preserved", "visual", "editable".
    #[serde(default, deserialize_with = "lenient_opt")]
    pub(super) strict: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePageParams {
    pub(super) design_id: String,
    /// Like "Components".
    pub(super) name: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportParams {
    pub(super) design_id: String,
    /// "html", "finite" (a Finite bundle) or "figma" (a .figma.json file for the Finite Figma plugin).
    pub(super) format: String,
    /// One artboard to export. Omit for the whole design.
    #[serde(default)]
    pub(super) artboard_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenamePageParams {
    pub(super) design_id: String,
    pub(super) page_id: String,
    pub(super) name: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageParams {
    pub(super) design_id: String,
    pub(super) page_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveToPageParams {
    pub(super) design_id: String,
    #[serde(alias = "nodeIds", alias = "artboardId", deserialize_with = "lenient")]
    pub(super) artboard_ids: Vec<String>,
    pub(super) page_id: String,
}
