/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // The Rooms host calls the contract endpoints cross-origin, so allow CORS.
        source: "/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
          // Keep the launch token from leaking via Referer to any destination.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  // No X-Frame-Options: the room page must be embeddable in the Rooms sandboxed iframe.
};

module.exports = nextConfig;
