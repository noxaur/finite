//! Version numbers for what Finite stores: snapshots, journal records and
//! bundles. This is how stored formats change without breaking old data.
//!
//! Every stored object starts with its version, as in `{"v":1,"meta":…}`.
//! Data from before versions existed has none and counts as version 1.
//! Reading data at the current version parses it straight into its type.
//! Older data goes through a chain of [`Upgrade`] steps first, one per
//! version, each a small function over JSON. Data newer than this build
//! knows is refused, never guessed at or rewritten, so an old server in a
//! cluster can't damage what a newer one wrote.
//!
//! To change a stored format: bump its [`Schema::version`], add the step
//! that turns the old shape into the new one to [`Schema::upgrades`], and
//! add a fixture of the old shape to the tests.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

/// Turns one version of a stored object into the next.
pub type Upgrade = fn(Value) -> Result<Value, String>;

/// A stored format: its name, current version, and how to get there.
pub struct Schema {
    pub name: &'static str,
    pub version: u32,
    /// `upgrades[0]` turns version 1 into 2, `upgrades[1]` turns 2 into 3,
    /// and so on, so there's one fewer than `version`.
    pub upgrades: &'static [Upgrade],
}

/// A saved design: [`crate::Snapshot`].
pub const SNAPSHOT: Schema = Schema {
    name: "snapshot",
    version: 1,
    upgrades: &[],
};

/// One line of a design's journal: [`crate::Record`].
pub const RECORD: Schema = Schema {
    name: "journal record",
    version: 1,
    upgrades: &[],
};

const _: () = {
    assert!(SNAPSHOT.upgrades.len() + 1 == SNAPSHOT.version as usize);
    assert!(RECORD.upgrades.len() + 1 == RECORD.version as usize);
};

#[derive(Debug)]
pub enum VersionError {
    /// Written by a newer build. Nothing here can read it safely.
    Newer {
        schema: &'static str,
        found: u32,
        known: u32,
    },
    /// An upgrade step refused the data.
    Upgrade {
        schema: &'static str,
        from: u32,
        reason: String,
    },
    Json(serde_json::Error),
}

impl std::fmt::Display for VersionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Newer {
                schema,
                found,
                known,
            } => write!(
                f,
                "this {schema} is version {found}, and this server only reads up to {known}"
            ),
            Self::Upgrade {
                schema,
                from,
                reason,
            } => write!(
                f,
                "couldn't upgrade a {schema} from version {from}: {reason}"
            ),
            Self::Json(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VersionError {}

impl From<serde_json::Error> for VersionError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

impl Schema {
    /// `value` as JSON, with this schema's version as its first key. `value`
    /// must serialize as a JSON object.
    pub fn encode<T: Serialize>(&self, value: &T) -> serde_json::Result<String> {
        let json = serde_json::to_string(value)?;
        let rest = json
            .strip_prefix('{')
            .expect("stored values serialize as JSON objects");
        let comma = if rest == "}" { "" } else { "," };
        Ok(format!("{{\"v\":{}{comma}{rest}", self.version))
    }

    /// Reads JSON written by [`Schema::encode`] at any version up to this
    /// one, or written before versions existed.
    pub fn decode<T: DeserializeOwned>(&self, json: &str) -> Result<T, VersionError> {
        let found = version_of(json)?;
        if found > self.version {
            return Err(self.newer(found));
        }
        if found == self.version {
            return Ok(serde_json::from_str(json)?);
        }
        let value = self.upgrade(serde_json::from_str(json)?, found)?;
        Ok(serde_json::from_value(value)?)
    }

    /// Runs the upgrade steps from `found` to the current version.
    fn upgrade(&self, mut value: Value, found: u32) -> Result<Value, VersionError> {
        for from in found.max(1)..self.version {
            value = self.upgrades[from as usize - 1](value).map_err(|reason| {
                VersionError::Upgrade {
                    schema: self.name,
                    from,
                    reason,
                }
            })?;
        }
        if let Value::Object(map) = &mut value {
            map.insert("v".into(), self.version.into());
        }
        Ok(value)
    }

    fn newer(&self, found: u32) -> VersionError {
        VersionError::Newer {
            schema: self.name,
            found,
            known: self.version,
        }
    }
}

/// The version of a stored object. [`Schema::encode`] writes it first, so
/// it's read from the first few bytes. Anything else, like data from before
/// versions, is scanned without building it.
fn version_of(json: &str) -> serde_json::Result<u32> {
    if let Some(rest) = json.strip_prefix("{\"v\":") {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if let Ok(v) = rest[..digits].parse() {
            return Ok(v);
        }
    }
    // Fields other than `v` are skipped, which doesn't build them.
    #[derive(Deserialize)]
    struct Probe {
        v: Option<u32>,
    }
    let probe: Probe = serde_json::from_str(json)?;
    Ok(probe.v.unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Pet {
        name: String,
        legs: u32,
    }

    /// Version 1 had `feet`; version 2 calls them `legs`.
    const PET: Schema = Schema {
        name: "pet",
        version: 2,
        upgrades: &[|mut v| {
            let feet = v["feet"].take();
            if feet.is_null() {
                return Err("no feet".into());
            }
            v["legs"] = feet;
            Ok(v)
        }],
    };

    fn rex() -> Pet {
        Pet {
            name: "Rex".into(),
            legs: 4,
        }
    }

    #[test]
    fn encoding_puts_the_version_first() {
        assert_eq!(
            PET.encode(&rex()).unwrap(),
            r#"{"v":2,"name":"Rex","legs":4}"#
        );
        assert_eq!(
            PET.decode::<Pet>(&PET.encode(&rex()).unwrap()).unwrap(),
            rex()
        );
    }

    #[test]
    fn old_data_is_upgraded_step_by_step() {
        let v1 = json!({ "v": 1, "name": "Rex", "feet": 4 }).to_string();
        assert_eq!(PET.decode::<Pet>(&v1).unwrap(), rex());
        // No version at all is version 1, wherever the other keys are.
        let unversioned = json!({ "feet": 4, "name": "Rex" }).to_string();
        assert_eq!(PET.decode::<Pet>(&unversioned).unwrap(), rex());
    }

    #[test]
    fn a_failed_upgrade_says_which_step() {
        let v1 = json!({ "v": 1, "name": "Rex" }).to_string();
        let err = PET.decode::<Pet>(&v1).unwrap_err();
        assert_eq!(
            err.to_string(),
            "couldn't upgrade a pet from version 1: no feet"
        );
    }

    #[test]
    fn newer_data_is_refused() {
        let v3 = json!({ "v": 3, "name": "Rex", "legs": 4 }).to_string();
        let err = PET.decode::<Pet>(&v3).unwrap_err();
        assert!(
            matches!(
                err,
                VersionError::Newer {
                    found: 3,
                    known: 2,
                    ..
                }
            ),
            "{err}"
        );
        // Also when the version isn't the first key.
        let v3 = json!({ "name": "Rex", "v": 3 }).to_string();
        assert!(matches!(
            PET.decode::<Pet>(&v3),
            Err(VersionError::Newer { .. })
        ));
    }
}
