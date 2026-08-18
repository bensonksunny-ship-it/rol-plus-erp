const nextConfig = {
  // Disable React StrictMode — prevents double-invocation of effects in dev.
  reactStrictMode: false,

  // ─── Cache headers ──────────────────────────────────────────────────────────
  // Hashed static chunks (_next/static/**) are safe to cache forever —
  // the hash changes on every deploy so stale content is never served.
  //
  // _next/static/chunks/ files get content-hashed names (e.g. page-abc123.js).
  // Browsers that cache them long-term will still get the correct file
  // because the HTML references the NEW hash after a deploy.
  //
  // The root cause of the ChunkLoadError loop was:
  //   old HTML in browser → references old chunk hash → Vercel 404s it →
  //   webpack retries → ChunkLoadError → React crash → page reloads → repeat.
  //
  // The ChunkErrorBoundary handles recovery. These headers ensure CDN and
  // browser caches are correctly configured going forward.
  async headers() {
    return [
      {
        // Hashed chunks — immutable, cache forever
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // HTML pages and API routes — always revalidate so new deploy is picked up
        source: "/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;