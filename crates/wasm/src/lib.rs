//! The document model from `finite-design`, compiled to WebAssembly for the
//! web viewer, so the browser applies ops and exports HTML with the same
//! Rust code as the server.
//!
//! The exports are a plain C ABI. The TypeScript side
//! (`apps/web/src/design/wasm.ts`) is hand-written and small, because every
//! call passes UTF-8 strings, mostly JSON:
//!
//! 1. JS asks for an input buffer of `n` bytes with [`input`], which returns
//!    its address in linear memory, and writes the arguments there.
//! 2. It calls a function with the arguments' byte lengths. A function that
//!    returns text writes it to the output buffer and returns its length.
//!    A negative length means an error, and the output holds the message.
//! 3. JS reads the result at [`output`] before the next call overwrites it.
//!
//! A replica is a handle: an index into a table of documents here.
//! `crates/wasm/build.mjs` builds this crate for `wasm32-unknown-unknown`.

mod replica;

use std::cell::RefCell;

use finite_design::{flow, html};
pub use replica::Replica;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static REPLICAS: RefCell<Vec<Option<Replica>>> = const { RefCell::new(Vec::new()) };
    /// The message of the last panic. A panic aborts, so JS reads it after
    /// the trap with [`panic_message`] and [`panic_message_len`].
    static PANIC: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Call once after instantiating: keeps panic messages for JS to read.
#[unsafe(no_mangle)]
pub extern "C" fn init() {
    std::panic::set_hook(Box::new(|info| {
        PANIC.with(|p| *p.borrow_mut() = info.to_string());
    }));
}

/// Makes the input buffer `len` bytes long, keeping what it holds, and
/// returns its address.
#[unsafe(no_mangle)]
pub extern "C" fn input(len: usize) -> *mut u8 {
    INPUT.with(|buffer| {
        let mut buffer = buffer.borrow_mut();
        buffer.resize(len, 0);
        buffer.as_mut_ptr()
    })
}

/// The address of the last result.
#[unsafe(no_mangle)]
pub extern "C" fn output() -> *const u8 {
    OUTPUT.with(|buffer| buffer.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn panic_message() -> *const u8 {
    PANIC.with(|p| p.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn panic_message_len() -> usize {
    PANIC.with(|p| p.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_new() -> u32 {
    REPLICAS.with(|table| {
        let mut table = table.borrow_mut();
        let slot = table.iter().position(Option::is_none).unwrap_or_else(|| {
            table.push(None);
            table.len() - 1
        });
        table[slot] = Some(Replica::default());
        slot as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_free(handle: u32) {
    REPLICAS.with(|table| {
        if let Some(slot) = table.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// [`Replica::load`] with the nodes JSON in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_load(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.load(text(input, 0, len)?))
    })
}

/// [`Replica::apply`] with the ops JSON in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_apply(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.apply(text(input, 0, len)?))
    })
}

/// [`Replica::export`] for the node id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_export(handle: u32, len: usize, ids: u32) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.export(text(input, 0, len)?, ids != 0)))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_pages(handle: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.pages()))
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_tokens(handle: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.tokens()))
}

/// [`Replica::expand`] for the instance id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_expand(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.expand(text(input, 0, len)?)))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_take_dirty(handle: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.take_dirty()))
}

/// [`Replica::set_client`] with the client id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_set_client(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| {
            replica.set_client(text(input, 0, len)?);
            Ok(String::new())
        })
    })
}

/// [`Replica::draft`] for mutation id `seed`, with the edits JSON (or
/// `null`) in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_draft(handle: u32, seed: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.draft(seed.into(), text(input, 0, len)?))
    })
}

/// [`Replica::propose`] for mutation `mid`, with the edits JSON in the
/// first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_propose(handle: u32, mid: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| replica.propose(mid.into(), text(input, 0, len)?))
    })
}

/// [`Replica::receive`] with the ops JSON in the first `len` input bytes.
/// `mine` is the tab's mutation id for the change, or 0 when it isn't the
/// tab's own (mutation ids start at 1).
#[unsafe(no_mangle)]
pub extern "C" fn replica_receive(handle: u32, len: usize, mine: u32) -> i32 {
    with_replica(handle, |replica| {
        let mine = (mine != 0).then_some(mine.into());
        with_input(|input| replica.receive(text(input, 0, len)?, mine))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_settle(handle: u32, mid: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.settle(mid.into())))
}

/// [`Replica::has_local`], as 1 or 0. Not a handle error: a freed replica has none.
#[unsafe(no_mangle)]
pub extern "C" fn replica_has_local(handle: u32) -> u32 {
    REPLICAS.with(|table| {
        table
            .borrow()
            .get(handle as usize)
            .and_then(Option::as_ref)
            .is_some_and(Replica::has_local)
            .into()
    })
}

/// [`Replica::component_info`] for the node id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_component_info(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.component_info(text(input, 0, len)?)))
    })
}

/// [`html::is_safe_attr`] for a name in the first `name_len` input bytes
/// and a value in the `value_len` bytes after it. Returns 1 or 0.
#[unsafe(no_mangle)]
pub extern "C" fn is_safe_attr(name_len: usize, value_len: usize) -> u32 {
    with_input(
        |input| match (text(input, 0, name_len), text(input, name_len, value_len)) {
            (Ok(name), Ok(value)) => html::is_safe_attr(name, value) as u32,
            _ => 0,
        },
    )
}

/// [`Replica::token_style`] for the artboard id in the first `len` input
/// bytes, for a shadow root when `shadow` is 1.
#[unsafe(no_mangle)]
pub extern "C" fn replica_token_style(handle: u32, len: usize, shadow: u32) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.token_style(text(input, 0, len)?, shadow != 0)))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn replica_flow(handle: u32) -> i32 {
    with_replica(handle, |replica| Ok(replica.flow()))
}

/// [`Replica::flow_target`] for the artboard id in the first `len` input
/// bytes, from a screen `width` pixels wide, or of any width when it's NaN.
#[unsafe(no_mangle)]
pub extern "C" fn replica_flow_target(handle: u32, len: usize, width: f64) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| {
            Ok(replica.flow_target(text(input, 0, len)?, (!width.is_nan()).then_some(width)))
        })
    })
}

/// The rules that need no document, as JSON (see [`Rules`]).
#[unsafe(no_mangle)]
pub extern "C" fn rules() -> i32 {
    respond(Ok(
        serde_json::to_string(&Rules::default()).expect("rules serialize")
    ))
}

/// [`html::bootstrap_script`] for the nonce in the first `nonce_len` input
/// bytes and the JSON object of page storage in the `storage_len` bytes after it.
#[unsafe(no_mangle)]
pub extern "C" fn bootstrap_script(nonce_len: usize, storage_len: usize) -> i32 {
    respond(with_input(|input| {
        let nonce = text(input, 0, nonce_len)?;
        let storage = serde_json::from_str(text(input, nonce_len, storage_len)?)
            .map_err(|e| e.to_string())?;
        Ok(html::bootstrap_script(nonce, &storage))
    }))
}

/// [`flow::href_target`] for the `href` in the first `len` input bytes, as
/// JSON: the artboard id, or `null` when it isn't a link to an artboard.
#[unsafe(no_mangle)]
pub extern "C" fn artboard_target(len: usize) -> i32 {
    respond(with_input(|input| {
        let target = flow::href_target(text(input, 0, len)?);
        Ok(serde_json::to_string(&target).expect("text serializes"))
    }))
}

/// [`flow::percent_decode`] for the text in the first `len` input bytes, as
/// JSON: the decoded text, or `null` when it's malformed.
#[unsafe(no_mangle)]
pub extern "C" fn percent_decode(len: usize) -> i32 {
    respond(with_input(|input| {
        let decoded = flow::percent_decode(text(input, 0, len)?);
        Ok(serde_json::to_string(&decoded).expect("text serializes"))
    }))
}

/// [`Replica::pixel_size`] for the node id in the first `len` input bytes.
#[unsafe(no_mangle)]
pub extern "C" fn replica_pixel_size(handle: u32, len: usize) -> i32 {
    with_replica(handle, |replica| {
        with_input(|input| Ok(replica.pixel_size(text(input, 0, len)?)))
    })
}

/// What the viewer needs from `finite-design` before it has a document:
/// the constants it renders artboards with.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    /// [`html::BASE_CSS`], the styles every artboard renders with.
    base_css: &'static str,
    base_layer: &'static str,
    /// [`html::CSP`], the content policy for artboards that run scripts.
    csp: &'static str,
    sandbox: &'static str,
    frame_permissions: &'static str,
    /// [`html::BLOCKED_TAGS`], which the viewer never creates as elements.
    blocked_tags: &'static [&'static str],
    default_artboard_size: (f64, f64),
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            base_css: html::BASE_CSS,
            base_layer: html::BASE_LAYER,
            csp: html::CSP,
            sandbox: html::SANDBOX,
            frame_permissions: html::FRAME_PERMISSIONS,
            blocked_tags: html::BLOCKED_TAGS,
            default_artboard_size: html::DEFAULT_ARTBOARD_SIZE,
        }
    }
}

fn with_input<T>(f: impl FnOnce(&[u8]) -> T) -> T {
    INPUT.with(|buffer| f(&buffer.borrow()))
}

/// The input bytes at `start..start + len`, as text.
fn text(input: &[u8], start: usize, len: usize) -> Result<&str, String> {
    let bytes = input
        .get(start..start + len)
        .ok_or("the argument is outside the input buffer")?;
    std::str::from_utf8(bytes).map_err(|e| e.to_string())
}

fn with_replica(handle: u32, f: impl FnOnce(&mut Replica) -> Result<String, String>) -> i32 {
    let result = REPLICAS.with(|table| {
        match table
            .borrow_mut()
            .get_mut(handle as usize)
            .and_then(Option::as_mut)
        {
            Some(replica) => f(replica),
            None => Err(format!("no replica {handle}")),
        }
    });
    respond(result)
}

/// Puts a result in the output buffer. Returns its length, negated for an error.
fn respond(result: Result<String, String>) -> i32 {
    let (text, ok) = match result {
        Ok(text) => (text, true),
        Err(message) => (message, false),
    };
    let len = text.len() as i32;
    OUTPUT.with(|buffer| *buffer.borrow_mut() = text.into_bytes());
    if ok { len } else { -len.max(1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes `args` to the input buffer one after another, as the
    /// TypeScript side does, and returns their byte lengths.
    fn put(args: &[&str]) -> Vec<usize> {
        let bytes = args.concat().into_bytes();
        let ptr = input(bytes.len());
        // SAFETY: `input` returned a buffer of exactly `bytes.len()` bytes.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
        args.iter().map(|a| a.len()).collect()
    }

    /// Reads a function's result the way the TypeScript side does.
    fn result(n: i32) -> Result<String, String> {
        let text = OUTPUT.with(|o| String::from_utf8(o.borrow().clone()).unwrap());
        if n >= 0 {
            assert_eq!(n as usize, text.len());
            Ok(text)
        } else {
            Err(text)
        }
    }

    #[test]
    fn a_replica_round_trips_through_the_abi() {
        let h = replica_new();
        let nodes = r#"[{"id":"a","parent":null,"index":"V","type":"element","tag":"p"},{"id":"t","parent":"a","index":"V","type":"text","text":"Grüße 👋"}]"#;
        assert!(result(replica_load(h, put(&[nodes])[0])).is_ok());
        let html = result(replica_export(h, put(&["a"])[0], 0));
        assert_eq!(html.unwrap(), "<p>Grüße 👋</p>");
        let ops = r#"[{"op":"set","id":"t","key":"text","value":"Hej"}]"#;
        let applied = result(replica_apply(h, put(&[ops])[0])).unwrap();
        assert!(applied.contains(r#""text":"Hej""#), "{applied}");
        replica_free(h);
        let gone = result(replica_export(h, put(&["a"])[0], 0));
        assert_eq!(gone, Err(format!("no replica {h}")));
        assert_eq!(replica_new(), h);
    }

    #[test]
    fn errors_come_back_as_messages() {
        let h = replica_new();
        let err = result(replica_apply(h, put(&["not json"])[0])).unwrap_err();
        assert!(err.contains("expected"), "{err}");
    }

    #[test]
    fn rules_that_need_no_document() {
        let rules: serde_json::Value = serde_json::from_str(&result(rules()).unwrap()).unwrap();
        assert_eq!(rules["baseLayer"], html::BASE_LAYER);
        assert_eq!(
            rules["defaultArtboardSize"],
            serde_json::json!([1440.0, 900.0])
        );
        assert!(
            rules["blockedTags"]
                .as_array()
                .unwrap()
                .contains(&"iframe".into())
        );

        let lens = put(&["#finite-artboard=a%62c"]);
        assert_eq!(result(artboard_target(lens[0])).unwrap(), r#""abc""#);
        let lens = put(&["#section"]);
        assert_eq!(result(artboard_target(lens[0])).unwrap(), "null");
        let lens = put(&["a%zz"]);
        assert_eq!(result(percent_decode(lens[0])).unwrap(), "null");

        let lens = put(&["tab", r#"{"k":"</script>"}"#]);
        let script = result(bootstrap_script(lens[0], lens[1])).unwrap();
        assert!(script.contains(r#""artboardLink":"#));
        assert!(script.contains("\\u003c/script>"), "{script}");
    }

    #[test]
    fn pixel_sizes_come_from_the_document() {
        let h = replica_new();
        let nodes = r#"[{"id":"a","parent":null,"index":"V","type":"element","tag":"div","styles":{"width":"300px","height":"auto"}}]"#;
        result(replica_load(h, put(&[nodes])[0])).unwrap();
        assert_eq!(
            result(replica_pixel_size(h, put(&["a"])[0])).unwrap(),
            "[300.0,null]"
        );
        assert_eq!(
            result(replica_pixel_size(h, put(&["gone"])[0])).unwrap(),
            "[null,null]"
        );
    }

    #[test]
    fn attribute_checks_read_two_arguments() {
        let safe = |name: &str, value: &str| {
            let lens = put(&[name, value]);
            is_safe_attr(lens[0], lens[1]) == 1
        };
        assert!(safe("href", "https://example.com"));
        assert!(!safe("href", "java\tscript:alert(1)"));
        assert!(!safe("onclick", "x"));
    }
}
