import type { NextConfig } from "next";

const cors = [
  { key: "Access-Control-Allow-Origin", value: "*" },
  { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" },
  {
    key: "Access-Control-Allow-Headers",
    value: "Content-Type, X-WB-Name, X-WB-Token, X-WB-Kind, X-WB-Key, X-WB-Owner, X-WB-Admin, X-WB-Session, X-WB-Build, X-API-Key, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  },
  { key: "Access-Control-Expose-Headers", value: "X-WB-Seq, Retry-After, Mcp-Session-Id, X-WB-CLI-Latest" },
];

// One id per deploy, inlined into server and browser bundles alike. The page
// compares it with the server's and asks the human to reload when they differ.
const BUILD = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || `dev${Date.now().toString(36)}`;

const config: NextConfig = {
  env: { NEXT_PUBLIC_WB_BUILD: BUILD },
  async headers() {
    return [
      { source: "/api/:path*", headers: cors },
      { source: "/(api.php|grid.php|cell.php)", headers: cors },
    ];
  },
  async rewrites() {
    return [
      { source: "/api.php", destination: "/api/v1" },
      { source: "/grid.php", destination: "/api/v1/grid" },
      { source: "/cell.php", destination: "/api/v1" },
    ];
  },
};

export default config;
