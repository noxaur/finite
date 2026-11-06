Finite is a design canvas for agents. A design (a canvas) holds artboards: fixed-size frames on an infinite canvas, containing ordinary HTML and CSS. Users watch live, steer agents by pinning comments, and can move, resize and delete things too.

Every tool except list_designs and create_design takes a designId. Agents and people may edit the same design, so re-read the tree before editing nodes you didn't create.

Workflow:

1. Pick a design with list_designs (pass a query to find one by name or id), or create_design.
2. Orient: get_basic_info (it counts open comments), then get_tree_summary.
3. New screen: create_artboard with its first section in html (desktop 1440x900, tablet 768x1024, mobile 390x844). Without x and y it goes right of the others. Omit the height and the artboard grows to fit its content.
4. Build the rest in sections with write_html, one call per section, not one huge call.
5. Check with get_screenshot after each section. An artboard's shot has a layout check naming content cut off by its edge and text overflowing its box. A node's shot is cropped to it: add padding, or scale 2, to read small text.
6. get_layout gives each element's box (to place pins over content) and cut-off, overflowing and overlapping text, without an image.
7. Refine with update_styles, set_text_content, set_attributes, move_nodes or delete_nodes.

To show users what you're doing, call start_working_on_nodes with a short status, then finish_working_on_nodes.

HTML: inline styles, or <style> blocks with classes. Prefer flexbox and gap. Name layers with data-name="Header". box-sizing is border-box. Images use <img src="https://...">; inline <svg> works. Artboards default to a white flex column with overflow hidden, so children shrink unless they have flex-shrink: 0. Resize an artboard with update_styles on its width or height. update_styles changes inline styles only; for part of a <style> or <script>, use replace_values with within, and set_text_content only to rewrite all of it.

Components: put data-component="Top bar" on each copy of a part screens share. The first defines it, later ones are instances whose differences become overrides. Edit the first to change all. Also create_component, get_components, detach_instance.

Motion: a <style> or <script> only affects its own artboard, so select by class or id, not html or body. Use @keyframes, transitions and :hover. For pointer-following effects, use a <script> with addEventListener (on* attributes are dropped). Scripts run sandboxed, restart on edit; https <script src>, fetch, localStorage work. href="#finite-artboard=<id>" links. WebGL shaders work. get_screenshot waits about 3 seconds after load; settleMs (up to 10000) waits longer.

Comments are user requests, pinned to an artboard and usually an element. When a design has open comments, call get_comments, make the change, check it with get_screenshot, then reply_to_comment saying what you changed, with resolve: true. If a comment is unclear, ask in a reply and leave it open. Skip ones "for" others. To keep taking feedback, loop on wait_for_comments.

Long results come in parts: a note at the end says how to get the rest.

Undo and redo reverse only your own changes, one tool call per step, and skip steps whose nodes someone else deleted.

Files: import_design adds one as artboards, export_design writes one.
