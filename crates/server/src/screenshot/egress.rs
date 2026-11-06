//! The only way out of the screenshot browser.
//!
//! The server is hosted and shared, and a page that runs scripts can `fetch`.
//! If Chrome connected directly, a page could ask for `169.254.169.254` (a
//! cloud's metadata service), `localhost` or any private address, and read
//! the answer in its screenshot (server-side request forgery). So Chrome is
//! started with `--proxy-server` pointing at this proxy, and with loopback
//! taken off its bypass list. The proxy resolves each host itself, refuses
//! every address that isn't globally routable ([`is_global`]), and connects to
//! the address it checked, so a DNS answer can't change between the check and
//! the connection (DNS rebinding). Only ports 80 and 443 are allowed.
//!
//! It speaks the two things a browser sends a proxy: `CONNECT host:port` for
//! `https:` and `wss:`, and plain `GET http://host/path` for `http:`.
//! Redirects come back to the proxy as new requests, so each hop is checked.

use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

/// Connections served at once. A page with assets on a dozen hosts opens
/// about six to each; further connections are closed at once.
const MAX_CONNECTIONS: usize = 128;
/// The longest request head (request line and headers) accepted.
const MAX_HEAD: usize = 16 * 1024;
/// How long a client may take to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a name lookup may take.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// How long connecting to one address may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How many of a host's addresses are tried.
const MAX_ATTEMPTS: usize = 4;
/// The longest one connection lives, tunnel or request. A capture's page
/// loads for at most 20 seconds and runs for at most 10 more.
const LIFETIME: Duration = Duration::from_secs(120);

/// What the proxy allows beyond public addresses on ports 80 and 443.
/// Production captures use [`Policy::default`], which allows nothing more.
/// Tests that serve a page from a local server can name its address; that
/// field doesn't exist outside tests.
#[derive(Clone, Debug, Default)]
pub struct Policy {
    #[cfg(test)]
    pub allow: Vec<SocketAddr>,
}

impl Policy {
    fn port_ok(&self, port: u16) -> bool {
        matches!(port, 80 | 443) || self.exempt_port(port)
    }

    fn addr_ok(&self, addr: SocketAddr) -> bool {
        (is_global(addr.ip()) && matches!(addr.port(), 80 | 443)) || self.exempt(addr)
    }

    #[cfg(test)]
    fn exempt(&self, addr: SocketAddr) -> bool {
        self.allow.contains(&addr)
    }

    #[cfg(not(test))]
    fn exempt(&self, _: SocketAddr) -> bool {
        false
    }

    #[cfg(test)]
    fn exempt_port(&self, port: u16) -> bool {
        self.allow.iter().any(|a| a.port() == port)
    }

    #[cfg(not(test))]
    fn exempt_port(&self, _: u16) -> bool {
        false
    }
}

/// A running proxy on a loopback port, stopped when dropped. Dropping it
/// also closes every connection it is serving.
pub struct Egress {
    addr: SocketAddr,
    task: JoinHandle<()>,
}

impl Drop for Egress {
    fn drop(&mut self) {
        // Aborting the accept task drops its JoinSet, which aborts the connections.
        self.task.abort();
    }
}

impl Egress {
    pub async fn start(policy: Policy) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let addr = listener.local_addr()?;
        let task = tokio::spawn(accept(listener, Arc::new(policy)));
        Ok(Self { addr, task })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
}

async fn accept(listener: TcpListener, policy: Arc<Policy>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((client, _)) = accepted else { continue };
                // Over the limit, the client is dropped, which closes it.
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let policy = policy.clone();
                connections.spawn(async move {
                    let _slot = slot;
                    let _ = timeout(LIFETIME, serve(client, &policy)).await;
                });
            }
            // Reap finished connections so the set doesn't grow.
            Some(_) = connections.join_next() => {}
        }
    }
}

/// A request the proxy refuses, and the status to say so with.
struct Refusal(u16, &'static str);

const BAD_REQUEST: Refusal = Refusal(400, "Bad Request");
const FORBIDDEN: Refusal = Refusal(403, "Forbidden");
const BAD_GATEWAY: Refusal = Refusal(502, "Bad Gateway");

async fn serve(mut client: TcpStream, policy: &Policy) {
    if let Err(Refusal(code, reason)) = handle(&mut client, policy).await {
        let reply =
            format!("HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let _ = client.write_all(reply.as_bytes()).await;
    }
    let _ = client.shutdown().await;
}

async fn handle(client: &mut TcpStream, policy: &Policy) -> Result<(), Refusal> {
    let (head, extra) = timeout(HEAD_TIMEOUT, read_head(client))
        .await
        .map_err(|_| BAD_REQUEST)?
        .ok_or(BAD_REQUEST)?;
    let request = Request::parse(&head).ok_or(BAD_REQUEST)?;
    if request.method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_authority(&request.target, None).ok_or(BAD_REQUEST)?;
        let mut upstream = connect(policy, &host, port).await?;
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .map_err(|_| BAD_GATEWAY)?;
        if !extra.is_empty() {
            upstream.write_all(&extra).await.map_err(|_| BAD_GATEWAY)?;
        }
        let _ = tokio::io::copy_bidirectional(client, &mut upstream).await;
        return Ok(());
    }

    let target = request.target.strip_prefix("http://").ok_or(BAD_REQUEST)?;
    let end = target.find(['/', '?', '#']).unwrap_or(target.len());
    let (authority, rest) = target.split_at(end);
    let path = match rest.chars().next() {
        None => "/".to_owned(),
        Some('/') => rest.to_owned(),
        Some(_) => format!("/{rest}"),
    };
    let (host, port) = split_authority(authority, Some(80)).ok_or(BAD_REQUEST)?;
    let mut upstream = connect(policy, &host, port).await?;
    // One request per connection: the upstream is told to close, and the
    // client then opens a new proxy connection, checked afresh, for the
    // next request. Whatever else it sent on this one only reaches the
    // address checked above.
    let mut out = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
        request.method, path, authority
    );
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if lower == "host"
            || lower == "connection"
            || lower == "keep-alive"
            || lower == "upgrade"
            || lower.starts_with("proxy-")
        {
            continue;
        }
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    upstream
        .write_all(out.as_bytes())
        .await
        .map_err(|_| BAD_GATEWAY)?;
    if !extra.is_empty() {
        upstream.write_all(&extra).await.map_err(|_| BAD_GATEWAY)?;
    }
    let _ = tokio::io::copy_bidirectional(client, &mut upstream).await;
    Ok(())
}

/// Reads up to the blank line that ends a request head. Returns the head
/// and whatever followed it, or `None` if the client closed or sent too much.
async fn read_head(client: &mut TcpStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let extra = buf.split_off(end + 4);
            return Some((buf, extra));
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        match client.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn parse(head: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(head).ok()?;
        let mut lines = text.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let (method, target, version) = (first.next()?, first.next()?, first.next()?);
        if first.next().is_some()
            || method.is_empty()
            || !method.bytes().all(|b| b.is_ascii_alphabetic())
            || !version.starts_with("HTTP/1.")
        {
            return None;
        }
        let mut headers = Vec::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            let (name, value) = line.split_once(':')?;
            if name.is_empty()
                || name
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
            {
                return None;
            }
            headers.push((name.to_owned(), value.trim().to_owned()));
        }
        Some(Self {
            method: method.to_owned(),
            target: target.to_owned(),
            headers,
        })
    }
}

/// Splits `host:port` or `[v6]:port` into host and port. A port is required
/// unless `default` gives one. Refuses user info, which makes a URL's host
/// ambiguous, and anything that isn't an authority.
fn split_authority(authority: &str, default: Option<u16>) -> Option<(String, u16)> {
    if authority.is_empty()
        || authority.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '@' | '/' | '?' | '#' | '\\')
        })
    {
        return None;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        (host, after.strip_prefix(':'))
    } else if let Some((host, port)) = authority.split_once(':') {
        if port.contains(':') {
            return None;
        }
        (host, Some(port))
    } else {
        (authority, None)
    };
    if host.is_empty() {
        return None;
    }
    let port = match port {
        Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            p.parse::<u16>().ok().filter(|p| *p > 0)?
        }
        Some(_) => return None,
        None => default?,
    };
    Some((host.to_owned(), port))
}

/// Resolves `host`, drops every address the policy refuses, and connects to
/// the first that answers. The address connected to is the one that was checked.
async fn connect(policy: &Policy, host: &str, port: u16) -> Result<TcpStream, Refusal> {
    if !policy.port_ok(port) {
        return Err(FORBIDDEN);
    }
    let resolved: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => timeout(LOOKUP_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| BAD_GATEWAY)?
            .map_err(|_| BAD_GATEWAY)?
            .collect(),
    };
    if resolved.is_empty() {
        return Err(BAD_GATEWAY);
    }
    let allowed: Vec<SocketAddr> = resolved
        .into_iter()
        .filter(|a| policy.addr_ok(*a))
        .take(MAX_ATTEMPTS)
        .collect();
    if allowed.is_empty() {
        return Err(FORBIDDEN);
    }
    for addr in allowed {
        if let Ok(Ok(stream)) = timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            let _ = stream.set_nodelay(true);
            return Ok(stream);
        }
    }
    Err(BAD_GATEWAY)
}

/// Whether `ip` is a publicly routable unicast address: not loopback, private,
/// link-local, shared (CGNAT), unique-local, multicast, unspecified, reserved,
/// documentation or benchmarking space, and not a form that embeds one of
/// those (an IPv4-mapped IPv6 address, NAT64, 6to4).
pub fn is_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_global_v4(ip),
        IpAddr::V6(ip) => is_global_v6(ip),
    }
}

fn is_global_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0                                   // 0.0.0.0/8, "this network"
        || a == 10                             // private
        || (a == 100 && (64..128).contains(&b)) // 100.64.0.0/10, CGNAT
        || a == 127                            // loopback
        || (a == 169 && b == 254)              // link-local, cloud metadata
        || (a == 172 && (16..32).contains(&b)) // private
        || (a == 192 && b == 0 && c == 0)      // 192.0.0.0/24, IETF protocol assignments
        || (a == 192 && b == 0 && c == 2)      // documentation
        || (a == 192 && b == 88 && c == 99)    // deprecated 6to4 relay anycast
        || (a == 192 && b == 168)              // private
        || (a == 198 && (b == 18 || b == 19))  // 198.18.0.0/15, benchmarking
        || (a == 198 && b == 51 && c == 100)   // documentation
        || (a == 203 && b == 0 && c == 113)    // documentation
        || a >= 224) // multicast, reserved, and the broadcast address
}

fn is_global_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| {
        let [a, b] = hi.to_be_bytes();
        let [c, d] = lo.to_be_bytes();
        is_global_v4(Ipv4Addr::new(a, b, c, d))
    };
    // ::/96 holds ::, ::1 and the deprecated IPv4-compatible form; refuse all.
    if s[..6] == [0; 6] {
        return false;
    }
    // ::ffff:a.b.c.d, IPv4-mapped.
    if s[..5] == [0; 5] && s[5] == 0xffff {
        return embedded(s[6], s[7]);
    }
    // 64:ff9b::/96, NAT64: the address inside decides. 64:ff9b:1::/48 is
    // local-use NAT64 and is refused with the rest of the space below.
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return embedded(s[6], s[7]);
    }
    // 2002::/16, 6to4: the IPv4 address sits in bits 16 to 48.
    if s[0] == 0x2002 {
        return embedded(s[1], s[2]);
    }
    // Only 2000::/3 is global unicast; the rest is loopback, unique-local
    // (fc00::/7), link-local (fe80::/10), site-local, multicast (ff00::/8)
    // and reserved.
    if s[0] & 0xe000 != 0x2000 {
        return false;
    }
    !(s[0] == 0x2001 && (s[1] < 0x200            // 2001::/23: IETF assignments, Teredo
            || s[1] == 0xdb8                     // documentation
            || matches!(s[1] & 0xfff0, 0x10 | 0x20 | 0x30))) // ORCHID, drone IDs
        && !(s[0] == 0x3fff && s[1] < 0x1000) // 3fff::/20, documentation
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn ipv4_ranges_that_are_not_global_are_refused() {
        for s in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.255.255.255",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "169.254.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.254",
            "255.255.255.255",
        ] {
            assert!(!is_global(ip(s)), "{s} should be refused");
        }
    }

    #[test]
    fn ipv4_public_addresses_are_allowed() {
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "9.255.255.255",
            "11.0.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "126.255.255.255",
            "128.0.0.1",
            "169.253.255.255",
            "169.255.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.0.1.1",
            "192.0.3.1",
            "192.167.255.255",
            "192.169.0.1",
            "198.17.255.255",
            "198.20.0.1",
            "198.51.99.1",
            "198.51.101.1",
            "203.0.112.1",
            "203.0.114.1",
            "223.255.255.255",
            "93.184.216.34",
        ] {
            assert!(is_global(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn ipv6_ranges_that_are_not_global_are_refused() {
        for s in [
            "::",
            "::1",
            "::2",
            "::127.0.0.1",
            "::10.0.0.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "ff02::1",
            "ff0e::1",
            "100::1",
            "2001::1",
            "2001:1::1",
            "2001:db8::1",
            "2001:10::1",
            "2001:2f::1",
            "3fff::1",
            "3fff:fff::1",
            "5f00::1",
            "64:ff9b:1::1",
            "1::1",
            "4000::1",
            // IPv4-mapped, NAT64 and 6to4 forms of addresses that are refused.
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.1.2.3",
            "::ffff:192.168.0.1",
            "::ffff:100.64.0.1",
            "::ffff:0.0.0.0",
            "::ffff:255.255.255.255",
            "64:ff9b::7f00:1",
            "64:ff9b::a9fe:a9fe",
            "2002:7f00:1::1",
            "2002:a9fe:a9fe::1",
            "2002:c0a8:101::",
        ] {
            assert!(!is_global(ip(s)), "{s} should be refused");
        }
    }

    #[test]
    fn ipv6_public_addresses_are_allowed() {
        for s in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001::200e",
            "2001:200::1",
            "2400:cb00::1",
            "3ffe::1",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::1",
        ] {
            assert!(is_global(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn authorities_are_split_strictly() {
        let split = |s: &str, d| split_authority(s, d);
        assert_eq!(
            split("example.com:443", None),
            Some(("example.com".into(), 443))
        );
        assert_eq!(
            split("example.com", Some(80)),
            Some(("example.com".into(), 80))
        );
        assert_eq!(split("example.com", None), None);
        assert_eq!(split("[::1]:443", None), Some(("::1".into(), 443)));
        assert_eq!(split("[::1]", Some(80)), Some(("::1".into(), 80)));
        assert_eq!(split("::1:443", None), None);
        assert_eq!(split("user@example.com:443", None), None);
        assert_eq!(split("example.com:0", None), None);
        assert_eq!(split("example.com:99999", None), None);
        assert_eq!(split("example.com:", None), None);
        assert_eq!(split("example.com:44 3", None), None);
        assert_eq!(split("", Some(80)), None);
        assert_eq!(split(":443", None), None);
        assert_eq!(split("a.com\\@b.com:443", None), None);
    }

    /// Sends `request` to a proxy and returns everything it answers.
    async fn ask(proxy: &Egress, request: &str) -> String {
        let mut client = TcpStream::connect(proxy.addr()).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let _ = timeout(Duration::from_secs(5), client.read_to_end(&mut answer)).await;
        String::from_utf8_lossy(&answer).into_owned()
    }

    fn status(answer: &str) -> &str {
        answer.lines().next().unwrap_or("")
    }

    #[tokio::test]
    async fn the_proxy_refuses_internal_destinations_without_connecting() {
        let proxy = Egress::start(Policy::default()).await.unwrap();
        // None of these may reach the network: a connection to a private or
        // metadata address would hang until the connect timeout instead.
        for target in [
            "169.254.169.254:80",
            "127.0.0.1:443",
            "127.0.0.1:80",
            "10.0.0.1:443",
            "192.168.1.1:80",
            "100.64.0.1:443",
            "[::1]:443",
            "[::ffff:169.254.169.254]:80",
            "[::ffff:7f00:1]:443",
            "[fd00::1]:443",
            "[fe80::1]:80",
            "0.0.0.0:80",
            "255.255.255.255:80",
            "localhost:443",
            "localhost:80",
        ] {
            let started = std::time::Instant::now();
            let answer = ask(
                &proxy,
                &format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n"),
            )
            .await;
            assert_eq!(
                status(&answer),
                "HTTP/1.1 403 Forbidden",
                "CONNECT {target}: {answer:?}"
            );
            assert!(
                started.elapsed() < Duration::from_secs(4),
                "{target} was slow"
            );
            let answer = ask(
                &proxy,
                &format!("GET http://{target}/ HTTP/1.1\r\nHost: {target}\r\n\r\n"),
            )
            .await;
            // `GET http://host:443/` is a valid request for the same checks.
            assert_eq!(
                status(&answer),
                "HTTP/1.1 403 Forbidden",
                "GET {target}: {answer:?}"
            );
        }
    }

    #[tokio::test]
    async fn the_proxy_allows_only_ports_80_and_443() {
        let proxy = Egress::start(Policy::default()).await.unwrap();
        for target in [
            "1.1.1.1:22",
            "1.1.1.1:25",
            "1.1.1.1:8080",
            "1.1.1.1:6379",
            "example.com:5432",
        ] {
            let answer = ask(&proxy, &format!("CONNECT {target} HTTP/1.1\r\n\r\n")).await;
            assert_eq!(status(&answer), "HTTP/1.1 403 Forbidden", "{target}");
        }
    }

    #[tokio::test]
    async fn the_proxy_refuses_malformed_requests() {
        let proxy = Egress::start(Policy::default()).await.unwrap();
        for request in [
            "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
            "GET ftp://example.com/ HTTP/1.1\r\n\r\n",
            "GET http://user@example.com/ HTTP/1.1\r\n\r\n",
            "CONNECT example.com HTTP/1.1\r\n\r\n",
            "CONNECT user@example.com:443 HTTP/1.1\r\n\r\n",
            "nonsense\r\n\r\n",
            "GET http://example.com/ HTTP/1.1\r\nbroken header\r\n\r\n",
        ] {
            let answer = ask(&proxy, request).await;
            assert_eq!(status(&answer), "HTTP/1.1 400 Bad Request", "{request:?}");
        }
    }

    #[tokio::test]
    async fn the_proxy_tunnels_to_an_allowed_address() {
        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    while let Ok(n) = s.read(&mut buf).await {
                        if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        // Without the allowance, the same destination is refused.
        let closed = Egress::start(Policy::default()).await.unwrap();
        let answer = ask(&closed, &format!("CONNECT {echo_addr} HTTP/1.1\r\n\r\n")).await;
        assert_eq!(status(&answer), "HTTP/1.1 403 Forbidden");

        let open = Egress::start(Policy {
            allow: vec![echo_addr],
        })
        .await
        .unwrap();
        let mut client = TcpStream::connect(open.addr()).await.unwrap();
        client
            .write_all(format!("CONNECT {echo_addr} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut buf = [0u8; 64];
        let n = client.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        client.write_all(b"ping").await.unwrap();
        let n = client.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"ping");
    }

    #[tokio::test]
    async fn plain_http_requests_are_forwarded_in_origin_form() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        let seen = tokio::spawn(async move {
            let (mut s, _) = server.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        let proxy = Egress::start(Policy { allow: vec![addr] }).await.unwrap();
        let answer = ask(
            &proxy,
            &format!(
                "GET http://{addr}/img.png?x=1 HTTP/1.1\r\nHost: {addr}\r\nProxy-Connection: keep-alive\r\nAccept: image/*\r\n\r\n"
            ),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer:?}");
        assert!(answer.ends_with("ok"));
        let request = seen.await.unwrap();
        assert!(
            request.starts_with("GET /img.png?x=1 HTTP/1.1\r\n"),
            "{request:?}"
        );
        assert!(request.contains("Connection: close"));
        assert!(request.contains("Accept: image/*"));
        assert!(!request.to_ascii_lowercase().contains("proxy-"));
    }

    #[tokio::test]
    async fn the_proxy_caps_how_many_connections_it_serves() {
        let proxy = Egress::start(Policy::default()).await.unwrap();
        // Idle connections that never send a head hold their slots.
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            held.push(TcpStream::connect(proxy.addr()).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut extra = TcpStream::connect(proxy.addr()).await.unwrap();
        extra
            .write_all(b"CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut buf = Vec::new();
        let read = timeout(Duration::from_secs(3), extra.read_to_end(&mut buf)).await;
        // Closed without an answer, not served.
        assert!(read.is_ok(), "the extra connection should be closed");
        assert!(buf.is_empty(), "{buf:?}");
        drop(held);
    }
}
