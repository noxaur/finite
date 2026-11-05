Look at a design, as text.

- No select: an overview (pages, artboards, open comments, who else is working, how many tokens), then an outline of every artboard: one line per element with its tag, layer name, #id, size and text. Start here. page: "Inbox" shows only that page's artboards, here and with select.
- select (a CSS selector: #k3x9a2bq, .card, button, [data-name="Hero"] h1, :root for artboards, :contains("Sign in")) with as:
  "outline" (default): the outline under each match. depth sets how deep (default 4).
  "html": each match's HTML with inline styles; every element carries data-id, and the root data-read-at, so an html op with mode inner or replace can write it back. depth limits it.
  "css": the CSS that applies to each match: its inline style, then each matching rule from its artboard's <style> blocks, and which properties inline styles override.
  "jsx": each match as JSX to paste into a React codebase, with style objects, or Tailwind classes with tailwind: true.
- export: "figma" returns the design (or select's artboard) as a file's text: "html", "finite" (a bundle that imports back exactly), "repo" (a tar of text files for git), "figma" (for the Finite Figma plugin) or "jsx", with what didn't convert exactly. Save the text to a file yourself.
- as: "css" without select: the design's tokens and modes, and a list of every <style> block.
- contains: "#3b82f6" searches instead: elements whose styles (inline or in <style> blocks), visible text, attributes or layer name contain it, plus matching tokens. A color matches in any notation. Visible text skips <script> and <style>, including an SVG <style>; that code shows up with the styles, and replace reaches it with in: "code". With select, it searches inside the matches. Use it instead of reading whole artboards, before and after a change.

designId takes the design's id or its exact name.

Examples: {"designId": "…"} · {"designId": "…", "select": "[data-name=Hero]", "as": "html"} · {"designId": "…", "contains": "Clould"} · {"designId": "…", "select": ".btn", "as": "css"} · {"designId": "…", "export": "figma"}
