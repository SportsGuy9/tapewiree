import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const staticDemo = process.env.NEXT_PUBLIC_STATIC_DEMO === "1";

const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // The hosted demo is served from an arbitrary path, so assets resolve relative to the page, under app/
  // (some hosts reserve top-level names starting with "_").
  assetPrefix: staticDemo ? "./app" : undefined,
  distDir: staticDemo ? "out-demo-build" : ".next",
};

export default nextConfig;
