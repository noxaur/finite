# Design list

The design list at `/` shows every design as a card with a thumbnail, name, artboard count and age. A person can create an empty design and open any design's canvas. A search box appears once there are more designs than the list shows, or while a query is active.

## Sub-features

- `list-empty` shows `No designs yet. Create one, or ask an agent to.` on an empty server.
- `list-card` shows a card for a design an agent created, without a reload.
- `list-create` creates an `Untitled` design from `New design` and opens its canvas.
- `list-open` opens a design's canvas from its card.
- `list-search` filters designs by name.

## How to get to it (user POV)

- Load `/`, or choose `← Designs` on a canvas.
- Choose the `New design` button.
- Choose a design card.
- Type in `Search designs by name`. It shows only when the list is truncated or a query is set.

## Driving it with verify.sh

Preconditions:

- A fresh run, so the data folder is empty.
- The page is on `/` (`$V h $RUN open /`).

- **Empty state.** Look at the list. Run `$V save $RUN 01-empty snapshot --selector main`. It shows `No designs yet. Create one, or ask an agent to.` and an empty `list`.
- **Agent's design appears.** An agent creates a design. Run `$V h $RUN call designs '{"create":"Verify list"}'`, then `$V h $RUN wait '$deep("main a")?.textContent.includes("Verify list")'`. A card `link` named with `Verify list` and `0 artboards` appears without a reload.
- **Create from the list.** Choose `New design`. Run `$V h $RUN click 'main header button'`, then `$V h $RUN wait 'location.pathname.startsWith("/design")'`. The URL becomes `/design/?id=<id>`, and the top bar shows `Untitled`.
- **Stored.** Read the list back. Run `$V save $RUN 02-designs api GET /api/designs`. It lists both `Untitled` and `Verify list`.
- **Open from a card.** Choose `← Designs`, then the `Verify list` card. Run `$V h $RUN click 'header a[href="/"]'`, wait for `location.pathname === "/"`, then `$V h $RUN click 'main li a' --nth <i>`, picking `<i>` from `$V h $RUN query 'main li a'`. The canvas top bar shows `Verify list`.
- **Proof.** Back on `/`, run `$V save $RUN 03-list snapshot --selector main` and `$V shot $RUN 03-list`. Both show both cards.

## Gotchas

- `Search designs by name` isn't rendered until the server holds more designs than the first page of the list. A handful of designs won't show it, so prove `list-search` with enough designs or report it as skipped.
- Cards sort by last edit, so `--nth` indexes shift after any edit. Pick by text from `query`, not by a remembered index.
- `New design` is the only button in `main header`. The canvas has its own `header`, so the selector only works on `/`.
