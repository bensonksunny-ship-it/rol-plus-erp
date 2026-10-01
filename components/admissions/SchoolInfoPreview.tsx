"use client";

// Admissions → ℹ School Info for staff who may not edit it (e.g. Teachers):
// the exact page parents see after an enquiry, read-only, with only Close.
// Editing stays in SchoolInfoEditor (wing leaders in a leadership role).

import { useEffect } from "react";
import SchoolInfoView from "@/components/enquiry/SchoolInfoView";

export function SchoolInfoPreview({ wing, onClose }: { wing: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 12px" }}>
      <div role="dialog" aria-modal="true" aria-label="School Info preview"
        style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 600, boxShadow: "0 24px 64px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>ℹ️ School Info for Parents</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              <span style={{ fontWeight: 700, color: "#4f46e5", background: "#eef2ff", borderRadius: 6, padding: "1px 7px", marginRight: 6 }}>👁 Preview</span>
              Exactly what parents see after sending an enquiry.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            ✕
          </button>
        </div>
        <div style={{ padding: "16px 16px 20px", maxHeight: "72vh", overflowY: "auto", background: "#fafafa" }}>
          <SchoolInfoView wing={wing} preview />
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "9px 22px", borderRadius: 9, border: "none", background: "#4f46e5", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
