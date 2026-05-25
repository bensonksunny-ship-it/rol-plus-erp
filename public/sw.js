// ROL's Plus Service Worker
// Strategy:
//   /_next/static/**  → cache-first  (content-hashed, immutable)
//   navigation        → network-first → offline.html fallback
//   Firebase/auth     → network-only  (NEVER cached)
//   everything else   → network-first → cache fallback

const CACHE_VER   = "v2";
const STATIC_CACHE = `rol-static-${CACHE_VER}`;
const SHELL_CACHE  = `rol-shell-${CACHE_VER}`;
const ALL_CACHES   = [STATIC_CACHE, SHELL_CACHE];

// Patterns that must NEVER be intercepted by the SW
const BYPASS_PATTERNS = [
  "firebaseapp.com",
  "googleapis.com",
  "firebase.google.com",
  "gstatic.com",
  "identitytoolkit",
  "securetoken",
  "/__/auth/",
  "/__/firebase/",
];

// ── Install ───────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["/offline.html"]))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !ALL_CACHES.includes(k))
            .map((k) => {
              console.log("[SW] Deleting old cache:", k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== "GET") return;

  // Skip non-http(s) (chrome-extension, data:, etc.)
  if (!url.protocol.startsWith("http")) return;

  // Never intercept Firebase / auth / analytics
  if (BYPASS_PATTERNS.some((p) => url.href.includes(p))) return;

  // Next.js static assets — cache-first (they're content-hashed, safe forever)
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // HTML navigation — network-first, fallback to offline page
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigate(request));
    return;
  }

  // Same-origin requests (icons, manifest, etc.) — network-first
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // Cross-origin (fonts, CDN) — network only
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Asset unavailable offline", { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response("Unavailable offline", { status: 503 });
  }
}

async function networkFirstNavigate(request) {
  try {
    const response = await fetch(request);
    // Cache successful navigations so the shell loads offline
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Try the exact cached page first
    const cached = await caches.match(request);
    if (cached) return cached;

    // Fall back to root (SPA shell)
    const root = await caches.match("/");
    if (root) return root;

    // Last resort: offline page
    const offline = await caches.match("/offline.html");
    return (
      offline ??
      new Response(
        "<!DOCTYPE html><html><body style='font-family:system-ui;padding:40px;background:#0f172a;color:#f1f5f9'>" +
          "<h1>You are offline</h1><p>Please check your connection and refresh.</p></body></html>",
        { headers: { "Content-Type": "text/html" } }
      )
    );
  }
}

// ── SW Update broadcast ───────────────────────────────────────────────────────

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
