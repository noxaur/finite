//! The layout check on `edit` results: the note an edit waits for, and what
//! happens to one that isn't ready when the edit answers. These need a
//! browser. Each test sets how long its edits wait with [`common::waiting_app`],
//! so they share a process.

#[path = "../agent/mod.rs"]
mod agent;
mod check;
mod common;
mod components;
mod deferred;
mod fixed;
mod note;
