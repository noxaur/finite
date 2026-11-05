# Comments

A person steers agents by pinning comments to elements on the canvas. An agent reads them, makes the change, and replies with `resolve: true`. The reply links the agent's changes, and the resolved pin leaves the canvas at once. The Comments panel lists every comment, open and resolved.

## Sub-features

- `comment-pin` pins a comment to the clicked element in comment mode.
- `comment-multi` points one comment at several elements with Shift-click on the same artboard.
- `comment-wait` hands a new comment to an agent blocked in `wait_for_comments`.
- `comment-reply` posts an agent's reply, links its changes and resolves the thread.
- `comment-resolved-pin` removes a resolved pin from the canvas immediately.
- `comment-panel` lists comments under `Open N` and `Resolved N`, and opens a thread when you pick one.
- `comment-reopen` reopens a resolved comment when the person replies.
- `comment-name` saves the person's name in place of `Guest`.
- `comment-edit` changes the person's own newest message while no one has answered it, marked `· edited`.
- `comment-delete` deletes a comment and its replies after a confirmation.

## How to get to it (user POV)

- Choose `Comment (C)` in the `Tools` toolbar at the bottom of the canvas, or press `c`.
- Click an element in an artboard to open the comment box, type, and press `Enter` or choose `Send`.
- Shift-click more elements of the same artboard while the box is open.
- Choose the name after `Commenting as` in the box to change it.
- Choose a pin, or a row in the Comments panel, to open its thread: `Edit`, `Delete`, `Resolve`/`Reopen` and `Reply` are there.
- Choose `Comments` in the top bar to open the panel.
- An agent calls `get_comments`, `wait_for_comments` and `reply_to_comment`.

## Driving it with verify.sh

Preconditions:

- A design with an artboard holding `<h1 data-name="Title">Hello</h1><button data-name="CTA">Go</button>`, open in the page, as in the live canvas recipe. You have `<D>` and both nodeIds.
- The artboard has no `<script>`, because selectors can't reach a sandboxed one.
- The design has no comments yet.

- **Agent waits.** Run `$V bg $RUN 02-wait call wait_for_comments '{"designId":"<D>","timeoutSeconds":55}'`. It starts and returns at once, and the call blocks in the background. 55 seconds is the most the server waits.
- **Person pins.** Switch to the comment tool and click the button. Run `$V h $RUN key c`, then `$V h $RUN click '[data-artboard] >>> button'`, then `$V save $RUN 01-box snapshot --selector form`. The form shows textbox `Add a comment` [focused] and a disabled `Send`.
- **Several elements.** Shift-click the heading. Run `$V h $RUN click '[data-artboard] >>> h1' --shift`, then `$V save $RUN 01b-count query '[data-selection-count]'`. It reads `2 elements · Shift-click to add or remove`.
- **Name.** Run `$V h $RUN click 'button[title="Change your name"]'`, `$V h $RUN type "Verifier"` and `$V h $RUN key Enter`. The comment the agent gets below carries `author` `Verifier`, which proves the name was saved.
- **Person posts.** Run `$V h $RUN click 'textarea[placeholder="Add a comment"]'`, `$V h $RUN type "Make these orange"` and `$V h $RUN key Enter`.
- **Agent gets it.** Run `$V await $RUN 02-wait 30`. It prints one comment whose `nodeId` is the button, with `alsoSelected` holding the heading, `author` `Verifier`, `resolved: false` and the message.
- **Pin and count.** Run `$V h $RUN key Escape`, then `$V save $RUN 03-open snapshot --selector main`. It has a button `Comment: Make these orange`, and the top bar's button reads `Comments1`.
- **Edit.** Open the thread and edit the message. Run `$V h $RUN click 'button[aria-label^="Comment: "]'`, `$V save $RUN 04-thread snapshot --selector '[role=dialog]'` (it shows `Delete`, `Resolve`, `Close` and `Edit`), then `$V h $RUN click '[role=dialog] li button'`, `$V h $RUN eval "document.execCommand('selectAll')"`, `$V h $RUN type "Make both orange"` and `$V h $RUN key Enter`. Then `$V save $RUN 05-edited call get_comments '{"designId":"<D>"}'` shows the message `Make both orange`, and the thread shows `· edited`.
- **Agent answers.** Run `$V h $RUN key Escape`, `$V h $RUN call update_styles '{"designId":"<D>","updates":[{"nodeIds":["<button id>","<h1 id>"],"styles":{"background":"orange"}}]}'`, then `$V save $RUN 06-reply call reply_to_comment '{"designId":"<D>","commentId":"<C>","message":"Made both orange","resolve":true}'`. The reply says `The comment is resolved` and links `1 change`.
- **Pin leaves.** Run `$V save $RUN 07-resolved snapshot --selector main`. It has no `Comment: Make both orange` button, and the top bar's button reads plain `Comments`.
- **Panel.** Run `$V h $RUN click 'button[title="Every comment, open and resolved"]'`, then `$V save $RUN 08-panel snapshot --selector 'aside[aria-label=Comments]'`. The tabs read `Open 0` and `Resolved 1`. Run `$V shot $RUN 08-panel`.
- **Reopen by replying.** Open the resolved comment from the panel and reply. Run `$V h $RUN click '[role=tab]' --nth 1`, `$V h $RUN click 'aside[aria-label=Comments] li button'`, then `$V h $RUN click 'textarea[placeholder="Reply"]'`, `$V h $RUN type "Darker, please"` and `$V h $RUN key Enter`. Then `$V save $RUN 09-reopened snapshot --selector 'aside[aria-label=Comments] [role=tablist]'` reads `Open 1` and `Resolved 0`.
- **Stored.** Run `$V save $RUN 10-stored api GET /api/designs/<D>`. `comments[0]` has `resolved: false` and three messages, two with `kind: "user"` and one with `kind: "agent"`.
- **Delete.** In the open thread, run `$V h $RUN click '[role=dialog] button'` (the first button, `Delete`), then `$V save $RUN 11-confirm snapshot --selector '[role=dialog]'`. It shows the dialog `Delete comment` with `Delete this comment and its replies?`, `Cancel` and `Delete`. Run `$V h $RUN click '[role=dialog] button' --nth 1`. Then `$V save $RUN 12-deleted call get_comments '{"designId":"<D>"}'` prints `No open comments.`, and the panel's tabs read `Open 0` and `Resolved 0`.
- **Proof.** Run `$V save $RUN 13-console console`.

## Gotchas

- Clicking an element in pointer mode selects nothing and opens no box. Press `c` first, and check the `Comment (C)` button is pressed if the click does nothing.
- `wait_for_comments` returns as soon as anything is waiting, including comments posted before the call. Start it on a design with no unanswered comments, or the proof shows an old one.
- In comment mode the left button doesn't pan, so `click` on empty canvas pins a canvas-level comment (`artboardId: null`) instead of doing nothing.
- `Escape` closes the comment box and throws away the draft.
- `type` appends. The edit box starts with the old message, and `key Meta+a` doesn't select it, so select it with `execCommand('selectAll')` first, or the edit comes out as the new text followed by the old.
- `Edit` only shows on the person's own newest message, and only until someone answers. After the agent's reply, its absence is correct.
- The thread's buttons have no titles, so the recipe picks them by order. Check the order with `$V h $RUN query '[role=dialog] button'` if a click lands on the wrong one.
- The open count is part of the button's accessible name (`Comments1`). Match on `title`, not the name.
