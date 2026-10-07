import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Deriv WebSocket client runs server-side in the Node runtime.
  serverExternalPackages: ["ws", "pg"],
};

export default nextConfig;
