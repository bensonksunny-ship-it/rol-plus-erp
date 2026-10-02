"use client";

// "Cancel class" kept deliberately out of the way (Attendance batch cards and the
// centre modal): a small ⋮ options menu holds the action, and choosing it opens a
// confirm dialog that REQUIRES a reason. Visibility is the caller's job — only
// pass these to roles allowed by canCancelClass() (attendance.service).

import { useEffect, useRef, useState } from "react";

/** ⋮ button with a one-item dropdown: "🚫 Cancel class…" (danger tint). */
export function CancelClassMenu({ onChoose, label = "Cancel class…", disabled = false }: {
  onChoose: () => void; label?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={e => { e.stopPropagation(); setOpen(v => !v); }} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-label="More options" title="More options"
        style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", color: "#6b7280",
                 fontSize: 16, lineHeight: 1, cursor: disabled ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        ⋮
      </button>
      {open && (
        <div role="menu" onClick={e => e.stopPropagation()}
          style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 50, minWidth: 170, background: "#fff",
                   border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 10px 24px rgba(0,0,0,0.12)", padding: 4 }}>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onChoose(); }}
            style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "none", borderRadius: 7,
                     padding: "8px 10px", fontSize: 13, fontWeight: 600, color: "#b91c1c", cursor: "pointer" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#fef2f2")}
            onMouseLeave={e => (e.currentTarget.style.background = "none")}>
            🚫 {label}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Confirm dialog for cancelling a class. A reason is required (min 3 characters).
 * Closes only via "Keep class", ✕ or Esc — never a backdrop click.
 */
export function CancelClassDialog({ title, detail, busy, onConfirm, onClose }: {
  title: string; detail: React.ReactNode; busy: boolean;
  onConfirm: (reason: string) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);
  return (
    <div onClick={e => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="alertdialog" aria-modal="true" aria-label={title}
        style={{ width: "100%", maxWidth: 420, background: "#fff", borderRadius: 14, boxShadow: "0 20px 50px rgba(0,0,0,0.25)", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#991b1b" }}>🚫 {title}</div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            style={{ border: "none", background: "none", fontSize: 16, color: "#9ca3af", cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ fontSize: 12.5, color: "#4b5563", lineHeight: 1.5 }}>{detail}</div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
          Reason for cancelling <span style={{ color: "#dc2626" }}>*</span>
          <textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} disabled={busy} rows={2}
            placeholder="e.g. Teacher unwell, public holiday, venue unavailable"
            style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: "8px 10px", borderRadius: 8,
                     border: "1px solid #d1d5db", fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
        </label>
        {!ok && reason.length > 0 && <div style={{ fontSize: 11.5, color: "#b45309", marginTop: -4 }}>Please give a short reason.</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} disabled={busy}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Keep class
          </button>
          <button type="button" onClick={() => onConfirm(reason.trim())} disabled={busy || !ok}
            style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700,
                     cursor: busy || !ok ? "not-allowed" : "pointer", opacity: busy || !ok ? 0.5 : 1 }}>
            {busy ? "Cancelling…" : "Yes, cancel class"}
          </button>
        </div>
      </div>
    </div>
  );
}
