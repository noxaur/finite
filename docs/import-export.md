# Import and export

Finite moves designs in and out through one Rust crate, `crates/transfer`. Each format is a **codec** that converts between that format and Finite's own `Document`, so the document is the hub and there are no converters between pairs of formats. v1 ships four codecs that go both ways: HTML, a native `.finite` bundle, a folder of text files for git (`repo`), and Figma. Two more only export: JSX, and `app`, a whole prototype as a Vite + React project packed as a tar.

Two rules hold everything else up. Import never throws data away: Finite keeps the exact bytes it received, and anything it can't turn into nodes stays recoverable from them. And nothing that could run code reaches the document unless someone wrote it there on purpose.

`crates/transfer/SUPPORT.md` shows what each codec does with each feature. A test generates it, so it can't go stale.

## JSX

`crates/transfer/src/jsx.rs` writes a node as JSX for a React codebase. The `get_jsx` MCP tool calls `jsx::convert` on any node, and the codec's `write` wraps an artboard in a component file (`?format=jsx`, `export_design`, and **as JSX** for each artboard in the web app's Export menu). Attributes take React's names (`class` is `className`, `for` is `htmlFor`, SVG `stroke-width` is `strokeWidth`). Text JSX can't hold, like `{` or leading spaces, goes out as a string expression. By default each node's styles become a `style` object. With `tailwind`, they become classes: a utility where its meaning is plain (`flex`, `gap-[8px]`) and an arbitrary property (`[background-color:#fff]`) for the rest. A value a class can't hold, like a `url(…)`, stays in a `style` object. `<script>` elements are left out with a diagnostic, and so is `!important`, which a style object can't carry and a Tailwind arbitrary value rejects. `SUPPORT.md` marks frame, solid fill and flex layout approximate for that reason and because a Tailwind class has less weight than an inline style. `get_jsx` keeps stored images as this server's URLs, like `get_html`, and says so; the codec's file inlines them. A `<textarea>`'s text becomes `defaultValue`. Not handled: `selected` on an `<option>` stays as is, so React warns until it moves to the `<select>`'s `defaultValue`. JSX can't be imported.

## App

`crates/transfer/src/app/` writes the whole prototype as a Vite + React project in one tar archive (`<name>-app.tar`). Unpack it, then `npm install && npm run dev` for a clickable prototype or `npm run build` for `dist/`. One artboard can't be exported: links go between artboards, so `Scope::Artboard` is refused and the message says to export the design.

`flow::flow` gives the routes. Each route is a component in `src/pages/` that holds all its screens, as `jsx::convert_with` writes them. CSS media queries show one: the widest screen that fits the window, or the narrowest below that. A screen without a pixel width fits any window, so it hides the others, and of two screens as wide as each other the first shows. Both cases are left out with a diagnostic. The first route is served at `/` (no redirect), unless some route is `/` already. Every screen of a route is in the page at once, so each screen's `<style>` is limited to the screen (`css_scope.rs`, called by `jsx::convert_with` through `Options::scope`): `.title { … }` becomes `:where(.PageCart-0-page) .title { … }`, which keeps its specificity, and `html`, `body` and `:root` become the screen's page element. A screen is two elements: the outer `finite-screen PageCart-0`, which only the generated media queries style, and inside it `finite-page PageCart-0-page`, which the design's CSS is limited to. So a design's `body { display: flex !important }` styles the page and can't show a screen the media queries hide. A selector that starts with `:is()` or `:where()` and names the page in one alternative matches the page element and what is inside it (`:is(body, .x) .title` is `:is(:where(.PageCart-0-page), :where(.PageCart-0-page) .x) .title`); a page name anywhere else inside a pseudo-class, like `.a:is(body, .b)`, is left as written and doesn't match, since the page is never inside the element. Comment marks inside strings and after backslashes aren't comments. Rules inside `@media`, `@supports` and `@layer` are limited too; `@keyframes`, `@font-face` and `@import` stay as written, so two screens that define the same `@keyframes` name differently still share it. Only one route is mounted at a time, and the global stylesheet holds just the base styles, the tokens and the rules that show one screen. Routes match case-sensitively (`/Cart` and `/cart` are two routes), component files are named without regard to case (`PageFooBar.tsx` and `PageFoobar2.tsx`), and design text in generated code (paths, attributes) is written as escaped literals. An attribute or element name JSX can't write, like `@click` or `svg:rect`, is left out with a diagnostic, and the element's children stay. A route with a `.` or `..` segment isn't a route, since a browser removes them, so the artboard gets one from its name and `bad_routes` reports it. Links to artboards become the router's link component with the route as its target. A broken link becomes a plain `<a>` without its `href`, with a diagnostic. Scripts are left out with a diagnostic. Tokens are CSS variables in `src/global.css`: the first mode on `:root`, and each other mode on the screens that use it (`data-finite-mode`). Images are files in `public/assets/<sha256>.<ext>`.

Only the router differs between projects: a `Router` in `app/router.rs` has four functions: its `name`, its npm `packages`, the `link_prop` of its link component (`to`, or `href` for Next) and the `files` that set up routing (`src/link.ts` and `src/router.tsx`). `RouterKind` lists the routers and finds one by name, and React Router 7 is the only one so far. `app::write_with` takes the router.

`crates/transfer/tests/app.rs` compares a small flow with `fixtures/app/shop.txt`, and `the_project_builds` unpacks the archive and runs `npm run build`. It installs the packages once under the cargo target folder, keyed by the hash of `package.json`, and skips itself when `npm` isn't on `PATH` or `FINITE_SKIP_APP_BUILD=1`. CI runs it, since it has Node and network.

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

### Whole pages

An imported HTML file goes into a 1440px-wide artboard with no height, so it grows to fit its content like an artboard made without one. A file has no height of its own: before, every import got a 900px frame, and a saved web page 5,000 to 12,000px tall showed only its top. Fragments grow too, for the same reason.

A whole page (one with a doctype, `<html>`, `<head>` or `<body>` near the top) loses its `<html>` and `<body>` elements: both become the artboard, which takes their inline styles and attributes, and the classes of both. So the page's CSS rules for `html`, `body` and `:root` would match nothing, and a page that sets its theme there, like a dark background and colour variables on `:root`, would render light text on white. The importer rewrites those selectors in every `<style>` (`html/page_css.rs`) to select the artboard, which carries the class `finite-root`. It's a token-level rewrite: strings, comments, declarations and at-rule preludes are left alone, as is a word like `tbody` or `.body`. Rules inside `@media`, `@supports`, `@layer` and other grouping rules are rewritten too, and so are selectors inside `:is()`, `:not()`, `:where()` and `:has()`.

Both elements are one element now, so a chain of them folds into one compound: `html.dark body > main` becomes `:where(.finite-root).dark > main`. Any compound before `body` can only have matched `<html>`, so `.client-js body.skin .x` becomes `:where(.finite-root).client-js.skin .x`. `html` and `body` go inside `:where()` to keep their near-zero specificity, and `:root` becomes `.finite-root`, which has the same specificity as `:root`. A selector that doesn't map onto one element, like `html + p` or `div body`, is left as it was, and its `<style>` gets a diagnostic. The selectors work the same in a shadow root, a sandboxed iframe and a screenshot, since in each one the artboard is an ordinary element and the class is on it.

Inline styles beat any rule, so the artboard's default look (`LOOK` in `crates/transfer/src/lib.rs`: the white background and the flex column) would still hide a page's `body { background: … }`. When a page's CSS has rules for the artboard, the importer leaves that look out of the artboard's inline styles and adds it to the first `<style>` in a cascade layer, `finite-artboard`, which every rule of the page's own overrides. The layer is declared with an `@layer finite-artboard;` statement at the very start of the stylesheet, so it's the lowest of the page's own layers too, and the rule itself goes at the end, where it can't void an `@import`. The `overflow: hidden` and `position: relative` that make the artboard a frame stay inline.

`import_design` groups its diagnostics by kind (what, why and the three scores), with a count and the first three paths, because a real page has hundreds: Linear's homepage has 370 `<link>`s alone, and its result went from 51,131 to 698 characters. When a line leaves paths out, the result points at `GET /api/designs/{id}/imports`, whose record lists every quarantined item with its path. `export_design` groups the same way.

### Content that could run code

HTML import keeps everything, but some of it never becomes a node. `on*` handlers, `javascript:` URLs, `<iframe>`, `<object>`, `<link>` and `<meta>` are quarantined. So is `<script>`, because nobody chose to run an imported file's scripts. The parser runs with `Policy::Import` and reports each item it left out, with its path in the source and the nearest node it kept.

Quarantined content stays only in the original bytes, in the blob store. The document never holds it, so the viewer, the screenshot pipeline and `get_html` can't reach it by any path. The record lists each item, and each one becomes a diagnostic. Running a quarantined script takes a new edit by hand.

`write_html` is for authoring, so it runs with `Policy::Authoring`: an agent's inline scripts are kept and run in the artboard's sandbox, as before. It still drops handlers and embeds, but it now tells the agent what it left out.

## Imports are all-or-nothing

`Design::import` runs `place` as a transaction (`Design::transact`, see "Several edits as one change" in [How Finite works](how-finite-works.md)). Each step's ops apply right away through `Document::try_apply`, so the next step sees them. Placing several artboards one after another keeps them from overlapping. `try_apply` returns `Applied::Changed`, `Applied::Unchanged` or `Rejected`, where plain `apply` skips any op that doesn't apply. That skipping is what keeps undo safe when other agents have edited in between, and undo keeps it.

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

The HTML codec writes one artboard as a standalone page: the base styles, the design's tokens in the artboard's mode, and the artboard with its layer names. The page carries the same content security policy the viewer uses. Importing the page gives back the artboard as a `<div>` inside a new artboard. The page's `<meta>` and `<title>` act on the page rather than the design, so they're quarantined.

Figma has no CSS, so Figma export reads how the artboard actually rendered. The headless Chrome the screenshot pipeline already runs measures every element's box and computed styles, through the `Measure` trait (`crates/transfer/src/scene.rs`). That measurement is a `Scene`, which is derived data: it's built for one revision, thrown away after the export, and never written back as CSS. Computed styles already account for classes and tokens, so the codec maps what the browser drew, not what the inline styles say.

Flexbox becomes auto layout only when auto layout would put every child where the browser did. The codec lays the children out the way Figma would and compares; if any child is more than a pixel off, because of margins, `order` or `flex-basis`, say, the frame keeps the measured positions and reports it. Grid always exports as measured positions.

The `app` codec writes the whole design's prototype flow as a standalone Vite + React project, packed as `<design>-app.tar`. Each route from `data-route` on an artboard becomes a React Router route, and each `<a href="#finite-artboard=<id>">` link points at the route of the artboard it names. It exports the whole design; one artboard isn't an app, so an artboard export is refused.

## Keeping a design in a repo

The `repo` codec writes a design as a folder of text files, so it can sit next to the code and show up in pull requests:

```text
finite.json          name, pages, modes, tokens, and each artboard's file, page, mode and position
artboards/home.html  one artboard: its <div> and everything inside, one tag per line
assets/<sha256>.png  files the design points to, such as images
```

A codec returns one file, so the export is one tar archive of that folder. Unpack it with `tar -xf`, commit the files, and pack them again with `tar -cf design.tar finite.json artboards assets` to import them (one folder around those is fine). The archive is deterministic: an unchanged design writes the same bytes, so a re-export of an unedited design leaves no diff.

Import back is exact for what Finite edits: layer names, styles, attributes, text and nesting, plus each artboard's size (an auto-height artboard stays auto-height), position, page and mode, the page list and the tokens. A folder from before tokens can hold a `shared.css`; importing it moves the CSS into tokens and each new artboard's `<style>`, as loading an old design does. A test exports a design with mixed text and inline elements and checks that the imported document matches node for node. What doesn't come back:

- **Scripts.** A `<script>` is written to the file, but import quarantines it like any imported file's scripts, so it stays out of the document and is listed in the import's diagnostics. The original tar stays downloadable.
- Node ids, undo history, comments and import records. The export reports the import records, as a bundle does.
- Whitespace-only text that contains a newline. HTML import treats it as source indentation, here and in every other codec.
- An artboard whose root isn't a `<div>`. Artboards are created as `<div>`s.
- Two pages with the same name. The manifest refers to pages by name, so the second is written as `Name (2)` and the export says so.

File names come from layer names, as ASCII letters, digits and dashes. A name with other characters, like `Café` or `日本語`, gets a short hash of the name added (`caf-1a2b3c.html`), so different names never share a file. Names Windows reserves (`con`, `nul`, `com1`…) get `-artboard` added. Artboards that share a name get a hash of each one's node id instead, so deleting one doesn't renumber the rest; the one left then takes the plain name. Renaming an artboard renames its file, and the importer reads the manifest, not the file name, so a renamed file still imports once the manifest says so.

Reading applies the HTML import rules: scripts, handlers and embeds are quarantined, with their path in the file. Because the files are meant to be edited, the importer also checks the manifest against the files: a listed file must exist, and an asset's name must match its sha256. Archives that use pax or GNU long names are refused with a message (repack with `tar --format=ustar`), since a cut-off name would point at the wrong file. Images in files are `finite-asset:<sha256>` references to the `assets/` folder, not paths, so the HTML files show a missing image if opened directly in a browser.

This is export and import only. Changing a file and importing it adds new artboards; it doesn't update the ones already in the design. A sync mode would build on the import record's node-to-path map, and isn't built.

## Reaching Figma

The Figma REST API can't create nodes, so Finite ships a small Figma plugin, `apps/figma-plugin`. The plugin and Finite trade `.figma.json` files, which hold a versioned payload (`crates/transfer/src/figma/payload.rs`, mirrored in `apps/figma-plugin/src/payload.ts`). One schema serves both directions. The plugin saves a selection as a file for Finite's Import button, and opens a file from Finite's Export menu to build layers. It has no network access, so there's no token to manage and no cross-origin surface. It also carries no conversion logic: it copies values between the payload and the Plugin API, and every mapping lives in the codec.

Every release attaches the plugin as `finite-figma-plugin.zip`: `manifest.json` and the `dist/` files it names. People unzip it and choose **Plugins → Development → Import plugin from manifest…** in the Figma desktop app. Under the Figma entries, the web app's Export menu links to `releases/latest/download/finite-figma-plugin.zip` (`FIGMA_PLUGIN_URL` in `apps/web/src/lib/transfer.ts`). `apps/figma-plugin/README.md` covers building and loading it from source.

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

Over HTTP, `POST /api/designs/{id}/import?format=html&name=…&strict=preserved,editable` takes the file's bytes as the body, up to 32 MB (the largest blob, since the file is kept whole), and answers `201` with the record, the new artboards and the diagnostics. `GET /api/designs/{id}/export?format=html&artboard=…` (or `format=jsx` or `format=figma` with an artboard, or `format=repo` for the folder as a tar, or `format=app` for the whole design as a React project in a tar) downloads the design, or one artboard, and its `Finite-Diagnostics` header counts the diagnostics. `GET /api/designs/{id}/imports` lists the records, and `GET /api/designs/{id}/imports/{import}/original` downloads the exact bytes, always as `application/octet-stream` with `nosniff` and `Content-Security-Policy: sandbox`, so a hostile page can't render. An unknown format or strict axis, bad input and a strict refusal all answer `422`. Agents have `import_design`, which takes the file as `content` or `contentBase64`, and `export_design`, which returns the file as text or, for a tar, says where to download it.

## Not in v1

v1 converts frames, text, solid fills, images and basic flex layout. Everything else is archived and reported. The design leaves room for these, but we're deliberately not building them yet:

- **Re-import into existing nodes.** v1 always imports as new nodes. The record already maps nodes to source paths, so a three-way merge needs no data migration later.
- **Components, variables, boolean ops.** These wait for Finite to support them as features.
- **Fetching remote HTML dependencies.** v1 leaves remote URLs as they are. Fetching them needs an SSRF guard and size caps, so it comes later.
- **Visual proof.** A visual yes will need a pixel comparison between Figma's PNG export and Finite's screenshot, for one recorded render environment. Until then, visual reports unknown unless a mapping is exact.
- **Deleting blobs.** v1 never deletes one. A sweep has to know about every design that shares the store, so it comes once blobs take real space.
- **Two-step version rollout.** v1 adds version numbers, the upgrade chain and refusal of newer versions. Switching servers to read a new version before any writes it comes with the first format change that needs it, along with a protocol version for browsers.
