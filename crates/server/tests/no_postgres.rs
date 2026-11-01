//! A build without the `postgres` feature has no shared store. If someone
//! sets `FINITE_DATABASE_URL` anyway, the server and the router must refuse
//! to start, not quietly fall back to a data folder of their own: that
//! server's designs would never reach the others.
#![cfg(not(feature = "postgres"))]

use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn run(args: &[&str]) -> (Option<i32>, String) {
    let data = std::env::temp_dir().join(format!("finite-no-pg-{}", std::process::id()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_finite-server"))
        .args(args)
        .env(
            "FINITE_DATABASE_URL",
            "postgres://finite@db.internal/finite",
        )
        .env("FINITE_DATA_DIR", &data)
        .env("FINITE_PORT", "0")
        .env_remove("FINITE_NODES")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            panic!("finite-server {args:?} started without Postgres support");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
    let _ = std::fs::remove_dir_all(data);
    (status.code(), stderr)
}

#[test]
fn a_database_url_without_postgres_support_is_an_error() {
    for args in [&[][..], &["router"]] {
        let (code, stderr) = run(args);
        assert_eq!(code, Some(1), "finite-server {args:?}: {stderr}");
        assert!(
            stderr.contains("built without Postgres") && stderr.contains("--features postgres"),
            "finite-server {args:?} says why: {stderr}"
        );
    }
}
