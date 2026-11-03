# Import and export

Finite moves designs in and out through one Rust crate, `crates/transfer`. Each format is a **codec** that converts between that format and Finite's own `Document`, so the document is the hub and there are no converters between pairs of formats. v1 ships four codecs that go both ways: HTML, a native `.finite` bundle, a folder of text files for git (`repo`), and Figma. A fifth, JSX, only exports.

Two rules hold everything else up. Import never throws data away: Finite keeps the exact bytes it received, and anything it can't turn into nodes stays recoverable from them. And nothing that could run code reaches the document unless someone wrote it there on purpose.

`crates/transfer/SUPPORT.md` shows what each codec does with each feature. A test generates it, so it can't go stale.

## JSX

`crates/transfer/src/jsx.rs` writes a node as JSX for a React codebase. The `get_jsx` MCP tool calls `jsx::convert` on any node, and the codec's `write` wraps an artboard in a component file (`?format=jsx`, `export_design`). Attributes take React's names (`class` is `className`, `for` is `htmlFor`, SVG `stroke-width` is `strokeWidth`). Text JSX can't hold, like `{` or leading spaces, goes out as a string expression. By default each node's styles become a `style` object. With `tailwind`, they become classes: a utility where its meaning is plain (`flex`, `gap-[8px]`) and an arbitrary property (`[background-color:#fff]`) for the rest. A value a class can't hold, like a `url(…)`, stays in a `style` object. `<script>` elements are left out with a diagnostic, and so is `!important`, which a style object can't carry and a Tailwind arbitrary value rejects. `SUPPORT.md` marks frame, solid fill and flex layout approximate for that reason and because a Tailwind class has less weight than an inline style. `get_jsx` keeps stored images as this server's URLs, like `get_html`, and says so; the codec's file inlines them. A `<textarea>`'s text becomes `defaultValue`. Not handled: `selected` on an `<option>` stays as is, so React warns until it moves to the `<select>`'s `defaultValue`. JSX can't be imported.

## Adding a format or a feature

A codec is a type that implements `Codec`, and the `Format` enum is the registry:

```rust
pub trait Codec: Sync {
    fn name(&self) -> &'static str;
    fn support(&self, feature: Feature, direction: Direction) -> Support;
    fn read(&self, input: &Input<'_>) -> Result<Imported, Error>;
    fn write(&self, revision: &Revision<'_>, artboard: &str) -> Result<Exported, Error>;
}
```

To add a format, add a variant to `Format`, point `Format::codec` at the new codec, and give it a module. Inside the module, keep one file per feature once it grows, like `figma/text.rs`.

To add something a design can contain, add a variant to `Feature`. Every codec answers `support` with a `match` that has no wildcard arm, so the build fails until each codec says what it does with the new feature: `Exact`, `Approximate`, `Opaque` or `Unsupported`. The table states capability. What one conversion actually did is in its diagnostics.

Finite's document owns every concept Finite can edit. When another format has a concept Finite lacks, the concept stays in the archived source instead of being invented in the document. So supporting Figma components takes two steps: make components a real Finite feature in `crates/design`, then add one file per codec that maps them. Until then, a Figma component imports as plain nodes that render the same, and its definition stays in the original bytes.

## Import never loses data

An import happens in two steps:

1. `Codec::read` parses the bytes into an `Imported`: the artboards to create and the diagnostics. It runs on the blocking pool and doesn't touch any design.
2. `Imported::place` creates the artboards inside `Design::import` while the design is locked.

Before step 2, the server writes the bytes to the blob store, durably, and the import's `ImportRecord` points at them:

```rust
pub struct ImportRecord {
    pub id: String,
    pub artifact: BlobHash,             // the exact bytes received
    pub format: String,                 // "html"
    pub input_kind: String,             // "figma-payload v1", not "the Figma file"
    pub file_name: Option<String>,
    pub received_at: u64,
    pub nodes: BTreeMap<NodeId, String>, // which source path each node came from
    pub dependencies: Vec<Dependency>,  // things the source pointed to
    pub quarantined: Vec<Quarantined>,  // what was kept out, and where
}
```

The record is journaled as part of the design. Undoing the import removes the nodes but keeps the record, so the original stays downloadable whatever happens to the nodes. `transfer::original` returns the exact bytes. Rebuilding an _edited_ source document from the nodes would be a separate operation, and v1 doesn't have one.

Nodes carry nothing extra. The record maps nodes to source paths, and with the original bytes that's enough to rebuild any fingerprint a later re-import needs. The fingerprints are derived data, so they aren't stored.

### Content that could run code

HTML import keeps everything, but some of it never becomes a node. `on*` handlers, `javascript:` URLs, `<iframe>`, `<object>`, `<link>` and `<meta>` are quarantined. So is `<script>`, because nobody chose to run an imported file's scripts. The parser runs with `Policy::Import` and reports each item it left out, with its path in the source and the nearest node it kept.

Quarantined content stays only in the original bytes, in the blob store. The document never holds it, so the viewer, the screenshot pipeline and `get_html` can't reach it by any path. The record lists each item, and each one becomes a diagnostic. Running a quarantined script takes a new edit by hand.

`write_html` is for authoring, so it runs with `Policy::Authoring`: an agent's inline scripts are kept and run in the artboard's sandbox, as before. It still drops handlers and embeds, but it now tells the agent what it left out.

## Imports are all-or-nothing

`Design::import` gives `place` a `Transaction`. Each step's ops apply right away through `Document::try_apply`, so the next step sees them. Placing several artboards one after another keeps them from overlapping. `try_apply` returns `Applied::Changed`, `Applied::Unchanged` or `Rejected`, where plain `apply` skips any op that doesn't apply. That skipping is what keeps undo safe when other agents have edited in between, and undo keeps it.

If any step fails, the transaction puts the document back by applying the inverses in reverse, and nothing is recorded. The limits on nodes and nesting depth are checked against the staged document, so they count every artboard the import makes. When the import succeeds, its ops become one undo step, and the record and the change go to the journal as one `Record::Import`. A crash can't keep one without the other.

## Diagnostics

Every conversion returns its result plus a list of diagnostics. A codec returns them as values and never logs a loss on its own. Each diagnostic names a node, a source path, a feature and a reason, and scores three things separately:

| Axis      | Question                     | Values           |
| --------- | ---------------------------- | ---------------- |
| preserved | Is the data kept?            | yes, no, unknown |
| visual    | Does it look the same?       | yes, no, unknown |
| editable  | Can you change it in Finite? | yes, no, unknown |

A quarantined `onclick` scores preserved yes, visual unknown and editable no. Strict mode names the axes that must hold and refuses an import with any no or unknown on them. All scores are known after `read`, so a strict import fails before anything is stored.

## Export

Export reads one revision. The server copies the design under its lock, then the codec writes from the copy without the lock, so a slow export never holds up edits.

The HTML codec writes one artboard as a standalone page: the base styles, the design's shared CSS, and the artboard with its layer names. The page carries the same content security policy the viewer uses. Importing the page gives back the artboard as a `<div>` inside a new artboard. The page's `<meta>` and `<title>` act on the page rather than the design, so they're quarantined.

Figma has no CSS, so Figma export reads how the artboard actually rendered. The headless Chrome the screenshot pipeline already runs measures every element's box and computed styles, through the `Measure` trait (`crates/transfer/src/scene.rs`). That measurement is a `Scene`, which is derived data: it's built for one revision, thrown away after the export, and never written back as CSS. Computed styles already account for classes and the shared CSS, so the codec maps what the browser drew, not what the inline styles say.

Flexbox becomes auto layout only when auto layout would put every child where the browser did. The codec lays the children out the way Figma would and compares; if any child is more than a pixel off, because of margins, `order` or `flex-basis`, say, the frame keeps the measured positions and reports it. Grid always exports as measured positions.

## Keeping a design in a repo

The `repo` codec writes a design as a folder of text files, so it can sit next to the code and show up in pull requests:

```text
finite.json          name, pages, and each artboard's file, page and position
shared.css           the shared CSS, if the design has any
artboards/home.html  one artboard: its <div> and everything inside, one tag per line
assets/<sha256>.png  files the design points to, such as images
```

A codec returns one file, so the export is one tar archive of that folder. Unpack it with `tar -xf`, commit the files, and pack them again with `tar -cf design.tar finite.json shared.css artboards assets` to import them (one folder around those is fine). The archive is deterministic: an unchanged design writes the same bytes, so a re-export of an unedited design leaves no diff.

Import back is exact for what Finite edits: layer names, styles, attributes, text and nesting, plus each artboard's size, position and page, and the page list. A test exports a design with mixed text and inline elements and checks that the imported document matches node for node. What doesn't come back:

- Node ids, undo history, comments and import records. The export reports the import records, as a bundle does.
- Whitespace-only text that contains a newline. HTML import treats it as source indentation, here and in every other codec.
- An artboard whose root isn't a `<div>`. Artboards are created as `<div>`s.

Reading applies the HTML import rules: scripts, handlers and embeds are quarantined, with their path in the file. Because the files are meant to be edited, the importer also checks the manifest against the files: a listed file must exist, and an asset's name must match its sha256. Images in files are `finite-asset:<sha256>` references to the `assets/` folder, not paths, so the HTML files show a missing image if opened directly in a browser.

This is export and import only. Changing a file and importing it adds new artboards; it doesn't update the ones already in the design. A sync mode would build on the import record's node-to-path map, and isn't built.

## Reaching Figma

The Figma REST API can't create nodes, so Finite ships a small Figma plugin, `apps/figma-plugin`. The plugin and Finite trade `.figma.json` files, which hold a versioned payload (`crates/transfer/src/figma/payload.rs`, mirrored in `apps/figma-plugin/src/payload.ts`). One schema serves both directions. The plugin saves a selection as a file for Finite's Import button, and opens a file from Finite's Export menu to build layers. It has no network access, so there's no token to manage and no cross-origin surface. It also carries no conversion logic: it copies values between the payload and the Plugin API, and every mapping lives in the codec.

The payload uses the Plugin API's names and units, so the plugin never converts. Fields a newer plugin sends that this server doesn't know land in `extra`: each is reported once, and the original bytes keep it. A vector shape travels as the SVG Figma exports, which is already rotated, so its box is its drawn bounding box.

## Storage

Import artifacts, images and other files live in a content-addressed blob store keyed by sha256, next to the designs in `FileStore` and `PgStore`, and served at `/api/designs/{id}/assets/{hash}`. A blob never changes, so it needs no version, and the same bytes stored twice are stored once. A blob is on disk before `put_blob` returns, so a record never points at bytes that a crash could lose. When servers keep separate folders and a design moves to a new owner, its blobs move first, then its snapshot.

New artboards go on the page the import names (the web UI passes the page you're looking at; `page` over HTTP, `pageId` over MCP), or the first page. A bundle carries its design's pages by name: importing it creates the ones the design doesn't have, empty ones too, and puts each artboard back on its page.

A `.finite` bundle uses its own wire types, not `Snapshot`, which also carries server state like seq numbers and undo history. Its manifest lists every blob it references with its hash. Import checks the manifest against every reference in the decoded bundle, then checks every hash, before it accepts anything.

## Changing stored formats

Snapshots and journal records start with a version number, as in `{"v":1,"meta":…}` (`crates/design/src/version.rs`). Data from before versions has none and counts as version 1. A `Schema` names the current version and the steps that upgrade older data:

```rust
pub const SNAPSHOT: Schema = Schema { name: "snapshot", version: 1, upgrades: &[] };
```

Data at the current version parses straight into its type. The version is the first key, so reading it doesn't cost a second parse. Older data goes through the upgrade steps first, one per version, each a `fn(Value) -> Result<Value, String>`. Data from a newer version than this build knows is refused and never rewritten, so an old server in a cluster can't damage what a newer one wrote.

To change a stored format, bump its version, add the upgrade step, and add a fixture of the old shape to the tests.

## Where to call it

`crates/server/src/transfer.rs` has the three operations: `import`, `export` and `original`. The HTTP API, the MCP tools, the Figma plugin and the web UI are thin layers over them, and none of them holds conversion logic.

Over HTTP, `POST /api/designs/{id}/import?format=html&name=…&strict=preserved,editable` takes the file's bytes as the body, up to 32 MB (the largest blob, since the file is kept whole), and answers `201` with the record, the new artboards and the diagnostics. `GET /api/designs/{id}/export?format=html&artboard=…` (or `format=repo` for the folder as a tar) downloads the design, or one artboard, and its `Finite-Diagnostics` header counts the diagnostics. `GET /api/designs/{id}/imports` lists the records, and `GET /api/designs/{id}/imports/{import}/original` downloads the exact bytes, always as `application/octet-stream` with `nosniff` and `Content-Security-Policy: sandbox`, so a hostile page can't render. An unknown format or strict axis, bad input and a strict refusal all answer `422`. Agents have `import_design`, which takes the file as `content` or `contentBase64`, and `export_design`, which returns the file as text.

## Not in v1

v1 converts frames, text, solid fills, images and basic flex layout. Everything else is archived and reported. The design leaves room for these, but we're deliberately not building them yet:

- **Re-import into existing nodes.** v1 always imports as new nodes. The record already maps nodes to source paths, so a three-way merge needs no data migration later.
- **Components, variables, boolean ops.** These wait for Finite to support them as features.
- **Fetching remote HTML dependencies.** v1 leaves remote URLs as they are. Fetching them needs an SSRF guard and size caps, so it comes later.
- **Visual proof.** A visual yes will need a pixel comparison between Figma's PNG export and Finite's screenshot, for one recorded render environment. Until then, visual reports unknown unless a mapping is exact.
- **Deleting blobs.** v1 never deletes one. A sweep has to know about every design that shares the store, so it comes once blobs take real space.
- **Two-step version rollout.** v1 adds version numbers, the upgrade chain and refusal of newer versions. Switching servers to read a new version before any writes it comes with the first format change that needs it, along with a protocol version for browsers.
