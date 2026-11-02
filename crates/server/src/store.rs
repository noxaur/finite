use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use finite_design::{
    Record, Snapshot,
    version::{self, VersionError},
};

use crate::{
    blob::{self, BlobHash},
    hub::is_design_id,
};

/// A design as stored: its last snapshot, plus the journal of records since.
/// Replay the journal onto the snapshot with `Design::replay`.
pub struct Stored {
    pub snapshot: Snapshot,
    pub journal: Vec<Record>,
}

/// A fencing token: a number the store raises each time a server takes a
/// design's lease. Every write carries the token its server got, and the
/// store refuses a write whose token is no longer the latest. So a server
/// that lost a design, say while it was paused, can't overwrite the edits of
/// the server that took over.
pub type Token = u64;

/// What [`Store::claim`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    /// This server holds the design's lease now. Write with this token.
    Granted(Token),
    /// Another live server holds the lease. This is its base URL.
    Held(String),
    /// No such design.
    Missing,
}

/// The error a write gets when its token is out of date: another server
/// took the design's lease since this one got it.
#[derive(Debug)]
pub struct Fenced;

impl std::fmt::Display for Fenced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("another server took over this design")
    }
}

impl std::error::Error for Fenced {}

pub fn fenced() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, Fenced)
}

/// Whether a write failed because its fencing token is out of date.
pub fn is_fenced(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|e| e.is::<Fenced>())
}

/// A snapshot as stored, with its version first (see [`finite_design::version`]).
pub fn encode_snapshot(snapshot: &Snapshot) -> io::Result<String> {
    Ok(version::SNAPSHOT.encode(snapshot)?)
}

/// A journal record as stored, with its version first.
pub fn encode_record(record: &Record) -> io::Result<String> {
    Ok(version::RECORD.encode(record)?)
}

/// Reads a stored snapshot. `Ok(None)` when it isn't JSON a snapshot could
/// be, which the store skips as before. A snapshot from a newer server, or
/// one an upgrade refused, is an error instead: skipping it would let this
/// server treat the design as missing and write over it.
pub fn decode_snapshot(json: &str) -> io::Result<Option<Snapshot>> {
    match version::SNAPSHOT.decode(json) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(VersionError::Json(_)) => Ok(None),
        Err(error) => Err(io::Error::other(error)),
    }
}

/// Reads a stored journal record. `Ok(None)` for a torn or garbled record,
/// where reading stops. A record from a newer server is an error, for the
/// same reason as in [`decode_snapshot`]: stopping there would lose it at
/// the next compaction.
pub fn decode_record(json: &str) -> io::Result<Option<Record>> {
    match version::RECORD.decode(json) {
        Ok(record) => Ok(Some(record)),
        Err(VersionError::Json(_)) => Ok(None),
        Err(error) => Err(io::Error::other(error)),
    }
}

/// Where designs persist. The hub only ever calls these methods.
///
/// Saving is a write-ahead journal with compaction. After each burst of edits
/// the hub appends the new records with [`Store::append`], which is cheap
/// however large the design is. Now and then it writes a full snapshot with
/// [`Store::save`], which replaces the journal.
///
/// Several servers can share one store, like the Postgres store
/// (`postgres::PgStore`, built with the `postgres` feature).
/// Then a server takes a design's lease with [`Store::claim`] before it loads
/// it, and every write carries the fencing token it got. A store only one
/// server uses, like [`FileStore`], can keep the defaults: its claims always
/// succeed, and it ignores tokens.
pub trait Store: Send + Sync + 'static {
    /// The id of every stored design.
    fn ids(&self) -> io::Result<Vec<String>>;
    /// One design, or `None` if it isn't stored.
    fn load(&self, id: &str) -> io::Result<Option<Stored>>;
    /// Writes a full snapshot and clears the design's journal. Fails with
    /// [`Fenced`] if `token` is out of date.
    fn save(&self, snapshot: &Snapshot, token: Token) -> io::Result<()>;
    /// Adds records to the design's journal. The design must have been saved
    /// once. Fails with [`Fenced`] if `token` is out of date.
    fn append(&self, id: &str, records: &[Record], token: Token) -> io::Result<()>;
    /// Deletes a design's snapshot and journal, after it moved to another server.
    fn remove(&self, id: &str) -> io::Result<()>;

    /// Stores a blob and returns its hash. Putting bytes that are already
    /// stored changes nothing. The blob is durable when this returns. Fails
    /// with `InvalidInput` for more than [`blob::MAX_BLOB`] bytes.
    ///
    /// Blobs belong to no design and are shared by all of them. They never
    /// change, so they need no fencing token, and nothing deletes them yet.
    fn put_blob(&self, bytes: &[u8]) -> io::Result<BlobHash>;
    /// A blob's bytes, or `None` if it isn't stored.
    fn get_blob(&self, hash: &BlobHash) -> io::Result<Option<Vec<u8>>>;
    /// Whether a blob is stored.
    fn has_blob(&self, hash: &BlobHash) -> io::Result<bool>;

    /// Reserves a new design's id and takes its lease, or `None` if a design
    /// already has that id. The snapshot may not be stored until the first
    /// [`Store::save`].
    fn create(&self, _snapshot: &Snapshot) -> io::Result<Option<Token>> {
        Ok(Some(0))
    }
    /// Takes a design's lease for this server, unless another live server
    /// holds it.
    fn claim(&self, _id: &str) -> io::Result<Claim> {
        Ok(Claim::Granted(0))
    }
    /// Gives up a lease, so another server can claim the design at once.
    /// The token stops working. Does nothing if `token` is out of date.
    fn release(&self, _id: &str, _token: Token) -> io::Result<()> {
        Ok(())
    }
    /// Every design whose lease this server holds, with its token.
    fn held(&self) -> io::Result<Vec<(String, Token)>> {
        Ok(Vec::new())
    }
}

/// Who's in a cluster whose servers share a store. Each server records a
/// **heartbeat** every so often. A server whose last heartbeat is older than
/// the lease (`FINITE_LEASE_MS`) counts as gone, and its designs move to the
/// others.
pub trait Registry: Send + Sync + 'static {
    /// Records that this server is alive, joining if it hasn't yet.
    fn heartbeat(&self) -> io::Result<()>;
    /// The base URLs of every live server, sorted.
    fn live(&self) -> io::Result<Vec<String>>;
    /// Leaves the cluster, so the others take over this server's designs at once.
    fn leave(&self) -> io::Result<()>;
}

/// Two files per design in `<dir>/designs/`: `<id>.json` is the last snapshot,
/// and `<id>.log` is the journal since, one JSON record per line. A blob is
/// one file, `<dir>/blobs/<first two digits of its hash>/<hash>`.
///
/// Snapshots go to a temporary file first and are renamed into place, so a
/// crash never leaves a half-written snapshot, and blobs the same way. A crash mid-append can leave a
/// torn last line; loading stops there, and the hub compacts on startup.
///
/// Only one server may use a data folder at a time. Two servers writing the
/// same files would overwrite each other's edits, so the store holds an
/// exclusive lock on `<dir>/lock` for as long as it's open.
pub struct FileStore {
    dir: PathBuf,
    blobs: PathBuf,
    /// Held for the store's lifetime; the OS releases it if the process dies.
    _lock: fs::File,
}

/// [`FileStore::sync_dir`] for any directory.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

impl FileStore {
    /// Opens the store, or fails with `WouldBlock` if another server already uses `dir`.
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let root = dir.as_ref();
        fs::create_dir_all(root.join("designs"))?;
        fs::create_dir_all(root.join("blobs"))?;
        sync_dir(root)?;
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
        let store = Self {
            dir: root.join("designs"),
            blobs: root.join("blobs"),
            _lock: lock,
        };
        store.remove_leftovers()?;
        Ok(store)
    }

    /// Deletes temporary snapshots and blobs a crash left mid-save. Holding
    /// the lock means no other server is writing one right now.
    fn remove_leftovers(&self) -> io::Result<()> {
        for entry in fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.to_str().is_some_and(|p| p.ends_with(".json.tmp")) {
                tracing::info!(?path, "removing a snapshot left half-written by a crash");
                fs::remove_file(path)?;
            }
        }
        for shard in fs::read_dir(&self.blobs)? {
            for entry in fs::read_dir(shard?.path())? {
                let path = entry?.path();
                if path.extension().is_some_and(|ext| ext == "tmp") {
                    tracing::info!(?path, "removing a blob left half-written by a crash");
                    fs::remove_file(path)?;
                }
            }
        }
        Ok(())
    }

    /// Makes the directory's entries (new, renamed and deleted files)
    /// durable. Without it, a rename can reach the disk before the file it
    /// points to, or not at all. Windows can't open a directory as a file and
    /// doesn't need this, so it's a no-op there.
    fn sync_dir(&self) -> io::Result<()> {
        sync_dir(&self.dir)
    }

    /// The file a blob is kept in. A hash is only hex digits, so it can't
    /// name a file outside the store.
    fn blob_path(&self, hash: &BlobHash) -> PathBuf {
        self.blobs.join(&hash.as_str()[..2]).join(hash.as_str())
    }

    /// The file `id` keeps with this extension. Ids come from requests, so
    /// one that isn't a design id is refused here: `../x` would name a file
    /// outside the store.
    fn path(&self, id: &str, extension: &str) -> io::Result<PathBuf> {
        if !is_design_id(id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{id:?} isn't a design id"),
            ));
        }
        Ok(self.dir.join(format!("{id}.{extension}")))
    }

    fn journal_path(&self, id: &str) -> io::Result<PathBuf> {
        self.path(id, "log")
    }

    fn read_journal(&self, id: &str) -> io::Result<Vec<Record>> {
        let file = match fs::File::open(self.journal_path(id)?) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut records = Vec::new();
        for line in io::BufReader::new(file).lines() {
            match decode_record(&line?)? {
                Some(record) => records.push(record),
                None => {
                    tracing::warn!(id, "journal ends in a torn record; ignoring the rest");
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
        let path = self.path(id, "json")?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(snapshot) = std::str::from_utf8(&bytes)
            .ok()
            .map(decode_snapshot)
            .transpose()?
            .flatten()
        else {
            tracing::warn!(?path, "skipping unreadable design");
            return Ok(None);
        };
        let journal = self.read_journal(id)?;
        Ok(Some(Stored { snapshot, journal }))
    }

    /// The order matters after a power cut, not just a crash: the snapshot's
    /// bytes reach the disk before the rename does, and the rename before the
    /// old journal is deleted. Otherwise the disk could end up with an empty
    /// snapshot and no journal.
    fn save(&self, snapshot: &Snapshot, _token: Token) -> io::Result<()> {
        let path = self.path(&snapshot.meta.id, "json")?;
        let tmp = path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp)?;
        file.write_all(encode_snapshot(snapshot)?.as_bytes())?;
        file.sync_all()?;
        fs::rename(tmp, path)?;
        self.sync_dir()?;
        // If this fails or we crash first, the old journal replays harmlessly:
        // see `Record`.
        match fs::remove_file(self.journal_path(&snapshot.meta.id)?) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    fn append(&self, id: &str, records: &[Record], _token: Token) -> io::Result<()> {
        let mut out = Vec::new();
        for record in records {
            out.extend_from_slice(encode_record(record)?.as_bytes());
            out.push(b'\n');
        }
        if !self.path(id, "json")?.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "design was never saved",
            ));
        }
        let path = self.journal_path(id)?;
        let new = !path.exists();
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        file.write_all(&out)?;
        file.sync_data()?;
        // A new file's name is in the directory, which needs its own sync.
        if new {
            self.sync_dir()?;
        }
        Ok(())
    }

    fn remove(&self, id: &str) -> io::Result<()> {
        for path in [
            self.path(id, "json")?,
            self.journal_path(id)?,
            self.path(id, "json.tmp")?,
        ] {
            match fs::remove_file(path) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
        Ok(())
    }

    /// Written like a snapshot: to a temporary file, synced, renamed into
    /// place, and then the folders synced. A file that's there already was
    /// written that way, so it's whole, but another thread may have renamed it
    /// a moment ago, so the folder is synced either way.
    fn put_blob(&self, bytes: &[u8]) -> io::Result<BlobHash> {
        let hash = blob::accept(bytes)?;
        let path = self.blob_path(&hash);
        let shard = path.parent().expect("a blob is in a folder");
        if !path.try_exists()? {
            fs::create_dir_all(shard)?;
            let tmp = shard.join(format!("{hash}.{}.tmp", uuid::Uuid::new_v4()));
            let mut file = fs::File::create(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(tmp, &path)?;
        }
        sync_dir(shard)?;
        sync_dir(&self.blobs)?;
        Ok(hash)
    }

    fn get_blob(&self, hash: &BlobHash) -> io::Result<Option<Vec<u8>>> {
        match fs::read(self.blob_path(hash)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn has_blob(&self, hash: &BlobHash) -> io::Result<bool> {
        self.blob_path(hash).try_exists()
    }
}

/// Keeps designs in memory. Used by tests.
///
/// A `MemoryStore` stands for one server's connection to a store.
/// [`MemoryStore::node`] opens another connection to the same designs, the
/// way a second server opens the same database. So tests can run several
/// servers in one process, and this store fences writes and keeps heartbeats
/// the way a shared store must.
pub struct MemoryStore {
    shared: Arc<Mutex<Shared>>,
    /// This server's base URL. Empty for a store with one server.
    me: String,
}

struct Shared {
    designs: HashMap<String, Entry>,
    blobs: HashMap<BlobHash, Vec<u8>>,
    heartbeats: HashMap<String, Instant>,
    /// How long a heartbeat counts.
    lease: Duration,
}

struct Entry {
    snapshot: Snapshot,
    journal: Vec<Record>,
    holder: Option<String>,
    epoch: Token,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::with_lease(Duration::from_secs(10))
    }
}

impl MemoryStore {
    /// An empty store whose servers count as gone `lease` after their last heartbeat.
    pub fn with_lease(lease: Duration) -> Self {
        let shared = Shared {
            designs: HashMap::new(),
            blobs: HashMap::new(),
            heartbeats: HashMap::new(),
            lease,
        };
        Self {
            shared: Arc::new(Mutex::new(shared)),
            me: String::new(),
        }
    }

    /// Another connection to the same designs, for the server at `url`.
    pub fn node(&self, url: &str) -> Self {
        Self {
            shared: self.shared.clone(),
            me: url.to_owned(),
        }
    }

    /// How many records the design's journal holds.
    pub fn journal_len(&self, id: &str) -> usize {
        self.shared
            .lock()
            .unwrap()
            .designs
            .get(id)
            .map_or(0, |d| d.journal.len())
    }

    fn lock(&self) -> io::Result<std::sync::MutexGuard<'_, Shared>> {
        Ok(self.shared.lock().unwrap())
    }
}

impl Shared {
    fn alive(&self, url: &str) -> bool {
        self.heartbeats
            .get(url)
            .is_some_and(|at| at.elapsed() < self.lease)
    }

    /// The design, if `token` is its latest.
    fn fenced(&mut self, id: &str, token: Token) -> io::Result<&mut Entry> {
        let entry = self
            .designs
            .get_mut(id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "design was never saved"))?;
        if entry.epoch != token {
            return Err(fenced());
        }
        Ok(entry)
    }
}

impl Store for MemoryStore {
    fn ids(&self) -> io::Result<Vec<String>> {
        Ok(self.lock()?.designs.keys().cloned().collect())
    }

    fn load(&self, id: &str) -> io::Result<Option<Stored>> {
        Ok(self.lock()?.designs.get(id).map(|entry| Stored {
            snapshot: entry.snapshot.clone(),
            journal: entry.journal.clone(),
        }))
    }

    fn save(&self, snapshot: &Snapshot, token: Token) -> io::Result<()> {
        let mut shared = self.lock()?;
        let id = &snapshot.meta.id;
        if !shared.designs.contains_key(id) {
            let entry = Entry {
                snapshot: snapshot.clone(),
                journal: Vec::new(),
                holder: None,
                epoch: token,
            };
            shared.designs.insert(id.clone(), entry);
            return Ok(());
        }
        let entry = shared.fenced(id, token)?;
        entry.snapshot = snapshot.clone();
        entry.journal.clear();
        Ok(())
    }

    fn append(&self, id: &str, records: &[Record], token: Token) -> io::Result<()> {
        self.lock()?
            .fenced(id, token)?
            .journal
            .extend_from_slice(records);
        Ok(())
    }

    fn remove(&self, id: &str) -> io::Result<()> {
        self.lock()?.designs.remove(id);
        Ok(())
    }

    fn put_blob(&self, bytes: &[u8]) -> io::Result<BlobHash> {
        let hash = blob::accept(bytes)?;
        self.lock()?
            .blobs
            .entry(hash.clone())
            .or_insert_with(|| bytes.to_vec());
        Ok(hash)
    }

    fn get_blob(&self, hash: &BlobHash) -> io::Result<Option<Vec<u8>>> {
        Ok(self.lock()?.blobs.get(hash).cloned())
    }

    fn has_blob(&self, hash: &BlobHash) -> io::Result<bool> {
        Ok(self.lock()?.blobs.contains_key(hash))
    }

    fn create(&self, snapshot: &Snapshot) -> io::Result<Option<Token>> {
        let mut shared = self.lock()?;
        if shared.designs.contains_key(&snapshot.meta.id) {
            return Ok(None);
        }
        let entry = Entry {
            snapshot: snapshot.clone(),
            journal: Vec::new(),
            holder: Some(self.me.clone()),
            epoch: 1,
        };
        shared.designs.insert(snapshot.meta.id.clone(), entry);
        Ok(Some(1))
    }

    fn claim(&self, id: &str) -> io::Result<Claim> {
        let mut shared = self.lock()?;
        let holder = match shared.designs.get(id) {
            None => return Ok(Claim::Missing),
            Some(entry) => entry.holder.clone(),
        };
        if let Some(holder) = holder.filter(|h| *h != self.me && shared.alive(h)) {
            return Ok(Claim::Held(holder));
        }
        let entry = shared.designs.get_mut(id).expect("checked above");
        entry.epoch += 1;
        entry.holder = Some(self.me.clone());
        Ok(Claim::Granted(entry.epoch))
    }

    fn release(&self, id: &str, token: Token) -> io::Result<()> {
        let mut shared = self.lock()?;
        if let Some(entry) = shared.designs.get_mut(id)
            && entry.epoch == token
            && entry.holder.as_deref() == Some(&self.me)
        {
            entry.holder = None;
            entry.epoch += 1;
        }
        Ok(())
    }

    fn held(&self) -> io::Result<Vec<(String, Token)>> {
        Ok(self
            .lock()?
            .designs
            .iter()
            .filter(|(_, e)| e.holder.as_deref() == Some(&self.me))
            .map(|(id, e)| (id.clone(), e.epoch))
            .collect())
    }
}

impl Registry for MemoryStore {
    fn heartbeat(&self) -> io::Result<()> {
        let mut shared = self.lock()?;
        shared.heartbeats.insert(self.me.clone(), Instant::now());
        Ok(())
    }

    fn live(&self) -> io::Result<Vec<String>> {
        let shared = self.lock()?;
        let mut live: Vec<String> = shared
            .heartbeats
            .keys()
            .filter(|url| shared.alive(url))
            .cloned()
            .collect();
        live.sort();
        Ok(live)
    }

    fn leave(&self) -> io::Result<()> {
        self.lock()?.heartbeats.remove(&self.me);
        Ok(())
    }
}

/// The behavior every [`Store`] must have. Run [`contract::check`] against a
/// new implementation, such as a database store, before the hub uses it. A
/// store several servers share must pass [`contract::check_shared`] too.
pub mod contract {
    use finite_design::{DesignMeta, Record, Snapshot};

    use super::{Claim, Registry, Store, is_fenced};
    use crate::blob::{BlobHash, MAX_BLOB};

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
            css: None,
            comments: Vec::new(),
            histories: None,
            log: None,
            imports: Vec::new(),
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
            store.append("a", &[rename("a", "x")], 0).is_err(),
            "appending to a design that was never saved fails"
        );

        let a = store.create(&snapshot("a", 3)).unwrap().expect("a new id");
        let b = store.create(&snapshot("b", 0)).unwrap().expect("a new id");
        store.save(&snapshot("a", 3), a).unwrap();
        store.save(&snapshot("b", 0), b).unwrap();
        let mut ids = store.ids().unwrap();
        ids.sort();
        assert_eq!(ids, ["a", "b"], "ids lists every saved design");
        let loaded = store.load("a").unwrap().expect("a saved design loads");
        assert_eq!(loaded.snapshot.seq, 3, "load returns the saved snapshot");
        assert!(loaded.journal.is_empty(), "a fresh snapshot has no journal");

        store.append("a", &[rename("a", "One")], a).unwrap();
        store
            .append("a", &[rename("a", "Two"), rename("a", "Three")], a)
            .unwrap();
        let journal = store.load("a").unwrap().unwrap().journal;
        assert_eq!(
            names(&journal),
            ["One", "Two", "Three"],
            "the journal keeps append order"
        );
        let loaded = store.load("b").unwrap().unwrap();
        assert!(loaded.journal.is_empty(), "journals are per design");

        store.save(&snapshot("a", 9), a).unwrap();
        let loaded = store.load("a").unwrap().unwrap();
        assert_eq!(loaded.snapshot.seq, 9, "save replaces the snapshot");
        assert!(loaded.journal.is_empty(), "save clears the journal");

        let Claim::Granted(a) = store.claim("a").unwrap() else {
            panic!("the only server can always claim a design");
        };
        store.append("a", &[rename("a", "Four")], a).unwrap();
        store.remove("a").unwrap();
        assert!(
            store.load("a").unwrap().is_none(),
            "a removed design is gone"
        );
        assert_eq!(store.ids().unwrap(), ["b"], "and no longer listed");
        store.remove("a").unwrap();

        check_blobs(store);
    }

    fn check_blobs(store: &dyn Store) {
        let bytes = b"\x89PNG not really".as_slice();
        let hash = BlobHash::of(bytes);
        assert!(!store.has_blob(&hash).unwrap(), "a new blob isn't stored");
        assert_eq!(
            store.get_blob(&hash).unwrap(),
            None,
            "a missing blob reads as None"
        );

        assert_eq!(store.put_blob(bytes).unwrap(), hash, "put returns the hash");
        assert!(store.has_blob(&hash).unwrap(), "a stored blob is there");
        assert_eq!(
            store.get_blob(&hash).unwrap().as_deref(),
            Some(bytes),
            "get returns the bytes"
        );
        assert_eq!(
            store.put_blob(bytes).unwrap(),
            hash,
            "putting a blob twice is fine"
        );
        assert_eq!(store.get_blob(&hash).unwrap().as_deref(), Some(bytes));
        let empty = store.put_blob(b"").unwrap();
        assert_eq!(
            store.get_blob(&empty).unwrap(),
            Some(Vec::new()),
            "even empty"
        );

        for bad in ["", "../../etc/passwd", "ABC", &hash.as_str().to_uppercase()] {
            assert!(BlobHash::parse(bad).is_err(), "{bad:?} isn't a blob hash");
        }
        let error = store.put_blob(&vec![0; MAX_BLOB + 1]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput, "too big");
        assert!(
            !store
                .has_blob(&BlobHash::of(&vec![0; MAX_BLOB + 1]))
                .unwrap()
        );
    }

    /// Panics with the first rule a shared store breaks. `a` and `b` are two
    /// servers' connections to the same empty store, at `a_url` and `b_url`.
    pub fn check_shared<S: Store + Registry>(a: &S, a_url: &str, b: &S, b_url: &str) {
        a.heartbeat().unwrap();
        b.heartbeat().unwrap();
        let mut both = vec![a_url.to_owned(), b_url.to_owned()];
        both.sort();
        assert_eq!(a.live().unwrap(), both, "a heartbeat makes a server live");
        assert_eq!(b.live().unwrap(), both, "every server sees the same list");

        let t1 = a.create(&snapshot("d", 0)).unwrap().expect("a new id");
        assert_eq!(
            b.create(&snapshot("d", 0)).unwrap(),
            None,
            "an id can be created only once"
        );
        a.save(&snapshot("d", 1), t1).unwrap();
        assert_eq!(
            b.claim("d").unwrap(),
            Claim::Held(a_url.into()),
            "a live server's lease can't be taken"
        );
        assert_eq!(b.claim("x").unwrap(), Claim::Missing, "a missing design");
        assert_eq!(a.held().unwrap(), [("d".to_owned(), t1)], "a holds d");

        a.release("d", t1).unwrap();
        assert!(a.held().unwrap().is_empty(), "a released lease isn't held");
        let Claim::Granted(t2) = b.claim("d").unwrap() else {
            panic!("a released lease can be claimed");
        };
        assert!(t2 > t1, "each claim raises the token");
        let refused = a.append("d", &[rename("d", "Stale")], t1).unwrap_err();
        assert!(is_fenced(&refused), "an append with an old token is fenced");
        let refused = a.save(&snapshot("d", 7), t1).unwrap_err();
        assert!(is_fenced(&refused), "a save with an old token is fenced");
        b.append("d", &[rename("d", "Fresh")], t2).unwrap();
        let stored = a.load("d").unwrap().unwrap();
        assert_eq!(stored.snapshot.seq, 1, "the fenced save changed nothing");
        assert_eq!(names(&stored.journal), ["Fresh"], "nor the fenced append");

        b.leave().unwrap();
        assert_eq!(a.live().unwrap(), [a_url], "a server that left isn't live");
        let Claim::Granted(t3) = a.claim("d").unwrap() else {
            panic!("a gone server's lease can be taken");
        };
        assert!(t3 > t2);
        let refused = b.save(&snapshot("d", 8), t2).unwrap_err();
        assert!(is_fenced(&refused), "the old holder's writes are fenced");
        a.release("d", t2).unwrap();
        assert_eq!(
            a.held().unwrap(),
            [("d".to_owned(), t3)],
            "releasing with an old token does nothing"
        );
        let Claim::Granted(t4) = a.claim("d").unwrap() else {
            panic!("a holder can claim its own lease again");
        };
        assert!(t4 > t3, "which raises the token too");
        a.leave().unwrap();

        let hash = a.put_blob(b"shared").unwrap();
        assert_eq!(
            b.get_blob(&hash).unwrap().as_deref(),
            Some(b"shared".as_slice()),
            "every server sees the same blobs"
        );
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
            css: None,
            comments: Vec::new(),
            histories: None,
            log: None,
            imports: Vec::new(),
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
    fn memory_store_meets_the_shared_contract() {
        let store = MemoryStore::default();
        let (a, b) = (store.node("http://a"), store.node("http://b"));
        contract::check_shared(&a, "http://a", &b, "http://b");
    }

    #[test]
    fn file_store_meets_the_contract() {
        let dir = temp_dir();
        contract::check(&FileStore::new(&dir).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ids_cant_name_files_outside_the_store() {
        let dir = temp_dir();
        let store = FileStore::new(dir.join("data")).unwrap();
        let mut escaping = snapshot();
        escaping.meta.id = "../../escaped".into();
        let error = store.save(&escaping, 0).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        for result in [
            store.load("../x").map(|_| ()),
            store.append("../x", &[meta("x")], 0),
            store.remove("../x"),
        ] {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
        assert!(!dir.join("escaped.json").exists());
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
    fn opening_removes_snapshots_a_crash_left_half_written() {
        let dir = temp_dir();
        let store = FileStore::new(&dir).unwrap();
        store.save(&snapshot(), 0).unwrap();
        fs::write(dir.join("designs/d.json.tmp"), b"{\"half").unwrap();
        drop(store);
        let store = FileStore::new(&dir).unwrap();
        assert!(!dir.join("designs/d.json.tmp").exists());
        assert!(
            store.load("d").unwrap().is_some(),
            "the real snapshot stays"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_store_ignores_a_torn_journal_line() {
        let dir = temp_dir();
        let store = FileStore::new(&dir).unwrap();
        store.save(&snapshot(), 0).unwrap();
        store.append("d", &[meta("One"), meta("Two")], 0).unwrap();
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

    /// Data a newer server wrote fails to load instead of being skipped, so
    /// this server can't take the design for missing and write over it.
    #[test]
    fn file_store_refuses_data_from_a_newer_server() {
        let dir = temp_dir();
        let store = FileStore::new(&dir).unwrap();
        store.save(&snapshot(), 0).unwrap();
        let saved = fs::read_to_string(dir.join("designs/d.json")).unwrap();
        assert!(saved.starts_with(r#"{"v":1,"#), "{saved}");

        fs::write(dir.join("designs/d.log"), "{\"v\":99,\"type\":\"meta\"}\n").unwrap();
        let error = store.load("d").err().unwrap();
        assert!(error.to_string().contains("version 99"), "{error}");

        fs::remove_file(dir.join("designs/d.log")).unwrap();
        fs::write(
            dir.join("designs/d.json"),
            saved.replacen("\"v\":1", "\"v\":99", 1),
        )
        .unwrap();
        assert!(store.load("d").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
