// A mock MCP server for AX experiments: it shows agents a tool surface from a
// spec file and answers through a real finite-server, so a redesign of the
// tools can be tried on agents before any of it is built in Rust.
//
//   node e2e/ax/run.mjs --task rebrand --runs 3 --label no-search --surface e2e/ax/surfaces/no-search.mjs
//
// run.mjs starts it over stdio, with FINITE_BASE set to the run's server.
// Tools the spec doesn't name pass through unchanged, so a spec only holds
// what it changes. A spec file's default export:
//
//   instructions   a string, or (real) => string from the real server's text
//   drop           names of real tools to hide, or "all" to hide every unnamed one
//   tools          { name: tool }, where a tool takes the real tool of the
//                  same name (or `forward`'s) and overrides any of:
//     description, inputSchema   what the agent sees
//     forward: "real_tool"       answer with this real tool (default: the same name)
//     args: (a) => a             reshape the agent's arguments for it
//     reply: (text, a) => text   rewrite the text of its answer; images pass through
//     run: async (a, real) => text | result
//                                answer in code instead, with `real` from e2e/mcp.mjs
//     text: "Done {{id}}"        a canned answer, with the agent's arguments filled in
//
// A handler that throws becomes an isError result with the error's message,
// so write those messages for the agent.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "../mcp.mjs";

// Claude Code keeps only this much of a server's instructions.
const INSTRUCTIONS_LIMIT = 4096;

const specFile = process.argv[2];
if (!specFile || !process.env.FINITE_BASE) {
  console.error("usage: FINITE_BASE=http://127.0.0.1:PORT node e2e/ax/mock-surface.mjs <spec.mjs>");
  process.exit(2);
}
const spec = (await import(pathToFileURL(path.resolve(specFile)).href)).default;
const real = await connect(process.env.FINITE_BASE, process.env.FINITE_AGENT ?? "Agent");
const realTools = new Map((await real.tools()).map((t) => [t.name, t]));
// For `run`: real.call's errors start with the real tool's name, which the
// agent may never have seen, so these carry the server's text alone.
const forRun = {
  ...real,
  async call(name, args = {}) {
    const result = await real.callRaw(name, args);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    if (result.isError) throw new Error(text);
    return text;
  },
};

const instructions =
  typeof spec.instructions === "function"
    ? spec.instructions(real.instructions)
    : (spec.instructions ?? real.instructions);
if (instructions.length > INSTRUCTIONS_LIMIT)
  console.error(
    `mock-surface: instructions are ${instructions.length} chars; Claude Code keeps ${INSTRUCTIONS_LIMIT}`,
  );

/** The surface: every tool the agent sees, with how to answer it. */
const surface = new Map();
const named = spec.tools ?? {};
for (const [name, tool] of realTools) {
  const hidden = spec.drop === "all" || spec.drop?.includes(name);
  if (!hidden && !named[name]) surface.set(name, { ...tool, forward: name });
}
for (const [name, def] of Object.entries(named)) {
  const forward = def.run || def.text != null ? null : (def.forward ?? name);
  const base = realTools.get(def.forward ?? name);
  if (forward && !realTools.has(forward))
    throw new Error(`${name}: no real tool ${forward} to forward to; give it run or text`);
  if (!base && (!def.description || !def.inputSchema))
    throw new Error(`${name}: a new tool needs a description and an inputSchema`);
  surface.set(name, {
    ...base,
    ...def,
    name,
    forward,
    inputSchema: def.inputSchema ?? base.inputSchema,
  });
}

/**
 * Checks arguments against a tool's schema like the real server does: it
 * accepts arrays and objects sent as JSON strings, as agents often send them
 * before they've loaded a schema. Returns the arguments or throws.
 */
function validate(schema, args) {
  const out = { ...args };
  for (const key of schema.required ?? [])
    if (out[key] === undefined) throw new Error(`missing field \`${key}\``);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let value = out[key];
    if (value === undefined) continue;
    const types = [prop.type ?? []].flat();
    if (typeof value === "string" && (types.includes("array") || types.includes("object"))) {
      try {
        value = out[key] = JSON.parse(value);
      } catch {}
    }
    const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok =
      !types.length ||
      types.some((t) => t === kind || (t === "integer" && Number.isInteger(value)));
    if (!ok) throw new Error(`invalid type for \`${key}\`: expected ${types.join(" or ")}`);
  }
  return out;
}

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text: String(text) }],
  ...(isError && { isError: true }),
});

async function answer(tool, args) {
  if (tool.text != null)
    return textResult(tool.text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(args[k] ?? "")));
  if (tool.run) {
    const out = await tool.run(args, forRun);
    return typeof out === "string" ? textResult(out) : out;
  }
  const result = await real.callRaw(tool.forward, tool.args ? tool.args(args) : args);
  if (!tool.reply) return result;
  return {
    ...result,
    content: result.content.map((c) =>
      c.type === "text" ? { ...c, text: tool.reply(c.text, args) } : c,
    ),
  };
}

const listed = [...surface.values()].map(
  ({ name, title, description, inputSchema, annotations }) => ({
    name,
    ...(title && { title }),
    description,
    inputSchema,
    ...(annotations && { annotations }),
  }),
);

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "finite", version: "mock" },
        instructions,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: listed };
    case "tools/call": {
      const tool = surface.get(msg.params?.name);
      if (!tool)
        throw Object.assign(new Error(`tool not found: ${msg.params?.name}`), { code: -32602 });
      let args;
      try {
        args = validate(tool.inputSchema ?? {}, msg.params.arguments ?? {});
      } catch (error) {
        throw Object.assign(new Error(`failed to deserialize parameters: ${error.message}`), {
          code: -32602,
        });
      }
      try {
        return await answer(tool, args);
      } catch (error) {
        return textResult(error.message, true);
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
  }
}

// stdio transport: one JSON-RPC message per line each way.
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Notifications and responses need no answer.
    if (msg.id === undefined || !msg.method) continue;
    handle(msg).then(
      (result) => send({ jsonrpc: "2.0", id: msg.id, result }),
      (error) =>
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: error.code ?? -32603, message: error.message },
        }),
    );
  }
});
process.stdin.on("end", () => process.exit(0));
