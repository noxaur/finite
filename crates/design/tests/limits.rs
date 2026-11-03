//! Records the comment limits in `fixtures/limits.json`. The web app checks
//! its own copies against the same file (`apps/web/src/lib/limits.test.ts`),
//! so the browser stops typing where the server would refuse.
//!
//! Regenerate with `FINITE_UPDATE_FIXTURES=1` after changing a limit.

use std::{fs, path::PathBuf};

use finite_design::comment;
use serde_json::{Value, json};

#[test]
fn limits_match_the_shared_fixture() {
    let limits = json!({
        "about": "Limits the server enforces, recorded from crates/design/tests/limits.rs. apps/web/src/lib/limits.test.ts checks the web app's copies.",
        "commentBody": comment::MAX_BODY,
        "authorName": comment::MAX_NAME,
        "commentSelection": comment::MAX_SELECTION,
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/limits.json");
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        fs::write(&path, serde_json::to_string_pretty(&limits).unwrap() + "\n").unwrap();
        return;
    }
    let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(limits, stored, "a limit changed; regenerate the fixture");
}
