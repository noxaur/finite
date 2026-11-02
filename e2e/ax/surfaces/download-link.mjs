// export_design answers with a command that downloads the file, instead of
// the file's text. A `path` the server writes to (surfaces/file-paths.mjs)
// saved the most calls, but the server may run on another machine and its
// MCP endpoint has no auth, so it can't write files for whoever asks. Does a
// download link, run where the agent is, keep most of the gain?

const base = process.env.FINITE_BASE;

export default {
  tools: {
    export_design: {
      description:
        'Export the design, or one artboard, as a file in a format like "html", "finite" or "figma" (for the Finite Figma plugin). Returns a diagnostic for anything that didn\'t convert exactly, and a command that downloads the file. Pass inline to get the file\'s text instead.',
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          format: { type: "string" },
          artboardId: { type: "string", description: "One artboard. Omit for the whole design." },
          inline: { type: "boolean", description: "Return the file's text in the reply." },
        },
        required: ["designId", "format"],
      },
      async run({ designId, format, artboardId, inline }, real) {
        const reply = await real.call("export_design", {
          designId,
          format,
          ...(artboardId ? { artboardId } : {}),
        });
        if (inline) return reply;
        // The real reply is the diagnostics, then the file name and the file.
        const [diagnostics, rest = ""] = reply.split(/\n(?=\S+ \([^)]+\):\n)/);
        const name = rest.match(/^(\S+) \(/)?.[1] ?? "export";
        const query = new URLSearchParams({
          format,
          ...(artboardId ? { artboard: artboardId } : {}),
        });
        const url = `${base}/api/designs/${designId}/export?${query}`;
        return `${diagnostics.trim()}\nDownload it with: curl -sSf -o '${name}' '${url}'\n(Change the -o name to save it elsewhere.)`;
      },
    },
  },
};
