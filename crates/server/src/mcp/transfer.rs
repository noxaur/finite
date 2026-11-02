//! Importing files into a design and exporting it, over `crate::transfer`.
//! The conversion is all in `finite-transfer`; these tools only read
//! arguments and say what happened.

use base64::Engine;
use finite_transfer::{Diagnostic, Scope, Score};
use rmcp::{
    RoleServer, handler::server::wrapper::Parameters, service::RequestContext, tool, tool_router,
};

use super::{FiniteMcp, ToolResult, cut, fail, ok, params::*};
use crate::transfer::{self, ImportRequest};

fn score(score: Score) -> &'static str {
    match score {
        Score::Yes => "yes",
        Score::No => "no",
        Score::Unknown => "unknown",
    }
}

/// One line per diagnostic: what, where, why, and its three scores.
fn diagnostics(text: &mut String, diagnostics: &[Diagnostic]) {
    if diagnostics.is_empty() {
        text.push_str("Everything converted exactly.\n");
        return;
    }
    text.push_str(&format!("{} diagnostic(s):\n", diagnostics.len()));
    for d in diagnostics {
        text.push_str(&format!(
            "- {} at {}: {} (preserved {}, visual {}, editable {})\n",
            d.what,
            d.path,
            d.reason,
            score(d.preserved),
            score(d.visual),
            score(d.editable)
        ));
    }
}

#[tool_router(router = transfer_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Import a file into the design as new artboards, as one undo step. Pass the file as content (text) or contentBase64 (bytes). Returns the new artboards, a diagnostic for anything that didn't convert exactly (with preserved, visual and editable scores), and the import's id. Scripts, handlers and embeds never reach the design; Finite keeps the original file. strict refuses the import, changing nothing, if anything scores no or unknown on the axes you name."
    )]
    async fn import_design(
        &self,
        Parameters(p): Parameters<ImportParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let bytes = match (p.content, p.content_base64) {
            (Some(text), None) => text.into_bytes(),
            (None, Some(encoded)) => {
                match base64::engine::general_purpose::STANDARD.decode(encoded.trim()) {
                    Ok(bytes) => bytes,
                    Err(error) => return fail(format!("contentBase64 isn't base64: {error}")),
                }
            }
            _ => return fail("pass exactly one of content or contentBase64"),
        };
        let strict = p.strict.unwrap_or_default();
        let request = match (
            transfer::format_named(&p.format),
            transfer::strict_named(strict.iter().map(String::as_str)),
        ) {
            (Ok(format), Ok(strict)) => ImportRequest {
                format,
                bytes,
                file_name: p.file_name,
                strict,
            },
            (Err(error), _) | (_, Err(error)) => return fail(error.to_string()),
        };
        let result =
            match transfer::import(&self.hub, &p.design_id, &self.actor(&ctx), request).await {
                Ok(result) => result,
                Err(error) => return fail(error.to_string()),
            };
        let mut text = handle.read(|d| {
            let mut text = format!("Imported {} artboard(s):\n", result.artboards.len());
            for id in &result.artboards {
                let name = d
                    .doc()
                    .get(id)
                    .map(|b| b.display_name())
                    .unwrap_or_default();
                text.push_str(&format!("  #{id} {name:?}\n"));
            }
            text
        });
        diagnostics(&mut text, &result.diagnostics);
        text.push_str(&format!(
            "Import #{}. Finite keeps the original file, so nothing above is lost.",
            result.import.id
        ));
        ok(cut(text, "Check the artboards with get_screenshot."))
    }

    #[tool(
        description = "Export the design, or one artboard, as a file in a format like \"html\". Returns the file's text, and a diagnostic for anything that didn't convert exactly.",
        annotations(read_only_hint = true)
    )]
    async fn export_design(&self, Parameters(p): Parameters<ExportParams>) -> ToolResult {
        let format = match transfer::format_named(&p.format) {
            Ok(format) => format,
            Err(error) => return fail(error.to_string()),
        };
        let _ = design!(self, &p.design_id);
        let route = match &p.artboard_id {
            Some(board) => format!(
                "GET /api/designs/{}/export?format={}&artboard={board}",
                p.design_id, p.format
            ),
            None => format!(
                "GET /api/designs/{}/export?format={}",
                p.design_id, p.format
            ),
        };
        let scope = p.artboard_id.map_or(Scope::Design, Scope::Artboard);
        let exported = match transfer::export(&self.hub, &p.design_id, format, scope).await {
            Ok(exported) => exported,
            Err(error) => return fail(error.to_string()),
        };
        let mut text = String::new();
        diagnostics(&mut text, &exported.diagnostics);
        match String::from_utf8(exported.bytes) {
            Ok(file) => {
                text.push_str(&format!(
                    "{} ({}):\n",
                    exported.file_name, exported.media_type
                ));
                text.push_str(&file);
                ok(cut(text, &format!("The whole file is at {route}.")))
            }
            Err(error) => ok(format!(
                "{text}{} is {} bytes of {}, not text. Download it from {route}.",
                exported.file_name,
                error.as_bytes().len(),
                exported.media_type
            )),
        }
    }
}
