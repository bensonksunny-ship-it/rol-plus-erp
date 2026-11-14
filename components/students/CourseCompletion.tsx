"use client";

// =============================================================================
// Course completion & progression — shared by the student profile
// (/dashboard/students/[id]) and the centre page's student preview
// (Enrollments → Centers → centre → student). Both wings.
//
// Shows the level steps (Introduction → Intermediate → Advanced), a
// "Mark Course Complete" button, the 🎓 Graduated badge and finished courses.
// The write is completeStudentCourse(): records the completion date and
// advances to the next level; at Advanced the student is marked graduated and
// stays Active.
// =============================================================================

import { useState } from "react";
import { ROLES } from "@/config/constants";
import {
  COURSE_LEVELS, formatCourse, instrumentOfCourse, levelOfCourse, nextCourseLevel,
  type CourseCompletion as CourseCompletionEntry, type CourseLevel,
} from "@/lib/course";
import { completeStudentCourse, type LevelChangeBy } from "@/services/student/courseLevel.service";

export interface CourseInfo {
  level: CourseLevel | "";
  instrument: string;
  course: string;
  completed: CourseCompletionEntry[];
  graduated: boolean;
  graduatedOn: string;
  hasSyllabusSlot: boolean;
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Course progression state from a raw `users` doc. */
export function readCourseInfo(d: Record<string, unknown>): CourseInfo {
  const level = levelOfCourse(d.courseLevel, d.course);
  const instrument = (level && instrumentOfCourse(d.course)) || s(d.instrument);
  return {
    level, instrument,
    course: s(d.course) || (level ? formatCourse(level, instrument) : instrument),
    completed: Array.isArray(d.completedCourses) ? (d.completedCourses as CourseCompletionEntry[]) : [],
    graduated: d.graduated === true,
    graduatedOn: s(d.graduatedOn),
    hasSyllabusSlot: !!s(d.syllabusLevel),
  };
}

/** Staff who may mark a course complete (teachers are further limited to their centres by the caller). */
export function canMarkCourseComplete(role: string | null | undefined): boolean {
  return role === ROLES.FOUNDER || role === "super_admin" || role === ROLES.ADMIN
    || role === ROLES.DIRECTOR || role === ROLES.CHIEF_TEACHER || role === ROLES.TEACHER;
}

function ymdToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Progress + Completed rows. `row` renders a label/value line in the host's
 * own style; `onCompleted` lets the host reload the student.
 */
export default function CourseCompletion({ uid, studentName, info, canEdit, by, row, onCompleted }: {
  uid: string;
  studentName: string;
  info: CourseInfo;
  canEdit: boolean;
  by: LevelChangeBy;
  row: (label: string, value: React.ReactNode) => React.ReactNode;
  onCompleted: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const done = [...info.completed].sort((a, b) => a.completedOn.localeCompare(b.completedOn));
  const idx = info.level ? COURSE_LEVELS.indexOf(info.level) : -1;

  return (
    <>
      {row("Progress",
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const }}>
          {COURSE_LEVELS.map((l, i) => {
            const past = i < idx || (info.graduated && i === idx);
            const cur  = i === idx && !info.graduated;
            return (
              <span key={l} style={{
                fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 9px",
                background: past ? "#dcfce7" : cur ? "#eef2ff" : "#f3f4f6",
                color: past ? "#166534" : cur ? "#3730a3" : "#9ca3af",
                border: `1px solid ${past ? "#86efac" : cur ? "#c7d2fe" : "#e5e7eb"}`,
              }}>
                {past ? "✓ " : ""}{l}
              </span>
            );
          })}
          {info.graduated && (
            <span style={{ fontSize: 11.5, fontWeight: 800, borderRadius: 999, padding: "2px 9px", background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}>
              🎓 Graduated{info.graduatedOn ? ` · ${fmtDay(info.graduatedOn)}` : ""}
            </span>
          )}
          {canEdit && !info.graduated && (
            info.level ? (
              <button type="button" onClick={() => setOpen(true)} style={{
                fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "4px 12px", cursor: "pointer",
                border: "1px solid #86efac", background: "#f0fdf4", color: "#15803d",
              }}>
                ✓ Mark Course Complete
              </button>
            ) : (
              <span style={{ fontSize: 11.5, color: "#9ca3af" }}>Set the course level to track completion</span>
            )
          )}
        </span>,
      )}
      {done.length > 0 && row("Completed",
        <span style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
          {done.map((c, i) => (
            <span key={i} style={{ fontSize: 12.5 }}>
              ✓ {c.course} · <span style={{ color: "#6b7280" }}>{fmtDay(c.completedOn)}</span>
            </span>
          ))}
        </span>,
      )}
      {open && info.level && (
        <CourseCompleteModal
          studentName={studentName} course={info.course} level={info.level} instrument={info.instrument}
          onClose={() => setOpen(false)}
          onConfirm={async completedOn => {
            const { next } = await completeStudentCourse({
              uid, level: info.level as CourseLevel, course: info.course, instrument: info.instrument,
              completedOn, hasSyllabusSlot: info.hasSyllabusSlot, by,
            });
            setOpen(false);
            onCompleted(next ? `Course completed — now on ${formatCourse(next, info.instrument)}.` : `${studentName} has completed the final course 🎓`);
          }}
        />
      )}
    </>
  );
}

/** Completion date (default today) → confirm → record + advance to the next course. */
function CourseCompleteModal({ studentName, course, level, instrument, onClose, onConfirm }: {
  studentName: string; course: string; level: CourseLevel; instrument: string;
  onClose: () => void; onConfirm: (completedOn: string) => Promise<void>;
}) {
  const [date, setDate]     = useState(ymdToday());
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");
  const next = nextCourseLevel(level);
  const nextCourse = next ? formatCourse(next, instrument) : null;
  const future = date > ymdToday();
  const blocked = !date || future || saving;

  async function submit() {
    if (blocked) return;
    setSaving(true); setErr("");
    try { await onConfirm(date); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not save. Try again."); setSaving(false); }
  }

  return (
    // Stop clicks/keys reaching the host modal underneath (e.g. the centre student preview).
    <div onClick={e => { e.stopPropagation(); if (!saving) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label="Mark course complete" onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "18px 22px", borderBottom: "1px solid #e5e7eb" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#111827" }}>✓ Mark Course Complete</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{studentName}</div>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#9ca3af" }}>✕</button>
        </div>
        <div style={{ padding: "18px 22px" }}>
          {err && <div style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "9px 14px", marginBottom: 14, fontSize: 13 }}>{err}</div>}
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 16, fontSize: 13 }}>
            <div><span style={{ color: "#6b7280" }}>Completing: </span><b>{course}</b></div>
            <div>
              <span style={{ color: "#6b7280" }}>Next course: </span>
              {nextCourse ? <b style={{ color: "#15803d" }}>{nextCourse}</b>
                : <b style={{ color: "#92400e" }}>None (final course). Student is marked 🎓 Graduated and stays Active.</b>}
            </div>
          </div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
            Completion date *
          </label>
          <input type="date" value={date} max={ymdToday()} onChange={e => setDate(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 14 }} />
          {future && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>Completion date can&apos;t be in the future.</div>}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 10, background: "#f9fafb" }}>
          <button onClick={onClose} disabled={saving} style={{ background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={blocked} style={{
            padding: "8px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 700,
            background: blocked ? "#9ca3af" : "#15803d", color: "#fff", cursor: blocked ? "not-allowed" : "pointer",
          }}>
            {saving ? "Saving…" : nextCourse ? `✓ Complete & move to ${next}` : "✓ Complete course"}
          </button>
        </div>
      </div>
    </div>
  );
}
