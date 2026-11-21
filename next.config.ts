import type { NextConfig } from "next";

// Static export so the app can be hosted on GitHub Pages (it is fully client-side).
// PAGES_BASE_PATH is set by the deploy workflow ("" on a custom domain, "/repo" on github.io).
const basePath = process.env.PAGES_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
