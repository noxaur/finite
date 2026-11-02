//! Finding nodes and replacing values across a design. In AX runs
//! (`e2e/ax`), agents recoloring a design with them used half the calls and
//! read a third of the context, where before they read every artboard's
//! HTML and picked out each use by eye.

use finite_design::search::{self, Places, Query};
use rmcp::{
    handler::server::wrapper::Parameters,
    service::{RequestContext, RoleServer},
    tool, tool_router,
};

use super::{FiniteMcp, ToolResult, cut, ok, outline, params::*};

/// How many matches find_nodes lists.
const FOUND_SHOWN: usize = 200;

#[tool_router(router = search_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Find elements by text, layer name, tag, CSS (inline styles and <style> blocks) or attribute, in one artboard or the whole design. Every filter you pass must match. Returns each match's outline line, grouped by artboard, with the declarations or attributes that matched. Use it before editing many nodes, and after, to check none were missed.",
        annotations(read_only_hint = true)
    )]
    async fn find_nodes(&self, Parameters(p): Parameters<FindParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let query = Query {
            text: p.text,
            name: p.name,
            tag: p.tag,
            style: p.style,
            attribute: p.attribute,
        };
        if query.text.is_none()
            && query.name.is_none()
            && query.tag.is_none()
            && query.style.is_none()
            && query.attribute.is_none()
        {
            return super::fail("pass at least one of text, name, tag, style or attribute");
        }
        let text = handle.read(|d| {
            let doc = d.doc();
            if let Some(id) = &p.within
                && !doc.contains(id)
            {
                return format!("node {id:?} not found");
            }
            let found = search::find(doc, p.within.as_deref(), &query);
            if found.is_empty() {
                return "No elements match.".into();
            }
            let mut text = format!(
                "{} element{} match:\n",
                found.len(),
                if found.len() == 1 { "" } else { "s" }
            );
            let mut board: Option<String> = None;
            for f in found.iter().take(FOUND_SHOWN) {
                let here = doc.artboard_of(&f.id).map(|b| b.id.clone());
                if here != board {
                    if let Some(b) = here.as_deref().and_then(|id| doc.get(id)) {
                        text.push_str(&format!("Artboard {:?} #{}:\n", b.display_name(), b.id));
                    }
                    board = here;
                }
                text.push_str("  ");
                text.push_str(outline(doc, &f.id, 0).lines().next().unwrap_or("").trim());
                for detail in &f.details {
                    text.push_str(&format!("\n      {detail}"));
                }
                text.push('\n');
            }
            if found.len() > FOUND_SHOWN {
                text.push_str(&format!(
                    "Showing the first {FOUND_SHOWN}. Narrow it with within or another filter.\n"
                ));
            }
            text
        });
        ok(cut(text, "Narrow it with within or another filter."))
    }

    #[tool(
        description = "Find and replace text or a value, as one undo step: in inline styles, attributes (like SVG fill), <style> CSS and <script> code, and in visible text if includeText is set. Use it to change part of a <style> or <script> (a duration, a class name, a delay) without resending all of it. A color matches in any notation (#3B82F6, rgb(59 130 246), rgba(59,130,246,.2)) in styles, attributes and <style>; when it is replaced by another color, each use keeps its own alpha, and when it is replaced by text like var(--brand), tints with their own alpha are left alone. Other text, and anything inside a <script>, matches exactly; if that matches more than once inside a <style> or <script>, nothing changes until you narrow it with within or a longer find, or pass all: true. Preview with dryRun. Returns every change it made."
    )]
    async fn replace_values(
        &self,
        Parameters(p): Parameters<ReplaceParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: p.include_text,
        };
        let report =
            |handle: &crate::hub::DesignHandle, replaced: Vec<search::Replaced>, dry: bool| {
                if replaced.is_empty() {
                    return format!("Found no {:?} to replace.", p.find);
                }
                let total: usize = replaced.iter().map(|r| r.count).sum();
                handle.read(|d| {
                    let mut text = format!(
                        "{} {total} use{} on {} node{}:\n",
                        if dry { "Would replace" } else { "Replaced" },
                        if total == 1 { "" } else { "s" },
                        replaced.len(),
                        if replaced.len() == 1 { "" } else { "s" }
                    );
                    for r in &replaced {
                        text.push_str("  ");
                        text.push_str(
                            outline(d.doc(), &r.id, 0)
                                .lines()
                                .next()
                                .unwrap_or("")
                                .trim(),
                        );
                        for change in &r.changes {
                            text.push_str(&format!("\n      {change}"));
                        }
                        text.push('\n');
                    }
                    cut(text, "Scope it with within to see one artboard's changes.")
                })
            };
        if p.dry_run {
            let handle = design!(self, &p.design_id);
            let result = handle.read(|d| {
                search::replace(
                    d.doc(),
                    p.within.as_deref(),
                    &p.find,
                    &p.replace,
                    places,
                    true,
                )
            });
            return match result {
                Ok((_, replaced)) => ok(report(&handle, replaced, true)),
                Err(error) => super::fail(error.to_string()),
            };
        }
        let label = format!("Replace {:?}", p.find);
        self.edit(
            &ctx,
            &p.design_id,
            &label,
            |doc| search::replace(doc, p.within.as_deref(), &p.find, &p.replace, places, p.all),
            |handle, replaced, _| report(handle, replaced, false),
        )
        .await
    }
}
