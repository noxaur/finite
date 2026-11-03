//! Design tokens: the design's CSS variables, like `--brand`, which every
//! artboard can use with `var(--brand)`, with a value per mode such as
//! Light and Dark. They live in the document (`Op::Token`, `Op::Mode`), so
//! they're saved, synced to viewers and undoable like any edit. People
//! edit them in the viewer through the same [`token_ops`].

use std::collections::BTreeMap;

use finite_design::{
    Document, Op,
    edit::{self, EditError, TokenChange},
};
use rmcp::{
    RoleServer, handler::server::wrapper::Parameters, service::RequestContext, tool, tool_router,
};
use serde_json::{Map, Value};

use super::{FiniteMcp, ToolResult, changed, json, params::*};
use crate::hub::random_id;

pub(super) const INSTRUCTIONS: &str = "Tokens: set_tokens holds CSS variables every artboard can use, like var(--brand), with a value per mode (Light, Dark), for shared colors, fonts and sizes. set_artboard_mode picks an artboard's mode.";

/// The ops for a `set_tokens` call or the viewer's token panel: `modes`
/// names the design's modes in order (see [`edit::set_modes`]), then each
/// token in `tokens` is set, changed or deleted, by mode name or id.
pub(crate) fn token_ops(
    doc: &Document,
    modes: Option<&[String]>,
    tokens: &BTreeMap<String, Option<TokenValue>>,
) -> Result<Vec<Op>, EditError> {
    let (mut ops, list) = match modes {
        Some(names) => {
            let mut new_id = || loop {
                let id = format!("mode-{}", random_id(8));
                if !doc.mode_map().contains_key(&id) {
                    return id;
                }
            };
            edit::set_modes(doc, names, &mut new_id)?
        }
        None => (Vec::new(), edit::mode_list(doc)),
    };
    let changes: Vec<(String, TokenChange)> = tokens
        .iter()
        .map(|(name, value)| {
            let change = match value {
                None => TokenChange::Delete,
                Some(TokenValue::All(value)) => TokenChange::All(value.clone()),
                Some(TokenValue::Modes(values)) => TokenChange::Modes(values.clone()),
            };
            (name.clone(), change)
        })
        .collect();
    ops.extend(edit::set_tokens(doc, &list, &changes)?);
    Ok(ops)
}

/// The design's tokens as `set_tokens` takes them: the modes by name, and
/// each token's values by mode name, or one value when only the first mode
/// has one.
pub(super) fn listed(doc: &Document) -> Value {
    let modes = doc.modes();
    let name = |id: &str| {
        modes
            .iter()
            .find(|(m, _)| *m == id)
            .map(|(_, m)| m.name.clone())
    };
    let first = doc.first_mode();
    let tokens: Map<String, Value> = doc
        .tokens()
        .iter()
        .map(|(token, values)| {
            let value = match values.iter().next() {
                Some((mode, value)) if values.len() == 1 && mode == first => value.clone().into(),
                _ => values
                    .iter()
                    .filter_map(|(mode, value)| Some((name(mode)?, Value::from(value.clone()))))
                    .collect::<Map<_, _>>()
                    .into(),
            };
            (token.clone(), value)
        })
        .collect();
    let mut by_mode: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for board in doc.artboards() {
        let mode = doc.mode_of(board);
        if mode != first
            && let Some(name) = name(mode)
        {
            by_mode.entry(name).or_default().push(&board.id);
        }
    }
    let mut out = serde_json::json!({
        "modes": modes.iter().map(|(_, m)| m.name.clone()).collect::<Vec<_>>(),
        "tokens": tokens,
    });
    if !by_mode.is_empty() {
        out["artboardModes"] = serde_json::to_value(by_mode).expect("ids serialize");
    }
    out
}

#[tool_router(router = tokens_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Set the design's tokens: CSS variables every artboard can use, like var(--brand). Give a token one value, a value per mode, or null to delete it; tokens you don't pass stay as they are. Pass modes to name the design's modes in order, like [\"Light\", \"Dark\"]: the first renames the first mode, and extra names add modes. A mode without a value uses the first mode's."
    )]
    async fn set_tokens(
        &self,
        Parameters(p): Parameters<SetTokensParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let count = p.tokens.len();
        self.edit(
            &ctx,
            &p.design_id,
            "Set tokens",
            |doc| Ok((token_ops(doc, p.modes.as_deref(), &p.tokens)?, ())),
            |handle, (), change| match change {
                None => "Nothing changed: the tokens already were that.".into(),
                Some(_) => handle.read(|d| {
                    let modes: Vec<String> =
                        edit::mode_list(d.doc()).into_iter().map(|(_, n)| n).collect();
                    format!(
                        "Saved {count} token{}. The design has {} tokens, in modes {}. Use them as var(--name) in any artboard.",
                        if count == 1 { "" } else { "s" },
                        d.doc().tokens().len(),
                        modes.join(", ")
                    )
                }),
            },
        )
        .await
    }

    #[tool(
        description = "The design's tokens and modes, as set_tokens takes them, and which artboards render in a mode other than the first.",
        annotations(read_only_hint = true)
    )]
    async fn get_tokens(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        json(handle.read(|d| listed(d.doc())))
    }

    #[tool(
        description = "Set the mode artboards render in, by the mode's name, like \"Dark\". Their var(--…) values then come from that mode. Pass no mode to put them back in the first mode."
    )]
    async fn set_artboard_mode(
        &self,
        Parameters(p): Parameters<ArtboardModeParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let requested = p.artboard_ids.len();
        self.edit(
            &ctx,
            &p.design_id,
            "Set artboard mode",
            |doc| {
                Ok((
                    edit::set_artboard_mode(doc, &p.artboard_ids, p.mode.as_deref())?,
                    (),
                ))
            },
            |handle, (), change| changed(handle, change, requested),
        )
        .await
    }
}
