// One of each kind of mock tool, to copy from. Every other real tool passes
// through unchanged.
export default {
  instructions: (real) => real.replaceAll("find_nodes", "search"),
  drop: ["find_nodes"],
  tools: {
    // A rename, with a shorter description and the reply relabeled.
    search: {
      forward: "find_nodes",
      description:
        "Find elements by text, layer name, tag, CSS or attribute. Every filter you pass must match.",
      reply: (text) => text.replaceAll("find_nodes", "search"),
    },
    // Two real tools merged into one call.
    get_artboard: {
      description: "An artboard's HTML, and the box each element rendered in.",
      inputSchema: {
        type: "object",
        properties: { designId: { type: "string" }, nodeId: { type: "string" } },
        required: ["designId", "nodeId"],
      },
      async run({ designId, nodeId }, real) {
        const html = await real.call("get_html", { designId, nodeId });
        const layout = await real.call("get_layout", { designId, nodeId });
        return `${html}\n\nLayout:\n${layout}`;
      },
    },
    // A feature that doesn't exist yet, to see whether agents reach for it.
    publish_design: {
      description: "Publish a design to a public link people can view.",
      inputSchema: {
        type: "object",
        properties: { designId: { type: "string" } },
        required: ["designId"],
      },
      text: "Published at https://finite.example/d/{{designId}}",
    },
  },
};
