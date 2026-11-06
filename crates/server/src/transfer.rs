//! Imports and exports: the steps between a request and the codecs in
//! `finite-transfer`. The HTTP routes and MCP tools are thin layers over
//! these three functions.
//!
//! An import goes in a fixed order. The bytes are parsed on the blocking
//! pool, without the design's lock. Then they're written to the blob store,
//! durably, before anything points at them. Only then does the design take
//! its lock and create the import's nodes, all or nothing.

use std::sync::Arc;

use finite_design::import::{BlobHash, ImportRecord};
use finite_transfer::{
    Axis, Blobs, Diagnostic, Exported, Format, Input, Receipt, Revision, Scope, app::RouterKind,
    violations,
};

use crate::{
    hub::{Actor, Hub, OpenError, now_ms},
    id::{node_id, random_id},
    screenshot,
    store::Store,
};

/// What an import is asked to do.
pub struct ImportRequest {
    pub format: Format,
    pub bytes: Vec<u8>,
    pub file_name: Option<String>,
    /// The page the new artboards go on, or `None` for the first page.
    pub page: Option<String>,
    /// Strict mode: refuse the import if any diagnostic scores anything but
    /// yes on one of these axes. Empty accepts everything.
    pub strict: Vec<Axis>,
}

/// What an import did.
#[derive(Debug, serde::Serialize)]
pub struct ImportResult {
    pub import: ImportRecord,
    pub artboards: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug)]
pub enum TransferError {
    /// No such design, artboard or import.
    NotFound(String),
    /// The input or request is wrong, or strict mode refused it. Nothing changed.
    Invalid(String),
    /// Storage failed. Nothing changed.
    Io(std::io::Error),
    /// The design couldn't be opened here: it lives on another server, or is
    /// moving. Nothing changed.
    Unopened(OpenError),
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(what) | Self::Invalid(what) => f.write_str(what),
            Self::Io(e) => write!(f, "storage failed: {e}"),
            Self::Unopened(e) => e.fmt(f),
        }
    }
}

impl From<OpenError> for TransferError {
    fn from(e: OpenError) -> Self {
        match e {
            OpenError::NotFound => Self::NotFound("no such design".into()),
            OpenError::Failed(e) => Self::Io(e),
            other => Self::Unopened(other),
        }
    }
}

/// The format named `name`, as a route or tool names it.
/// Agents often name a format by its file's extension, like `figma.json`
/// or `.htm`, so those count too.
pub fn format_named(name: &str) -> Result<Format, TransferError> {
    let lower = name.trim().trim_start_matches('.').to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "htm" => "html",
        "figma.json" => "figma",
        other => other,
    };
    Format::named(canonical).ok_or_else(|| {
        let known: Vec<&str> = Format::ALL.iter().map(|f| f.codec().name()).collect();
        TransferError::Invalid(format!(
            "no format {name:?}; use one of {}",
            known.join(", ")
        ))
    })
}

/// The router named `name`, as a route or tool names it.
pub fn router_named(name: &str) -> Result<RouterKind, TransferError> {
    let canonical = name.trim().to_ascii_lowercase();
    RouterKind::named(&canonical).ok_or_else(|| {
        let known: Vec<&str> = RouterKind::ALL.iter().map(|r| r.router().name()).collect();
        TransferError::Invalid(format!(
            "no router {name:?}; use one of {}",
            known.join(", ")
        ))
    })
}

const AXES: [Axis; 3] = [Axis::Preserved, Axis::Visual, Axis::Editable];

/// The axes strict mode holds, from names like `preserved,editable`.
pub fn strict_named<'a>(
    names: impl IntoIterator<Item = &'a str>,
) -> Result<Vec<Axis>, TransferError> {
    let mut axes = Vec::new();
    for name in names.into_iter().flat_map(|n| n.split(',')) {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(axis) = AXES.into_iter().find(|axis| axis.name() == name) else {
            let known: Vec<&str> = AXES.iter().map(|axis| axis.name()).collect();
            return Err(TransferError::Invalid(format!(
                "no strict axis {name:?}; use one of {}",
                known.join(", ")
            )));
        };
        if !axes.contains(&axis) {
            axes.push(axis);
        }
    }
    Ok(axes)
}

/// The stack an import's parser gets. A file nests as deep as a design may,
/// and the deserializers recurse once per level: a Figma payload overflowed
/// Tokio's 2 MiB blocking threads at 120 levels, which aborts the whole
/// server. Untouched stack pages cost nothing.
const DEEP_STACK: usize = 128 << 20;

/// Runs `f` on a thread of its own with [`DEEP_STACK`].
async fn on_deep_stack<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, TransferError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("finite-import".into())
        .stack_size(DEEP_STACK)
        .spawn(move || {
            let _ = tx.send(f());
        })
        .map_err(TransferError::Io)?;
    rx.await
        .map_err(|_| TransferError::Io(std::io::Error::other("the import's parser stopped")))
}

fn joined<T>(result: Result<T, tokio::task::JoinError>) -> Result<T, TransferError> {
    result.map_err(|e| TransferError::Io(std::io::Error::other(e)))
}

/// An import read, checked and stored, ready to place in a transaction
/// with [`Prepared::place`].
pub struct Prepared {
    imported: finite_transfer::Imported,
    format: Format,
    artifact: BlobHash,
    file_name: Option<String>,
    design: String,
}

/// Reads an import's bytes for design `id`, refuses them as strict mode
/// says, and stores them and every file they carry. Nothing points at the
/// stored bytes until the import is placed. It doesn't take the design's lock.
pub async fn prepare(
    hub: &Arc<Hub>,
    id: &str,
    format: Format,
    bytes: Vec<u8>,
    file_name: Option<String>,
    strict: &[Axis],
) -> Result<Prepared, TransferError> {
    let bytes = Arc::new(bytes);
    let (imported, bytes) = {
        let file_name = file_name.clone();
        on_deep_stack(move || {
            let input = Input {
                bytes: &bytes,
                file_name: file_name.as_deref(),
            };
            (format.codec().read(&input), bytes)
        })
        .await?
    };
    let mut imported = imported.map_err(|e| TransferError::Invalid(e.0))?;
    // Every score is known before placing, so strict mode refuses before
    // anything is stored.
    let pending: Vec<Diagnostic> = imported
        .diagnostics
        .iter()
        .map(|(_, d)| d.clone())
        .collect();
    if let Some(first) = violations(&pending, strict).first() {
        return Err(TransferError::Invalid(format!(
            "strict import refused: {} at {} ({})",
            first.what, first.path, first.reason
        )));
    }
    // The bytes and every file the import carries are durable before any
    // node or record points at them.
    let store = hub.store();
    let carried = std::mem::take(&mut imported.blobs);
    let artifact = joined(
        tokio::task::spawn_blocking(move || {
            for blob in &carried {
                store.put_blob(blob)?;
            }
            store.put_blob(&bytes)
        })
        .await,
    )?
    .map_err(TransferError::Io)?;
    Ok(Prepared {
        imported,
        format,
        artifact,
        file_name,
        design: id.to_owned(),
    })
}

impl Prepared {
    /// The label of the change that adds it, like `Import landing.html`.
    pub fn label(&self) -> String {
        match &self.file_name {
            Some(name) => format!("Import {name}"),
            None => format!("Import {}", self.format.codec().name()),
        }
    }

    /// Creates the import's artboards in `tx`, on `page` unless they name
    /// their own, and records the import there.
    pub fn place(
        self,
        tx: &mut finite_design::Transaction<'_>,
        page: Option<String>,
    ) -> Result<ImportResult, finite_transfer::Error> {
        let receipt = Receipt {
            id: random_id(12),
            design: self.design,
            page,
            artifact: self.artifact,
            file_name: self.file_name,
            received_at: now_ms(),
        };
        let (import, placed) = self.imported.place(tx, receipt, &mut node_id)?;
        tx.record_import(import.clone());
        Ok(ImportResult {
            import,
            artboards: placed.artboards,
            diagnostics: placed.diagnostics,
        })
    }
}

/// Imports `request` into design `id` as one undo step for `actor`.
pub async fn import(
    hub: &Arc<Hub>,
    id: &str,
    actor: &Actor,
    request: ImportRequest,
) -> Result<ImportResult, TransferError> {
    let handle = hub.open(id).await?;
    let ImportRequest {
        format,
        bytes,
        file_name,
        page,
        strict,
    } = request;
    let prepared = prepare(hub, id, format, bytes, file_name, &strict).await?;
    let label = prepared.label();
    let (result, _) = handle
        .transact(actor, &label, |tx| prepared.place(tx, page))
        .map_err(|e| TransferError::Invalid(e.0))?;
    Ok(result)
}

/// Writes `scope` of design `id` as `format`, routing an app export with
/// `router`. The design is copied under its lock, so the export reads one
/// revision, and written without it. A codec that measures layout, like
/// Figma's, does it in headless Chrome.
pub async fn export_with(
    hub: &Arc<Hub>,
    id: &str,
    format: Format,
    scope: Scope,
    router: Option<RouterKind>,
) -> Result<Exported, TransferError> {
    let handle = hub.open(id).await?;
    let (name, doc, imports) = handle.read(|design| {
        (
            design.meta.name.clone(),
            design.doc().clone(),
            design.imports().to_vec(),
        )
    });
    let blobs = StoreBlobs(hub.store());
    let measure = screenshot::ChromeMeasure(tokio::runtime::Handle::current());
    joined(
        tokio::task::spawn_blocking(move || {
            let revision = Revision {
                name: &name,
                doc: &doc,
                imports: &imports,
                blobs: &blobs,
                measure: &measure,
            };
            finite_transfer::export_with(format, &revision, &scope, router)
        })
        .await,
    )?
    .map_err(|e| TransferError::Invalid(e.0))
}

/// The store, as the codecs read blobs.
struct StoreBlobs(Arc<dyn Store>);

impl Blobs for StoreBlobs {
    fn get(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>, finite_transfer::Error> {
        self.0
            .get_blob(hash)
            .map_err(|e| finite_transfer::Error(format!("couldn't read a stored file: {e}")))
    }
}

/// The exact bytes import `import_id` received, with its record.
pub async fn original(
    hub: &Arc<Hub>,
    id: &str,
    import_id: &str,
) -> Result<(ImportRecord, Vec<u8>), TransferError> {
    let handle = hub.open(id).await?;
    let record = handle
        .read(|design| design.imports().iter().find(|i| i.id == import_id).cloned())
        .ok_or_else(|| TransferError::NotFound(format!("no import {import_id:?}")))?;
    let store = hub.store();
    let hash = record.artifact.clone();
    let bytes = joined(tokio::task::spawn_blocking(move || store.get_blob(&hash)).await)?
        .map_err(TransferError::Io)?
        .ok_or_else(|| {
            TransferError::Io(std::io::Error::other(format!(
                "import {:?} points at a blob the store doesn't have",
                record.id
            )))
        })?;
    Ok((record, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_go_by_name_or_extension() {
        for name in ["figma", "figma.json", ".figma.json", "FIGMA"] {
            assert_eq!(format_named(name).unwrap(), Format::Figma, "{name}");
        }
        for name in ["html", "htm", ".html"] {
            assert_eq!(format_named(name).unwrap(), Format::Html, "{name}");
        }
        assert_eq!(format_named("repo").unwrap(), Format::Repo);
        assert_eq!(format_named("app").unwrap(), Format::App);
        assert_eq!(format_named("APP").unwrap(), Format::App);
        assert!(format_named("docx").is_err());
    }
}
