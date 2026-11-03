//! A [`Store`] in Postgres, which several servers can share. Set
//! `FINITE_DATABASE_URL` to use it.
//!
//! Four tables hold everything:
//!
//! - `finite_designs`: one row per design, with its last snapshot as JSON,
//!   the server holding its lease (`holder`), and its fencing token (`epoch`).
//! - `finite_journal`: the records appended since that snapshot, in order.
//! - `finite_nodes`: one row per server, with the time of its last heartbeat.
//! - `finite_blobs`: one row per blob, keyed by the hash of its bytes. Blobs
//!   never change, so they need no token.
//!
//! Every write checks the token in the same transaction that changes the
//! design: `save` updates the row only `WHERE epoch = token`, and `append`
//! locks the row before it compares. A claim raises `epoch` on that same row,
//! so a claim and a stale write can't both succeed: whichever runs second
//! sees the other's change.
//!
//! The database clock decides who's alive (`now()` against each heartbeat), so
//! servers' clocks don't need to agree.
//!
//! The hub calls a store from plain threads, so this store runs its own small
//! Tokio runtime for the connections and blocks the caller until each query
//! finishes, as a file read would.

use std::{future::Future, io, sync::Mutex, time::Duration};

use finite_design::{Record, Snapshot};
use tokio_postgres::Client;
use tokio_postgres_rustls::MakeRustlsConnect;

pub mod tls;

use crate::{
    blob::{self, BlobHash},
    store::{
        Claim, Registry, Store, Stored, Token, decode_record, decode_snapshot, encode_record,
        encode_snapshot, fenced,
    },
};

/// The longest one call may take before it fails, so a database that stopped
/// answering can't hang a save forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a server that stopped heartbeating stays in `finite_nodes` before
/// any server deletes its row.
const FORGET_NODES_AFTER: &str = "1 day";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS finite_designs (
    id text PRIMARY KEY,
    snapshot text NOT NULL,
    holder text,
    epoch bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS finite_designs_holder ON finite_designs (holder);
CREATE TABLE IF NOT EXISTS finite_journal (
    design text NOT NULL REFERENCES finite_designs (id) ON DELETE CASCADE,
    n bigserial,
    record text NOT NULL,
    PRIMARY KEY (design, n)
);
CREATE TABLE IF NOT EXISTS finite_nodes (
    url text PRIMARY KEY,
    instance text NOT NULL,
    heartbeat timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS finite_blobs (
    hash text PRIMARY KEY,
    bytes bytea NOT NULL
);
";

/// Runs `$body` on a pooled connection named `$client`, through
/// [`PgStore::run`]. The body ends in `Ok(value)`.
macro_rules! query {
    ($store:expr, |$client:ident| $body:block) => {
        $store.run(move |#[allow(unused_mut)] mut $client| async move {
            let result: Result<_, Error> = async { $body }.await;
            ($client, result)
        })
    };
}

/// Whether `name` can be a schema without quoting: Postgres folds unquoted
/// names to lowercase, and this keeps them out of SQL injection's reach.
fn is_schema_name(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !name.as_bytes()[0].is_ascii_digit()
}

/// The connection settings in `url`, and a TLS connector for its `sslmode`.
fn open(url: &str) -> io::Result<(tokio_postgres::Config, MakeRustlsConnect)> {
    let (url, settings) = tls::split(url)?;
    let mut config: tokio_postgres::Config = url.parse().map_err(other)?;
    config.connect_timeout(CALL_TIMEOUT);
    config.ssl_mode(settings.ssl_mode());
    Ok((config, settings.connector()?))
}

/// Designs, journals, leases and heartbeats in Postgres.
pub struct PgStore {
    config: tokio_postgres::Config,
    /// Encrypts connections and checks the server's certificate, as
    /// `sslmode` says (see [`tls`]).
    tls: MakeRustlsConnect,
    runtime: Option<tokio::runtime::Runtime>,
    /// Idle connections. A call takes one, or opens one if there's none.
    idle: Mutex<Vec<Client>>,
    /// This server's base URL, which other servers and the router use.
    me: String,
    /// A random name for this process. If another process starts with the
    /// same URL, its heartbeat replaces this one's, and this one stops
    /// counting as alive rather than share a name.
    instance: String,
    /// How long a heartbeat counts.
    lease: Duration,
}

fn other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

/// An error with the errors that caused it, like "error performing TLS
/// handshake: invalid peer certificate: UnknownIssuer". `tokio-postgres`
/// keeps the cause out of its message, and the cause is what says what to fix.
fn with_causes(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut cause = error.source();
    while let Some(next) = cause {
        message.push_str(": ");
        message.push_str(&next.to_string());
        cause = next.source();
    }
    message
}

impl PgStore {
    /// Connects to the database at `url` as the server at `me`, and creates
    /// the tables if they're missing. A router, which only reads the list of
    /// servers, can pass any `me`.
    pub fn connect(url: &str, me: &str, lease: Duration) -> io::Result<Self> {
        Self::connect_in(url, None, me, lease)
    }

    /// Like [`PgStore::connect`], with the tables in `schema`
    /// (`FINITE_DATABASE_SCHEMA` in development builds), which is created if
    /// it's missing. Test runs can then share one database without seeing
    /// each other's designs.
    pub fn connect_in(
        url: &str,
        schema: Option<&str>,
        me: &str,
        lease: Duration,
    ) -> io::Result<Self> {
        let (mut config, tls) = open(url)?;
        config.application_name("finite-server");
        let create_schema = match schema {
            None => String::new(),
            Some(schema) => {
                if !is_schema_name(schema) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "a schema name is 1 to 63 lowercase letters, digits and _, starting with a letter or _, not {schema:?}"
                        ),
                    ));
                }
                // Every connection looks there first, so the tables and
                // every query go to this schema.
                let options = config.get_options().unwrap_or_default();
                config.options(format!("{options} -c search_path={schema}").trim());
                format!("CREATE SCHEMA IF NOT EXISTS {schema};")
            }
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("finite-postgres")
            .enable_all()
            .build()?;
        let store = Self {
            config,
            tls,
            runtime: Some(runtime),
            idle: Mutex::new(Vec::new()),
            me: me.to_owned(),
            instance: crate::hub::random_id(12),
            lease,
        };
        query!(store, |client| {
            let tx = client.transaction().await?;
            // Two servers starting at once would race to create the tables.
            tx.execute("SELECT pg_advisory_xact_lock(4100)", &[])
                .await?;
            tx.batch_execute(&create_schema).await?;
            tx.batch_execute(SCHEMA).await?;
            tx.commit().await?;
            Ok(())
        })?;
        Ok(store)
    }

    /// Runs `work` with a connection on this store's runtime, and waits for
    /// it. `work` gets the connection and hands it back with its result. Use
    /// it through [`query!`].
    fn run<T, F, Fut>(&self, work: F) -> io::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Client) -> Fut + Send + 'static,
        Fut: Future<Output = (Client, Result<T, Error>)> + Send,
    {
        let runtime = self
            .runtime
            .as_ref()
            .expect("the runtime lives as long as the store");
        let pooled = self.idle.lock().unwrap().pop();
        let (config, tls) = (self.config.clone(), self.tls.clone());
        let call = runtime.spawn(async move {
            let client = match pooled.filter(|c| !c.is_closed()) {
                Some(client) => client,
                None => {
                    let (client, connection) = config.connect(tls).await?;
                    tokio::spawn(async move {
                        if let Err(error) = connection.await {
                            tracing::warn!(%error, "lost a database connection");
                        }
                    });
                    client
                }
            };
            match tokio::time::timeout(CALL_TIMEOUT, work(client)).await {
                Ok((client, result)) => Ok((Some(client), result)),
                // The connection may be mid-query, so it isn't reused.
                Err(_) => Ok((
                    None,
                    Err(Error::Io(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the database didn't answer in time",
                    ))),
                )),
            }
        });
        // Blocks this thread, not the store's runtime, so it works from
        // any thread, inside another runtime or not.
        let (client, result) = futures::executor::block_on(call)
            .map_err(other)?
            .map_err(Error::into_io)?;
        if let Some(client) = client.filter(|c| !c.is_closed()) {
            self.idle.lock().unwrap().push(client);
        }
        result.map_err(Error::into_io)
    }

    /// The lease as Postgres seconds, for `make_interval`.
    fn lease_secs(&self) -> f64 {
        self.lease.as_secs_f64()
    }
}

impl Drop for PgStore {
    /// Dropping a runtime waits for its threads, which isn't allowed inside
    /// another runtime, so this one is told to stop in the background.
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

/// Why a call failed: the database said no, or the store's own rule did.
enum Error {
    Db(tokio_postgres::Error),
    Io(io::Error),
}

impl From<tokio_postgres::Error> for Error {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::Db(error)
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Io(error.into())
    }
}

impl Error {
    fn into_io(self) -> io::Error {
        match self {
            Self::Io(error) => error,
            Self::Db(error) => io::Error::other(with_causes(&error)),
        }
    }
}

fn not_saved() -> Error {
    Error::Io(io::Error::new(
        io::ErrorKind::NotFound,
        "design was never saved",
    ))
}

impl Store for PgStore {
    fn ids(&self) -> io::Result<Vec<String>> {
        query!(self, |client| {
            let rows = client.query("SELECT id FROM finite_designs", &[]).await?;
            Ok(rows.iter().map(|row| row.get(0)).collect())
        })
    }

    /// Reads the snapshot and the journal in one snapshot of the database,
    /// so a save between the two can't pair a new snapshot with an old journal.
    fn load(&self, id: &str) -> io::Result<Option<Stored>> {
        let id = id.to_owned();
        query!(self, |client| {
            let tx = client
                .build_transaction()
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .read_only(true)
                .start()
                .await?;
            let Some(row) = tx
                .query_opt("SELECT snapshot FROM finite_designs WHERE id = $1", &[&id])
                .await?
            else {
                return Ok(None);
            };
            let snapshot: String = row.get(0);
            let Some(snapshot) = decode_snapshot(&snapshot)? else {
                tracing::warn!(id, "skipping unreadable design");
                return Ok(None);
            };
            let rows = tx
                .query(
                    "SELECT record FROM finite_journal WHERE design = $1 ORDER BY n",
                    &[&id],
                )
                .await?;
            let mut journal = Vec::with_capacity(rows.len());
            for row in rows {
                match decode_record(row.get(0))? {
                    Some(record) => journal.push(record),
                    None => {
                        tracing::warn!(id, "journal has an unreadable record; ignoring the rest");
                        break;
                    }
                }
            }
            tx.commit().await?;
            Ok(Some(Stored { snapshot, journal }))
        })
    }

    fn save(&self, snapshot: &Snapshot, token: Token) -> io::Result<()> {
        let id = snapshot.meta.id.clone();
        let json = encode_snapshot(snapshot)?;
        let token = token as i64;
        query!(self, |client| {
            let tx = client.transaction().await?;
            let updated = tx
                .execute(
                    "UPDATE finite_designs SET snapshot = $2 WHERE id = $1 AND epoch = $3",
                    &[&id, &json, &token],
                )
                .await?;
            if updated == 0 {
                if token != 0 {
                    return Err(Error::Io(fenced()));
                }
                let inserted = tx
                    .execute(
                        "INSERT INTO finite_designs (id, snapshot, epoch) VALUES ($1, $2, $3)
                         ON CONFLICT (id) DO NOTHING",
                        &[&id, &json, &token],
                    )
                    .await?;
                if inserted == 0 {
                    return Err(Error::Io(fenced()));
                }
            }
            tx.execute("DELETE FROM finite_journal WHERE design = $1", &[&id])
                .await?;
            tx.commit().await?;
            Ok(())
        })
    }

    /// Locks the design's row before comparing tokens, so a claim waits until
    /// this append has committed, and loads it.
    fn append(&self, id: &str, records: &[Record], token: Token) -> io::Result<()> {
        let id = id.to_owned();
        let records = records
            .iter()
            .map(encode_record)
            .collect::<io::Result<Vec<String>>>()?;
        let token = token as i64;
        query!(self, |client| {
            let tx = client.transaction().await?;
            let Some(row) = tx
                .query_opt(
                    "SELECT epoch FROM finite_designs WHERE id = $1 FOR SHARE",
                    &[&id],
                )
                .await?
            else {
                return Err(not_saved());
            };
            if row.get::<_, i64>(0) != token {
                return Err(Error::Io(fenced()));
            }
            tx.execute(
                "INSERT INTO finite_journal (design, record)
                 SELECT $1, record FROM unnest($2::text[]) WITH ORDINALITY AS r(record, i) ORDER BY i",
                &[&id, &records],
            )
            .await?;
            tx.commit().await?;
            Ok(())
        })
    }

    fn remove(&self, id: &str) -> io::Result<()> {
        let id = id.to_owned();
        query!(self, |client| {
            client
                .execute("DELETE FROM finite_designs WHERE id = $1", &[&id])
                .await?;
            Ok(())
        })
    }

    fn delete(&self, id: &str, token: Token) -> io::Result<()> {
        let id = id.to_owned();
        let token = token as i64;
        query!(self, |client| {
            let removed = client
                .execute(
                    "DELETE FROM finite_designs WHERE id = $1 AND epoch = $2",
                    &[&id, &token],
                )
                .await?;
            if removed == 0 {
                return Err(Error::Io(fenced()));
            }
            Ok(())
        })
    }

    fn put_blob(&self, bytes: &[u8]) -> io::Result<BlobHash> {
        let hash = blob::accept(bytes)?;
        let (key, bytes) = (hash.to_string(), bytes.to_vec());
        query!(self, |client| {
            client
                .execute(
                    "INSERT INTO finite_blobs (hash, bytes) VALUES ($1, $2)
                     ON CONFLICT (hash) DO NOTHING",
                    &[&key, &bytes],
                )
                .await?;
            Ok(())
        })?;
        Ok(hash)
    }

    fn get_blob(&self, hash: &BlobHash) -> io::Result<Option<Vec<u8>>> {
        let key = hash.to_string();
        query!(self, |client| {
            let row = client
                .query_opt("SELECT bytes FROM finite_blobs WHERE hash = $1", &[&key])
                .await?;
            Ok(row.map(|row| row.get::<_, Vec<u8>>(0)))
        })
    }

    fn has_blob(&self, hash: &BlobHash) -> io::Result<bool> {
        let key = hash.to_string();
        query!(self, |client| {
            let row = client
                .query_opt("SELECT 1 FROM finite_blobs WHERE hash = $1", &[&key])
                .await?;
            Ok(row.is_some())
        })
    }

    fn create(&self, snapshot: &Snapshot) -> io::Result<Option<Token>> {
        let id = snapshot.meta.id.clone();
        let json = encode_snapshot(snapshot)?;
        let me = self.me.clone();
        query!(self, |client| {
            let row = client
                .query_opt(
                    "INSERT INTO finite_designs (id, snapshot, holder, epoch) VALUES ($1, $2, $3, 1)
                     ON CONFLICT (id) DO NOTHING RETURNING epoch",
                    &[&id, &json, &me],
                )
                .await?;
            Ok(row.map(|row| row.get::<_, i64>(0) as Token))
        })
    }

    /// Takes the lease if nobody holds it, this server does, or its holder's
    /// heartbeat is older than the lease. All in one statement, so two
    /// servers claiming at once can't both win.
    fn claim(&self, id: &str) -> io::Result<Claim> {
        let id = id.to_owned();
        let me = self.me.clone();
        let lease = self.lease_secs();
        query!(self, |client| {
            let granted = client
                .query_opt(
                    "UPDATE finite_designs d SET holder = $2, epoch = d.epoch + 1
                     WHERE d.id = $1 AND (d.holder IS NULL OR d.holder = $2 OR NOT EXISTS (
                         SELECT 1 FROM finite_nodes n
                         WHERE n.url = d.holder AND n.heartbeat > now() - make_interval(secs => $3)))
                     RETURNING d.epoch",
                    &[&id, &me, &lease],
                )
                .await?;
            if let Some(row) = granted {
                return Ok(Claim::Granted(row.get::<_, i64>(0) as Token));
            }
            let held = client
                .query_opt("SELECT holder FROM finite_designs WHERE id = $1", &[&id])
                .await?;
            Ok(match held {
                None => Claim::Missing,
                Some(row) => Claim::Held(row.get::<_, Option<String>>(0).unwrap_or_default()),
            })
        })
    }

    fn release(&self, id: &str, token: Token) -> io::Result<()> {
        let id = id.to_owned();
        let me = self.me.clone();
        let token = token as i64;
        query!(self, |client| {
            client
                .execute(
                    "UPDATE finite_designs SET holder = NULL, epoch = epoch + 1
                     WHERE id = $1 AND epoch = $2 AND holder = $3",
                    &[&id, &token, &me],
                )
                .await?;
            Ok(())
        })
    }

    fn held(&self) -> io::Result<Vec<(String, Token)>> {
        let me = self.me.clone();
        query!(self, |client| {
            let rows = client
                .query(
                    "SELECT id, epoch FROM finite_designs WHERE holder = $1",
                    &[&me],
                )
                .await?;
            Ok(rows
                .iter()
                .map(|row| (row.get(0), row.get::<_, i64>(1) as Token))
                .collect())
        })
    }
}

impl Registry for PgStore {
    /// Renews this server's row. If the row is missing, say on the first
    /// heartbeat, it joins. If another process has taken its URL, it fails.
    fn heartbeat(&self) -> io::Result<()> {
        let (me, instance) = (self.me.clone(), self.instance.clone());
        let lease = self.lease_secs();
        query!(self, |client| {
            let renewed = client
                .execute(
                    "UPDATE finite_nodes SET heartbeat = now() WHERE url = $1 AND instance = $2",
                    &[&me, &instance],
                )
                .await?;
            if renewed == 1 {
                return Ok(());
            }
            client
                .execute(
                    &format!(
                        "DELETE FROM finite_nodes WHERE heartbeat < now() - interval '{FORGET_NODES_AFTER}'"
                    ),
                    &[],
                )
                .await?;
            let joined = client
                .execute(
                    "INSERT INTO finite_nodes (url, instance, heartbeat) VALUES ($1, $2, now())
                     ON CONFLICT (url) DO UPDATE SET instance = $2, heartbeat = now()
                     WHERE finite_nodes.heartbeat < now() - make_interval(secs => $3)",
                    &[&me, &instance, &lease],
                )
                .await?;
            if joined == 0 {
                return Err(Error::Io(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!("another live Finite server is using the URL {me}"),
                )));
            }
            Ok(())
        })
    }

    fn live(&self) -> io::Result<Vec<String>> {
        let lease = self.lease_secs();
        query!(self, |client| {
            let rows = client
                .query(
                    "SELECT url FROM finite_nodes
                     WHERE heartbeat > now() - make_interval(secs => $1) ORDER BY url",
                    &[&lease],
                )
                .await?;
            Ok(rows.iter().map(|row| row.get(0)).collect())
        })
    }

    fn leave(&self) -> io::Result<()> {
        let (me, instance) = (self.me.clone(), self.instance.clone());
        query!(self, |client| {
            client
                .execute(
                    "DELETE FROM finite_nodes WHERE url = $1 AND instance = $2",
                    &[&me, &instance],
                )
                .await?;
            Ok(())
        })
    }
}

/// For tests: a new, empty schema in the database at `url`, and a URL that
/// uses it. Each test gets its own tables that way, so tests can run at once
/// against one database.
pub fn scratch_schema(url: &str) -> io::Result<String> {
    let schema = new_schema(url)?;
    let joiner = if url.contains('?') { '&' } else { '?' };
    Ok(format!("{url}{joiner}options=-c%20search_path%3D{schema}"))
}

/// Creates an empty schema with a random name in the database at `url`.
fn new_schema(url: &str) -> io::Result<String> {
    let schema = format!("finite_test_{}", crate::hub::random_id(10));
    let (base, statement) = (url.to_owned(), format!("CREATE SCHEMA {schema}"));
    // On a thread of its own, since the caller may be inside a runtime.
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let (config, tls) = open(&base)?;
            let (client, connection) = config
                .connect(tls)
                .await
                .map_err(|e| io::Error::other(with_causes(&e)))?;
            tokio::spawn(connection);
            client.batch_execute(&statement).await.map_err(other)
        })
    })
    .join()
    .map_err(|_| io::Error::other("creating the schema panicked"))??;
    Ok(schema)
}

/// The database tests use, from `FINITE_TEST_DATABASE_URL`, with a fresh
/// schema. `None` when it isn't set, and the test should skip.
pub fn test_database() -> Option<String> {
    let Ok(url) = std::env::var("FINITE_TEST_DATABASE_URL") else {
        eprintln!("skipping: set FINITE_TEST_DATABASE_URL to run the tests that need Postgres");
        return None;
    };
    Some(scratch_schema(&url).expect("FINITE_TEST_DATABASE_URL is reachable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::contract;

    const LEASE: Duration = Duration::from_secs(10);

    #[test]
    fn postgres_store_meets_the_contract() {
        let Some(url) = test_database() else { return };
        contract::check(&PgStore::connect(&url, "http://a", LEASE).unwrap());
    }

    #[test]
    fn postgres_store_meets_the_shared_contract() {
        let Some(url) = test_database() else { return };
        let a = PgStore::connect(&url, "http://a", LEASE).unwrap();
        let b = PgStore::connect(&url, "http://b", LEASE).unwrap();
        contract::check_shared(&a, "http://a", &b, "http://b");
    }

    /// Two deployments in two schemas of one database don't see each
    /// other's designs, or each other's servers.
    #[test]
    fn a_schema_keeps_a_deployment_to_itself() {
        let Ok(url) = std::env::var("FINITE_TEST_DATABASE_URL") else {
            eprintln!("skipping: set FINITE_TEST_DATABASE_URL");
            return;
        };
        let name = |n| format!("finite_test_{}_{n}", crate::hub::random_id(8));
        let (one, two) = (name(1), name(2));
        let a = PgStore::connect_in(&url, Some(&one), "http://a", LEASE).unwrap();
        let b = PgStore::connect_in(&url, Some(&two), "http://b", LEASE).unwrap();
        let snapshot = |id: &str| Snapshot {
            meta: finite_design::DesignMeta {
                id: id.into(),
                name: id.into(),
                created_at: 0,
                updated_at: 0,
            },
            seq: 0,
            nodes: Vec::new(),
            css: None,
            pages: Default::default(),
            comments: Vec::new(),
            histories: None,
            imports: Vec::new(),
            log: None,
        };
        a.create(&snapshot("d")).unwrap().unwrap();
        b.create(&snapshot("e")).unwrap().unwrap();
        assert_eq!(a.ids().unwrap(), ["d"]);
        assert_eq!(b.ids().unwrap(), ["e"]);
        a.heartbeat().unwrap();
        b.heartbeat().unwrap();
        assert_eq!(a.live().unwrap(), ["http://a"]);
        // Reopening the same schema finds the design again.
        let again = PgStore::connect_in(&url, Some(&one), "http://a", LEASE).unwrap();
        assert_eq!(again.ids().unwrap(), ["d"]);
        let refused = PgStore::connect_in(&url, Some("x; DROP TABLE y"), "http://a", LEASE);
        assert_eq!(refused.err().unwrap().kind(), io::ErrorKind::InvalidInput);
    }

    /// A second process can't share a live server's URL, but a server that
    /// restarts takes its URL back once the old heartbeat has run out.
    #[test]
    fn a_url_belongs_to_one_live_server() {
        let Some(url) = test_database() else { return };
        let lease = Duration::from_millis(500);
        let first = PgStore::connect(&url, "http://a", lease).unwrap();
        first.heartbeat().unwrap();
        let second = PgStore::connect(&url, "http://a", lease).unwrap();
        let error = second.heartbeat().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        std::thread::sleep(lease);
        second.heartbeat().unwrap();
        assert!(first.heartbeat().is_err(), "the old process lost its URL");
    }

    /// A TLS front for the test database, the way a managed Postgres
    /// looks. It answers Postgres's request for TLS, does the handshake with
    /// a certificate for `localhost` from a CA of its own, and passes the
    /// rest through. It refuses a connection that doesn't ask for TLS.
    struct TlsFront {
        port: u16,
        /// The front's CA, as a PEM file, for `sslrootcert`.
        ca: std::path::PathBuf,
        handshakes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        /// The database behind it, and a fresh schema there.
        database: tokio_postgres::Config,
        schema: String,
        _runtime: tokio::runtime::Runtime,
    }

    /// The first bytes of Postgres's SSLRequest: its length and its code.
    const SSL_REQUEST: [u8; 8] = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];

    impl TlsFront {
        fn start() -> Option<Self> {
            use rustls::pki_types::PrivateKeyDer;
            use std::sync::{Arc, atomic::Ordering};
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let url = std::env::var("FINITE_TEST_DATABASE_URL").ok()?;
            let schema = new_schema(&url).unwrap();
            let (database, _) = open(&url).unwrap();
            let upstream = match (&database.get_hosts()[0], database.get_ports()[0]) {
                (tokio_postgres::config::Host::Tcp(host), port) => format!("{host}:{port}"),
                _ => panic!("the test database must be reached over TCP"),
            };

            let ca_key = rcgen::KeyPair::generate().unwrap();
            let mut ca_params = rcgen::CertificateParams::new(Vec::new()).unwrap();
            ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
            let ca_cert = ca_params.self_signed(&ca_key).unwrap();
            let ca =
                std::env::temp_dir().join(format!("finite-ca-{}.pem", crate::hub::random_id(8)));
            std::fs::write(&ca, ca_cert.pem()).unwrap();
            let key = rcgen::KeyPair::generate().unwrap();
            let cert = rcgen::CertificateParams::new(vec!["localhost".to_owned()])
                .unwrap()
                .signed_by(&key, &rcgen::Issuer::from_params(&ca_params, &ca_key))
                .unwrap();
            let config = rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )
            .unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

            let runtime = tokio::runtime::Runtime::new().unwrap();
            let listener = runtime
                .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            let handshakes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = handshakes.clone();
            runtime.spawn(async move {
                loop {
                    let Ok((mut client, _)) = listener.accept().await else {
                        return;
                    };
                    let (acceptor, upstream, counted) =
                        (acceptor.clone(), upstream.clone(), counted.clone());
                    tokio::spawn(async move {
                        let mut first = [0; 8];
                        if client.read_exact(&mut first).await.is_err() || first != SSL_REQUEST {
                            return;
                        }
                        client.write_all(b"S").await.unwrap();
                        let Ok(mut tls) = acceptor.accept(client).await else {
                            return;
                        };
                        counted.fetch_add(1, Ordering::SeqCst);
                        let mut db = tokio::net::TcpStream::connect(&upstream).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut tls, &mut db).await;
                    });
                }
            });
            Some(Self {
                port,
                ca,
                handshakes,
                database,
                schema,
                _runtime: runtime,
            })
        }

        /// Opens the store through the front, as `host`, with these TLS settings.
        fn connect(&self, host: &str, tls: &str) -> io::Result<PgStore> {
            let user = self.database.get_user().unwrap_or("postgres");
            let password = self
                .database
                .get_password()
                .map(|p| format!(":{}", String::from_utf8_lossy(p)))
                .unwrap_or_default();
            let db = self.database.get_dbname().unwrap_or(user);
            let tls = tls.replace("CA", &self.ca.display().to_string());
            let url = format!(
                "postgres://{user}{password}@{host}:{}/{db}?options=-c%20search_path%3D{}&{tls}",
                self.port, self.schema
            );
            PgStore::connect(&url, "http://a", LEASE)
        }

        fn handshakes(&self) -> usize {
            self.handshakes.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Drop for TlsFront {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.ca);
        }
    }

    /// A store that connects with TLS works like any other, and its traffic
    /// really goes through a handshake.
    #[test]
    fn the_store_connects_over_tls() {
        let Some(front) = TlsFront::start() else {
            eprintln!("skipping: set FINITE_TEST_DATABASE_URL");
            return;
        };
        let store = front.connect("localhost", "sslmode=require").unwrap();
        contract::check(&store);
        assert!(front.handshakes() >= 1, "the connection used TLS");
    }

    /// Each `sslmode` checks what libpq's does. The front's certificate is
    /// signed by its own CA, for `localhost` only.
    #[test]
    fn sslmode_decides_what_is_checked() {
        let Some(front) = TlsFront::start() else {
            eprintln!("skipping: set FINITE_TEST_DATABASE_URL");
            return;
        };
        let works = |host: &str, tls: &str| front.connect(host, tls).map(|_| ());
        // `prefer` and `require` encrypt, but take any certificate.
        works("127.0.0.1", "sslmode=prefer").unwrap();
        works("127.0.0.1", "sslmode=require").unwrap();
        // `verify-full` needs the CA, and the name in the certificate.
        works("localhost", "sslmode=verify-full&sslrootcert=CA").unwrap();
        let error = works("127.0.0.1", "sslmode=verify-full&sslrootcert=CA").unwrap_err();
        assert!(error.to_string().contains("not valid for name"), "{error}");
        let error = works("localhost", "sslmode=verify-full").unwrap_err();
        assert!(error.to_string().contains("UnknownIssuer"), "{error}");
        // `verify-ca` needs the CA, whatever the name.
        works("127.0.0.1", "sslmode=verify-ca&sslrootcert=CA").unwrap();
        works("localhost", "sslmode=verify-ca").unwrap_err();
        // `require` with a CA file checks the CA, as in libpq.
        works("127.0.0.1", "sslmode=require&sslrootcert=CA").unwrap();
        // The front refuses plain connections, so `disable` can't connect.
        works("localhost", "sslmode=disable").unwrap_err();
    }

    /// The test database itself has no TLS, like a local Postgres. The
    /// default, `prefer`, connects to it in plain text, and `require` refuses to.
    #[test]
    fn a_server_without_tls_works_unless_tls_is_required() {
        let Some(url) = test_database() else { return };
        PgStore::connect(&url, "http://a", LEASE).unwrap();
        let error = PgStore::connect(&format!("{url}&sslmode=require"), "http://a", LEASE)
            .err()
            .expect("require refuses a server without TLS");
        assert!(
            error.to_string().contains("server does not support TLS"),
            "{error}"
        );
    }
}
