Make changes to a design. One edit call is one transaction: its ops run in order, all or nothing (if one fails, nothing changes and the error names it), and undo reverses the whole call as one step. Pass ops as a list, or one op flat at the top level: {"designId": "…", "op": "replace", "find": "#3b82f6", "replace": "#f97316"}.

Ops, each addressed with select, a CSS selector: #k3x9a2bq (a node id), .card, button, [data-name=Hero] h1, :root (every artboard), :contains("text"):

{"op": "artboard", "name": "Home — mobile", "width": 390, "height": 844, "html": "<header data-name=\"Nav\">…</header>", "as": "m"}
A new screen with its first sections. desktop 1440x900, tablet 768x1024, mobile 390x844. Omit x and y to place it right of the others; omit height to grow with the content. css (declarations) and class style the artboard itself. page: a page's name or id (default the first); mode: the mode its tokens come from, like "Dark". from: "#k3x9a2bq" starts it as a copy of that artboard, with the given name and size, so a mobile version keeps the content and you only restyle it.
{"op": "html", "select": "@m", "html": "<section data-name=\"Features\">…</section>", "mode": "append"}
mode: append (default, last child), prepend (first child), before or after (a sibling), inner (replace the children), replace (replace the element). append and the others act on every match; inner and replace take one. Use inner on an element to change its text. With inner or replace, elements that keep the data-id from read's html are updated in place: they keep their ids, comment pins and history, and a value another agent changed since you read it is kept, and named in the result.
{"op": "css", "css": "#k3x9a2bq { height: 1712px } .btn { border-radius: 999px }", "to": "inline"}
css is a stylesheet; each rule's selector picks elements. to: "inline" (default) sets the declarations in each match's style attribute (so #id { height: … } resizes an artboard); "style" merges the rules into the matching artboard's <style> block (use it for classes, :hover, @media, @keyframes). Values every screen shares go in tokens. Rules merge: a declaration replaces the same property, prop: unset removes it, an empty rule .x {} removes the rule. Or pass select and plain declarations: {"op": "css", "select": ".btn", "css": "border-radius: 999px"}. With rules, select limits them to inside its matches (with to: "style", it picks the artboard).
{"op": "attrs", "select": ".cta", "set": {"href": "/start", "data-name": "CTA"}}
Sets attributes on every match; null removes one. data-name is the layer name. data-id can't change; style goes through a css op.
{"op": "move", "select": "#a1b2c3d4", "to": "#list", "position": "prepend"}
to: a selector of one element, or "canvas" to make artboards. position: append (default), prepend, before, after, relative to to. copy: true moves copies instead (without to, a copy lands right after its original; copied artboards go into free space). For an artboard, x and y set its canvas position, page moves it to a page, and mode sets the mode its tokens come from.
{"op": "remove", "select": "[data-name=Banner]"}
Deletes every match with everything inside it. A select whose matches nest inside each other is refused, since it would take the outer ones whole.
{"op": "replace", "find": "#3b82f6", "replace": "#f97316"}
A value everywhere: inline styles, attributes, <style> blocks, <script> code and token values. A color matches in any notation, and tints keep their alpha. includeText: true also replaces visible text (a product name, a typo). in limits where it looks: "text", "styles", "attributes", "code" (<style> and <script>), "tokens", or a list; "in": "text" changes only what people read, leaving links, ids and titles alone. select limits it to matches. replace "" deletes it.
{"op": "page", "create": "Drafts", "as": "d"}
Pages hold artboards; people see one page at a time. create, {"rename": "Drafts", "name": "Archive"} or {"remove": "Drafts"} (deletes the page and its artboards). Put artboards on a page with the artboard op's page, or {"op": "move", "select": "#k3x9a2bq", "page": "Drafts"}.
{"op": "tokens", "set": {"--brand": "#f97316", "--bg": {"Light": "#ffffff", "Dark": "#0b0b0b"}}, "modes": ["Light", "Dark"]}
Tokens are CSS variables every artboard can use as var(--brand). Give a token one value, a value per mode, or null to delete it; tokens you don't pass stay. modes names the design's modes in order: the first renames the first mode, more add modes. A mode without a value uses the first mode's. An artboard renders in one mode: the artboard op's mode, or {"op": "move", "select": "#k3x9a2bq", "mode": "Dark"}.
{"op": "component", "select": "[data-name=Nav]", "name": "Top bar", "as": "bar"}
A component is one definition its instances follow, like a top bar on every screen. The first match (or the one that's already a component) becomes the component; the other matches become its instances in place, keeping their ids. Each must be built the same way; where its text, styles or attributes differ, they become that instance's overrides. Editing the component changes every instance; editing inside one (its ids look like #instanceId/nodeId) changes only it. {"op": "component", "select": "#k2n0d9xa", "detach": true} makes instances plain copies again. In html, data-component="Top bar" on several elements does the same as the op (the first defines it), and <header data-instance-of="k3x9a2bq"></header> adds an instance of component #k3x9a2bq; read's html marks both.
{"op": "import", "name": "landing.html", "content": "<!doctype html>…", "page": "Inbox"}
Adds a file as new artboards: an .html page, a .finite bundle, a .figma.json from the Finite Figma plugin, or a repo .tar (contentBase64). Pass the file's text as content (Finite can't read your files). Scripts, handlers and embeds are dropped; the result lists what didn't convert exactly.

"as": "m" names what an op creates (an artboard, the first root of html, the first copy of a move, a page, an import's first artboard, a component); later ops in the same call use "@m" in select or page.

status: a few words shown to people watching ("Making the mobile version"). It also labels the edit in undo and in comment replies.
A layout check of the artboards the edit touched follows every result: content cut off by the artboard's edge (not what a scroller, overflow: hidden or clip-path clips), text overflowing its box or overlapping other text, with the css op that fixes an artboard's height. It lists findings the edit caused or touched and counts the earlier ones; render with output: "layout" lists them all. check: false skips it.
dryRun: true reports what the ops would change, and changes nothing. Use it before a broad replace or remove.

Returns one numbered section per op: the nodes each changed or created, with their ids.

Example, a mobile copy in one call:
{"designId": "…", "status": "Mobile version", "ops": [
{"op": "artboard", "name": "Landing — mobile", "width": 390, "height": 844, "html": "<header data-name=\"Nav\" style=\"…\">…</header>", "as": "m"},
{"op": "html", "select": "@m", "html": "<section data-name=\"Features\" style=\"…\">…</section>"},
{"op": "html", "select": "@m", "html": "<footer data-name=\"Footer\">…</footer>"}]}
