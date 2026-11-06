//! A prototype as a standalone Vite + React project, packed as a tar
//! archive like a design folder. Export only.
//!
//! The routes and links come from [`finite_design::flow::flow`]. The
//! scaffold is the same for every router; only the router module differs,
//! and each router is a [`Router`] in [`ROUTERS`].

use crate::{
    Codec, Direction, Error, Exported, Feature, Imported, Input, Revision, Scope, Support,
};

pub struct App;

impl Codec for App {
    fn name(&self) -> &'static str {
        "app"
    }

    fn support(&self, feature: Feature, direction: Direction) -> Support {
        use {Direction::*, Support::*};
        match (feature, direction) {
            (_, Import) => Unsupported,
            (Feature::Text | Feature::Image, Export) => Exact,
            (Feature::Frame | Feature::SolidFill | Feature::FlexLayout, Export) => Approximate,
            (Feature::Instance, Export) => Approximate,
            (Feature::Script | Feature::Embed | Feature::ImportHistory, Export) => Unsupported,
        }
    }

    fn read(&self, _input: &Input<'_>) -> Result<Imported, Error> {
        Err(Error(
            "an app can only be exported; import HTML instead".into(),
        ))
    }

    fn write(&self, _revision: &Revision<'_>, _scope: &Scope) -> Result<Exported, Error> {
        Err(Error("the app export isn't written yet".into()))
    }
}
