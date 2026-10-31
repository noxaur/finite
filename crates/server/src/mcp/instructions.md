Finite is a design canvas for agents. A design (also called a canvas) holds artboards: fixed-size frames placed on an infinite canvas. Artboards contain ordinary HTML elements styled with inline CSS. Users watch designs live and can't edit them, so all changes come from agents. Users steer agents by pinning comments to the canvas.

Every tool except list_designs and create_design takes a designId. You can work on several designs at once, and other agents may be editing the same design at the same time, so re-read the tree before editing nodes you didn't create.

Workflow:

1. Pick a design: list_designs, or create_design for a new one.
2. Orient: get_basic_info (it counts open comments), then get_tree_summary.
3. New screen: find_placement, then create_artboard (typical sizes: desktop 1440x900, tablet 768x1024, mobile 390x844).
4. Call start_working_on_nodes with the artboard id so users see what you're doing.
5. Build in small sections with write_html (one call per section, such as a header, a hero or a card grid), not one huge call.
6. Check the result with get_screenshot after each section. Correct markup doesn't guarantee a correct render.
7. Refine with update_styles, set_text_content, set_attributes, move_nodes or delete_nodes.
8. Call finish_working_on_nodes when done.

HTML rules: style with inline style attributes, or with <style> blocks and classes. Prefer flexbox and gap for layout. Name layers with data-name="Header". box-sizing is border-box. Images use <img src="https://...">. Inline <svg> works. New artboards default to a white flex column with overflow hidden.

Motion and interaction: each artboard is isolated, so a <style> or <script> inside it only affects that artboard. Put them inside the artboard, and select by class or id rather than html or body. Use CSS @keyframes and transitions for animation, and :hover for simple pointer effects. For anything that follows the cursor, use a <script> with addEventListener and requestAnimationFrame (inline on* attributes are dropped). An artboard with a script runs in a sandbox: inline code only, no network requests, remote images and fonts allowed. It restarts after every edit. get_screenshot runs scripts and captures the frame about 3 seconds after load.

Comments: a comment is a request from a user, pinned to an artboard and usually to the element they clicked. When a design has open comments, call get_comments, call start_working_on_nodes on the comment's node, make the change, check it with get_screenshot, then reply_to_comment saying what you changed, with resolve: true. Your reply links the edits you made to that artboard since the thread's last message, so the user can see what changed. If a comment is unclear, reply with a question and leave it open.

Undo: undo and redo reverse only your own changes, one tool call per step. Other agents' work is left alone. If someone else has since deleted the nodes a step touched, that step is skipped.
