use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use finite_design::Snapshot;

/// Where design snapshots persist. Swap the file store for a database by
/// implementing this trait; the hub only ever calls these two methods.
pub trait Store: Send + Sync + 'static {
    fn load_all(&self) -> io::Result<Vec<Snapshot>>;
    fn save(&self, snapshot: &Snapshot) -> io::Result<()>;
}

/// One JSON file per design in `<dir>/designs/`. Writes go to a temporary file
/// first and are renamed into place, so a crash never leaves a half-written design.
pub struct FileStore {
    dir: PathBuf,
}

impl FileStore {
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().join("designs");
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }
}

impl Store for FileStore {
    fn load_all(&self) -> io::Result<Vec<Snapshot>> {
        let mut snapshots = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            match fs::read(&path).map(|bytes| serde_json::from_slice::<Snapshot>(&bytes)) {
                Ok(Ok(snapshot)) => snapshots.push(snapshot),
                Ok(Err(error)) => tracing::warn!(?path, %error, "skipping unreadable design"),
                Err(error) => tracing::warn!(?path, %error, "skipping unreadable design"),
            }
        }
        Ok(snapshots)
    }

    fn save(&self, snapshot: &Snapshot) -> io::Result<()> {
        let path = self.dir.join(format!("{}.json", snapshot.meta.id));
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(snapshot)?)?;
        fs::rename(tmp, path)
    }
}

/// Keeps snapshots in memory. Used by tests.
#[derive(Default)]
pub struct MemoryStore {
    snapshots: Mutex<Vec<Snapshot>>,
}

impl Store for MemoryStore {
    fn load_all(&self) -> io::Result<Vec<Snapshot>> {
        Ok(self.snapshots.lock().unwrap().clone())
    }

    fn save(&self, snapshot: &Snapshot) -> io::Result<()> {
        let mut snapshots = self.snapshots.lock().unwrap();
        snapshots.retain(|s| s.meta.id != snapshot.meta.id);
        snapshots.push(snapshot.clone());
        Ok(())
    }
}
