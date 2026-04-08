"use client";

/**
 * ChunkErrorBoundary
 *
 * Catches ChunkLoadError — the "Loading chunk N failed" error that occurs when
 * Vercel deploys a new build while a user has the old version open in their browser.
 *
 * What happens:
 *   1. New build is deployed → chunk filenames change (content hash in filename)
 *   2. Browser still has the old HTML/JS which references old chunk URLs
 *   3. Old chunk URLs return 404 → webpack throws ChunkLoadError
 *   4. React catches it here → we do ONE hard reload to get the new build
 *   5. A localStorage flag prevents infinite reload if the new build also errors
 *
 * Without this, the browser retries the failed chunk endlessly, causing the
 * "page refreshing 2 times per second" loop visible in production on Vercel.
 */

import React from "react";

interface State {
  hasError: boolean;
  reloading: boolean;
}

export default class ChunkErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, reloading: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    const isChunkError =
      error.name === "ChunkLoadError" ||
      /Loading chunk \d+ failed/i.test(error.message) ||
      /loading css chunk/i.test(error.message) ||
      /Failed to fetch dynamically imported module/i.test(error.message) ||
      /Importing a module script failed/i.test(error.message);

    if (isChunkError) {
      return { hasError: true };
    }
    // Not a chunk error — rethrow by NOT returning hasError:true,
    // but we still need to surface it. Return hasError so the fallback shows,
    // but we won't auto-reload for non-chunk errors.
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    const isChunkError =
      error.name === "ChunkLoadError" ||
      /Loading chunk \d+ failed/i.test(error.message) ||
      /loading css chunk/i.test(error.message) ||
      /Failed to fetch dynamically imported module/i.test(error.message) ||
      /Importing a module script failed/i.test(error.message);

    if (!isChunkError) return;

    // Guard: only auto-reload ONCE per 30 seconds to avoid an infinite hard-reload loop
    // if the new deploy itself is broken.
    const RELOAD_KEY = "__chunk_reload_at__";
    const lastReload = parseInt(localStorage.getItem(RELOAD_KEY) ?? "0", 10);
    const now = Date.now();

    if (now - lastReload < 30_000) {
      // Already reloaded recently — don't loop. Show the error fallback instead.
      console.error("[ChunkErrorBoundary] ChunkLoadError but reload guard active.", error);
      return;
    }

    localStorage.setItem(RELOAD_KEY, String(now));
    this.setState({ reloading: true });

    // Hard reload — bypasses the browser cache so the new chunk manifest is fetched.
    window.location.reload();
  }

  render() {
    if (this.state.reloading) {
      // Brief "Updating…" screen shown for the ~200ms before the hard reload fires.
      return (
        <div style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#f59e0b",
          fontFamily: "system-ui, sans-serif",
          gap: 12,
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path d="M9 18V5l12-2v13" stroke="#f59e0b" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="6" cy="18" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
            <circle cx="18" cy="16" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
          </svg>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Updating to latest version…</span>
        </div>
      );
    }

    if (this.state.hasError) {
      // Reload guard blocked the auto-reload — show a manual refresh button.
      return (
        <div style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#f3f4f6",
          fontFamily: "system-ui, sans-serif",
          gap: 16,
          padding: "0 24px",
          textAlign: "center",
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#f59e0b" strokeWidth="1.5"/>
            <path d="M12 8v4m0 4h.01" stroke="#f59e0b" strokeWidth="1.8"
              strokeLinecap="round"/>
          </svg>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
              A new version is available
            </div>
            <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 20 }}>
              Please refresh the page to load the latest update.
            </div>
            <button
              onClick={() => {
                localStorage.removeItem("__chunk_reload_at__");
                window.location.reload();
              }}
              style={{
                padding: "10px 28px",
                background: "#f59e0b",
                color: "#0a0a0a",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Refresh Now
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
