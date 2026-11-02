//! A Figma payload into artboards.

use crate::{Error, Imported, Input};

pub fn read(_input: &Input<'_>) -> Result<Imported, Error> {
    Err(Error("Figma import isn't built yet".into()))
}
