// A minimal MCP client over Streamable HTTP, enough to drive Finite's six
// tools (designs, read, edit, render, comments, undo) the way an agent does.
export async function connect(base, agent = "E2E") {
  let session;
  let id = 0;
  const post = async (body) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Finite-Agent": agent,
    };
    if (session) headers["Mcp-Session-Id"] = session;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("");
    return data ? JSON.parse(data) : null;
  };
  const init = await post({
    jsonrpc: "2.0",
    id: id++,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "finite-e2e", version: "1" },
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const request = async (method, params, label = method) => {
    const res = await post({ jsonrpc: "2.0", id: id++, method, params });
    if (!res) throw new Error(`${label}: no response`);
    if (res.error) throw new Error(`${label}: ${JSON.stringify(res.error)}`);
    return res.result;
  };
  return {
    /** The server's instructions, as agents see them when they connect. */
    instructions: init?.result?.instructions ?? "",
    /** Calls a tool and returns its text. Throws if the tool reports an error. */
    async call(name, args = {}) {
      const result = await this.callRaw(name, args);
      const text = result.content.map((c) => c.text ?? "").join("\n");
      if (result.isError) throw new Error(`${name}: ${text}`);
      return text;
    },
    /** Calls a tool and returns its whole result: `content`, with any images, and `isError`. */
    callRaw(name, args = {}) {
      return request("tools/call", { name, arguments: args }, name);
    },
    /** Lists the server's tools, with their descriptions and input schemas. */
    async tools() {
      return (await request("tools/list", {})).tools;
    },
    /** Creates a design and returns its designId. */
    async createDesign(name) {
      return (await this.call("designs", { create: name })).match(/designId "([a-z0-9]+)"/)[1];
    },
    /**
     * Runs `ops` as one edit and returns the result text. The layout check
     * is off unless `extra` turns it on, since it waits for a browser.
     */
    edit(designId, ops, extra = {}) {
      return this.call("edit", { designId, ops, check: false, ...extra });
    },
    /** Adds an artboard (`fields` are the artboard op's) and returns its id. */
    async artboard(designId, fields) {
      const text = await this.edit(designId, [{ op: "artboard", ...fields }]);
      return text.match(/Created artboard \S+ (?:".*" )?#([a-z0-9]+)/)[1];
    },
    /** Appends `html` to the node `id`, and returns the result text. */
    write(designId, id, html) {
      return this.edit(designId, [{ op: "html", select: `#${id}`, html }]);
    },
    /** A selector's HTML, as `read` shows it. */
    readHtml(designId, select) {
      return this.call("read", { designId, select, as: "html" });
    },
    /** Like `readHtml`, but throws if the result left something out. */
    async readFullHtml(designId, select) {
      const text = await this.readHtml(designId, select);
      const cut = text.match(/not shown|more than a result holds|cut short|cut off after/);
      if (cut)
        throw new Error(`read ${select} left something out (${cut[0]}): ${text.slice(-400)}`);
      return text;
    },
    /** A design's size and artboards, read from `read`'s overview. */
    async overview(designId) {
      // Depth 0 lists only the artboards, so a big design isn't cut off.
      const text = await this.call("read", { designId, depth: 0 });
      const nodes = Number(text.match(/: \d+ artboards?, (\d+) nodes/)?.[1] ?? 0);
      const artboards = [];
      let page = null;
      for (const line of text.split("\n")) {
        page = line.match(/^Page "(.*)":$/)?.[1] ?? page;
        const m = line.match(
          /^\S+ (?:"(.*)" )?#([a-z0-9]+) \(artboard at (-?[\d.]+), (-?[\d.]+)\) \[(\d+)px × (\d+|auto)(?:px)?\]/,
        );
        if (m)
          artboards.push({
            id: m[2],
            name: m[1] ?? null,
            x: Number(m[3]),
            y: Number(m[4]),
            width: Number(m[5]),
            height: m[6] === "auto" ? null : Number(m[6]),
            page,
          });
      }
      const reported = Number(text.match(/: (\d+) artboards?,/)?.[1] ?? 0);
      if (artboards.length !== reported)
        throw new Error(`overview parsed ${artboards.length} of ${reported} artboards: ${text}`);
      return { nodes, artboards };
    },
  };
}

/** The first `#id` after `label` in a tool's outline output. */
export function idAfter(text, label) {
  const at = text.indexOf(label);
  if (at < 0) throw new Error(`${label} not in: ${text}`);
  return text.slice(at).match(/#([a-z0-9]+)/)[1];
}
