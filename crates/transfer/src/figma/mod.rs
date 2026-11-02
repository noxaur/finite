//! Figma, through the Finite Figma plugin (`apps/figma-plugin`). The plugin
//! and Finite trade `.figma.json` files holding a [`payload::Payload`]: the
//! plugin saves a selection as one for Finite to import, and opens one that
//! Finite exported to build Figma layers from it. All conversion is here;
//! the plugin only copies values between the payload and the Plugin API.
//!
//! - [`import`] turns a payload into artboards with CSS.
//! - [`export`] turns artboards into a payload, from their measured
//!   [`crate::scene::Scene`].

mod export;
mod import;
pub mod payload;

use crate::{
    Codec, Direction, Error, Exported, Feature, Imported, Input, Revision, Scope, Support,
};

pub struct Figma;

impl Codec for Figma {
    fn name(&self) -> &'static str {
        "figma"
    }

    fn support(&self, feature: Feature, direction: Direction) -> Support {
        use {Direction::*, Support::*};
        match (feature, direction) {
            (Feature::Frame | Feature::SolidFill, Import | Export) => Exact,
            // Figma and the browser may not have the same fonts.
            (Feature::Text, Import | Export) => Approximate,
            (Feature::Image, Import) => Exact,
            // Figma's scale modes cover the common `object-fit`s, not every
            // CSS background.
            (Feature::Image, Export) => Approximate,
            (Feature::FlexLayout, Import) => Exact,
            // Auto layout has no grid, `order` or `flex-basis`; those export
            // as measured positions.
            (Feature::FlexLayout, Export) => Approximate,
            // Figma has neither.
            (Feature::Script | Feature::Embed, Import | Export) => Unsupported,
            (Feature::ImportHistory, Import | Export) => Unsupported,
        }
    }

    fn read(&self, input: &Input<'_>) -> Result<Imported, Error> {
        import::read(input)
    }

    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error> {
        export::write(revision, scope)
    }
}
