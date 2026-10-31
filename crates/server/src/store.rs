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
/// this trait; the hub only ever calls these five methods.
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
    /// Deletes a design's snapshot and journal, after it moved to another server.
    fn remove(&self, id: &str) -> io::Result<()>;
}

/// Two files per design in `<dir>/designs/`: `<id>.json` is the last snapshot,
/// and `<id>.log` is the journal since, one JSON record per line.
///
/// Snapshots go to a temporary file first and are renamed into place, so a
/// crash never leaves a half-written snapshot. A crash mid-append can leave a
/// torn last line; loading stops there, and the hub compacts on startup.
///
/// Only one server may use a data folder at a time. Two servers writing the
/// same files would overwrite each other's edits, so the store holds an
/// exclusive lock on `<dir>/lock` for as long as it's open.
pub struct FileStore {
    dir: PathBuf,
    /// Held for the store's lifetime; the OS releases it if the process dies.
    _lock: fs::File,
}

impl FileStore {
    /// Opens the store, or fails with `WouldBlock` if another server already uses `dir`.
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let root = dir.as_ref();
        fs::create_dir_all(root.join("designs"))?;
        let lock = fs::File::create(root.join("lock"))?;
        if let Err(error) = lock.try_lock() {
            return Err(match error {
                fs::TryLockError::WouldBlock => io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!(
                        "another Finite server is using {}; stop it or set FINITE_DATA_DIR",
                        root.display()
                    ),
                ),
                fs::TryLockError::Error(error) => error,
            });
        }
        Ok(Self {
            dir: root.join("designs"),
            _lock: lock,
        })
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
        if !self.dir.join(format!("{id}.json")).exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "design was never saved",
            ));
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path(id))?;
        file.write_all(&out)?;
        file.sync_data()
    }

    fn remove(&self, id: &str) -> io::Result<()> {
        for path in [self.dir.join(format!("{id}.json")), self.journal_path(id)] {
            match fs::remove_file(path) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
        Ok(())
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

    fn remove(&self, id: &str) -> io::Result<()> {
        self.designs.lock().unwrap().remove(id);
        Ok(())
    }
}

/// The behavior every [`Store`] must have. Run [`contract::check`] against a
/// new implementation, such as a database store, before the hub uses it.
pub mod contract {
    use finite_design::{DesignMeta, Record, Snapshot};

    use super::Store;

    fn snapshot(id: &str, seq: u64) -> Snapshot {
        Snapshot {
            meta: DesignMeta {
                id: id.into(),
                name: format!("Design {id}"),
                created_at: 1,
                updated_at: 2,
            },
            seq,
            nodes: Vec::new(),
            comments: Vec::new(),
        }
    }

    fn rename(id: &str, name: &str) -> Record {
        Record::Meta {
            meta: DesignMeta {
                name: name.into(),
                ..snapshot(id, 0).meta
            },
        }
    }

    fn names(records: &[Record]) -> Vec<String> {
        records
            .iter()
            .map(|r| match r {
                Record::Meta { meta } => meta.name.clone(),
                _ => panic!("unexpected record"),
            })
            .collect()
    }

    /// Panics with a description of the first rule `store` breaks. The store
    /// must start empty.
    pub fn check(store: &dyn Store) {
        assert!(store.ids().unwrap().is_empty(), "a new store is empty");
        assert!(
            store.load("a").unwrap().is_none(),
            "a missing design loads as None"
        );
        assert!(
            store.append("a", &[rename("a", "x")]).is_err(),
            "appending to a design that was never saved fails"
        );

        store.save(&snapshot("a", 3)).unwrap();
        store.save(&snapshot("b", 0)).unwrap();
        let mut ids = store.ids().unwrap();
        ids.sort();
        assert_eq!(ids, ["a", "b"], "ids lists every saved design");
        let a = store.load("a").unwrap().expect("a saved design loads");
        assert_eq!(a.snapshot.seq, 3, "load returns the saved snapshot");
        assert!(a.journal.is_empty(), "a fresh snapshot has no journal");

        store.append("a", &[rename("a", "One")]).unwrap();
        store
            .append("a", &[rename("a", "Two"), rename("a", "Three")])
            .unwrap();
        let journal = store.load("a").unwrap().unwrap().journal;
        assert_eq!(
            names(&journal),
            ["One", "Two", "Three"],
            "the journal keeps append order"
        );
        let b = store.load("b").unwrap().unwrap();
        assert!(b.journal.is_empty(), "journals are per design");

        store.save(&snapshot("a", 9)).unwrap();
        let a = store.load("a").unwrap().unwrap();
        assert_eq!(a.snapshot.seq, 9, "save replaces the snapshot");
        assert!(a.journal.is_empty(), "save clears the journal");

        store.append("a", &[rename("a", "Four")]).unwrap();
        store.remove("a").unwrap();
        assert!(
            store.load("a").unwrap().is_none(),
            "a removed design is gone"
        );
        assert_eq!(store.ids().unwrap(), ["b"], "and no longer listed");
        store.remove("a").unwrap();
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

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("finite-store-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn memory_store_meets_the_contract() {
        contract::check(&MemoryStore::default());
    }

    #[test]
    fn file_store_meets_the_contract() {
        let dir = temp_dir();
        contract::check(&FileStore::new(&dir).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_data_folder_has_one_server_at_a_time() {
        let dir = temp_dir();
        let first = FileStore::new(&dir).unwrap();
        let second = FileStore::new(&dir).err().expect("the folder is locked");
        assert_eq!(second.kind(), io::ErrorKind::WouldBlock);
        drop(first);
        FileStore::new(&dir).expect("the lock is released with the store");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_store_ignores_a_torn_journal_line() {
        let dir = temp_dir();
        let store = FileStore::new(&dir).unwrap();
        store.save(&snapshot()).unwrap();
        store.append("d", &[meta("One"), meta("Two")]).unwrap();
        let load = || store.load("d").unwrap().unwrap();

        // A torn last line, as after a crash mid-append, is ignored.
        let mut log = fs::OpenOptions::new()
            .append(true)
            .open(dir.join("designs/d.log"))
            .unwrap();
        log.write_all(br#"{"type":"me"#).unwrap();
        assert_eq!(load().journal.len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
}
