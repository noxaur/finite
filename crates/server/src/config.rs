//! Everything the server reads from its environment, parsed once at startup.
//!
//! `finite-server` and the router call [`Config::from_env`] first and fail
//! with the message it returns, so a mistyped value stops the process
//! instead of falling back to a default. Nothing else reads `FINITE_*`
//! variables, except `FINITE_CHROME` ([`crate::screenshot`] finds a browser
//! by itself when it's unset) and the tests' own switches.

use std::{path::PathBuf, time::Duration};

use crate::cluster::{Cluster, Lease, is_base_url};

/// How long an edit waits for its layout check by default. AX runs saw a
/// cold browser miss a shorter wait on most first edits, so agents rendered
/// to find out instead.
pub const DEFAULT_LAYOUT_WAIT: Duration = Duration::from_secs(5);

/// What a [`crate::Hub`] needs besides its store and cluster.
#[derive(Clone, Debug)]
pub struct Settings {
    /// `Host` names MCP and the API accept besides localhost and the
    /// cluster's servers: `FINITE_ALLOWED_HOSTS`.
    pub allowed_hosts: Vec<String>,
    /// How long an edit waits for its layout check before it answers without
    /// one: `FINITE_LAYOUT_WAIT_MS`. 0 leaves every note for the next result.
    pub layout_wait: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            allowed_hosts: Vec::new(),
            layout_wait: DEFAULT_LAYOUT_WAIT,
        }
    }
}

/// The Postgres database servers share (`FINITE_DATABASE_URL`).
#[derive(Clone, Debug)]
pub struct Database {
    pub url: String,
    /// `FINITE_DATABASE_SCHEMA`, for development builds.
    pub schema: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    /// The built frontend to serve: `FINITE_STATIC_DIR`.
    pub static_dir: Option<String>,
    pub database: Option<Database>,
    /// Where the folder store keeps designs: `FINITE_DATA_DIR`.
    pub data_dir: String,
    /// `FINITE_NODES`: every server's base URL, when each keeps its own folder.
    pub nodes: Option<Vec<String>>,
    /// `FINITE_NODE`: this server's position in `nodes`.
    node: Option<usize>,
    /// How the other servers and the router reach this one: `FINITE_NODE_URL`.
    pub node_url: String,
    /// Where routers share MCP sessions: `FINITE_SESSION_DIR`.
    pub session_dir: Option<PathBuf>,
    pub lease: Lease,
    pub settings: Settings,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::parse(|name| match std::env::var(name) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(error) => Err(format!("{name}: {error}")),
        })
    }

    /// Parses the variables `get` returns, or says which one is wrong.
    pub fn parse(get: impl Fn(&str) -> Result<Option<String>, String>) -> Result<Self, String> {
        let number = |name: &str| -> Result<Option<u64>, String> {
            get(name)?
                .map(|v| {
                    v.trim()
                        .parse()
                        .map_err(|_| format!("{name} must be a number, not {v:?}"))
                })
                .transpose()
        };
        let port = match number("FINITE_PORT")? {
            None => 4100,
            Some(p) => u16::try_from(p).map_err(|_| format!("FINITE_PORT {p} is not a port"))?,
        };
        let lease = match number("FINITE_LEASE_MS")? {
            None => Lease::default(),
            Some(ms) if ms >= 100 => Lease(Duration::from_millis(ms)),
            Some(_) => return Err("FINITE_LEASE_MS must be 100 or more milliseconds".into()),
        };
        let schema = get("FINITE_DATABASE_SCHEMA")?;
        // A deployment's tables must not land somewhere its operator didn't mean.
        if schema.is_some() && !cfg!(debug_assertions) {
            return Err("FINITE_DATABASE_SCHEMA is only for development builds; unset it".into());
        }
        let database = get("FINITE_DATABASE_URL")?.map(|url| Database { url, schema });
        let nodes = get("FINITE_NODES")?.map(|list| {
            list.split(',')
                .map(|n| n.trim().trim_end_matches('/').to_owned())
                .filter(|n| !n.is_empty())
                .collect::<Vec<_>>()
        });
        let node_url = match get("FINITE_NODE_URL")? {
            Some(url) => url.trim_end_matches('/').to_owned(),
            None => format!("http://127.0.0.1:{port}"),
        };
        if !is_base_url(&node_url) {
            return Err(format!(
                "FINITE_NODE_URL must look like http://10.0.0.2:4100, not {node_url:?}"
            ));
        }
        let allowed_hosts = get("FINITE_ALLOWED_HOSTS")?
            .iter()
            .flat_map(|list| list.split(','))
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(String::from)
            .collect();
        Ok(Self {
            port,
            static_dir: get("FINITE_STATIC_DIR")?,
            database,
            data_dir: get("FINITE_DATA_DIR")?.unwrap_or_else(|| "data".into()),
            nodes,
            node: number("FINITE_NODE")?.map(|n| n as usize),
            node_url,
            session_dir: get("FINITE_SESSION_DIR")?.map(PathBuf::from),
            lease,
            settings: Settings {
                allowed_hosts,
                layout_wait: number("FINITE_LAYOUT_WAIT_MS")?
                    .map_or(DEFAULT_LAYOUT_WAIT, Duration::from_millis),
            },
        })
    }

    /// The servers `FINITE_NODES` lists, as the server at `FINITE_NODE`; a
    /// single server without them.
    pub fn cluster(&self) -> Result<Cluster, String> {
        let Some(nodes) = &self.nodes else {
            return Ok(Cluster::default());
        };
        let me = self
            .node
            .ok_or("FINITE_NODES is set, so FINITE_NODE must be too")?;
        Cluster::new(nodes.clone(), me)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(pairs: &[(&str, &str)]) -> Result<Config, String> {
        Config::parse(|name| {
            Ok(pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned()))
        })
    }

    #[test]
    fn nothing_set_is_a_single_server_on_4100() {
        let config = parse(&[]).unwrap();
        assert_eq!(config.port, 4100);
        assert_eq!(config.node_url, "http://127.0.0.1:4100");
        assert_eq!(config.data_dir, "data");
        assert_eq!(config.lease.0, Duration::from_secs(10));
        assert_eq!(config.settings.layout_wait, DEFAULT_LAYOUT_WAIT);
        assert_eq!(config.cluster().unwrap(), Cluster::default());
    }

    #[test]
    fn a_value_that_does_not_parse_is_an_error() {
        for (name, value) in [
            ("FINITE_PORT", "http"),
            ("FINITE_PORT", "70000"),
            ("FINITE_LEASE_MS", "5"),
            ("FINITE_LAYOUT_WAIT_MS", "soon"),
            ("FINITE_NODE", "one"),
            ("FINITE_NODE_URL", "10.0.0.2:4100"),
        ] {
            let error = parse(&[(name, value)]).unwrap_err();
            assert!(error.contains(name), "{error}");
        }
    }

    #[test]
    fn the_node_list_needs_this_servers_position() {
        let list = ("FINITE_NODES", "http://a:1, http://b:1/");
        let config = parse(&[list]).unwrap();
        assert!(config.cluster().unwrap_err().contains("FINITE_NODE"));
        let config = parse(&[list, ("FINITE_NODE", "1")]).unwrap();
        let cluster = config.cluster().unwrap();
        assert_eq!(cluster.nodes(), ["http://a:1", "http://b:1"]);
        assert!(cluster.has_me());
        let config = parse(&[list, ("FINITE_NODE", "2")]).unwrap();
        assert!(config.cluster().is_err());
    }

    #[test]
    fn allowed_hosts_are_split_and_trimmed() {
        let config = parse(&[("FINITE_ALLOWED_HOSTS", "a.example, b.example ,")]).unwrap();
        assert_eq!(config.settings.allowed_hosts, ["a.example", "b.example"]);
    }
}
