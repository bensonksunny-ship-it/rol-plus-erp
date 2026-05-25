"use client";

import { useState } from "react";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

/**
 * Floating install banner that appears when the browser fires beforeinstallprompt.
 * Shows iOS instructions as a fallback sheet.
 * Disappears once installed or dismissed.
 */
export default function InstallPrompt() {
  const { installState, triggerInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(false);
  const [showIOS, setShowIOS]     = useState(false);

  if (dismissed || installState === "installed" || installState === "unsupported") {
    return null;
  }

  return (
    <>
      {/* Install banner */}
      {!showIOS && (
        <div style={{
          position: "fixed",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          width: "calc(100% - 32px)",
          maxWidth: 400,
          background: "#1e293b",
          border: "1px solid #334155",
          borderRadius: 16,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          zIndex: 9999,
        }}>
          {/* Icon */}
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            background: "#0f172a",
            border: "1px solid #334155",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: "#f59e0b" }}>R+</span>
          </div>

          {/* Text */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}>
              Install ROL&apos;s Plus
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
              {installState === "ios"
                ? "Add to your Home Screen for the best experience"
                : "Install for offline access & faster loading"}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => setDismissed(true)}
              style={{
                background: "transparent", border: "none",
                color: "#64748b", fontSize: 20, cursor: "pointer",
                padding: "4px 6px", borderRadius: 6, lineHeight: 1,
              }}
              aria-label="Dismiss"
            >×</button>
            <button
              onClick={installState === "ios" ? () => setShowIOS(true) : triggerInstall}
              style={{
                background: "#f59e0b", color: "#0f172a",
                border: "none", borderRadius: 8,
                padding: "8px 14px", fontSize: 13, fontWeight: 700,
                cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              {installState === "ios" ? "How?" : "Install"}
            </button>
          </div>
        </div>
      )}

      {/* iOS instruction sheet */}
      {showIOS && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            zIndex: 10000, display: "flex", alignItems: "flex-end",
          }}
          onClick={() => setShowIOS(false)}
        >
          <div
            style={{
              background: "#1e293b", borderRadius: "20px 20px 0 0",
              padding: "24px 24px 40px", width: "100%",
              border: "1px solid #334155",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9", marginBottom: 20, textAlign: "center" }}>
              Add to Home Screen
            </div>
            {[
              { step: "1", text: "Tap the Share button (□↑) in Safari" },
              { step: "2", text: 'Scroll down and tap "Add to Home Screen"' },
              { step: "3", text: 'Tap "Add" to confirm' },
            ].map(({ step, text }) => (
              <div key={step} style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 16 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: "#f59e0b", color: "#0f172a",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 800, flexShrink: 0,
                }}>
                  {step}
                </div>
                <p style={{ fontSize: 14, color: "#cbd5e1", lineHeight: 1.5, marginTop: 4 }}>{text}</p>
              </div>
            ))}
            <button
              onClick={() => { setShowIOS(false); setDismissed(true); }}
              style={{
                width: "100%", padding: "13px",
                background: "#f59e0b", color: "#0f172a",
                border: "none", borderRadius: 12,
                fontSize: 15, fontWeight: 700, cursor: "pointer",
                marginTop: 8,
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
