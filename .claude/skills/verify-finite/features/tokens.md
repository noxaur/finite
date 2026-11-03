# Tokens

Tokens are the design's CSS variables, like `--brand`, which every artboard reads with `var(--brand)`. A token has a value per mode, like Light and Dark, and each artboard renders in one mode. An artboard's own styles still override a token. A person edits tokens in the Tokens panel on the canvas, and an agent edits them with `set_tokens`. Each side sees the other's change.

## Sub-features

- `tokens-panel-add` adds a token from the panel's `Add` form.
- `tokens-panel-edit` changes a value, renames a token or deletes it, saving when a cell loses focus.
- `tokens-modes` adds, renames and deletes modes from the panel's header row.
- `tokens-artboard-mode` puts an artboard in a mode from the panel's artboard list, or with `set_artboard_mode`.
- `tokens-agent` reads and writes tokens through `get_tokens` and `set_tokens`, and an open panel follows.
- `tokens-migrate` moves a design's old shared CSS into tokens when it loads.

## How to get to it (user POV)

- Choose `Tokens` in the canvas top bar. The button has `title="CSS variables every artboard uses, in each mode"`.
- An agent calls `get_tokens`, `set_tokens` and `set_artboard_mode` with the designId.

## Driving it with verify.sh

Preconditions:

- A design with one artboard holding `<button style="color: var(--ok, rgb(1, 2, 3))">Go</button>`, open in the page.

- **Open the panel.** Run `$V h $RUN click 'button[title="CSS variables every artboard uses, in each mode"]'`, then `$V save $RUN 01-panel snapshot --selector 'section[aria-label=Tokens]'`. It shows a `Default` mode column, "No tokens yet." and the `Add a token` form.
- **Person adds a token.** Click `input[aria-label="New token name"]` and type `--ok`, click `input[aria-label="New token value"]` and type `rgb(0, 128, 0)`, then click `form[aria-label="Add a token"] button`.
- **Applied to the artboard.** Run `$V save $RUN 02-applied eval 'getComputedStyle($deep("[data-artboard] >>> button")).color'`. It prints `rgb(0, 128, 0)`.
- **Agent adds a mode.** Run `$V h $RUN call set_tokens '{"designId":"<D>","modes":["Light","Dark"],"tokens":{"--ok":{"Dark":"rgb(0, 0, 255)"}}}'`. The panel's header shows `Light` and `Dark`, and the artboard list shows a mode select.
- **Artboard in Dark.** Run `$V h $RUN call set_artboard_mode '{"designId":"<D>","artboardIds":["<B>"],"mode":"Dark"}'`, then check the button's color is `rgb(0, 0, 255)`.
- **Proof.** Run `$V shot $RUN 03-tokens`.

## Gotchas

- `key Enter` doesn't submit the `Add a token` form in headless Chrome, which sends no keypress. Click its button.
- A value cell saves when it loses focus. Enter blurs it, so `key Enter` works there.
- An empty cell in a mode other than the first shows the first mode's value as its placeholder, and the artboard uses that value.
- A value the server refuses, like `red; color: blue`, shows a `role="alert"` in the panel. Snapshot the panel, not just the artboard.
- An agent's presence chip can move the top bar's buttons. Wait for the agent's edit to land before you measure a click target.
