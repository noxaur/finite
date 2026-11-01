// A minimal MCP client over Streamable HTTP, enough to drive Finite's tools.
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
    const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("");
    return data ? JSON.parse(data) : null;
  };
  await post({
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
  };
}

/** The first `#id` after `label` in a tool's outline output. */
export function idAfter(text, label) {
  const at = text.indexOf(label);
  if (at < 0) throw new Error(`${label} not in: ${text}`);
  return text.slice(at).match(/#([a-z0-9]+)/)[1];
}
