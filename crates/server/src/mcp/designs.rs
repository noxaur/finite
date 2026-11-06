//! The `designs` tool: list, create, rename and delete designs, and the
//! rules for naming a design in any tool, which the router's relay shares.

use rmcp::{
    model::{CallToolResult, ContentBlock},
    schemars::{self, JsonSchema},
};
use serde::Deserialize;
use serde_json::json;

use super::{
    FiniteMcp,
    result::{ToolResult, fail, fit, ok},
};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesignsParams {
    /// Part of a design's name, or the start of its id.
    #[serde(default)]
    query: Option<String>,
    /// How many designs to list (default 50, at most 200).
    #[serde(default)]
    limit: Option<usize>,
    /// Create a design with this name.
    #[serde(default)]
    create: Option<String>,
    /// With rename: the design to rename.
    #[serde(default)]
    design_id: Option<String>,
    /// The new name for designId.
    #[serde(default)]
    rename: Option<String>,
    /// A design's id or exact name to delete permanently.
    #[serde(default)]
    delete: Option<String>,
}

/// How many designs a list shows when the agent doesn't say.
pub(crate) const DEFAULT_LIMIT: usize = 50;

/// The most designs a list asks for. A list that doesn't fit one tool result
/// ([`super::format::OUTPUT_LIMIT`]) is cut short and says so.
pub(crate) const MAX_LIMIT: usize = 200;

/// The note after a list whose query matched ids, not names.
pub(crate) const ID_MATCH_NOTE: &str =
    "The query matched the designId, not the name. Pass this designId to the other tools.";

/// `limit` as a list takes it.
pub(crate) fn list_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// Whether a design shows up for `query`: its name contains it (ignoring
/// case) or its id starts with it.
fn matches(query: Option<&str>, id: &str, name: &str) -> bool {
    query.is_none_or(|q| name.to_lowercase().contains(&q.to_lowercase()) || id_matches(id, q))
}

fn id_matches(id: &str, query: &str) -> bool {
    !query.is_empty() && id.to_lowercase().starts_with(&query.to_lowercase())
}

/// Whether `query` found designs only through their ids, none through a
/// name. `designs` is every `(id, name)` that matched.
pub(crate) fn only_by_id<'a>(
    query: Option<&str>,
    designs: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> bool {
    let Some(q) = query.filter(|q| !q.is_empty()) else {
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

impl FiniteMcp {
    pub(super) async fn designs(&self, p: DesignsParams) -> ToolResult {
        if let Some(name) = p.create {
            let hub = self.hub.clone();
            let created = tokio::task::spawn_blocking(move || hub.try_create(&name)).await;
            return match created.map_err(std::io::Error::other) {
                Ok(Ok(design)) => ok(format!(
                    "Created design {:?} with designId {:?}. Next: edit with an \"artboard\" op.",
                    design.meta.name, design.meta.id
                )),
                Ok(Err(error)) | Err(error) => fail(format!("Couldn't create the design: {error}")),
            };
        }
        if let Some(given) = p.delete {
            let id = match self.design_named(&given) {
                Ok(id) => id,
                Err(error) => return fail(error),
            };
            let handle = design!(self, &id);
            let name = handle.summary().meta.name;
            if let Some(error) = inexact_delete(&given, &id, &name) {
                return fail(error);
            }
            let hub = self.hub.clone();
            let deleted = tokio::task::spawn_blocking(move || hub.delete(&handle)).await;
            return match deleted.map_err(std::io::Error::other) {
                Ok(Ok(())) => ok(format!("Deleted design {name:?} ({id}) permanently.")),
                Ok(Err(error)) | Err(error) => fail(format!("Couldn't delete the design: {error}")),
            };
        }
        if let Some(name) = p.rename {
            let Some(id) = p.design_id else {
                return fail(
                    "rename needs designId, like {\"designId\": \"…\", \"rename\": \"New name\"}.",
                );
            };
            let handle = design!(self, &id);
            handle.rename(name.clone());
            return ok(format!("Renamed the design to {:?}.", name.trim()));
        }
        self.list(p.query.as_deref(), p.limit)
    }

    /// The designs, most recently edited first, with a note when the list
    /// was cut or the query matched ids and no name.
    fn list(&self, query: Option<&str>, limit: Option<usize>) -> ToolResult {
        let matching: Vec<_> = self
            .hub
            .list()
            .into_iter()
            .filter(|d| matches(query, &d.meta.id, &d.meta.name))
            .collect();
        let limit = list_limit(limit);
        let (list, shown) = fit(matching.iter().take(limit).map(|d| {
            json!({
                "designId": d.meta.id,
                "name": d.meta.name,
                "artboards": d.artboard_count,
                "nodes": d.node_count,
                "updatedAt": d.meta.updated_at,
            })
        }));
        let mut content = vec![list];
        let named = matching
            .iter()
            .map(|d| (d.meta.id.as_str(), d.meta.name.as_str()));
        if only_by_id(query, named) {
            content.push(ContentBlock::text(ID_MATCH_NOTE));
        }
        if matching.len() > shown {
            content.push(ContentBlock::text(format!(
                "Showing the {shown} most recently edited of {} designs. Pass a query to find one by name, or a larger limit.",
                matching.len()
            )));
        }
        Ok(CallToolResult::success(content))
    }

    /// The id of the design `given` names on this server ([`resolve_design`]).
    /// An id this server doesn't list goes through, for another server to
    /// answer.
    pub(super) fn design_named(&self, given: &str) -> Result<String, String> {
        let all = self.hub.list();
        let designs: Vec<_> = all
            .iter()
            .map(|d| (d.meta.id.as_str(), d.meta.name.as_str()))
            .collect();
        resolve_design(given, &designs, |id| self.hub.elsewhere(id).is_some())
    }
}

/// The id of the design `given` names among `designs` (each one's id and
/// name, most recently edited first): its id, its exact name ignoring case
/// when only one design has it, or the start of one design's id. An id that
/// `elsewhere` says another server answers for goes through. The router's
/// relay resolves names this way too, across every server's designs.
pub(crate) fn resolve_design(
    given: &str,
    designs: &[(&str, &str)],
    elsewhere: impl Fn(&str) -> bool,
) -> Result<String, String> {
    let want = given.trim();
    if designs.iter().any(|(id, _)| *id == want) {
        return Ok(want.to_owned());
    }
    let named: Vec<_> = designs
        .iter()
        .filter(|(_, name)| name.trim().eq_ignore_ascii_case(want))
        .collect();
    if let [(id, _)] = named.as_slice() {
        return Ok((*id).to_owned());
    }
    let prefixed: Vec<_> = designs
        .iter()
        .filter(|(id, _)| !want.is_empty() && id.starts_with(want))
        .collect();
    if named.is_empty()
        && let [(id, _)] = prefixed.as_slice()
    {
        return Ok((*id).to_owned());
    }
    if named.is_empty() && elsewhere(want) {
        return Ok(want.to_owned());
    }
    let lower = want.to_lowercase();
    let near: Vec<String> = if named.len() > 1 {
        named
            .iter()
            .map(|(id, name)| format!("{name:?} ({id})"))
            .collect()
    } else {
        designs
            .iter()
            .filter(|(_, name)| name.to_lowercase().contains(&lower))
            .take(5)
            .map(|(id, name)| format!("{name:?} ({id})"))
            .collect()
    };
    let hint = if near.is_empty() {
        " Call designs to list them.".to_owned()
    } else {
        format!(" Did you mean {}?", near.join(", "))
    };
    Err(format!(
        "there's no design {want:?}{}.{hint}",
        if named.len() > 1 {
            " with one name: several have it, so pass the id"
        } else {
            ""
        }
    ))
}

/// Why `given` mustn't delete the design `id` named `name` it resolved to.
/// Deleting can't be undone, so only an exact id or name will do: an id
/// prefix or a mistyped name could pick another design.
pub(crate) fn inexact_delete(given: &str, id: &str, name: &str) -> Option<String> {
    let given = given.trim();
    (id != given && !name.trim().eq_ignore_ascii_case(given)).then(|| {
        format!(
            "\"{given}\" isn't a design's exact id or name, so nothing was deleted. Did you mean {name:?} ({id})? Pass its id to delete it."
        )
    })
}
