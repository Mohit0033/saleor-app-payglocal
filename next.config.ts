import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Runner needs no node_modules (docker): `next start` via server.js
  output: "standalone",
};

export default nextConfig;
