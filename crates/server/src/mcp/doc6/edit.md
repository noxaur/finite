Change a design. Ops run in order as one transaction: all or nothing, one undo step. Pass ops as a list, or one op at the top level.

select is a CSS selector: #k3x9a2bq (a node id), .card, [data-name=Hero] h1, :root (all artboards). "as": "m" names what an op makes; later ops use "@m".

{"op": "artboard", "name": "Home — mobile", "width": 390, "height": 844, "html": "<header data-name=\"Nav\">…</header>", "as": "m"}
Desktop 1440x900, tablet 768x1024. Without height it grows with the content. x, y and page place it. from: "#k3x9a2bq" copies an artboard; detach: true freezes the copy's instances.
{"op": "html", "select": "@m", "html": "<section data-name=\"Features\">…</section>", "mode": "append"}
mode: append, prepend, before, after, inner or replace.
{"op": "css", "select": ".btn", "css": "border-radius: 999px"}
Sets inline styles; an artboard's width and height resize it. to: "style" writes rules to the artboard's <style>, for classes, :hover, @media and @keyframes.
{"op": "attrs", "select": ".cta", "set": {"href": "/start"}}
{"op": "move", "select": "#a1b2c3d4", "to": "#list", "position": "prepend"}
copy: true duplicates. Artboards also take x, y, page and mode.
{"op": "remove", "select": "[data-name=Banner]"}
{"op": "replace", "find": "#3b82f6", "replace": "#f97316"}
Everywhere, in any color notation. in: "text" limits it to visible text.
{"op": "tokens", "set": {"--brand": "#f97316", "--bg": {"Light": "#fafcfb", "Dark": "#0b0b0b"}}, "modes": ["Light", "Dark"]}
CSS variables every artboard can use as var(--brand). An artboard's mode picks which value it gets.
{"op": "component", "select": "[data-name=Nav]", "name": "Top bar"}
The first match defines it; the rest become instances. Edit it to change them all. In html, data-component="Top bar" on each copy does the same.
{"op": "page", "create": "Drafts"}
{"op": "import", "name": "landing.html", "content": "<!doctype html>…"}
.html, .finite or .figma.json, as artboards.

status shows people what you're doing, dryRun: true previews, and each result ends with a layout check.
