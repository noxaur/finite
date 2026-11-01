//! The design's shared stylesheet: CSS every artboard renders with, for
//! classes and CSS variables shared across screens. It lives in the document
//! (`Op::Css`), so it's saved, synced to viewers and undoable like any edit.
//!
//! The tools ship only when `FINITE_MCP_EXTRA` includes `shared-styles`, as
//! they did while they were a demo, so AX runs (`e2e/ax`) stay comparable.
//! See https://github.com/noxaur/finite/issues/8.

use finite_design::edit;
use rmcp::{
    RoleServer, handler::server::wrapper::Parameters, service::RequestContext, tool, tool_router,
};

use super::{FiniteMcp, ToolResult, ok, params::*};

pub(super) const INSTRUCTIONS: &str = "Shared styles: set_shared_css holds CSS every artboard uses. Define CSS variables (--brand) and classes shared across screens (.btn, .top-bar) there once, not in each artboard. get_basic_info shows its size (sharedCssChars).";

#[tool_router(router = styles_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Set CSS that every artboard in the design uses: CSS variables and classes shared across screens, so each artboard doesn't repeat them. Replaces the whole stylesheet. Classes defined here work in write_html and update_styles values (var(--brand)) everywhere."
    )]
    async fn set_shared_css(
        &self,
        Parameters(p): Parameters<SharedCssParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let cleared = p.css.trim().is_empty();
        let rules = p.css.matches('{').count();
        self.edit(
            &ctx,
            &p.design_id,
            "Set shared CSS",
            |_| Ok((edit::set_css(&p.css)?, ())),
            |_, (), change| match (change, cleared) {
                (None, true) => "This design has no shared CSS.".into(),
                (None, false) => "The shared CSS was already that.".into(),
                (Some(_), true) => "Cleared the shared CSS.".into(),
                (Some(_), false) => format!(
                    "Saved the shared CSS ({rules} rule{}). Every artboard in the design uses it.",
                    if rules == 1 { "" } else { "s" }
                ),
            },
        )
        .await
    }

    #[tool(
        description = "The CSS every artboard in the design shares, set with set_shared_css.",
        annotations(read_only_hint = true)
    )]
    async fn get_shared_css(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        ok(handle.read(|d| {
            d.doc()
                .css()
                .map_or_else(|| "This design has no shared CSS.".into(), str::to_owned)
        }))
    }
}
