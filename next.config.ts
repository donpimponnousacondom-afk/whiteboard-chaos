import type { NextConfig } from "next";

const cors = [
  { key: "Access-Control-Allow-Origin", value: "*" },
  { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" },
  {
    key: "Access-Control-Allow-Headers",
    value: "Content-Type, X-WB-Name, X-WB-Token, X-WB-Kind, X-WB-Key, X-WB-Admin, X-API-Key, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  },
  { key: "Access-Control-Expose-Headers", value: "X-WB-Seq, Retry-After, Mcp-Session-Id" },
];

const config: NextConfig = {
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
