use std::{
    collections::HashMap,
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use finite_design::{Record, Snapshot};

use super::{Claim, Refusal, Registry, Store, Stored, Token, not_saved};
use crate::blob::{self, BlobHash};

/// Keeps designs in memory, with no disk or database behind it. It is in the
/// library, behind the `testing` feature, because the integration tests and
/// examples run servers on it. A normal build of the server leaves it out.
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
        let entry = self.designs.get_mut(id).ok_or_else(not_saved)?;
        if entry.epoch != token {
            return Err(Refusal::Fenced.error());
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
            if token != 0 {
                return Err(Refusal::Fenced.error());
            }
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

    fn delete(&self, id: &str, token: Token) -> io::Result<()> {
        let mut state = self.lock()?;
        state.fenced(id, token)?;
        state.designs.remove(id);
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
