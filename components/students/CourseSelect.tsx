"use client";

// =============================================================================
// Course dropdown: the 9 listed courses (lib/course COURSES), grouped by
// instrument. Both wings.
//   <CourseSelect>        controlled; for forms (admission, enrol, edit)
//   <StudentCourseSelect> saves straight to the student (Registry rows,
//                         Students page, student profile), with the course
//                         status line and ✓ Mark complete
//   <PrevCourseDialog>    "Has the student finished the previous course?"
//                         shown when an Intermediate/Advanced course is picked
// A student whose stored course isn't one of the 9 (e.g. Piano, Vocal) keeps
// it. The dropdown shows it as "Not in list" until someone picks a course.
// =============================================================================

import { useState } from "react";
import {
  COURSES, COURSE_INSTRUMENTS, courseProgress, findCourse, levelOfCourse, missingPrevCourses, nextCourseLevel,
  type CourseLevel, type CourseOption, type CourseStep,
} from "@/lib/course";
import {
  completeStudentCourse, confirmPreviousCourses, setStudentCourse,
  type LevelChangeBy, type PrevCoursesAnswer,
} from "@/services/student/courseLevel.service";
import { CourseCompleteModal, ymdToday } from "@/components/students/CourseCompletion";
import { CertificateReadyDialog } from "@/components/students/CertificateButton";
import type { CertificateData } from "@/lib/courseCertificate";

const NOT_LISTED = "__not_listed";

export function CourseSelect({ value, onChange, disabled, style, ariaLabel = "Course", placeholder = "Select course…" }: {
  /** Stored course title, either spelling; "" when none. */
  value: string;
  onChange: (course: CourseOption) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const match = findCourse(value);
  const raw = value.trim();
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={match ? match.label : raw ? NOT_LISTED : ""}
      onChange={e => {
        const c = COURSES.find(x => x.label === e.target.value);
        if (c) onChange(c);
      }}
      style={style}
    >
      {!match && !raw && <option value="" disabled>{placeholder}</option>}
      {!match && raw && <option value={NOT_LISTED} disabled>{`Not in list: ${raw}`}</option>}
      {COURSE_INSTRUMENTS.map(inst => (
        <optgroup key={inst} label={inst}>
          {COURSES.filter(c => c.instrument === inst).map(c => (
            <option key={c.label} value={c.label}>{c.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ── "Has the student finished the previous course?" ──────────────────────────

/**
 * Asked when a course above Introduction is picked and its lower courses
 * aren't recorded as completed. Yes → finished on the given date; No → saved
 * with the previous course(s) shown as "Not finished".
 */
export function PrevCourseDialog({ studentName, course, missing, confirmOnly, onAnswer, onCancel }: {
  studentName: string;
  course: string;
  /** Labels of the lower courses to ask about. */
  missing: string[];
  /** Confirming an earlier "Not finished" — no "No" button. */
  confirmOnly?: boolean;
  onAnswer: (a: PrevCoursesAnswer) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [date, setDate]     = useState(ymdToday());
  // Old courses often have no record of when they finished — saved with no date.
  const [noDate, setNoDate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");
  const future = !noDate && date > ymdToday();
  const dateOk = noDate || (!!date && !future);
  const list = missing.join(" and ");

  async function answer(finished: boolean) {
    if (saving || (finished && !dateOk)) return;
    setSaving(true); setErr("");
    try { await onAnswer({ finished, completedOn: finished && !noDate ? date : "" }); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not save. Try again."); setSaving(false); }
  }

  const btn: React.CSSProperties = { padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: saving ? "default" : "pointer" };
  return (
    <div onClick={e => { e.stopPropagation(); if (!saving) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label="Previous course" onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); e.stopPropagation(); }}
        style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden", color: "#111827" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #e5e7eb" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{confirmOnly ? "Confirm previous course" : "Previous course finished?"}</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{studentName || "Student"} · {course}</div>
        </div>
        <div style={{ padding: "18px 22px", fontSize: 14 }}>
          {err && <div style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "9px 14px", marginBottom: 14, fontSize: 13 }}>{err}</div>}
          <div style={{ marginBottom: 14 }}>
            Has {studentName || "the student"} finished <b>{list}</b>?
          </div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
            Completion date (if finished)
          </label>
          <input type="date" value={noDate ? "" : date} max={ymdToday()} disabled={noDate} onChange={e => setDate(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 14, opacity: noDate ? 0.5 : 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 13, color: "#374151", cursor: "pointer" }}>
            <input type="checkbox" checked={noDate} onChange={e => setNoDate(e.target.checked)} />
            Date unavailable
          </label>
          {future && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>Completion date can&apos;t be in the future.</div>}
          {!confirmOnly && (
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 10 }}>
              No → the course is still saved; {missing.length > 1 ? "these courses show" : "it shows"} as &quot;Not finished&quot; until confirmed.
            </div>
          )}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 10, background: "#f9fafb", flexWrap: "wrap" }}>
          <button type="button" onClick={onCancel} disabled={saving} style={{ ...btn, fontWeight: 600, background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db" }}>Cancel</button>
          {!confirmOnly && (
            <button type="button" onClick={() => answer(false)} disabled={saving} style={{ ...btn, background: "#fffbeb", color: "#b45309", border: "1px solid #fcd34d" }}>
              No, not finished
            </button>
          )}
          <button type="button" onClick={() => answer(true)} disabled={saving || !dateOk}
            style={{ ...btn, border: "none", background: saving || !dateOk ? "#9ca3af" : "#15803d", color: "#fff" }}>
            {saving ? "Saving…" : "✓ Yes, finished"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Course status line ───────────────────────────────────────────────────────

const STEP_STYLE: Record<CourseStep["state"], { bg: string; fg: string; bd: string; text: string }> = {
  completed:    { bg: "#dcfce7", fg: "#166534", bd: "#86efac", text: "✓ Completed" },
  not_finished: { bg: "#fffbeb", fg: "#b45309", bd: "#fcd34d", text: "⚠ Not finished" },
  unconfirmed:  { bg: "#f3f4f6", fg: "#6b7280", bd: "#e5e7eb", text: "? Not confirmed" },
  in_progress:  { bg: "#eef2ff", fg: "#3730a3", bd: "#c7d2fe", text: "▶ In progress" },
  graduated:    { bg: "#fef3c7", fg: "#92400e", bd: "#fcd34d", text: "🎓 Completed" },
};

function StepChip({ step, showLabel, big }: { step: CourseStep; showLabel: boolean; big?: boolean }) {
  const st = STEP_STYLE[step.state];
  return (
    <span title={`${step.label}: ${st.text.replace(/^\S+\s/, "")}`} style={{
      fontSize: big ? 12 : 11, fontWeight: 700, borderRadius: 999, padding: big ? "4px 11px" : "1px 8px", whiteSpace: "nowrap",
      background: st.bg, color: st.fg, border: `1px solid ${st.bd}`,
    }}>
      {showLabel ? `${step.label} · ` : ""}{st.text}
    </span>
  );
}

const compact: React.CSSProperties = {
  fontSize: 12, borderRadius: 6, padding: "3px 6px", maxWidth: "100%",
  border: "1px solid var(--color-border)", background: "var(--color-surface)",
  color: "var(--color-text-primary)", cursor: "pointer",
};
const smallBtn = (fg: string, bg: string, bd: string): React.CSSProperties => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: "1px 8px", cursor: "pointer",
  color: fg, background: bg, border: `1px solid ${bd}`, whiteSpace: "nowrap",
});

// Roomy layout (student card popup): full-width select, status row, action row.
const ROOMY_CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;
const roomySelect: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 42, padding: "0 38px 0 12px", borderRadius: 10,
  border: "1.5px solid #c7d2fe", background: `#fff ${ROOMY_CHEVRON} no-repeat right 12px center`,
  appearance: "none", WebkitAppearance: "none", color: "#0f172a", fontSize: 14, fontWeight: 600,
  fontFamily: "inherit", cursor: "pointer", textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden",
};
const roomyLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" };
const roomyBtn = (solid: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 14px", borderRadius: 9,
  fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
  ...(solid
    ? { background: "#16a34a", color: "#fff", border: "1px solid #16a34a", boxShadow: "0 2px 6px rgba(22,163,74,0.25)" }
    : { background: "#fff", color: "#15803d", border: "1.5px solid #86efac" }),
});

/**
 * Self-saving course dropdown for one student, with the status of each course
 * on their path (previous courses Completed / Not finished, current course
 * In progress) and ✓ Mark complete. Read-only text when `canEdit` is false.
 */
export function StudentCourseSelect({
  uid, studentName = "", course, courseLevel, hasSyllabusSlot, by, canEdit,
  completedCourses, unfinishedCourses, graduated = false, showMarkComplete = true,
  onSaved, onChanged, style, certificate, roomy = false,
}: {
  /** Spacious layout: full-width select, then a status row, then an actions row. */
  roomy?: boolean;
  uid: string;
  studentName?: string;
  /** Stored `course` (raw). */
  course: string;
  /** Stored `courseLevel` (raw). */
  courseLevel?: unknown;
  hasSyllabusSlot: boolean;
  by: LevelChangeBy;
  canEdit: boolean;
  /** Raw `completedCourses` / `unfinishedCourses` / `graduated` from the student doc. */
  completedCourses?: unknown;
  unfinishedCourses?: unknown;
  graduated?: boolean;
  /** False where the host already shows Mark Course Complete (student profile). */
  showMarkComplete?: boolean;
  /** A new course was saved. */
  onSaved?: (course: CourseOption) => void;
  /** Anything about the course changed (course, previous courses, completion) — reload the student. */
  onChanged?: (msg: string) => void;
  style?: React.CSSProperties;
  /** Student details for the completion certificate offered after ✓ Mark complete. */
  certificate?: { admissionNo: string; wing: string; centre?: string };
}) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<CertificateData | null>(null);
  const [err, setErr]   = useState("");
  // Optimistic: the picked course shows at once, before the live data refreshes.
  const [shown, setShown] = useState<string | null>(null);
  // New data from the parent wins over the optimistic value.
  const [seen, setSeen] = useState(course);
  if (seen !== course) { setSeen(course); setShown(null); }
  const current = shown ?? course;
  const [asking, setAsking] = useState<{ course: CourseOption; missing: string[] } | null>(null);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [completing, setCompleting] = useState(false);

  const steps = courseProgress(current, completedCourses, unfinishedCourses, graduated);
  const cur = findCourse(current);
  const notFinished = steps.filter(s => s.state === "not_finished" || s.state === "unconfirmed").map(s => s.label);
  const curStep = steps[steps.length - 1];

  async function save(c: CourseOption, prevAnswer: PrevCoursesAnswer | null) {
    setBusy(true); setErr(""); setShown(c.label);
    try {
      await setStudentCourse({
        uid, course: c, prevLevel: levelOfCourse(courseLevel, course), prevCourse: course,
        hasSyllabusSlot, by, completed: completedCourses, prevAnswer,
      });
      onSaved?.(c);
      onChanged?.(`Course set to ${c.label}.`);
    } catch (e) {
      setShown(null);
      setErr(e instanceof Error ? e.message : "Failed to save course.");
    } finally {
      setBusy(false);
    }
  }

  function pick(c: CourseOption) {
    if (findCourse(current)?.label === c.label) return;
    const missing = missingPrevCourses(c, completedCourses).map(x => x.label);
    if (missing.length) setAsking({ course: c, missing });
    else void save(c, null);
  }

  if (!canEdit) {
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: roomy ? 10 : 3 }}>
        <span style={roomy ? { fontSize: 15, fontWeight: 700, color: "#0f172a" } : undefined}>{cur?.label || current || "—"}</span>
        {steps.length > 0 && (
          <span style={{ display: "flex", gap: roomy ? 8 : 4, flexWrap: "wrap" }}>
            {steps.map(s => <StepChip key={s.label} step={s} showLabel={s !== curStep} big={roomy} />)}
          </span>
        )}
      </span>
    );
  }

  const canMarkComplete = showMarkComplete && curStep?.state === "in_progress" && !!cur;

  return (
    <span onClick={e => e.stopPropagation()} style={{ display: roomy ? "flex" : "inline-flex", flexDirection: "column", gap: roomy ? 12 : 3, maxWidth: "100%", width: roomy ? "100%" : undefined }}>
      <CourseSelect value={current} onChange={pick} disabled={busy}
        style={{ ...(roomy ? roomySelect : compact), opacity: busy ? 0.6 : 1, ...style }} />
      {roomy && steps.length > 0 && (
        <span style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: "1px dashed #c7d2fe" }}>
          {/* Status: where the student is on the course path */}
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ ...roomyLabel, minWidth: 64 }}>Status</span>
            {steps.slice(0, -1).map(s => <StepChip key={s.label} step={s} showLabel big />)}
            <StepChip step={curStep} showLabel={steps.length > 1} big />
          </span>
          {/* Actions the user can take */}
          {(notFinished.length > 0 || canMarkComplete) && (
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...roomyLabel, minWidth: 64 }}>Actions</span>
              {notFinished.length > 0 && (
                <button type="button" disabled={busy} onClick={() => setConfirming(notFinished)}
                  title={`Confirm ${notFinished.join(" and ")} as finished`} style={roomyBtn(false)}>
                  ✓ Confirm finished
                </button>
              )}
              {canMarkComplete && (
                <button type="button" disabled={busy} onClick={() => setCompleting(true)}
                  title={`Mark ${cur!.label} as completed`} style={roomyBtn(true)}>
                  🏁 Mark complete
                </button>
              )}
            </span>
          )}
        </span>
      )}
      {!roomy && steps.length > 0 && (
        <span style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {steps.slice(0, -1).map(s => <StepChip key={s.label} step={s} showLabel />)}
          {notFinished.length > 0 && (
            <button type="button" disabled={busy} onClick={() => setConfirming(notFinished)}
              style={smallBtn("#15803d", "#f0fdf4", "#86efac")}>
              Confirm finished
            </button>
          )}
          <StepChip step={curStep} showLabel={false} />
          {showMarkComplete && curStep.state === "in_progress" && cur && (
            <button type="button" disabled={busy} onClick={() => setCompleting(true)}
              title={`Mark ${cur.label} as completed`} style={smallBtn("#15803d", "#f0fdf4", "#86efac")}>
              ✓ Mark complete
            </button>
          )}
        </span>
      )}
      {err && <span style={{ fontSize: 11, color: "#dc2626" }}>{err}</span>}

      {asking && (
        <PrevCourseDialog studentName={studentName} course={asking.course.label} missing={asking.missing}
          onCancel={() => setAsking(null)}
          onAnswer={async a => { const c = asking.course; setAsking(null); await save(c, a); }} />
      )}
      {confirming && cur && (
        <PrevCourseDialog confirmOnly studentName={studentName} course={cur.label} missing={confirming}
          onCancel={() => setConfirming(null)}
          onAnswer={async a => {
            await confirmPreviousCourses(uid, confirming, a.completedOn, by);
            setConfirming(null);
            onChanged?.(`${confirming.join(" and ")} marked as completed.`);
          }} />
      )}
      {ready && <CertificateReadyDialog uid={uid} data={ready} onClose={() => setReady(null)} />}
      {completing && cur && (
        <CourseCompleteModal studentName={studentName} course={cur.label} level={cur.level} instrument={cur.instrument}
          onClose={() => setCompleting(false)}
          onConfirm={async completedOn => {
            const { next } = await completeStudentCourse({
              uid, level: cur.level as CourseLevel, course: cur.label, instrument: cur.instrument,
              completedOn, hasSyllabusSlot, by,
            });
            setCompleting(false);
            if (certificate) setReady({ studentName, course: cur.label, completedOn, ...certificate });
            const nextLevel = nextCourseLevel(cur.level);
            onChanged?.(next && nextLevel
              ? `${cur.label} completed — now on ${findCourse(`${nextLevel} ${cur.instrument}`)?.label ?? nextLevel}.`
              : `${studentName || "Student"} has completed the final course 🎓`);
          }} />
      )}
    </span>
  );
}

/**
 * Lower courses on the student's path that aren't recorded as completed
 * ("? Not confirmed" / "⚠ Not finished"), each with Confirm finished → date or
 * Date unavailable → recorded in completedCourses (and its certificate appears).
 * Shown under COMPLETED COURSES. Renders nothing when there are none.
 */
export function UnconfirmedCourses({ uid, studentName, course, completedCourses, unfinishedCourses, by, canEdit, onChanged }: {
  uid: string; studentName: string; course: string;
  completedCourses: unknown; unfinishedCourses: unknown;
  by: LevelChangeBy; canEdit: boolean;
  onChanged?: (msg: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const steps = courseProgress(course, completedCourses, unfinishedCourses, false)
    .filter(s => s.state === "unconfirmed" || s.state === "not_finished");
  if (!steps.length) return null;
  return (
    <>
      {steps.map(s => (
        <div key={s.label} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
          padding: "8px 12px", borderRadius: 10, border: "1px dashed #fcd34d", background: "#fffdf5",
        }}>
          <span style={{ fontWeight: 600, color: "#78716c" }}>🏅 {s.label}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <StepChip step={s} showLabel={false} />
            {canEdit && (
              <button type="button" onClick={e => { e.stopPropagation(); setConfirming(s.label); }}
                style={smallBtn("#15803d", "#f0fdf4", "#86efac")}>
                Confirm finished
              </button>
            )}
          </span>
        </div>
      ))}
      {confirming && (
        <PrevCourseDialog confirmOnly studentName={studentName} course={findCourse(course)?.label ?? course} missing={[confirming]}
          onCancel={() => setConfirming(null)}
          onAnswer={async a => {
            const label = confirming;
            await confirmPreviousCourses(uid, [label], a.completedOn, by);
            setConfirming(null);
            onChanged?.(`${label} marked as completed — certificate ready.`);
          }} />
      )}
    </>
  );
}
