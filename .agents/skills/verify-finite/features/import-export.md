# Import and export

A person adds artboards to a design by importing a file (`.html`, `.finite`, `.figma.json` or `.tar`) with the Import button, and sees a card saying what it made. The Export menu offers each artboard as HTML or for Figma, and the whole design as a `.finite` bundle or a `.tar` of text files. Agents do the same with `import_design` and `export_design`.

## Sub-features

- `import-ui` imports a picked file as new artboards and shows `Imported N artboard(s).` in the Import card.
- `import-agent` imports a file passed as `content` through `import_design`, as one undo step.
- `export-menu` lists a link per artboard (HTML, Figma) and two whole-design links (`.finite`, `.tar`).
- `export-download` serves each link's file.
- `export-agent` returns a file's text from `export_design`.
- `round-trip` imports a `.finite` export into a new design with the same artboards.

## How to get to it (user POV)

- Choose `Import` in the canvas top bar, then pick a file in the OS file picker.
- Choose `Export` in the canvas top bar, then a menu item.
- An agent calls `import_design` or `export_design` with the designId.

## Driving it with verify.sh

Preconditions:

- A design with one artboard named `Home`, open in the page, with `<D>` and the artboard id in hand.
- An HTML file to import in the evidence folder: `printf '<!doctype html><html><body><div style="width:400px;height:300px" data-name="Imported card"><h2>Imported</h2></div></body></html>' > .verify/$RUN/import-card.html`.

- **Person imports.** Pick the file in the Import button's input. Run `$V save $RUN 01-import upload 'input[type=file]' .verify/$RUN/import-card.html`, then `$V h $RUN wait '$deep("aside[aria-label=Import] [role=status]")'` and `$V save $RUN 02-import-card snapshot --selector 'aside[aria-label=Import]'`. The card's status reads `Imported 1 artboard.`
- **Imported artboard stored.** Run `$V save $RUN 03-tree call get_tree_summary '{"designId":"<D>"}'`. It lists a new artboard named `import-card` holding `div "Imported card"` and its `h2`.
- **Export menu.** Run `$V h $RUN click 'button[title="Download an artboard or the whole design"]'`, then `$V save $RUN 04-menu eval '[...document.querySelectorAll("[role=menu] a")].map(a => a.textContent + " -> " + a.getAttribute("href"))'`. It lists `Home as HTML`, `Home for Figma`, the same pair for `import-card`, `Whole design as .finite` and `Whole design as text files (.tar)`, each with an `/api/designs/<D>/export?...` href.
- **Download serves the file.** Fetch two of those hrefs. Run `$V save $RUN 05-html api GET '<Home as HTML href>'` and `$V save $RUN 06-finite api GET '<.finite href>'`. The first answers `200 OK` with `<!doctype html>`, and the second with JSON whose `kind` is `finite-bundle` and whose `artboards` list both artboards.
- **Round trip.** Import the saved bundle into a new design as an agent. Run `$V h $RUN call create_design '{"name":"Round trip"}'` for `<D2>`. Then turn `06-finite.txt` into the tool's input: `python3 -c 'import sys,json; body=open(sys.argv[1]).read().split("\n",2)[2].rsplit("\n[exit",1)[0]; json.dump({"designId":sys.argv[2],"content":body,"format":"finite"},open(sys.argv[3],"w"))' .verify/$RUN/06-finite.txt <D2> .verify/$RUN/round-trip.json`. The `split` drops the saved transcript's command and status lines, and the `rsplit` drops its exit line. Run `$V save $RUN 07-round-trip call import_design @.verify/$RUN/round-trip.json`. It reads `Imported 2 artboard(s)`, names `Home` and `import-card`, and reports `No conversion issues reported.` Run `$V save $RUN 08-tree call get_tree_summary '{"designId":"<D2>"}'`. Both artboards are listed, at their original sizes.
- **Agent exports.** Run `$V save $RUN 09-agent-export call export_design '{"designId":"<D>","format":"html","artboardId":"<artboard id>"}'`. It reports `No conversion issues reported.`, then `home.html (text/html; charset=utf-8):` and the artboard's HTML.
- **Proof.** Run `$V shot $RUN 10-imported` with both artboards on the canvas, and `$V save $RUN 11-console console`.

## Gotchas

- The file input is hidden. `upload` sets its file through CDP, the same way the OS picker hands one over, and Chrome fires the input's change event. Clicking `Import` instead opens a native picker that headless Chrome can't show, and the run hangs on nothing.
- The download links use the `download` attribute, and headless Chrome saves downloads nowhere you can read. Prove `export-download` by fetching each href with `api GET`. That's the same request the link makes.
- An imported HTML artboard takes the file's name (`import-card`) and a 1440 × 900 frame, not the size of the HTML's root element.
- Scripts, `on*` handlers and embeds never reach the design on import. An import that contained them reports diagnostics in the card, so snapshot the whole card, not just its status line.
