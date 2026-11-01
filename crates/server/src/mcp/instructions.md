Finite is a design canvas for agents. A design (a canvas) holds artboards: fixed-size frames on an infinite canvas, containing ordinary HTML and CSS. Users watch live and can't edit, so all changes come from agents. Users steer agents by pinning comments.

Every tool except list_designs and create_design takes a designId. Other agents may edit the same design, so re-read the tree before editing nodes you didn't create.

Workflow:

1. Pick a design with list_designs (pass a query to find one by name), or create_design.
2. Orient: get_basic_info (it counts open comments), then get_tree_summary.
3. New screen: create_artboard with its first section in html (desktop 1440x900, tablet 768x1024, mobile 390x844). Without x and y it goes right of the others.
4. Build the rest in sections with write_html, one call per section (header, hero, card grid), not one huge call.
5. Check with get_screenshot after each section. An artboard's shot has a layout check naming content cut off by its edge and text overflowing its box. A node's shot is cropped to it: add padding, or scale 2, to read small text. nodeIds takes up to 10.
6. Refine with update_styles, set_text_content, set_attributes, move_nodes or delete_nodes. Each edit lists the nodes it changed.

Users see which artboards you edit. To say what you're doing, call start_working_on_nodes with a short status, then finish_working_on_nodes.

HTML: inline styles, or <style> blocks with classes. Prefer flexbox and gap. Name layers with data-name="Header". box-sizing is border-box. Images use <img src="https://...">; inline <svg> works. Artboards default to a white flex column with overflow hidden, so children shrink unless they have flex-shrink: 0. Resize an artboard with update_styles on its width or height. update_styles changes inline styles only; to change a <style> block, set_text_content on it with the whole new CSS.

Motion: a <style> or <script> only affects its own artboard, so select by class or id, not html or body. Use @keyframes, transitions and :hover. For pointer-following effects, use a <script> with addEventListener (on* attributes are dropped). Scripts run sandboxed: inline only, no network requests, remote images and fonts allowed, restarted after every edit. get_screenshot captures about 3 seconds after load.

Comments are user requests, pinned to an artboard and usually an element. When a design has open comments, call get_comments, make the change, check it with get_screenshot, then reply_to_comment saying what you changed, with resolve: true. Your reply links your edits to that artboard since the thread's last message. If a comment is unclear, ask in a reply and leave it open. To keep taking feedback, loop on wait_for_comments.

Long results come in parts: a note at the end says how to get the rest. Edits past a limit are refused with what to do instead.

Undo and redo reverse only your own changes, one tool call per step, and skip steps whose nodes someone else deleted.
