# Pages

An agent splits a design into pages to keep components or drafts away from the screens. A person sees one page at a time and switches pages in the Pages sidebar, which lists each page with its artboard count. The sidebar shows on every design, even one with a single page. People can't create or rename pages. Only agents can.

## Sub-features

- `pages-sidebar` lists every page with its artboard count.
- `pages-switch` shows only the picked page's artboards and marks it `aria-current="page"`.
- `pages-agent` moves the sidebar live when an agent runs a `page` op, or a `move` op with `page`.

## How to get to it (user POV)

- Open a design's canvas. The `Pages` nav is at the top left.
- Choose a page's button in the sidebar.

## Driving it with verify.sh

Preconditions:

- A design with one artboard, open in the page.

- **Agent adds a page.** Run `$V h $RUN call edit '{"designId":"<D>","ops":[{"op":"page","create":"Drafts"}]}'`, then `$V save $RUN 01-sidebar snapshot --selector 'nav[aria-label=Pages]'`. It lists `Page 1 1` and `Drafts 0`, with no reload.
- **Agent fills it.** Run `$V h $RUN call edit '{"designId":"<D>","ops":[{"op":"artboard","page":"Drafts","name":"Draft","width":400,"height":300,"html":"<p>draft</p>"}]}'`. The sidebar count for `Drafts` becomes `1`.
- **Person switches.** Run `$V h $RUN click 'nav[aria-label=Pages] li:nth-child(2) button'`, then `$V save $RUN 02-switched query '[data-artboard]'`. Only the `Draft` artboard is listed, and the button has `aria-current="page"` (check it with `eval`).
- **Proof.** Run `$V shot $RUN 03-pages` and `$V save $RUN 04-info call read '{"designId":"<D>"}'`. The agent's overview lists both pages.

## Gotchas

- A new design has one page, `Page 1`, and the sidebar lists it alone. That's not proof the `page` op worked: check for the second row.
- `query '[data-artboard]'` lists only the artboards that rendered. An artboard on another page isn't in the DOM.
