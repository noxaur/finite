# Shared CSS

Shared CSS holds styles every artboard in a design uses, like a `--brand` variable or a `.btn` class. An artboard's own styles still override it. A person edits it in the Shared CSS panel on the canvas, and an agent edits it with `set_shared_css`. Each side sees the other's change.

## Sub-features

- `css-panel-save` saves a person's edit from the panel, with `Save` or Cmd-S.
- `css-agent-read` returns the person's CSS to an agent through `get_shared_css`.
- `css-agent-write` shows an agent's `set_shared_css` in an open panel and applies it to every artboard.
- `css-close` closes the panel with `Close` or `Escape`, with no save.

## How to get to it (user POV)

- Choose `Shared CSS` in the canvas top bar. The button has `title="CSS every artboard uses"`.
- An agent calls `get_shared_css` and `set_shared_css` with the designId.

## Driving it with verify.sh

Preconditions:

- A design with one artboard holding `<button class="btn">Go</button>`, open in the page.

- **Open the panel.** Run `$V h $RUN click 'button[title="CSS every artboard uses"]'`, then `$V save $RUN 01-panel snapshot --selector 'form[aria-label="Shared CSS"]'`. It shows an empty textbox with placeholder `:root { --brand: #c2410c; }`, and the buttons `Close` and `Save`.
- **Person types and saves.** Run `$V h $RUN click 'form[aria-label="Shared CSS"] textarea'`, then `$V h $RUN type ".btn{background:rgb(194, 65, 12)}"`, then `$V h $RUN key Meta+s`.
- **Applied to the artboard.** Run `$V save $RUN 02-applied eval 'getComputedStyle($deep("[data-artboard] >>> .btn")).backgroundColor'`. It prints `rgb(194, 65, 12)`.
- **Agent reads it.** Run `$V save $RUN 03-agent-read call get_shared_css '{"designId":"<D>"}'`. It prints exactly what the person typed.
- **Agent writes it.** Run `$V h $RUN call set_shared_css '{"designId":"<D>","css":".btn{background:rgb(0, 128, 0)}"}'`, then `$V save $RUN 04-panel-follows snapshot --selector 'form[aria-label="Shared CSS"]'`. The open panel shows the agent's CSS, because the person has no unsaved draft, and the button turns `rgb(0, 128, 0)`.
- **Proof.** Run `$V shot $RUN 05-shared-css`.

## Gotchas

- The panel follows agents' edits only while the person has no unsaved draft. Once they've typed, an agent's change stays out of the textbox until they save or close.
- `type` appends to the current text. It doesn't select all first, so start from an empty panel or clear it with `eval`.
- Cmd-S inside the form saves. `Escape` closes it without saving.
- A save the server rejects, like CSS over the size limit, shows a `role="alert"` in the form. Snapshot the form, not just the artboard.
