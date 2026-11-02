//! Moves designs in and out of Finite.
//!
//! Each format is a [`Codec`] that converts between that format and Finite's
//! own [`Document`], so the document is the hub and no codec knows about
//! another. Importing happens in two steps:
//!
//! 1. [`Codec::read`] parses the bytes into an [`Imported`], with no design
//!    and no lock: just artboards to create and what couldn't be kept.
//! 2. [`Imported::place`] creates them inside [`Design::import`], which
//!    applies everything or nothing.
//!
//! Nothing is ever thrown away. The caller stores the bytes it received,
//! and the design's [`ImportRecord`] points at them, so the original can
//! always be downloaded again. Content that could run code is quarantined:
//! it never enters the document, only the record of where it was.
//!
//! To add a format, add a [`Format`] variant and a module with its codec.
//! To add something a design can contain, add a [`Feature`]. Either way the
//! compiler lists every place that needs an answer.
//!
//! This crate has no I/O, like `finite-design`.
//!
//! [`Design::import`]: finite_design::Design::import

pub mod assets;
mod feature;
pub mod figma;
pub mod finite;
mod html;
mod report;
pub mod scene;

use std::collections::BTreeMap;

use finite_design::{
    Document, NodeId, Op, Rejected, Transaction,
    edit::{self, EditError, NewArtboard},
    html::Fragment,
    import::{BlobHash, Dependency, ImportRecord, Quarantined},
};

pub use feature::{Direction, Feature, Support};
pub use report::{Axis, Diagnostic, Score, violations};

/// A format Finite reads or writes. This enum is the registry: each
/// variant names its codec in [`Format::codec`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Html,
    /// A `.finite` bundle.
    Finite,
    /// A `.figma.json` file from or for the Finite Figma plugin.
    Figma,
}

impl Format {
    pub const ALL: [Format; 3] = [Format::Html, Format::Finite, Format::Figma];

    pub fn codec(self) -> &'static dyn Codec {
        match self {
            Format::Html => &html::Html,
            Format::Finite => &finite::Finite,
            Format::Figma => &figma::Figma,
        }
    }

    /// The format named `name`, as in an `?format=` query.
    pub fn named(name: &str) -> Option<Format> {
        Self::ALL.into_iter().find(|f| f.codec().name() == name)
    }
}

/// Converts between one format and Finite's document.
pub trait Codec: Sync {
    /// Short and lowercase, like `html`. Stored in each [`ImportRecord`].
    fn name(&self) -> &'static str;

    /// What this codec does with `feature` going `direction`. Write it as a
    /// `match` with no wildcard arm, so a new feature needs an answer.
    fn support(&self, feature: Feature, direction: Direction) -> Support;

    /// Parses the bytes of an import.
    fn read(&self, input: &Input<'_>) -> Result<Imported, Error>;

    /// Writes `scope` of `revision` in this format.
    fn write(&self, revision: &Revision<'_>, scope: &Scope) -> Result<Exported, Error>;
}

/// What an export covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The whole design.
    Design,
    /// One artboard, by id.
    Artboard(NodeId),
}

/// The bytes of an import, as received.
pub struct Input<'a> {
    pub bytes: &'a [u8],
    pub file_name: Option<&'a str>,
}

/// A design at one moment, for an export to read. The caller copies it
/// under the design's lock, so everything in it agrees, and the export runs
/// without the lock.
pub struct Revision<'a> {
    pub name: &'a str,
    pub doc: &'a Document,
    pub imports: &'a [ImportRecord],
    /// Where to read the files the design's nodes point to.
    pub blobs: &'a dyn Blobs,
    /// Measures how artboards render, for formats without CSS.
    pub measure: &'a dyn scene::Measure,
}

/// Reads blobs for an export. The server's store implements it.
pub trait Blobs: Sync {
    fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, Error>;
}

/// No blobs at all, for designs that point at none.
pub struct NoBlobs;

impl Blobs for NoBlobs {
    fn get(&self, _hash: &BlobHash) -> Result<Option<Vec<u8>>, Error> {
        Ok(None)
    }
}

impl Revision<'_> {
    /// The artboards `scope` covers, in canvas order.
    pub fn artboards(&self, scope: &Scope) -> Result<Vec<&finite_design::Node>, Error> {
        match scope {
            Scope::Design => Ok(self.doc.artboards()),
            Scope::Artboard(id) => self
                .doc
                .get(id)
                .filter(|n| n.is_artboard())
                .map(|board| vec![board])
                .ok_or_else(|| Error(format!("{id:?} isn't an artboard"))),
        }
    }
}

/// An export: one file, and what didn't carry over.
#[derive(Debug)]
pub struct Exported {
    pub file_name: String,
    pub media_type: &'static str,
    pub bytes: Vec<u8>,
    pub diagnostics: Vec<Diagnostic>,
}

/// A parsed import, not yet in any design.
#[derive(Debug)]
pub struct Imported {
    /// The codec that read it.
    pub format: &'static str,
    /// Precisely what the bytes were, like `html` or `figma-plugin-payload v1`.
    pub input_kind: String,
    pub boards: Vec<Board>,
    /// Pages the import brings, by name, in order. Each one the design
    /// doesn't have by that name is created, even if no board goes on it.
    pub pages: Vec<String>,
    /// Shared CSS to add after the design's own.
    pub css: Option<String>,
    /// Files the import carries, like a bundle's images. The caller stores
    /// them before placing, and the content refers to them as
    /// [`assets::SCHEME`] references.
    pub blobs: Vec<Vec<u8>>,
    pub dependencies: Vec<Dependency>,
    /// Each with where it belongs, which [`Imported::place`] turns into a node.
    pub diagnostics: Vec<(Anchor, Diagnostic)>,
}

/// One artboard to create, with its content.
#[derive(Debug, Default)]
pub struct Board {
    pub name: String,
    pub width: f64,
    pub height: f64,
    /// Where on the canvas, or `None` to place it beside the others.
    pub position: Option<(f64, f64)>,
    /// The name of the page it goes on, or `None` for the import's page.
    pub page: Option<String>,
    /// The artboard's own styles, over the defaults every artboard starts with.
    pub styles: BTreeMap<String, String>,
    pub attrs: BTreeMap<String, String>,
    pub content: Vec<Fragment>,
    /// Where the board came from in the source, in the codec's notation,
    /// if it came from anything.
    pub source: Option<String>,
    /// Where each content node came from, numbered like [`Anchor::node`].
    pub paths: Vec<String>,
}

/// Where a diagnostic belongs before its nodes have ids: a board, and a node
/// inside it numbered in the order [`Fragment::create_ops`] creates them
/// (`None` for the board itself).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub board: usize,
    pub node: Option<usize>,
}

/// What the caller knows about an import that the codec doesn't.
pub struct Receipt {
    pub id: String,
    /// The design it goes into, for the URLs of its blobs.
    pub design: String,
    /// The page boards go on unless they name their own, or `None` for the first page.
    pub page: Option<String>,
    /// Where the caller stored the bytes. They must be durable before
    /// [`Imported::place`] runs, since the record will point at them.
    pub artifact: BlobHash,
    pub file_name: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub received_at: u64,
}

/// An import once it's in a design.
#[derive(Debug)]
pub struct Placed {
    pub artboards: Vec<NodeId>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Imported {
    /// Creates the import's artboards in `tx`, one after another so each is
    /// placed clear of the last, and returns its record. Meant to run inside
    /// [`finite_design::Design::import`], which undoes everything if this fails.
    pub fn place(
        self,
        tx: &mut Transaction<'_>,
        receipt: Receipt,
        new_id: &mut impl FnMut() -> NodeId,
    ) -> Result<(ImportRecord, Placed), Error> {
        if let Some(page) = &receipt.page
            && tx.doc().page(page).is_none()
        {
            return Err(Error(format!("the design has no page {page:?}")));
        }
        for name in &self.pages {
            page_named(tx, name, new_id)?;
        }
        let mut boards: Vec<(NodeId, Vec<NodeId>)> = Vec::new();
        let mut nodes = BTreeMap::new();
        let resolve = |value: &mut String| {
            if value.contains(assets::SCHEME) {
                *value = assets::resolve(value, &receipt.design);
            }
        };
        for mut board in self.boards {
            let mut resolve = resolve;
            board.styles.values_mut().for_each(&mut resolve);
            board.attrs.values_mut().for_each(&mut resolve);
            assets::for_each_value(&mut board.content, &mut resolve);
            let page = match board.page.take() {
                Some(name) => Some(page_named(tx, &name, new_id)?),
                None => receipt.page.clone(),
            };
            let id = new_id();
            let mut content = Vec::new();
            let mut numbered = || {
                let id = new_id();
                content.push(id.clone());
                id
            };
            let spec = NewArtboard {
                name: board.name,
                width: board.width,
                height: Some(board.height),
                position: board.position,
                page,
                styles: board.styles,
            };
            let (mut ops, _) = edit::create_artboard_with(
                tx.doc(),
                id.clone(),
                spec,
                board.content,
                &mut numbered,
            )?;
            if let Some(Op::Create { node }) = ops.first_mut() {
                node.attrs.extend(board.attrs);
            }
            tx.apply(&ops)?;
            if let Some(source) = board.source {
                nodes.insert(id.clone(), source);
            }
            nodes.extend(content.iter().cloned().zip(board.paths));
            boards.push((id, content));
        }
        if let Some(css) = self.css.filter(|css| !css.trim().is_empty()) {
            let mut css = assets::resolve(&css, &receipt.design);
            if let Some(existing) = tx.doc().css() {
                css = format!("{existing}\n\n{css}");
            }
            tx.apply(&edit::set_css(&css)?)?;
        }
        let mut quarantined = Vec::new();
        let diagnostics: Vec<Diagnostic> = self
            .diagnostics
            .into_iter()
            .map(|(anchor, mut diagnostic)| {
                diagnostic.node = boards.get(anchor.board).map(|(board, content)| {
                    anchor
                        .node
                        .and_then(|n| content.get(n))
                        .unwrap_or(board)
                        .clone()
                });
                if diagnostic.quarantined {
                    quarantined.push(Quarantined {
                        node: diagnostic.node.clone(),
                        path: diagnostic.path.clone(),
                        what: diagnostic.what.clone(),
                        reason: diagnostic.reason.clone(),
                    });
                }
                diagnostic
            })
            .collect();
        let record = ImportRecord {
            id: receipt.id,
            artifact: receipt.artifact,
            format: self.format.to_owned(),
            input_kind: self.input_kind,
            file_name: receipt.file_name,
            received_at: receipt.received_at,
            nodes,
            dependencies: self.dependencies,
            quarantined,
        };
        let artboards = boards.into_iter().map(|(id, _)| id).collect();
        Ok((
            record,
            Placed {
                artboards,
                diagnostics,
            },
        ))
    }
}

/// The id of the page named `name`, created after the others if the design
/// has none by that name.
fn page_named(
    tx: &mut Transaction<'_>,
    name: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<String, Error> {
    if let Some((id, _)) = tx.doc().pages().into_iter().find(|(_, p)| p.name == name) {
        return Ok(id.to_owned());
    }
    let id = format!("page-{}", new_id());
    let ops = edit::create_page(tx.doc(), id.clone(), name)?;
    tx.apply(&ops)?;
    Ok(id)
}

/// Why an import or export failed. Nothing was changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<EditError> for Error {
    fn from(e: EditError) -> Self {
        Self(e.0)
    }
}

impl From<Rejected> for Error {
    fn from(e: Rejected) -> Self {
        Self(e.to_string())
    }
}

/// The file name for an export of `name`: letters, digits and dashes, so
/// it's safe in a `Content-Disposition` header and on any disk.
pub fn file_stem(name: &str) -> String {
    let mut stem = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            stem.push(c.to_ascii_lowercase());
        } else if !stem.ends_with('-') && !stem.is_empty() {
            stem.push('-');
        }
    }
    let stem = stem.trim_end_matches('-');
    if stem.is_empty() {
        "design".into()
    } else {
        stem.into()
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    /// `SUPPORT.md` is the support table, generated from every codec's
    /// `support`, with columns padded the way `vp check` formats Markdown.
    /// Regenerate it with `FINITE_UPDATE_FIXTURES=1`.
    #[test]
    fn support_table_is_current() {
        let mut rows = vec![vec!["Feature".to_owned()]];
        for format in Format::ALL {
            let name = format.codec().name();
            rows[0].push(format!("{name} import"));
            rows[0].push(format!("{name} export"));
        }
        for feature in Feature::ALL {
            let mut row = vec![feature.name().to_owned()];
            for format in Format::ALL {
                for direction in [Direction::Import, Direction::Export] {
                    let support = format.codec().support(feature, direction);
                    row.push(format!("{support:?}").to_lowercase());
                }
            }
            rows.push(row);
        }
        let widths: Vec<usize> = (0..rows[0].len())
            .map(|i| rows.iter().map(|r| r[i].len()).max().unwrap_or(0))
            .collect();
        let line = |cells: Vec<String>| {
            let cells: Vec<String> = cells
                .iter()
                .zip(&widths)
                .map(|(c, w)| format!("{c:w$}"))
                .collect();
            format!("| {} |\n", cells.join(" | "))
        };
        let mut table = String::from(
            "# What each format supports\n\nGenerated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.\n\n",
        );
        let mut rows = rows.into_iter();
        table.push_str(&line(rows.next().unwrap()));
        table.push_str(&line(widths.iter().map(|w| "-".repeat(*w)).collect()));
        for row in rows {
            table.push_str(&line(row));
        }
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("SUPPORT.md");
        if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
            fs::write(&path, &table).unwrap();
            return;
        }
        let saved = fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            saved, table,
            "SUPPORT.md is stale: run with FINITE_UPDATE_FIXTURES=1"
        );
    }

    #[test]
    fn formats_are_found_by_name() {
        for format in Format::ALL {
            assert_eq!(Format::named(format.codec().name()), Some(format));
        }
        assert_eq!(Format::named("nope"), None);
    }

    #[test]
    fn file_stems_are_safe() {
        assert_eq!(file_stem("Home — Desktop 2"), "home-desktop-2");
        assert_eq!(file_stem("../../etc"), "etc");
        assert_eq!(file_stem("✨"), "design");
    }
}
