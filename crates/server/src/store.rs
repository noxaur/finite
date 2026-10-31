use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use finite_design::{Record, Snapshot};

/// A design as stored: its last snapshot, plus the journal of records since.
/// Replay the journal onto the snapshot with `Design::replay`.
pub struct Stored {
    pub snapshot: Snapshot,
    pub journal: Vec<Record>,
}

/// Where designs persist. Swap the file store for a database by implementing
/// this trait; the hub only ever calls these four methods.
///
/// Saving is a write-ahead journal with compaction. After each burst of edits
/// the hub appends the new records with [`Store::append`], which is cheap
/// however large the design is. Now and then it writes a full snapshot with
/// [`Store::save`], which replaces the journal.
pub trait Store: Send + Sync + 'static {
    /// The id of every stored design.
    fn ids(&self) -> io::Result<Vec<String>>;
    /// One design, or `None` if it isn't stored.
    fn load(&self, id: &str) -> io::Result<Option<Stored>>;
    /// Writes a full snapshot and clears the design's journal.
    fn save(&self, snapshot: &Snapshot) -> io::Result<()>;
    /// Adds records to the design's journal. The design must have been saved once.
    fn append(&self, id: &str, records: &[Record]) -> io::Result<()>;
}

/// Two files per design in `<dir>/designs/`: `<id>.json` is the last snapshot,
/// and `<id>.log` is the journal since, one JSON record per line.
///
/// Snapshots go to a temporary file first and are renamed into place, so a
/// crash never leaves a half-written snapshot. A crash mid-append can leave a
/// torn last line; loading stops there, and the hub compacts on startup.
pub struct FileStore {
    dir: PathBuf,
}

impl FileStore {
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().join("designs");
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn journal_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.log"))
    }

    fn read_journal(&self, id: &str) -> io::Result<Vec<Record>> {
        let file = match fs::File::open(self.journal_path(id)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut records = Vec::new();
        for line in io::BufReader::new(file).lines() {
            match serde_json::from_str(&line?) {
                Ok(record) => records.push(record),
                Err(error) => {
                    tracing::warn!(id, %error, "journal ends in a torn record; ignoring the rest");
                    break;
                }
            }
        }
        Ok(records)
    }
}

impl Store for FileStore {
    fn ids(&self) -> io::Result<Vec<String>> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|ext| ext == "json")
                && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
            {
                ids.push(stem.to_owned());
            }
        }
        Ok(ids)
    }

    fn load(&self, id: &str) -> io::Result<Option<Stored>> {
        let path = self.dir.join(format!("{id}.json"));
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let snapshot: Snapshot = match serde_json::from_slice(&bytes) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::warn!(?path, %error, "skipping unreadable design");
                return Ok(None);
            }
        };
        let journal = self.read_journal(id)?;
        Ok(Some(Stored { snapshot, journal }))
    }

    fn save(&self, snapshot: &Snapshot) -> io::Result<()> {
        let path = self.dir.join(format!("{}.json", snapshot.meta.id));
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(snapshot)?)?;
        fs::rename(tmp, path)?;
        // If this fails or we crash first, the old journal replays harmlessly:
        // see `Record`.
        match fs::remove_file(self.journal_path(&snapshot.meta.id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    fn append(&self, id: &str, records: &[Record]) -> io::Result<()> {
        let mut out = Vec::new();
        for record in records {
            serde_json::to_writer(&mut out, record)?;
            out.push(b'\n');
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path(id))?;
        file.write_all(&out)?;
        file.sync_data()
    }
}

/// Keeps designs in memory. Used by tests.
#[derive(Default)]
pub struct MemoryStore {
    designs: Mutex<HashMap<String, (Snapshot, Vec<Record>)>>,
}

impl MemoryStore {
    /// How many records the design's journal holds.
    pub fn journal_len(&self, id: &str) -> usize {
        self.designs
            .lock()
            .unwrap()
            .get(id)
            .map_or(0, |d| d.1.len())
    }
}

impl Store for MemoryStore {
    fn ids(&self) -> io::Result<Vec<String>> {
        Ok(self.designs.lock().unwrap().keys().cloned().collect())
    }

    fn load(&self, id: &str) -> io::Result<Option<Stored>> {
        let designs = self.designs.lock().unwrap();
        Ok(designs.get(id).map(|(snapshot, journal)| Stored {
            snapshot: snapshot.clone(),
            journal: journal.clone(),
        }))
    }

    fn save(&self, snapshot: &Snapshot) -> io::Result<()> {
        let mut designs = self.designs.lock().unwrap();
        designs.insert(snapshot.meta.id.clone(), (snapshot.clone(), Vec::new()));
        Ok(())
    }

    fn append(&self, id: &str, records: &[Record]) -> io::Result<()> {
        let mut designs = self.designs.lock().unwrap();
        let (_, journal) = designs
            .get_mut(id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "design was never saved"))?;
        journal.extend_from_slice(records);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use finite_design::DesignMeta;

    fn snapshot() -> Snapshot {
        Snapshot {
            meta: DesignMeta {
                id: "d".into(),
                name: "Test".into(),
                created_at: 0,
                updated_at: 0,
            },
            seq: 0,
            nodes: Vec::new(),
            comments: Vec::new(),
        }
    }

    fn meta(name: &str) -> Record {
        Record::Meta {
            meta: DesignMeta {
                name: name.into(),
                ..snapshot().meta
            },
        }
    }

    #[test]
    fn file_store_appends_and_compacts() {
        let dir = std::env::temp_dir().join(format!("finite-store-{}", uuid::Uuid::new_v4()));
        let store = FileStore::new(&dir).unwrap();
        store.save(&snapshot()).unwrap();
        store.append("d", &[meta("One")]).unwrap();
        store.append("d", &[meta("Two")]).unwrap();
        let load = || store.load("d").unwrap().unwrap();
        assert_eq!(store.ids().unwrap(), ["d"]);
        assert_eq!(load().journal.len(), 2);

        // A torn last line, as after a crash mid-append, is ignored.
        let mut log = fs::OpenOptions::new()
            .append(true)
            .open(dir.join("designs/d.log"))
            .unwrap();
        log.write_all(br#"{"type":"me"#).unwrap();
        assert_eq!(load().journal.len(), 2);

        // Saving a snapshot clears the journal.
        store.save(&snapshot()).unwrap();
        assert!(load().journal.is_empty());
        assert!(store.load("missing").unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
