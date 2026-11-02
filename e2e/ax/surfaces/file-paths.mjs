// import_design and export_design with a `path`: Finite reads or writes the
// file itself, instead of the agent pasting the file's text into the call or
// copying an export out of the reply. Does it save calls and mistakes?
import fs from "node:fs";
import path from "node:path";

const base = process.env.FINITE_BASE;

/** The format a file name implies, as the web app's Import button does. */
const formatOf = (name) =>
  name.endsWith(".figma.json")
    ? "figma"
    : name.endsWith(".finite")
      ? "finite"
      : /\.html?$/.test(name)
        ? "html"
        : null;

export default {
  instructions: (real) =>
    real.replace(
      /Files: [^\n]*/,
      "Files: import_design adds a file as artboards, export_design writes one; both take a path.",
    ),
  tools: {
    import_design: {
      description:
        "Import a file into the design as new artboards, as one undo step. Pass path, the file's path on this machine; format comes from its extension unless you pass one. Returns the new artboards, a diagnostic for anything that didn't convert exactly (with preserved, visual and editable scores), and the import's id. Scripts, handlers and embeds never reach the design; Finite keeps the original file. strict refuses the import, changing nothing, if anything scores no or unknown on the axes you name.",
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          path: { type: "string", description: "Like landing.html or /Users/me/landing.html." },
          format: { type: "string", description: "html, finite or figma." },
          pageId: { type: "string", description: "The page the artboards go on." },
          strict: { type: "array", items: { type: "string" } },
        },
        required: ["designId", "path"],
      },
      async run({ designId, path: file, format, pageId, strict }, real) {
        const full = path.resolve(file);
        if (!fs.existsSync(full)) return `import_design: no file at ${full}`;
        return real.call("import_design", {
          designId,
          format: format ?? formatOf(full) ?? "html",
          contentBase64: fs.readFileSync(full).toString("base64"),
          fileName: path.basename(full),
          ...(pageId ? { pageId } : {}),
          ...(strict ? { strict } : {}),
        });
      },
    },
    export_design: {
      description:
        'Export the design, or one artboard, as a file in a format like "html", "finite" or "figma" (for the Finite Figma plugin), saved at path. Returns a diagnostic for anything that didn\'t convert exactly.',
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          format: { type: "string" },
          path: { type: "string", description: "Where to save it, like landing.figma.json." },
          artboardId: { type: "string", description: "One artboard. Omit for the whole design." },
        },
        required: ["designId", "format", "path"],
      },
      async run({ designId, format, path: file, artboardId }, real) {
        const reply = await real.call("export_design", {
          designId,
          format,
          ...(artboardId ? { artboardId } : {}),
        });
        // The real reply is the diagnostics, then the file itself.
        const diagnostics = reply.split(/\n\S+ \([^)]+\):\n/)[0];
        const query = new URLSearchParams({
          format,
          ...(artboardId ? { artboard: artboardId } : {}),
        });
        const res = await fetch(`${base}/api/designs/${designId}/export?${query}`);
        if (!res.ok) return `export_design: ${await res.text()}`;
        const bytes = Buffer.from(await res.arrayBuffer());
        const full = path.resolve(file);
        fs.writeFileSync(full, bytes);
        return `${diagnostics.trim()}\nSaved ${full} (${bytes.length} bytes).`;
      },
    },
  },
};
