//! The JSON files codecs read: a `.finite` bundle, a folder's manifest and a
//! Figma payload. Each has a version (see `finite_design::version`) and says
//! what it is in its `kind`, so a stray JSON file isn't taken for one.

use finite_design::{
    MAX_DEPTH,
    version::{Schema, VersionError},
};
use serde::de::DeserializeOwned;

use crate::Error;

pub(crate) trait JsonFile: DeserializeOwned {
    const SCHEMA: &'static Schema;
    /// What the file is, as an error says it: `a Finite bundle`.
    const NAME: &'static str;
    /// What its `kind` must say.
    const KIND: &'static str;
    /// How many levels of JSON the file nests beyond the two that each layer
    /// of a design takes (an object and its children's array).
    const EXTRA_DEPTH: usize;

    fn kind(&self) -> &str;

    /// Reads the file from `bytes`.
    fn read(bytes: &[u8]) -> Result<Self, Error> {
        let json = std::str::from_utf8(bytes).map_err(|_| {
            Error(format!(
                "the file isn't UTF-8 text, so it can't be {}",
                Self::NAME
            ))
        })?;
        Self::parse(json)
    }

    /// Reads the file from `json`, refusing one that nests deeper than a
    /// design can or whose `kind` is another file's.
    fn parse(json: &str) -> Result<Self, Error> {
        let limit = 2 * MAX_DEPTH + Self::EXTRA_DEPTH;
        let file: Self = Self::SCHEMA
            .decode_nested(json, limit)
            .map_err(|e| match e {
                VersionError::Json(e) => Error(format!("this isn't {}: {e}", Self::NAME)),
                other => Error(other.to_string()),
            })?;
        if file.kind() != Self::KIND {
            return Err(Error(format!(
                "this isn't {}: its kind is {:?}",
                Self::NAME,
                file.kind()
            )));
        }
        Ok(file)
    }
}
