//! The `render` tool: images of what a selector matches, or each element's
//! box as text.

use std::{collections::HashMap, time::Duration};

use base64::Engine;
use finite_design::{NodeId, NodeKind};
use rmcp::{
    model::{CallToolResult, ContentBlock},
    schemars::{self, JsonSchema},
};
use serde::Deserialize;

use super::{
    format::{self, cut},
    layout,
    result::{ToolResult, fail, ok},
    selector::{Select, describe, matched, selector_text},
};
use crate::{hub::DesignHandle, screenshot};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenderParams {
    pub(super) design_id: String,
    /// A CSS selector (#k3x9a2bq, [data-name=Hero], :root for every artboard), at most 10 matches.
    #[serde(default)]
    select: Option<Select>,
    /// "image" (default) or "layout": each element's box as text.
    #[serde(default)]
    output: Option<String>,
    /// CSS pixels of the surroundings to include around each image.
    #[serde(default)]
    padding: Option<f64>,
    /// Device pixel ratio, 0.25 to 3; 2 helps read small text.
    #[serde(default)]
    scale: Option<f64>,
    /// Show content past the artboard's edge instead of clipping it.
    #[serde(default)]
    reveal_overflow: bool,
    /// How long to wait after load before capturing, in ms (default 3000, at most 10000).
    #[serde(default)]
    settle_ms: Option<u64>,
    /// With output "layout": how many levels to list (default 4).
    #[serde(default)]
    depth: Option<usize>,
}

/// The default depth of a layout outline.
const LAYOUT_DEPTH: usize = 4;

pub(super) async fn render(handle: &DesignHandle, p: RenderParams) -> ToolResult {
    let ids: Vec<NodeId> = match &p.select {
        Some(select) => {
            let found = handle.read(|d| {
                let doc = d.view();
                let selector = selector_text(&select.value(), &HashMap::new())?;
                let ids = matched(doc, &selector, None)?;
                if ids.is_empty() {
                    return Err(format!(
                        "{selector:?} matches no element. read shows the outline with every id."
                    ));
                }
                if ids.len() > screenshot::MAX_SHOTS {
                    return Err(format!(
                        "{selector:?} matches {} elements; one render takes at most {}. Narrow select: {}.",
                        ids.len(),
                        screenshot::MAX_SHOTS,
                        describe(doc, &ids)
                    ));
                }
                Ok(ids)
            });
            match found {
                Ok(ids) => ids,
                Err(error) => return fail(error),
            }
        }
        None => {
            if handle.read(|d| d.view().artboards().is_empty()) {
                return fail(
                    "This design has no artboards yet. Add one with an edit's \"artboard\" op.",
                );
            }
            Vec::new()
        }
    };
    let layout = p
        .output
        .as_deref()
        .is_some_and(|o| o.eq_ignore_ascii_case("layout"));
    if layout {
        return layout_text(handle, ids, p.depth.unwrap_or(LAYOUT_DEPTH)).await;
    }
    images(handle, ids, &p).await
}

/// Each element's box as text, for `roots`, or every artboard when there are none.
async fn layout_text(handle: &DesignHandle, roots: Vec<NodeId>, depth: usize) -> ToolResult {
    let mut parts = Vec::new();
    if roots.is_empty() {
        let boards: Vec<NodeId> = handle.read(|d| {
            d.view()
                .artboards()
                .iter()
                .take(screenshot::MAX_SHOTS)
                .map(|a| a.id.clone())
                .collect()
        });
        parts.push(outlines_of(handle, &boards, depth).await);
    } else {
        for root in roots {
            parts.push(outlines_of(handle, &[root], depth).await);
        }
    }
    match parts.into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(parts) => ok(parts.join("\n\n")),
        Err(error) => fail(error),
    }
}

/// The layout outline of each of `roots`, measured one after another and
/// cut to what a result holds.
async fn outlines_of(
    handle: &DesignHandle,
    roots: &[NodeId],
    depth: usize,
) -> Result<String, String> {
    let mut parts = Vec::new();
    for node_id in roots {
        let options = screenshot::Options::default();
        let measurement =
            match handle.read(|d| screenshot::plan_measurement(d.view(), node_id, options)) {
                Ok(measurement) => measurement,
                Err(error) => return Err(error),
            };
        let boxes = screenshot::layout(measurement).await?;
        parts.push(handle.read(|d| {
            let doc = d.view();
            // A text node's layout is its element's.
            let root = match doc.get(node_id) {
                Some(n) if n.kind == NodeKind::Text => {
                    n.parent.clone().unwrap_or_else(|| node_id.clone())
                }
                _ => node_id.clone(),
            };
            format::rendered_outline(doc, &root, depth, &boxes)
        }));
    }
    Ok(cut(
        parts.join("\n"),
        "Pass select for one part, or a smaller depth, to see the rest.",
    ))
}

/// An image of each of `ids`, or of every artboard, with a layout check of
/// the whole artboards.
async fn images(handle: &DesignHandle, ids: Vec<NodeId>, p: &RenderParams) -> ToolResult {
    let nodes = if ids.is_empty() {
        handle.read(|d| {
            d.view()
                .artboards()
                .iter()
                .take(screenshot::MAX_SHOTS)
                .map(|a| a.id.clone())
                .collect()
        })
    } else {
        ids
    };
    let shots = nodes
        .into_iter()
        .map(|node| screenshot::Shot {
            node,
            region: None,
            padding: p.padding.unwrap_or(0.0),
        })
        .collect();
    let options = screenshot::Options {
        scale: p.scale.unwrap_or(1.0),
        reveal_overflow: p.reveal_overflow,
        settle: p.settle_ms.map_or(screenshot::DEFAULT_SETTLE, |ms| {
            Duration::from_millis(ms).min(screenshot::MAX_SETTLE)
        }),
        ..screenshot::Options::default()
    };
    let plan = match handle.read(|d| screenshot::plan(d.view(), shots, options)) {
        Ok(plan) => plan,
        Err(error) => return fail(error),
    };
    let images = match screenshot::capture(plan).await {
        Ok(images) => images,
        Err(error) => return fail(error),
    };
    let mut content = Vec::new();
    let mut failed = 0;
    for image in &images {
        match image {
            Ok(image) => {
                content.push(ContentBlock::image(
                    base64::engine::general_purpose::STANDARD.encode(&image.data),
                    image.mime,
                ));
                content.push(ContentBlock::text(format::shot(image)));
                if let Some(boxes) = &image.boxes {
                    let notes =
                        handle.read(|d| layout::layout_notes(d.view(), &image.artboard, boxes));
                    if !notes.is_empty() {
                        content.push(ContentBlock::text(notes));
                    }
                }
            }
            Err(error) => {
                failed += 1;
                content.push(ContentBlock::text(error.clone()));
            }
        }
    }
    if failed == images.len() {
        return Ok(CallToolResult::error(content));
    }
    if let Some(note) = format::settled_note(images.iter().filter_map(|i| i.as_ref().ok())) {
        content.push(ContentBlock::text(note));
    }
    Ok(CallToolResult::success(content))
}
