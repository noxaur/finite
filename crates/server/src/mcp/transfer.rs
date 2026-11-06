//! Saying what an import or an export did, over `crate::transfer`. The
//! conversion is all in `finite-transfer`; this only words the result.

use finite_design::NodeId;
use finite_transfer::{Diagnostic, Scope, Score};

use super::{
    format::cut,
    result::{ToolResult, fail, ok},
};
use crate::{hub::Hub, transfer};
use std::sync::Arc;

fn score(score: Score) -> &'static str {
    match score {
        Score::Yes => "yes",
        Score::No => "no",
        Score::Unknown => "unknown",
    }
}

/// How many paths a line of diagnostics shows before it says how many more.
const EXAMPLES: usize = 3;

/// One line per kind of diagnostic (what, why and its three scores), with
/// how many there are and where the first few are, so a page with hundreds
/// of `<link>`s still reads in a few lines. `record` says where to find
/// every path, if a line leaves some out.
pub(super) fn diagnostics(text: &mut String, diagnostics: &[Diagnostic], record: Option<&str>) {
    if diagnostics.is_empty() {
        text.push_str("No conversion issues reported.\n");
        return;
    }
    let mut kinds: Vec<(&Diagnostic, Vec<&str>)> = Vec::new();
    for d in diagnostics {
        let same = |k: &&mut (&Diagnostic, Vec<&str>)| {
            let k = k.0;
            (&k.what, &k.reason, k.preserved, k.visual, k.editable)
                == (&d.what, &d.reason, d.preserved, d.visual, d.editable)
        };
        match kinds.iter_mut().find(same) {
            Some((_, paths)) => paths.push(&d.path),
            None => kinds.push((d, vec![&d.path])),
        }
    }
    text.push_str(&format!(
        "{} diagnostic(s) of {} kind(s):\n",
        diagnostics.len(),
        kinds.len()
    ));
    let mut cut_short = false;
    for (d, paths) in &kinds {
        let count = match paths.len() {
            1 => String::new(),
            n => format!("{n} × "),
        };
        let shown: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|p| !p.is_empty())
            .take(EXAMPLES)
            .collect();
        let at = match (shown.len(), paths.len() - shown.len()) {
            (0, _) => String::new(),
            (_, 0) => format!(" at {}", shown.join(", ")),
            (_, more) => {
                cut_short = true;
                format!(" at {} and {more} more", shown.join(", "))
            }
        };
        text.push_str(&format!(
            "- {count}{}{at}: {} (preserved {}, visual {}, editable {})\n",
            d.what,
            d.reason,
            score(d.preserved),
            score(d.visual),
            score(d.editable)
        ));
    }
    if cut_short && let Some(record) = record {
        text.push_str(record);
        text.push('\n');
    }
}

/// The design, or one artboard, as a file in `format`: a diagnostic for
/// anything that didn't convert exactly, then the file's text, cut off past
/// [`super::format::OUTPUT_LIMIT`]. A binary file is named, with where to
/// download it.
pub(super) async fn export(
    hub: &Arc<Hub>,
    design_id: &str,
    format_name: &str,
    artboard: Option<NodeId>,
    router: Option<&str>,
) -> ToolResult {
    let format = match transfer::format_named(format_name) {
        Ok(format) => format,
        Err(error) => return fail(error.to_string()),
    };
    let router = match router.map(transfer::router_named).transpose() {
        Ok(router) => router,
        Err(error) => return fail(error.to_string()),
    };
    let router_query = router.map_or_else(String::new, |router| {
        format!("&router={}", router.router().name())
    });
    let route = match &artboard {
        Some(board) => format!(
            "GET /api/designs/{design_id}/export?format={format_name}&artboard={board}{router_query}"
        ),
        None => format!("GET /api/designs/{design_id}/export?format={format_name}{router_query}"),
    };
    let scope = artboard.map_or(Scope::Design, Scope::Artboard);
    let exported = match transfer::export_with(hub, design_id, format, scope, router).await {
        Ok(exported) => exported,
        Err(error) => return fail(error.to_string()),
    };
    let mut text = String::new();
    diagnostics(&mut text, &exported.diagnostics, None);
    // A tar archive is padded with NULs, which are valid UTF-8 but not text to read.
    let file = match exported.media_type {
        "application/x-tar" => None,
        _ => std::str::from_utf8(&exported.bytes).ok(),
    };
    match file {
        Some(file) => {
            text.push_str(&format!(
                "{} ({}):\n",
                exported.file_name, exported.media_type
            ));
            text.push_str(file);
            ok(cut(text, &format!("The whole file is at {route}.")))
        }
        None => ok(format!(
            "{text}{} is {} bytes of {}, not text. Download it from {route}.",
            exported.file_name,
            exported.bytes.len(),
            exported.media_type
        )),
    }
}
