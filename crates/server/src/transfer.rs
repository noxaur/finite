//! Imports and exports: the steps between a request and the codecs in
//! `finite-transfer`. The HTTP routes and MCP tools are thin layers over
//! these three functions.
//!
//! An import goes in a fixed order. The bytes are parsed on the blocking
//! pool, without the design's lock. Then they're written to the blob store,
//! durably, before anything points at them. Only then does the design take
//! its lock and create the import's nodes, all or nothing.

use std::sync::Arc;

use finite_design::import::ImportRecord;
use finite_transfer::{Axis, Diagnostic, Exported, Format, Input, Receipt, Revision, violations};

use crate::hub::{Actor, Hub, OpenError, now_ms, random_id};

/// What an import is asked to do.
pub struct ImportRequest {
    pub format: Format,
    pub bytes: Vec<u8>,
    pub file_name: Option<String>,
    /// Strict mode: refuse the import if any diagnostic scores anything but
    /// yes on one of these axes. Empty accepts everything.
    pub strict: Vec<Axis>,
}

/// What an import did.
#[derive(Debug)]
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
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(what) | Self::Invalid(what) => f.write_str(what),
            Self::Io(e) => write!(f, "storage failed: {e}"),
        }
    }
}

impl From<OpenError> for TransferError {
    fn from(e: OpenError) -> Self {
        match e {
            OpenError::NotFound => Self::NotFound("no such design".into()),
            OpenError::Failed(e) => Self::Io(e),
            busy @ OpenError::Busy(_) => Self::Io(std::io::Error::other(busy.to_string())),
        }
    }
}

fn joined<T>(result: Result<T, tokio::task::JoinError>) -> Result<T, TransferError> {
    result.map_err(|e| TransferError::Io(std::io::Error::other(e)))
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
        strict,
    } = request;
    let bytes = Arc::new(bytes);
    let (imported, bytes) = {
        let file_name = file_name.clone();
        joined(
            tokio::task::spawn_blocking(move || {
                let input = Input {
                    bytes: &bytes,
                    file_name: file_name.as_deref(),
                };
                (format.codec().read(&input), bytes)
            })
            .await,
        )?
    };
    let imported = imported.map_err(|e| TransferError::Invalid(e.0))?;
    // Every score is known before placing, so strict mode refuses before
    // anything is stored.
    let pending: Vec<Diagnostic> = imported
        .diagnostics
        .iter()
        .map(|(_, d)| d.clone())
        .collect();
    if let Some(first) = violations(&pending, &strict).first() {
        return Err(TransferError::Invalid(format!(
            "strict import refused: {} at {} ({})",
            first.what, first.path, first.reason
        )));
    }
    let store = hub.store();
    let artifact = joined(tokio::task::spawn_blocking(move || store.put_blob(&bytes)).await)?
        .map_err(TransferError::Io)?;
    let label = match &file_name {
        Some(name) => format!("Import {name}"),
        None => format!("Import {}", format.codec().name()),
    };
    let receipt = Receipt {
        id: random_id(12),
        artifact,
        file_name,
        received_at: now_ms(),
    };
    let ((import, placed), _) = handle
        .import(actor, &label, |tx| {
            let (record, placed) = imported.place(tx, receipt, &mut || random_id(8))?;
            Ok::<_, finite_transfer::Error>((record.clone(), (record, placed)))
        })
        .map_err(|e| TransferError::Invalid(e.0))?;
    Ok(ImportResult {
        import,
        artboards: placed.artboards,
        diagnostics: placed.diagnostics,
    })
}

/// Writes artboard `artboard` of design `id` as `format`. The design's lock
/// is held while the codec writes, so the export reads one revision.
pub async fn export(
    hub: &Arc<Hub>,
    id: &str,
    format: Format,
    artboard: &str,
) -> Result<Exported, TransferError> {
    let handle = hub.open(id).await?;
    let artboard = artboard.to_owned();
    joined(
        tokio::task::spawn_blocking(move || {
            handle.read(|design| {
                let revision = Revision {
                    doc: design.doc(),
                    imports: design.imports(),
                };
                format.codec().write(&revision, &artboard)
            })
        })
        .await,
    )?
    .map_err(|e| TransferError::NotFound(e.0))
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
