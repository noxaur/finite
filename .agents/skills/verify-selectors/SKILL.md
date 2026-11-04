---
name: verify-selectors
description: Check selectors used by the six MCP tools after changes to select.rs or doc6 selector normalization, aliases, page filtering, or text-node fallback.
---

# Verify selectors

When you change the selector code, run this from the repo root:

```sh
python3 .agents/skills/verify-selectors/check.py
```

This is bounded exhaustive verification: you check the real Rust code against a rule set based on parent links. The check covers every input in the stated domain. It does not sample. It uses Cargo and the versions in Cargo.lock; it needs no separate model checker. Last run: rustc 1.99.0 (b940084d7 2026-09-28). You can't infer a proof outside that domain.

## Property and bounds

A selector returns exactly the specified nodes, in the specified order, within its scope. A wrong match can send your MCP edit to the wrong element or artboard.

`crates/design/tests/select_exhaustive.rs` enumerates 4,283 labelled forests: zero through five elements, each parent either absent or an earlier element, siblings ordered by node number, each element a div with exactly one of classes a and b. Every ordered forest through five elements has a representation under this numbering. IDs start with digits. For each forest it checks the whole design and every subset of elements as a Within scope, including empty, disjoint and nested scopes. It compares complete result vectors, so missing matches, extra matches, duplicates and wrong order fail.

The 26 selector forms cover universal, class, node ID, data-id, root, empty, child position, filtered nth-child, is, not, repeated selector lists, all four combinators, and has with each combinator. The expected results use parent relations, not Servo or Matcher's flattened index. A Within scope matches the union of each selected root's strict descendants. A selected inner root can match when it descends from another selected root. Ancestors outside the scope remain available for matching. Different artboards never count as CSS siblings.

`crates/server/src/mcp/doc6/selector_verification.rs` checks all 258 ordered lists of length one through three over six spellings: two aliases, two bare IDs and two hash IDs. Each runs as a string and JSON array, over the design, either page and a missing page. These are 2,064 comparisons through the real selector_text and matched functions. Additional examples check quoted commas and aliases, unknown aliases, and text-node fallback. Those additional examples are not exhaustive.

## Coverage and exclusions

Last synchronized with e9a1833 (the source baseline on which this check was added).

- `crates/design/src/select.rs`: parse, Matcher::new/add/select, and Element navigation, classes and IDs for the domain above.
- `crates/server/src/mcp/doc6/mod.rs`: selector_text, looks_like_id, split_top, with_refs and matched for the adapter domain above. These functions feed the six-tool MCP surface.

Not covered exhaustively: arbitrary CSS syntax, arbitrary Unicode or escaping, arbitrary attribute values, tags other than div, visible-text folding and hidden text, parse_loose, components, text_nodes, page layouts beyond the two-board adapter fixture, or documents larger than five elements. The existing select and doc6 suites cover further examples. These checks do not cover transport, edit transaction, undo, renderer, Wasm ABI, storage or cluster correctness.

## Check that it can fail

```sh
python3 .agents/skills/verify-selectors/check.py --mutations
```

The command copies the crates to a temporary directory outside the checkout. It separately breaks scope exclusion, parent navigation, sibling navigation, node IDs, MCP page filtering and alias expansion. Each broken version must compile and fail a test; a compiler error does not count. It restores each scratch file and reruns the original checks. The checkout's product source stays untouched.

When you see a failed check, it names the parent vector, class bits, scope mask and selector. You can read node i's parent from the vector; a set bit gives class a, otherwise b. You can compare the expected IDs to the actual IDs. For example, including a Within root returns that root even though only its descendants were requested.

Keep the failed case. Check whether the Rust code or the expected result breaks the contract. If you find a real bug, report it before you change product code. If you meant to change the rules, update the expected results and bug checks together. After you change source, read each covered function before you advance the sync commit. Use /maintain-formal-verification-skill when the checks have drifted from the code.
