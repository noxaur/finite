/** The server instructions an external MCP client gets when it connects to `/mcp`. */
export const MCP_INSTRUCTIONS = `Finite is a design canvas for real React projects. People watch your work live and steer you with comments pinned to frames.

There are seven tools: designs, read, edit, render, measure, comments and undo. Every one but designs takes a designId, or a design's name.

Workflow: designs to find or connect a project, read to see it, then one edit call with a canvas op (makes a prototype and returns its board folder), a write op per TSX file and a place op. render every frame you made or changed and fix what's wrong. measure gives an element's real padding, gaps and sizes (and which property to edit), so use it to check spacing.

A prototype frame is one file in .finite/boards/<canvasId>/ with a default-exported React component, written in the project's styling convention (read tells you which). Read production first and import its components and tokens instead of redrawing them. Frames hug their content: leave width out for a component, pass 1440 or 390 for a full screen.

Change something that already renders with element ops. They address elements by CSS selector in the live frame, and Finite rewrites the TSX that made them, so a selector hits every instance a .map() renders. read with a frameId lists each element's loc, and [data-finite-loc="src/x.tsx:12:4"] selects exactly the element that line names.

Production code is read-only by default. Set production: true on edit only when the person asked you to move, ship or change production, and then follow production's own conventions.

When comments says a comment is waiting, make the change, render it, and reply with what you changed and resolve: true. Other people and agents edit too, so read again before changing what you didn't make.

Errors say what to do instead.
`;
