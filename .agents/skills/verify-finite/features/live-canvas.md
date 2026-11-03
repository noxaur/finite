# Live canvas

A person watching a design's canvas sees each agent's edit land as it happens: new artboards, written HTML, style changes and deletes, with no reload. A chip in the top bar names each agent present, and a dot shows whether the socket is live.

## Sub-features

- `canvas-render` renders an agent's artboard and its HTML in the page.
- `canvas-live` applies a later edit (`update_styles`, `set_text_content`) to the open page without a reload.
- `canvas-presence` shows a chip per agent, and separate chips for `--agent` names.
- `canvas-undo` reverts an agent's own last edit with `undo`, and the page follows.
- `canvas-screenshot` returns a PNG of an artboard from `get_screenshot`, with a layout check.

## How to get to it (user POV)

- Open `/design/?id=<designId>` from the design list or by URL. The id appears in the top bar.
- An agent calls MCP tools on that designId while the canvas is open.

## Driving it with verify.sh

Preconditions:

- A design from `$V h $RUN call create_design '{"name":"Live"}'`, with its designId.

- **First artboard.** An agent creates one. Run `$V h $RUN call create_artboard '{"designId":"<D>","name":"Home","width":800,"height":500,"html":"<section data-name=\"Hero\" style=\"padding:40px\"><h1>Hello</h1><button data-name=\"CTA\">Go</button></section>"}'`. The reply lists the artboard id and the node ids.
- **Person opens it.** Run `$V h $RUN design <D>`. It prints `1 of 1 artboards rendered`.
- **Live style edit.** With the page open, the agent restyles the button. Run `$V h $RUN call update_styles '{"designId":"<D>","updates":[{"nodeIds":["<button id>"],"styles":{"background":"orange"}}]}'`, then `$V save $RUN 01-live eval 'getComputedStyle($deep("[data-artboard] >>> button")).backgroundColor'`. It prints `rgb(255, 165, 0)`, with no `open` or `design` in between.
- **Presence.** Run `$V h $RUN call get_basic_info '{"designId":"<D>"}' --agent Bob`, then `$V save $RUN 02-presence snapshot --selector header`. The header lists chips `Agent` and `Bob`.
- **Undo per agent.** Alice turns the orange button red, and Bob turns the heading blue. Then Alice undoes. Run `$V h $RUN call update_styles '{"designId":"<D>","updates":[{"nodeIds":["<button id>"],"styles":{"background":"red"}}]}' --agent Alice`, `$V h $RUN call update_styles '{"designId":"<D>","updates":[{"nodeIds":["<h1 id>"],"styles":{"color":"blue"}}]}' --agent Bob`, `$V save $RUN 02b-undo call undo '{"designId":"<D>"}' --agent Alice`, then `$V save $RUN 02c-after-undo eval '[getComputedStyle($deep("[data-artboard] >>> button")).backgroundColor, getComputedStyle($deep("[data-artboard] >>> h1")).color]'`. The undo reply reads `Undid: Update styles`, and the page shows the button orange again (`rgb(255, 165, 0)`, the default agent's edit) and the heading still `rgb(0, 0, 255)`: Alice's undo reverted only her own edit. The header lists chips `Alice` and `Bob`.
- **Agent's screenshot.** Run `$V save $RUN 03-get-screenshot call get_screenshot '{"designId":"<D>","nodeIds":["<artboard id>"]}'`. It prints a PNG path, and cleanup copies the PNG to `tool-images/`.
- **Proof.** Run `$V shot $RUN 04-canvas` and `$V save $RUN 05-stored api GET /api/designs/<D>`. The stored nodes match what the page shows.

## Gotchas

- An artboard with a `<script>` renders in a sandboxed iframe. `$deep` and `>>>` can't reach inside it, so check it with `get_screenshot` or a page screenshot instead.
- A chip shows only while that agent's MCP session is present. Make a call as that agent shortly before you snapshot.
- `get_screenshot` uses its own headless Chrome, run by the server, not the harness's page. A blank image there doesn't mean the page is blank.
- The page can lag the tool reply by a frame. When a check races, wrap it in `wait`.
- Undo without `--agent` undoes the default `Agent`'s last edit, not Alice's. Pass the same `--agent` on `undo` as on the edit it should revert.
