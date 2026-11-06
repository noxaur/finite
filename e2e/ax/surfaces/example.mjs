// One of each kind of mock tool, to copy from. Every other real tool passes
// through unchanged.
export default {
  instructions: (real) => real.replaceAll("render", "look"),
  drop: ["render"],
  tools: {
    // A rename, with a shorter description and the reply relabeled.
    look: {
      forward: "render",
      description: "An image of what select matches, with a layout check.",
      reply: (text) => text.replaceAll("render", "look"),
    },
    // Two real calls merged into one tool.
    get_artboard: {
      description: "An artboard's HTML, and the box each element rendered in.",
      inputSchema: {
        type: "object",
        properties: { designId: { type: "string" }, artboardId: { type: "string" } },
        required: ["designId", "artboardId"],
      },
      async run({ designId, artboardId }, real) {
        const select = `#${artboardId}`;
        const html = await real.call("read", { designId, select, as: "html" });
        const layout = await real.call("render", { designId, select, output: "layout" });
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
