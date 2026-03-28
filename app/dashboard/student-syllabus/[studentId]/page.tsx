"use client";

import { use, useState, useEffect, useCallback } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/config/firebase";
import {
  getStudentSyllabusDoc,
  markAttempt,
  markItemCompleted,
  computeItemAnalytics,
} from "@/services/studentSyllabus/studentSyllabus.service";
import type { StudentSyllabusDoc, SyllabusLesson, SyllabusItem } from "@/types/studentSyllabus";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StudentSyllabusPage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  const { studentId } = use(params);
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <StudentSyllabusContent studentId={studentId} />
    </ProtectedRoute>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

interface StudentMeta {
  name:            string;
  admissionNumber: string;
}

function StudentSyllabusContent({ studentId }: { studentId: string }) {
  const [sylDoc, setSylDoc]       = useState<StudentSyllabusDoc | null>(null);
  const [student, setStudent]     = useState<StudentMeta | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [syl, userSnap] = await Promise.all([
        getStudentSyllabusDoc(studentId),
        getDoc(doc(db, "users", studentId)),
      ]);
      setSylDoc(syl);
      if (userSnap.exists()) {
        const d = userSnap.data();
        setStudent({
          name:            d.name ?? "Unknown",
          admissionNumber: d.admissionNumber ?? "—",
        });
      }
      if (syl && syl.lessons.length > 0 && !activeLessonId) {
        setActiveLessonId(syl.lessons[0]!.id);
      }
    } catch {
      setError("Failed to load syllabus.");
    } finally {
      setLoading(false);
    }
  }, [studentId, activeLessonId]);

  useEffect(() => { load(); }, [studentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={s.state}>Loading syllabus…</div>;
  if (error)   return <div style={{ ...s.state, color: "#dc2626" }}>{error}</div>;

  if (!sylDoc || sylDoc.lessons.length === 0) {
    return (
      <div style={s.empty}>
        <div style={s.emptyIcon}>📋</div>
        <div style={s.emptyTitle}>No syllabus imported yet</div>
        <div style={s.emptySub}>
          Import a syllabus for this student from the Students page using the "Import Syllabus" button.
        </div>
      </div>
    );
  }

  const activeLesson = sylDoc.lessons.find(l => l.id === activeLessonId) ?? sylDoc.lessons[0]!;

  // Overall progress
  const totalItems     = sylDoc.lessons.reduce((s, l) => s + l.items.length, 0);
  const completedItems = sylDoc.lessons.reduce((s, l) => s + l.items.filter(i => i.completed).length, 0);
  const progressPct    = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  return (
    <div>
      {/* Student header */}
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Student Syllabus</h1>
          {student && (
            <div style={s.studentMeta}>
              <span style={s.studentName}>{student.name}</span>
              <span style={s.admNo}>{student.admissionNumber}</span>
            </div>
          )}
        </div>
        <div style={s.progressChip}>
          <span style={s.progressNum}>{completedItems}/{totalItems}</span>
          <span style={s.progressLabel}> items completed</span>
          <div style={s.progressBarOuter}>
            <div style={{ ...s.progressBarInner, width: `${progressPct}%` }} />
          </div>
        </div>
      </div>

      <div style={s.layout}>
        {/* Lesson sidebar */}
        <div style={s.sidebar}>
          {sylDoc.lessons
            .sort((a, b) => a.order - b.order)
            .map(lesson => {
              const total     = lesson.items.length;
              const completed = lesson.items.filter(i => i.completed).length;
              const active    = lesson.id === activeLesson.id;
              return (
                <button
                  key={lesson.id}
                  style={{ ...s.lessonTab, ...(active ? s.lessonTabActive : {}) }}
                  onClick={() => setActiveLessonId(lesson.id)}
                >
                  <div style={s.lessonTabTitle}>{lesson.title}</div>
                  <div style={s.lessonTabMeta}>
                    {completed}/{total} done
                    {completed === total && total > 0 && <span style={s.doneCheck}> ✓</span>}
                  </div>
                </button>
              );
            })}
        </div>

        {/* Items panel */}
        <div style={s.panel}>
          <div style={s.panelHeader}>
            <div style={s.panelTitle}>{activeLesson.title}</div>
            <div style={s.panelCount}>{activeLesson.items.length} items</div>
          </div>
          <div style={s.itemList}>
            {activeLesson.items.map(item => (
              <ItemCard
                key={item.id}
                item={item}
                lessonId={activeLesson.id}
                studentId={studentId}
                onUpdated={load}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Item Card ────────────────────────────────────────────────────────────────

function ItemCard({
  item,
  lessonId,
  studentId,
  onUpdated,
}: {
  item:      SyllabusItem;
  lessonId:  string;
  studentId: string;
  onUpdated: () => void;
}) {
  const [busy, setBusy]     = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const attemptsUsed = item.attempts.filter(a => a === 1).length;
  const analytics    = computeItemAnalytics(item);

  async function handleAttempt() {
    setBusy(true);
    setErrMsg(null);
    const err = await markAttempt(studentId, lessonId, item.id);
    if (err) setErrMsg(err);
    else     onUpdated();
    setBusy(false);
  }

  async function handleComplete() {
    setBusy(true);
    setErrMsg(null);
    const err = await markItemCompleted(studentId, lessonId, item.id);
    if (err) setErrMsg(err);
    else     onUpdated();
    setBusy(false);
  }

  const typeColor: Record<string, { bg: string; fg: string }> = {
    concept:   { bg: "#ede9fe", fg: "#6d28d9" },
    exercise:  { bg: "#dcfce7", fg: "#15803d" },
    songsheet: { bg: "#fef9c3", fg: "#92400e" },
  };
  const tc = typeColor[item.type] ?? { bg: "#f3f4f6", fg: "#374151" };

  return (
    <div style={{ ...s.itemCard, ...(item.completed ? s.itemCardDone : {}) }}>
      {/* Top row */}
      <div style={s.itemTop}>
        <span style={{ ...s.typeBadge, background: tc.bg, color: tc.fg }}>
          {item.type}
        </span>
        {item.completed && <span style={s.completedBadge}>✓ Completed</span>}
      </div>

      {/* Title */}
      <div style={s.itemTitle}>{item.title}</div>

      {/* Attempt dots */}
      <div style={s.attemptsRow}>
        {item.attempts.map((val, i) => (
          <span
            key={i}
            style={{
              ...s.dot,
              background: val === 1 ? "#4f46e5" : "#e5e7eb",
            }}
            title={val === 1 ? `Attempt ${i + 1} done` : `Attempt ${i + 1} not done`}
          />
        ))}
        <span style={s.attemptsLabel}>{attemptsUsed}/5 attempts</span>
      </div>

      {/* Analytics */}
      {(item.startDate || analytics.daysTaken !== null) && (
        <div style={s.analyticsRow}>
          {item.startDate && (
            <span style={s.analyticChip}>Started {item.startDate}</span>
          )}
          {analytics.daysTaken !== null && (
            <span style={s.analyticChip}>
              {analytics.daysTaken === 0 ? "Completed same day" : `${analytics.daysTaken} day${analytics.daysTaken !== 1 ? "s" : ""} taken`}
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {errMsg && <div style={s.errMsg}>{errMsg}</div>}

      {/* Actions */}
      {!item.completed && (
        <div style={s.itemActions}>
          <button
            onClick={handleAttempt}
            disabled={busy || attemptsUsed >= 5}
            style={{
              ...s.attemptBtn,
              opacity: (busy || attemptsUsed >= 5) ? 0.5 : 1,
              cursor:  (busy || attemptsUsed >= 5) ? "not-allowed" : "pointer",
            }}
          >
            + Add Attempt
          </button>
          <button
            onClick={handleComplete}
            disabled={busy}
            style={{ ...s.doneBtn, opacity: busy ? 0.5 : 1 }}
          >
            Mark Done
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  state:          { padding: "48px 16px", textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" },

  empty:          { display: "flex", flexDirection: "column", alignItems: "center", padding: "64px 16px", textAlign: "center" },
  emptyIcon:      { fontSize: 40, marginBottom: 12 },
  emptyTitle:     { fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 8 },
  emptySub:       { fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 360 },

  header:         { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 },
  heading:        { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  studentMeta:    { display: "flex", gap: 10, alignItems: "center", marginTop: 6 },
  studentName:    { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" },
  admNo:          { fontSize: 12, fontFamily: "monospace", background: "#ede9fe", color: "#5b21b6", padding: "2px 8px", borderRadius: 99 },

  progressChip:   { textAlign: "right" as const },
  progressNum:    { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)" },
  progressLabel:  { fontSize: 12, color: "var(--color-text-secondary)" },
  progressBarOuter: { height: 6, background: "#e5e7eb", borderRadius: 99, width: 160, marginTop: 6, overflow: "hidden" },
  progressBarInner: { height: "100%", background: "#4f46e5", borderRadius: 99, transition: "width 0.4s ease" },

  layout:         { display: "flex", gap: 16, alignItems: "flex-start" },

  sidebar:        { width: 220, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 2 },
  lessonTab:      { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 14px", textAlign: "left" as const, cursor: "pointer", transition: "all 0.15s", width: "100%" },
  lessonTabActive:{ background: "#ede9fe", borderColor: "#a78bfa" },
  lessonTabTitle: { fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 2 },
  lessonTabMeta:  { fontSize: 11, color: "var(--color-text-secondary)" },
  doneCheck:      { color: "#16a34a", fontWeight: 700 },

  panel:          { flex: 1 },
  panelHeader:    { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  panelTitle:     { fontSize: 16, fontWeight: 700, color: "var(--color-text-primary)" },
  panelCount:     { fontSize: 12, color: "var(--color-text-secondary)" },

  itemList:       { display: "flex", flexDirection: "column" as const, gap: 8 },

  itemCard:       { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 20px" },
  itemCardDone:   { background: "#f0fdf4", borderColor: "#86efac" },
  itemTop:        { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  typeBadge:      { fontSize: 11, fontWeight: 700, borderRadius: 99, padding: "2px 10px", textTransform: "capitalize" as const },
  completedBadge: { fontSize: 11, fontWeight: 700, background: "#dcfce7", color: "#15803d", borderRadius: 99, padding: "2px 10px" },

  itemTitle:      { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 10 },

  attemptsRow:    { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  dot:            { width: 14, height: 14, borderRadius: "50%", display: "inline-block", transition: "background 0.2s" },
  attemptsLabel:  { fontSize: 11, color: "var(--color-text-secondary)", marginLeft: 4 },

  analyticsRow:   { display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 10 },
  analyticChip:   { fontSize: 11, color: "#6b7280", background: "#f3f4f6", borderRadius: 99, padding: "2px 10px" },

  errMsg:         { fontSize: 12, color: "#dc2626", marginBottom: 8 },

  itemActions:    { display: "flex", gap: 8, marginTop: 4 },
  attemptBtn:     { background: "#f3f4f6", color: "#374151", border: "none", padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600 },
  doneBtn:        { background: "#4f46e5", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
};
