//! Artboards into a Figma payload.

use crate::{Error, Exported, Revision, Scope};

pub fn write(_revision: &Revision<'_>, _scope: &Scope) -> Result<Exported, Error> {
    Err(Error("Figma export isn't built yet".into()))
}
