//! Building tool results.

use rmcp::{
    ErrorData as McpError,
    model::{CallToolResult, ContentBlock},
};
use serde_json::Value;

use super::format::OUTPUT_LIMIT;

pub(super) type ToolResult = Result<CallToolResult, McpError>;

pub(super) fn ok(text: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

pub(super) fn fail(text: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::error(vec![ContentBlock::text(text)]))
}

/// As many of `items` as fit in [`OUTPUT_LIMIT`] as a JSON array, and how
/// many that is. Always at least one, so a long list still makes progress.
pub(super) fn fit(items: impl Iterator<Item = Value>) -> (ContentBlock, usize) {
    let mut kept = Vec::new();
    let mut size = 0;
    for item in items {
        let text = serde_json::to_string_pretty(&item).expect("json values serialize");
        // Inside the array, every line is indented two more spaces.
        let len = text.len() + 2 * text.lines().count() + 2;
        if !kept.is_empty() && size + len > OUTPUT_LIMIT {
            break;
        }
        size += len;
        kept.push(item);
    }
    let shown = kept.len();
    let text = serde_json::to_string_pretty(&kept).expect("json values serialize");
    (ContentBlock::text(text), shown)
}

/// `content`, followed by `note` if there is one.
pub(super) fn with_note(content: ContentBlock, note: Option<String>) -> Vec<ContentBlock> {
    std::iter::once(content)
        .chain(note.map(ContentBlock::text))
        .collect()
}

/// The notes that are there, one per line.
pub(super) fn joined(notes: [Option<String>; 2]) -> Option<String> {
    let notes: Vec<String> = notes.into_iter().flatten().collect();
    (!notes.is_empty()).then(|| notes.join("\n"))
}
