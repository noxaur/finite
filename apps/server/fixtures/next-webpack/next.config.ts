import type { NextConfig } from "next";

// A webpack-only config: Turbopack doesn't run `webpack()`, so the page would show no bundler.
const nextConfig: NextConfig = {
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.DefinePlugin({ __BUNDLER__: JSON.stringify("webpack") }));
    return config;
  },
};

export default nextConfig;
