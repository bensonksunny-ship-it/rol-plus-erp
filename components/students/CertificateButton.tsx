"use client";

// Course completion certificate (JPEG) — download button, and the popup
// offered straight after "Mark complete". Both wings.

import { useEffect, useRef, useState } from "react";
import { downloadCertificateJPEG, type CertificateData } from "@/lib/courseCertificate";
import { normalizeCourse, type CourseCompletion } from "@/lib/course";

export function CertificateButton({ data, label = "⬇ Certificate", style }: {
  data: CertificateData; label?: string; style?: React.CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <button type="button" disabled={busy} title={`Download certificate — ${data.course} (JPEG)`}
        onClick={async e => {
          e.stopPropagation();
          setBusy(true); setErr("");
          try { await downloadCertificateJPEG(data); }
          catch (x) { setErr(x instanceof Error ? x.message : "Download failed."); }
          finally { setBusy(false); }
        }}
        style={{
          fontSize: 11.5, fontWeight: 700, borderRadius: 6, padding: "2px 9px", cursor: busy ? "default" : "pointer",
          border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", whiteSpace: "nowrap", opacity: busy ? 0.6 : 1,
          ...style,
        }}>
        {busy ? "Preparing…" : label}
      </button>
      {err && <span style={{ fontSize: 11, color: "#dc2626" }}>{err}</span>}
    </span>
  );
}

/** "Course completed 🎉 — Download certificate" after Mark complete. */
export function CertificateReadyDialog({ data, onClose }: { data: CertificateData; onClose: () => void }) {
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
          <CertificateButton data={data} label="⬇ Download Certificate (JPEG)"
            style={{ fontSize: 13, padding: "8px 16px", borderRadius: 8, background: "#4f46e5", color: "#fff", border: "none" }} />
        </div>
      </div>
    </div>
  );
}

/**
 * "🏅 Download Certificate" for a student's completed courses (Edit Student
 * footer). One course → downloads at once; several → pick from a menu; none →
 * disabled ("No completed course yet").
 */
export function CertificateMenuButton({ student, completed, style }: {
  student: Omit<CertificateData, "course" | "completedOn">;
  completed: CourseCompletion[] | undefined;
  style?: React.CSSProperties;
}) {
  const list = (completed ?? []).filter(c => normalizeCourse(c.course));
  const [open, setOpen]     = useState(false);
  const [state, setState]   = useState<"idle" | "busy" | "done" | "error">("idle");
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function download(c: CourseCompletion) {
    setOpen(false); setState("busy");
    try {
      await downloadCertificateJPEG({ ...student, course: normalizeCourse(c.course), completedOn: c.completedOn });
      setState("done");
      setTimeout(() => setState("idle"), 2200);
    } catch { setState("error"); }
  }

  const none = list.length === 0;
  const label = state === "busy" ? "Preparing…" : state === "done" ? "✓ Downloaded" : state === "error" ? "⚠ Try again" : "🏅 Download Certificate";
  return (
    <span ref={wrap} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" disabled={none || state === "busy"}
        title={none ? "No completed course yet — mark a course complete first" : "Download a course completion certificate (JPEG)"}
        onClick={() => (list.length === 1 ? download(list[0]) : setOpen(o => !o))}
        style={{ ...style, opacity: none ? 0.5 : 1, cursor: none || state === "busy" ? "default" : "pointer" }}>
        {none ? "🏅 No completed course yet" : <>{label}{list.length > 1 && state === "idle" ? " ▾" : ""}</>}
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
            <button key={`${c.course}-${i}`} type="button" role="menuitem" onClick={() => download(c)}
              style={{ textAlign: "left", border: "none", background: "transparent", borderRadius: 8, padding: "8px 10px", cursor: "pointer", fontFamily: "inherit" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#fff7ed")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "#0f172a" }}>🏅 {normalizeCourse(c.course)}</span>
              <span style={{ display: "block", fontSize: 11.5, color: "#64748b" }}>{c.completedOn || "Date unavailable"}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
