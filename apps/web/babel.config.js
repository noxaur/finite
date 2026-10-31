const path = require("node:path");

// StyleX compiles through Babel. See https://stylexjs.com/docs/learn/installation/
module.exports = {
  presets: ["next/babel"],
  plugins: [
    [
      "@stylexjs/babel-plugin",
      {
        dev: process.env.NODE_ENV !== "production",
        runtimeInjection: false,
        enableInlinedConditionalMerge: true,
        treeshakeCompensation: true,
        aliases: { "@/*": [path.join(__dirname, "src", "*")] },
        unstable_moduleResolution: { type: "commonJS" },
      },
    ],
  ],
};
