"use client";

// Course completion certificate (JPEG). Every download first asks for the
// certificate number (required): pre-filled with the number saved for that
// course, saved back when new or changed, and flagged when it's already on
// another certificate. Both wings.

import { useEffect, useRef, useState } from "react";
import { downloadCertificateJPEG, type CertificateData } from "@/lib/courseCertificate";
import { normalizeCourse, type CourseCompletion } from "@/lib/course";
import { useAuth } from "@/hooks/useAuth";
import {
  findCertificateNoUse, getSavedCertificateNo, normalizeCertNo, saveCertificateNo, type CertNoUse,
} from "@/services/student/certificate.service";

/** Certificate number → save → download. */
export function CertificateNumberDialog({ uid, data, onClose, onDone }: {
  uid: string; data: CertificateData; onClose: () => void; onDone?: () => void;
}) {
  const { user, role } = useAuth();
  const [saved, setSaved]   = useState<string | null>(null);   // null = loading
  const [no, setNo]         = useState("");
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState("");
  const [clash, setClash]   = useState<CertNoUse | null>(null);   // shown once; second click = use anyway
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    getSavedCertificateNo(uid, data.course)
      .then(v => { if (alive) { setSaved(v); setNo(v); } })
      .catch(() => { if (alive) setSaved(""); })
      .finally(() => setTimeout(() => input.current?.focus(), 0));
    return () => { alive = false; };
  }, [uid, data.course]);

  const value = no.trim();
  const changed = saved !== null && normalizeCertNo(value) !== normalizeCertNo(saved);

  async function submit() {
    if (!value || busy || saved === null) return;
    setBusy(true); setErr("");
    try {
      if (changed) {
        if (!clash) {
          const use = await findCertificateNoUse(value, uid, data.course);
          if (use) { setClash(use); setBusy(false); return; }
        }
        await saveCertificateNo({
          uid, course: data.course, no: value, previous: saved ?? "", studentName: data.studentName, wing: data.wing,
          by: { uid: user?.uid ?? "", role: role ?? "" },
        });
        setSaved(value);
      }
      await downloadCertificateJPEG({ ...data, certificateNo: value });
      onDone?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the certificate.");
      setBusy(false);
    }
  }

  const btn: React.CSSProperties = { padding: "9px 18px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, fontFamily: "inherit" };
  const blocked = !value || busy || saved === null;
  return (
    <div onClick={e => { e.stopPropagation(); if (!busy) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1400, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label="Certificate number" onClick={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
        style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden", color: "#0f172a" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #f1f5f9" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>🏅 Download Certificate</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 4 }}>{data.studentName} · <b style={{ color: "#0f172a" }}>{data.course}</b></div>
        </div>
        <div style={{ padding: "18px 22px" }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
            Certificate number *
          </label>
          <input ref={input} value={no} disabled={saved === null} placeholder={saved === null ? "Loading…" : "e.g. RSM-2026-0014"}
            onChange={e => { setNo(e.target.value); setClash(null); setErr(""); }}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${clash ? "#f59e0b" : "#e2e8f0"}`, fontSize: 15, fontFamily: "ui-monospace, monospace" }} />
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>
            {saved ? (changed ? `Replaces the saved number ${saved}.` : "Saved number for this course.") : "Saved with this course — used again next time."}
          </div>
          {clash && (
            <div style={{ marginTop: 10, background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", borderRadius: 8, padding: "9px 12px", fontSize: 12.5 }}>
              ⚠ {value} is already used on {clash.studentName || "another student"}&apos;s {clash.course || "certificate"}.
              Click <b>Use anyway</b> to keep it, or type a different number.
            </div>
          )}
          {err && <div style={{ marginTop: 10, background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "9px 12px", fontSize: 12.5 }}>{err}</div>}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end", gap: 10, background: "#f8fafc" }}>
          <button type="button" onClick={onClose} disabled={busy}
            style={{ ...btn, fontWeight: 600, background: "#fff", color: "#334155", border: "1.5px solid #e2e8f0", cursor: "pointer" }}>Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={blocked}
            style={{ ...btn, border: "none", color: "#fff", cursor: blocked ? "default" : "pointer",
              background: blocked ? "#94a3b8" : clash ? "#d97706" : "linear-gradient(135deg, #f97316 0%, #fb7185 100%)" }}>
            {busy ? "Preparing…" : clash ? "Use anyway & download" : "⬇ Download JPEG"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CertificateButton({ uid, data, label = "⬇ Certificate", style }: {
  uid: string; data: CertificateData; label?: string; style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" title={`Download certificate — ${data.course} (JPEG)`}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        style={{
          fontSize: 11.5, fontWeight: 700, borderRadius: 6, padding: "2px 9px", cursor: "pointer",
          border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", whiteSpace: "nowrap",
          ...style,
        }}>
        {label}
      </button>
      {open && <CertificateNumberDialog uid={uid} data={data} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "Course completed 🎉 — Download certificate" after Mark complete. */
export function CertificateReadyDialog({ uid, data, onClose }: { uid: string; data: CertificateData; onClose: () => void }) {
  const [asking, setAsking] = useState(false);
  if (asking) return <CertificateNumberDialog uid={uid} data={data} onClose={onClose} />;
  return (
    <div onClick={e => { e.stopPropagation(); onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label="Course completed" onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", padding: "24px 22px", textAlign: "center", color: "#111827" }}>
        <div style={{ fontSize: 34 }}>🎉</div>
        <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>Course completed</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
          {data.studentName} · <b style={{ color: "#111827" }}>{data.course}</b>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
          <button type="button" onClick={onClose}
            style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", cursor: "pointer" }}>
            Close
          </button>
          <button type="button" onClick={() => setAsking(true)}
            style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "#4f46e5", color: "#fff", border: "none", cursor: "pointer" }}>
            ⬇ Download Certificate (JPEG)
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "🏅 Download Certificate" for a student's completed courses (Edit Student
 * footer). One course → straight to the number box; several → pick from a
 * menu; none → disabled ("No completed course yet").
 */
export function CertificateMenuButton({ uid, student, completed, style }: {
  uid: string;
  student: Omit<CertificateData, "course" | "completedOn">;
  completed: CourseCompletion[] | undefined;
  style?: React.CSSProperties;
}) {
  const list = (completed ?? []).filter(c => normalizeCourse(c.course));
  const [open, setOpen]     = useState(false);
  const [picked, setPicked] = useState<CourseCompletion | null>(null);
  const [done, setDone]     = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const none = list.length === 0;
  const label = done ? "✓ Downloaded" : "🏅 Download Certificate";
  return (
    <span ref={wrap} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" disabled={none}
        title={none ? "No completed course yet — mark a course complete first" : "Download a course completion certificate (JPEG)"}
        onClick={() => (list.length === 1 ? setPicked(list[0]) : setOpen(o => !o))}
        style={{ ...style, opacity: none ? 0.5 : 1, cursor: none ? "default" : "pointer" }}>
        {none ? "🏅 No completed course yet" : <>{label}{list.length > 1 && !done ? " ▾" : ""}</>}
      </button>
      {open && (
        <span role="menu" style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 20, minWidth: 260,
          background: "#fff", border: "1px solid #fed7aa", borderRadius: 12, padding: 6,
          boxShadow: "0 12px 32px rgba(15,23,42,0.18)", display: "flex", flexDirection: "column", gap: 2,
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#9a3412", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 10px 4px" }}>
            Pick a completed course
          </span>
          {list.map((c, i) => (
            <button key={`${c.course}-${i}`} type="button" role="menuitem" onClick={() => { setOpen(false); setPicked(c); }}
              style={{ textAlign: "left", border: "none", background: "transparent", borderRadius: 8, padding: "8px 10px", cursor: "pointer", fontFamily: "inherit" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#fff7ed")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "#0f172a" }}>🏅 {normalizeCourse(c.course)}</span>
              <span style={{ display: "block", fontSize: 11.5, color: "#64748b" }}>{c.completedOn || "Date unavailable"}</span>
            </button>
          ))}
        </span>
      )}
      {picked && (
        <CertificateNumberDialog uid={uid}
          data={{ ...student, course: normalizeCourse(picked.course), completedOn: picked.completedOn }}
          onClose={() => setPicked(null)}
          onDone={() => { setDone(true); setTimeout(() => setDone(false), 2200); }} />
      )}
    </span>
  );
}
