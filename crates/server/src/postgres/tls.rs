//! TLS for the Postgres connection, set the way libpq reads it: `sslmode`
//! and `sslrootcert` in `FINITE_DATABASE_URL`.
//!
//! | `sslmode`          | Encrypted?             | Checks the certificate?           |
//! | ------------------ | ---------------------- | --------------------------------- |
//! | `disable`          | No                     | No                                |
//! | `allow`, `prefer`  | If the server offers it | No                               |
//! | `require`          | Yes                    | Only if `sslrootcert` is set      |
//! | `verify-ca`        | Yes                    | It's signed by a trusted CA       |
//! | `verify-full`      | Yes                    | That, and it names the host       |
//!
//! `prefer` is the default, as in libpq, so a local server without TLS
//! still works. `tokio-postgres` only knows `disable`, `prefer` and
//! `require`, and no `sslrootcert`, so Finite takes both out of the URL
//! before handing it on. The trusted CAs are the ones in `sslrootcert`, a
//! PEM file, or else the Mozilla list built into Finite (`webpki-roots`),
//! which covers public CAs like Let's Encrypt. Managed databases with their
//! own CA (RDS, Cloud SQL) need their CA file in `sslrootcert`.

use std::{io, path::PathBuf, sync::Arc};

use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme,
    client::{
        WebPkiServerVerifier,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime, pem::PemObject},
};
use tokio_postgres::config::SslMode;
use tokio_postgres_rustls::MakeRustlsConnect;

/// How much a connection checks, from `sslmode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// The TLS settings in a database URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub mode: Mode,
    /// `sslrootcert`: a PEM file of the CAs to trust.
    pub root: Option<PathBuf>,
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

impl Mode {
    fn parse(value: &str) -> io::Result<Self> {
        Ok(match value {
            "disable" => Self::Disable,
            // libpq's `allow` tries without TLS first. Taking TLS when the
            // server offers it is never less safe, so it's read as `prefer`.
            "allow" | "prefer" => Self::Prefer,
            "require" => Self::Require,
            "verify-ca" => Self::VerifyCa,
            "verify-full" => Self::VerifyFull,
            other => {
                return Err(invalid(format!(
                    "sslmode must be disable, allow, prefer, require, verify-ca or verify-full, not {other:?}"
                )));
            }
        })
    }
}

/// Splits the TLS settings out of a database URL, in either form libpq
/// takes: `postgres://…?sslmode=…` or `host=… sslmode=…`. Returns the URL
/// without them, for `tokio-postgres`.
pub fn split(url: &str) -> io::Result<(String, Settings)> {
    let mut settings = Settings {
        mode: Mode::Prefer,
        root: None,
    };
    let mut take = |key: &str, value: &str| -> io::Result<bool> {
        match key {
            "sslmode" => settings.mode = Mode::parse(value)?,
            // libpq 16 reads `system` as the operating system's CAs. The
            // closest Finite has is its built-in list, which is the default.
            "sslrootcert" if value == "system" => settings.root = None,
            "sslrootcert" => settings.root = Some(PathBuf::from(value)),
            _ => return Ok(false),
        }
        Ok(true)
    };
    let rest = if url.starts_with("postgres://") || url.starts_with("postgresql://") {
        match url.split_once('?') {
            None => url.to_owned(),
            Some((base, query)) => {
                let mut kept = Vec::new();
                for pair in query.split('&').filter(|p| !p.is_empty()) {
                    let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                    if !take(key, &decode(value)?)? {
                        kept.push(pair);
                    }
                }
                if kept.is_empty() {
                    base.to_owned()
                } else {
                    format!("{base}?{}", kept.join("&"))
                }
            }
        }
    } else {
        let mut kept = Vec::new();
        for word in url.split_whitespace() {
            let (key, value) = word.split_once('=').unwrap_or((word, ""));
            if !take(key, value.trim_matches('\''))? {
                kept.push(word);
            }
        }
        kept.join(" ")
    };
    Ok((rest, settings))
}

/// Undoes URL percent-encoding, as in `sslrootcert=%2Fetc%2Fca.pem`.
fn decode(value: &str) -> io::Result<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = value
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| invalid(format!("bad percent-encoding in {value:?}")))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| invalid(format!("{value:?} isn't UTF-8")))
}

impl Settings {
    /// What `tokio-postgres` should do: try TLS, insist on it, or skip it.
    pub fn ssl_mode(&self) -> SslMode {
        match self.mode {
            Mode::Disable => SslMode::Disable,
            Mode::Prefer => SslMode::Prefer,
            Mode::Require | Mode::VerifyCa | Mode::VerifyFull => SslMode::Require,
        }
    }

    /// The TLS connector for these settings.
    pub fn connector(&self) -> io::Result<MakeRustlsConnect> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let check = match (self.mode, &self.root) {
            (Mode::VerifyFull, _) => Check::Full,
            (Mode::VerifyCa, _) | (Mode::Require, Some(_)) => Check::Ca,
            _ => Check::Nothing,
        };
        let verifier: Arc<dyn ServerCertVerifier> = match check {
            Check::Nothing => Arc::new(Unchecked(provider.clone())),
            Check::Ca | Check::Full => {
                let full = WebPkiServerVerifier::builder_with_provider(
                    Arc::new(self.roots()?),
                    provider.clone(),
                )
                .build()
                .map_err(io::Error::other)?;
                if check == Check::Full {
                    full
                } else {
                    Arc::new(AnyName(full))
                }
            }
        };
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(io::Error::other)?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        Ok(MakeRustlsConnect::new(config))
    }

    fn roots(&self) -> io::Result<RootCertStore> {
        let mut roots = RootCertStore::empty();
        let Some(path) = &self.root else {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            return Ok(roots);
        };
        let unreadable = |e: &dyn std::fmt::Display| {
            io::Error::other(format!("couldn't read sslrootcert {}: {e}", path.display()))
        };
        for cert in CertificateDer::pem_file_iter(path).map_err(|e| unreadable(&e))? {
            roots
                .add(cert.map_err(|e| unreadable(&e))?)
                .map_err(|e| unreadable(&e))?;
        }
        if roots.is_empty() {
            return Err(unreadable(&"it holds no certificates"));
        }
        Ok(roots)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    /// `prefer`, and `require` without a CA file: encrypted, but anyone
    /// in the middle could present a certificate.
    Nothing,
    /// The chain must lead to a trusted CA, whatever name it carries.
    Ca,
    /// The chain, and the server's name in the certificate.
    Full,
}

/// Accepts any certificate, as libpq does for `require`. The handshake's
/// signatures are still checked, so the connection is encrypted with
/// whoever holds the certificate's key.
#[derive(Debug)]
struct Unchecked(Arc<CryptoProvider>);

impl ServerCertVerifier for Unchecked {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// `verify-ca`: the full check, except a certificate for another name is
/// fine. rustls checks the chain before the name, so a name error means the
/// chain already passed.
#[derive(Debug)]
struct AnyName(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for AnyName {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
        {
            Err(Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: Mode, root: Option<&str>) -> Settings {
        Settings {
            mode,
            root: root.map(PathBuf::from),
        }
    }

    #[test]
    fn the_url_keeps_everything_but_the_tls_settings() {
        let (url, found) = split(
            "postgres://u@db:5432/f?sslmode=verify-full&options=-c%20x%3Dy&sslrootcert=%2Fetc%2Fca.pem",
        )
        .unwrap();
        assert_eq!(url, "postgres://u@db:5432/f?options=-c%20x%3Dy");
        assert_eq!(found, settings(Mode::VerifyFull, Some("/etc/ca.pem")));

        let (url, found) = split("postgresql://u@db/f?sslmode=require").unwrap();
        assert_eq!(url, "postgresql://u@db/f");
        assert_eq!(found, settings(Mode::Require, None));

        let (url, found) = split("host=db user=u sslmode=verify-ca sslrootcert='/ca.pem'").unwrap();
        assert_eq!(url, "host=db user=u");
        assert_eq!(found, settings(Mode::VerifyCa, Some("/ca.pem")));
    }

    #[test]
    fn prefer_is_the_default_and_allow_reads_as_prefer() {
        assert_eq!(split("postgres://db/f").unwrap().1.mode, Mode::Prefer);
        assert_eq!(
            split("postgres://db/f?sslmode=allow").unwrap().1.mode,
            Mode::Prefer
        );
        let system = split("postgres://db/f?sslmode=verify-full&sslrootcert=system").unwrap();
        assert_eq!(system.1, settings(Mode::VerifyFull, None));
    }

    #[test]
    fn an_unknown_mode_is_an_error() {
        let error = split("postgres://db/f?sslmode=verify").unwrap_err();
        assert!(error.to_string().contains("verify-full"), "{error}");
    }

    #[test]
    fn a_missing_ca_file_is_an_error() {
        let error = settings(Mode::VerifyFull, Some("/nowhere/ca.pem"))
            .connector()
            .err()
            .unwrap();
        assert!(error.to_string().contains("/nowhere/ca.pem"), "{error}");
    }
}
