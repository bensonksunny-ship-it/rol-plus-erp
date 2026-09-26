"use client";

// Screening rubric & questions editor as a pop-up (opened from the ⚙ icon in
// the Admissions header) — the panel itself handles loading, editing, saving
// and the per-wing permission check.

import { useEffect, useRef, useState } from "react";
import { ScreeningQuestionsPanel } from "./ScreeningQuestionsPanel";

export function ScreeningQuestionsModal({ wing, onClose }: { wing: string; onClose: () => void }) {
  const [dirty, setDirty] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  function requestClose() {
    if (dirty && !window.confirm("Discard your unsaved changes to the screening questions?")) return;
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") requestClose(); }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";           // keep the page behind still
    boxRef.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }); // re-bind so the handler sees the latest `dirty`

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) requestClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(17,24,39,0.45)", display: "flex", justifyContent: "flex-end" }}>
      <div ref={boxRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Edit screening rubric and questions"
        style={{ width: "min(860px, 100%)", height: "100%", background: "#f8f9fb", boxShadow: "-12px 0 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 20px", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>Screening Rubric &amp; Questions</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Changes apply to every new screening in this wing.</div>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" title="Close (Esc)"
            className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            style={{ border: "none", background: "transparent", cursor: "pointer", lineHeight: 0 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          <ScreeningQuestionsPanel wing={wing} startEditing onDirtyChange={setDirty} />
        </div>
      </div>
    </div>
  );
}
