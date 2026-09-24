"use client";

import { useState } from "react";
import { formatErrorReport, type CapturedError } from "@/lib/errorReporting";

/**
 * Error fallback shared by the root boundary and the dashboard's error.tsx.
 * Shows the real error message (collapsible details) with Try again /
 * Go to Dashboard / Copy details, so a crash on a phone can be reported
 * without devtools.
 */
export default function ErrorPanel({ error, onRetry, fullScreen = false }: {
  error: CapturedError | null;
  onRetry: () => void;
  fullScreen?: boolean;
}) {
  const [open, setOpen]     = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!error) return;
    const text = formatErrorReport(error);
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setOpen(true); // clipboard blocked — at least reveal the text to long-press copy
    }
  }

  const btn: React.CSSProperties = {
    padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700,
    cursor: "pointer", border: "none", fontFamily: "inherit",
  };

  return (
    <div style={fullScreen
      ? { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb", padding: 16, boxSizing: "border-box" }
      : { padding: "24px 0" }}>
      <div role="alert" style={{
        width: "100%", maxWidth: 520, margin: "0 auto", background: "#fff",
        border: "1px solid #fecaca", borderRadius: 14, padding: 20,
        boxShadow: "0 4px 16px rgba(0,0,0,0.06)", fontFamily: "system-ui, sans-serif", boxSizing: "border-box",
      }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#991b1b", marginBottom: 4 }}>
          ⚠️ This page hit a problem
        </div>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14, lineHeight: 1.5 }}>
          The rest of the app still works — try again, or go back to the dashboard.
        </div>
        {error?.message && (
          <div style={{ fontSize: 12, color: "#7f1d1d", background: "#fef2f2", borderRadius: 8, padding: "8px 10px", marginBottom: 14, wordBreak: "break-word" }}>
            {error.message}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onRetry} style={{ ...btn, background: "#4f46e5", color: "#fff" }}>Try again</button>
          <a href="/dashboard" style={{ ...btn, background: "#f3f4f6", color: "#374151", textDecoration: "none" }}>Go to Dashboard</a>
          {error && (
            <button onClick={copy} style={{ ...btn, background: "#fff", color: "#374151", border: "1px solid #d1d5db" }}>
              {copied ? "✓ Copied" : "Copy error details"}
            </button>
          )}
        </div>
        {error && (
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setOpen(o => !o)}
              style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: "#6b7280", cursor: "pointer", textDecoration: "underline" }}>
              {open ? "Hide technical details" : "Show technical details"}
            </button>
            {open && (
              <pre style={{ marginTop: 8, maxHeight: 220, overflow: "auto", fontSize: 10.5, background: "#111827", color: "#e5e7eb", padding: 10, borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text" }}>
                {formatErrorReport(error)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
