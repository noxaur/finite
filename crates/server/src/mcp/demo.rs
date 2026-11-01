//! A demo of a feature Finite doesn't have yet: a design-wide stylesheet
//! that every artboard uses, for shared classes and CSS variables. It ships
//! only when `FINITE_MCP_EXTRA` includes `shared-styles`, so AX experiments
//! (`e2e/ax`) can measure whether agents build better with it.
//!
//! It's a demo because only the agent's side exists: the CSS lives in this
//! server's memory, screenshots apply it, and nothing else does. The real
//! feature needs the stylesheet in the document (saved, undoable and synced
//! like any edit), and the viewer and thumbnails applying it inside each
//! artboard's shadow root. See https://github.com/noxaur/finite/issues/8.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use rmcp::{handler::server::wrapper::Parameters, tool, tool_router};

use super::{FiniteMcp, ToolResult, fail, ok, params::*};

pub(super) const INSTRUCTIONS: &str = "Shared styles: set_shared_css holds CSS every artboard uses. Define CSS variables (--brand) and classes shared across screens (.btn, .top-bar) there once, not in each artboard. get_basic_info shows its size (sharedCssChars).";

/// The longest shared stylesheet, the same order as a large `<style>` block.
const MAX_CSS: usize = 100_000;

fn sheets() -> &'static Mutex<HashMap<String, String>> {
    static SHEETS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    SHEETS.get_or_init(Default::default)
}

/// The design's shared CSS, if the demo set one.
pub(crate) fn shared_css(design: &str) -> Option<String> {
    sheets().lock().expect("not poisoned").get(design).cloned()
}

#[tool_router(router = demo_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Set CSS that every artboard in the design uses: CSS variables and classes shared across screens, so each artboard doesn't repeat them. Replaces the whole stylesheet. Classes defined here work in write_html and update_styles values (var(--brand)) everywhere."
    )]
    async fn set_shared_css(&self, Parameters(p): Parameters<SharedCssParams>) -> ToolResult {
        let _handle = design!(self, &p.design_id);
        if p.css.len() > MAX_CSS {
            return fail(format!(
                "the stylesheet can be at most {MAX_CSS} characters"
            ));
        }
        if p.css.to_ascii_lowercase().contains("</style") {
            return fail("pass the CSS alone, without <style> tags");
        }
        let mut sheets = sheets().lock().expect("not poisoned");
        if p.css.trim().is_empty() {
            sheets.remove(&p.design_id);
            return ok("Cleared the shared CSS.");
        }
        let rules = p.css.matches('{').count();
        sheets.insert(p.design_id, p.css);
        ok(format!(
            "Saved the shared CSS ({rules} rule{}). Every artboard in the design uses it.",
            if rules == 1 { "" } else { "s" }
        ))
    }

    #[tool(
        description = "The CSS every artboard in the design shares, set with set_shared_css.",
        annotations(read_only_hint = true)
    )]
    async fn get_shared_css(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let _handle = design!(self, &p.design_id);
        ok(shared_css(&p.design_id).unwrap_or_else(|| "This design has no shared CSS.".into()))
    }
}
