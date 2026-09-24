"use client";

/**
 * ChunkErrorBoundary — the app-wide (root layout) error boundary.
 *
 * 1. ChunkLoadError — the "Loading chunk N failed" error that occurs when
 *    Vercel deploys a new build while a user has the old version open:
 *      - New build is deployed → chunk filenames change (content hash in filename)
 *      - Browser still has the old HTML/JS which references old chunk URLs
 *      - Old chunk URLs return 404 → webpack throws ChunkLoadError
 *      - We do ONE hard reload to get the new build; a localStorage timestamp
 *        prevents an infinite reload loop if the new build also errors.
 *    Without this, the browser retries the failed chunk endlessly, causing the
 *    "page refreshing 2 times per second" loop seen in production on Vercel.
 *
 * 2. Any other render error — logged with its stack (see lib/errorReporting)
 *    and shown in a soft ErrorPanel with Try again / Go to Dashboard / Copy
 *    error details. The boundary resets when the route changes. Errors inside
 *    /dashboard pages are normally caught earlier by app/dashboard/error.tsx,
 *    which keeps the sidebar usable; this one is the last line of defence.
 */

import React, { useEffect } from "react";
import { usePathname } from "next/navigation";
import ErrorPanel from "@/components/ErrorPanel";
import {
  captureError, installGlobalErrorLogging, isChunkLoadError, reloadOnceForChunkError, type CapturedError,
} from "@/lib/errorReporting";

interface State {
  hasError: boolean;
  isChunkError: boolean;
  reloading: boolean;
  captured: CapturedError | null;
}

function clearReloadTimestamp(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures on restricted browsers.
  }
}

/** Resets the boundary on route change and installs window-level error logging. */
export default function ChunkErrorBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => { installGlobalErrorLogging(); }, []);
  return <Boundary resetKey={pathname ?? ""}>{children}</Boundary>;
}

class Boundary extends React.Component<
  { children: React.ReactNode; resetKey: string },
  State
> {
  constructor(props: { children: React.ReactNode; resetKey: string }) {
    super(props);
    this.state = { hasError: false, isChunkError: false, reloading: false, captured: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, isChunkError: isChunkLoadError(error) };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.hasError && !this.state.isChunkError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, captured: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (!isChunkLoadError(error)) {
      this.setState({ captured: captureError(error, "RootErrorBoundary", info.componentStack ?? undefined) });
      return;
    }
    if (reloadOnceForChunkError()) {
      this.setState({ reloading: true });
    } else {
      console.error("[ChunkErrorBoundary] ChunkLoadError but reload guard active.", error);
    }
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

    if (this.state.hasError && this.state.isChunkError) {
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
                clearReloadTimestamp("__chunk_reload_at__");
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

    if (this.state.hasError) {
      return (
        <ErrorPanel
          fullScreen
          error={this.state.captured}
          onRetry={() => this.setState({ hasError: false, captured: null })}
        />
      );
    }

    return this.props.children;
  }
}
