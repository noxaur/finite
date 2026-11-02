//! What a design remembers about each import: the exact bytes it received
//! and what couldn't be kept as editable nodes.
//!
//! The bytes themselves live in the server's blob store, addressed by their
//! sha256. A design only holds the [`BlobHash`]. Quarantined content, like
//! an `onclick` handler, is never copied into the document: it stays in those
//! bytes, and the record says where it was. So nothing that renders a design
//! can reach it.

use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::NodeId;

/// The sha256 of a blob, as 64 lowercase hex digits. Parsing checks the
/// shape, so a hash is always safe to use as a file name.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BlobHash(String);

/// What [`BlobHash::parse`] refused.
#[derive(Debug, PartialEq, Eq)]
pub struct NotAHash;

impl fmt::Display for NotAHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a blob hash is 64 lowercase hex digits")
    }
}

impl std::error::Error for NotAHash {}

impl BlobHash {
    pub fn parse(hex: &str) -> Result<Self, NotAHash> {
        let valid = hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if valid {
            Ok(Self(hex.to_owned()))
        } else {
            Err(NotAHash)
        }
    }

    /// The hash of `bytes`.
    pub fn of(bytes: &[u8]) -> Self {
        let digest = Sha256::digest(bytes);
        Self(digest.iter().map(|b| format!("{b:02x}")).collect())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BlobHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for BlobHash {
    type Error = String;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::parse(&s).map_err(|_| format!("not a sha256 hash: {s:?}"))
    }
}

impl From<BlobHash> for String {
    fn from(hash: BlobHash) -> Self {
        hash.0
    }
}

/// One import into a design. Records never change after the import, and
/// undoing the import keeps its record, so the original bytes stay
/// downloadable whatever happens to the nodes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub id: String,
    /// The bytes as received.
    pub artifact: BlobHash,
    /// Which codec read them, like `html` or `figma`.
    pub format: String,
    /// What the bytes are, precisely: `figma-plugin-payload v1` is what the
    /// plugin sent, not the Figma file itself.
    pub input_kind: String,
    /// The file name the bytes came with, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub received_at: u64,
    /// Which node each source element became, by its path in the source
    /// (see the codec). With the artifact, this is enough to rebuild any
    /// fingerprint later, so none are stored.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub nodes: BTreeMap<NodeId, String>,
    /// Things the source referenced but didn't contain, like remote images.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<Dependency>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quarantined: Vec<Quarantined>,
}

/// A resource the source pointed to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub url: String,
    /// The fetched bytes, or `None` when the import didn't fetch them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<BlobHash>,
}

/// Source content the import kept out of the document because it could run
/// code. It's still in the artifact, at `path`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quarantined {
    /// The nearest node that was kept, or `None` for content at the top level.
    pub node: Option<NodeId>,
    /// Where it was in the source, in the codec's notation.
    pub path: String,
    /// What it was, like `<script>` or `onclick`.
    pub what: String,
    pub reason: String,
}
