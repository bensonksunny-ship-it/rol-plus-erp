"use client";

import { useState, useEffect, useCallback } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/config/firebase";
import {
  getLessonsForStudent,
  getProgressByStudent,
  addAttempt,
  markItemCompleted,
} from "@/services/lesson/lesson.service";
import type { Lesson, LessonItem, StudentLessonProgress, Attempt } from "@/types/lesson";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StudentSyllabusPage({
  params,
}: {
  params: { studentId: string };
}) {
  const { studentId } = params;
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT]}>
      <StudentSyllabusContent studentId={studentId} />
    </ProtectedRoute>
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface LessonWithItems extends Lesson {
  items: LessonItem[];
}

interface StudentMeta {
  name:            string;
  admissionNumber: string;
}

// ─── Content ─────────────────────────────────────────────────────────────────

function StudentSyllabusContent({ studentId }: { studentId: string }) {
  const { user, role } = useAuth();
  const isMobile       = useIsMobile();

  const [lessons, setLessons]               = useState<LessonWithItems[]>([]);
  const [progressMap, setProgressMap]        = useState<Record<string, StudentLessonProgress>>({});
  const [student, setStudent]               = useState<StudentMeta | null>(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState<string | null>(null);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [assignedData, allProgress, userSnap] = await Promise.all([
        getLessonsForStudent(studentId),
        getProgressByStudent(studentId),
        getDoc(doc(db, "users", studentId)),
      ]);

      setLessons(assignedData.lessons);

      // Build progress map keyed by itemId
      const pMap: Record<string, StudentLessonProgress> = {};
      allProgress.forEach(p => { pMap[p.itemId] = p; });
      setProgressMap(pMap);

      if (userSnap.exists()) {
        const d = userSnap.data();
        setStudent({
          name:            (d.displayName as string) ?? (d.name as string) ?? "Unknown",
          admissionNumber: (d.admissionNumber as string) ?? "—",
        });
      }

      if (assignedData.lessons.length > 0 && !activeLessonId) {
        setActiveLessonId(assignedData.lessons[0]!.id);
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

  if (lessons.length === 0) {
    return (
      <div style={s.empty}>
        <div style={s.emptyIcon}>📋</div>
        <div style={s.emptyTitle}>No syllabus assigned yet</div>
        <div style={s.emptySub}>
          No lessons are available for this student yet. Lessons are shown automatically once
          they have been imported for the student&apos;s center via{" "}
          <strong>Syllabus → Import from Excel</strong>. Student-specific lessons can also be
          imported directly for this student.
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <a href="/dashboard/lessons/import" style={s.importLink}>Import from Excel →</a>
        </div>
      </div>
    );
  }

  const activeLesson = lessons.find(l => l.id === activeLessonId) ?? lessons[0]!;

  // Overall progress
  const totalItems = lessons.reduce((sum, l) => sum + l.items.length, 0);
  const completedItems = lessons.reduce((sum, l) =>
    sum + l.items.filter(i => progressMap[i.id]?.completed).length, 0
  );
  const progressPct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  // Check if current user is teacher/admin (can add attempts)
  const canModify = role === "admin" || role === "super_admin" || role === "teacher";

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

      {/* Lesson tabs — horizontal strip on mobile */}
      {isMobile ? (
        <div style={s.tabStrip}>
          {lessons.map(lesson => {
            const total     = lesson.items.length;
            const completed = lesson.items.filter(i => progressMap[i.id]?.completed).length;
            const active    = lesson.id === activeLesson.id;
            return (
              <button
                key={lesson.id}
                style={{ ...s.tabChip, ...(active ? s.tabChipActive : {}) }}
                onClick={() => setActiveLessonId(lesson.id)}
              >
                <span style={s.tabChipTitle}>{lesson.title}</span>
                <span style={s.tabChipMeta}>{completed}/{total}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div style={isMobile ? s.mobileLayout : s.layout}>
        {/* Lesson sidebar — desktop only */}
        {!isMobile && (
          <div style={s.sidebar}>
            {lessons.map(lesson => {
              const total     = lesson.items.length;
              const completed = lesson.items.filter(i => progressMap[i.id]?.completed).length;
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
        )}

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
                progress={progressMap[item.id] ?? null}
                lessonId={activeLesson.id}
                studentId={studentId}
                canModify={canModify}
                teacherId={user?.uid ?? ""}
                teacherRole={role ?? "teacher"}
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
  progress,
  lessonId,
  studentId,
  canModify,
  teacherId,
  teacherRole,
  onUpdated,
}: {
  item:         LessonItem;
  progress:     StudentLessonProgress | null;
  lessonId:     string;
  studentId:    string;
  canModify:    boolean;
  teacherId:    string;
  teacherRole:  string;
  onUpdated:    () => void;
}) {
  const [busy, setBusy]     = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [notes, setNotes]   = useState("");

  const attempts     = progress?.attempts ?? [];
  const attemptCount = attempts.length;
  const isCompleted  = progress?.completed ?? false;

  async function handleAttempt() {
    if (!canModify) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await addAttempt(
        studentId,
        lessonId,
        item.id,
        teacherId,
        teacherRole as import("@/types").Role,
        notes.trim() || null,
      );
      setNotes("");
      onUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrMsg(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    if (!canModify) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await markItemCompleted(
        studentId,
        lessonId,
        item.id,
        teacherId,
        teacherRole as import("@/types").Role,
      );
      onUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrMsg(msg);
    } finally {
      setBusy(false);
    }
  }

  const typeColor: Record<string, { bg: string; fg: string }> = {
    concept:   { bg: "rgba(167,139,250,0.15)", fg: "#c4b5fd" },
    exercise:  { bg: "rgba(110,231,183,0.15)", fg: "#6ee7b7" },
    songsheet: { bg: "rgba(226,185,111,0.15)", fg: "#e2b96f" },
  };
  const tc = typeColor[item.type] ?? { bg: "rgba(255,255,255,0.07)", fg: "#94a3b8" };

  return (
    <div style={{ ...s.itemCard, ...(isCompleted ? s.itemCardDone : {}) }}>
      {/* Top row */}
      <div style={s.itemTop}>
        <span style={{ ...s.typeBadge, background: tc.bg, color: tc.fg }}>
          {item.type}
        </span>
        <span style={s.orderBadge}>#{item.order}</span>
        {isCompleted && <span style={s.completedBadge}>✓ Completed</span>}
      </div>

      {/* Title */}
      <div style={s.itemTitle}>{item.title}</div>

      {/* Attempt dots (slots = item.maxAttempts) */}
      <div style={s.attemptsRow}>
        {Array.from({ length: item.maxAttempts }).map((_, i) => (
          <span
            key={i}
            style={{
              ...s.dot,
              background: i < attemptCount ? "#e2b96f" : "rgba(255,255,255,0.08)",
              boxShadow: i < attemptCount ? "0 0 8px rgba(226,185,111,0.45)" : "none",
            }}
            title={i < attemptCount ? `Attempt ${i + 1} done` : `Attempt ${i + 1} not done`}
          />
        ))}
        <span style={s.attemptsLabel}>{attemptCount}/{item.maxAttempts} attempts</span>
      </div>

      {/* Attempt history */}
      {attempts.length > 0 && (
        <div style={s.attemptHistory}>
          <div style={s.historyLabel}>Attempt history</div>
          {attempts.map((a: Attempt) => (
            <div key={a.attemptNo} style={{ ...s.attemptRow, ...(a.status === "completed" ? s.attemptDone : {}) }}>
              <span style={s.attemptNo}>#{a.attemptNo}</span>
              <span style={s.attemptDate}>{a.date}</span>
              <span style={{ ...s.attemptStatus, color: a.status === "completed" ? "#6ee7b7" : "#94a3b8" }}>
                {a.status}
              </span>
              {a.notes && <span style={s.attemptNotes}>"{a.notes}"</span>}
            </div>
          ))}
        </div>
      )}

      {/* Analytics */}
      {progress?.firstAttemptDate && (
        <div style={s.analyticsRow}>
          <span style={s.analyticChip}>Started {progress.firstAttemptDate}</span>
          {progress.completionDate && (
            <span style={s.analyticChip}>
              Completed {progress.completionDate.slice(0, 10)}
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {errMsg && <div style={s.errMsg}>{errMsg}</div>}

      {/* Actions — teachers/admins only, and only when not completed */}
      {canModify && !isCompleted && (
        <div style={s.itemActions}>
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optional)…"
            style={s.notesInput}
            disabled={busy || attemptCount >= item.maxAttempts}
          />
          <button
            onClick={handleAttempt}
            disabled={busy || attemptCount >= item.maxAttempts}
            style={{
              ...s.attemptBtn,
              opacity: (busy || attemptCount >= item.maxAttempts) ? 0.5 : 1,
              cursor:  (busy || attemptCount >= item.maxAttempts) ? "not-allowed" : "pointer",
            }}
          >
            + Add Attempt
          </button>
          <button
            onClick={handleComplete}
            disabled={busy || attemptCount === 0}
            style={{
              ...s.doneBtn,
              opacity: (busy || attemptCount === 0) ? 0.5 : 1,
              cursor:  (busy || attemptCount === 0) ? "not-allowed" : "pointer",
            }}
          >
            Mark Done
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Styles (light-background safe — explicit hex only) ───────────────────────

const s: Record<string, React.CSSProperties> = {
  state: {
    padding:      "56px 16px",
    textAlign:    "center",
    fontSize:     13,
    color:        "#6b7280",
    background:   "#fff",
    borderRadius: 12,
  },

  empty: {
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    padding:        "72px 16px",
    textAlign:      "center",
    background:     "#fff",
  },
  emptyIcon:  { fontSize: 48, marginBottom: 14 },
  emptyTitle: { fontSize: 20, fontWeight: 700, color: "#111111", marginBottom: 10 },
  emptySub:   { fontSize: 13, color: "#6b7280", maxWidth: 420, lineHeight: 1.6 },
  importLink: {
    display:        "inline-block",
    background:     "#4f46e5",
    color:          "#fff",
    padding:        "9px 18px",
    borderRadius:   8,
    fontSize:       13,
    fontWeight:     700,
    textDecoration: "none",
  },

  // Page header
  header: {
    display:        "flex",
    alignItems:     "flex-start",
    justifyContent: "space-between",
    marginBottom:   20,
    flexWrap:       "wrap" as const,
    gap:            14,
  },
  heading:     { fontSize: 24, fontWeight: 700, color: "#111111", margin: 0 },
  studentMeta: { display: "flex", gap: 10, alignItems: "center", marginTop: 6 },
  studentName: { fontSize: 14, fontWeight: 600, color: "#111111" },
  admNo: {
    fontSize:     11,
    fontFamily:   "monospace",
    background:   "#fef3c7",
    color:        "#92400e",
    padding:      "3px 10px",
    borderRadius: 99,
    border:       "1px solid #fde68a",
    fontWeight:   700,
  },

  // Progress chip
  progressChip: { textAlign: "right" as const },
  progressNum:  { fontSize: 26, fontWeight: 800, color: "#111111", display: "block", lineHeight: 1.1 },
  progressLabel:{ fontSize: 11, color: "#6b7280" },
  progressBarOuter: {
    height:       5,
    background:   "#e5e7eb",
    borderRadius: 99,
    width:        "100%",
    minWidth:     120,
    maxWidth:     160,
    marginTop:    8,
    overflow:     "hidden",
  },
  progressBarInner: {
    height:     "100%",
    background: "#4f46e5",
    borderRadius: 99,
    transition: "width 0.4s ease",
  },

  layout:      { display: "flex", gap: 16, alignItems: "flex-start" },
  mobileLayout:{ display: "flex", flexDirection: "column" as const, gap: 12 },

  // Mobile tab strip
  tabStrip: {
    display:       "flex",
    gap:           6,
    overflowX:     "auto" as const,
    paddingBottom: 10,
    marginBottom:  10,
  },
  tabChip: {
    flexShrink:     0,
    background:     "#f3f4f6",
    border:         "1px solid #e5e7eb",
    borderRadius:   20,
    padding:        "7px 14px",
    cursor:         "pointer",
    textAlign:      "left" as const,
    display:        "flex",
    flexDirection:  "column" as const,
    gap:            2,
  },
  tabChipActive: {
    background:   "#ede9fe",
    borderColor:  "#a78bfa",
  },
  tabChipTitle: { fontSize: 12, fontWeight: 600, color: "#111111", whiteSpace: "nowrap" as const },
  tabChipMeta:  { fontSize: 10, color: "#6b7280" },

  // Lesson sidebar
  sidebar: { width: 228, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 4 },
  lessonTab: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 8,
    padding:      "11px 14px",
    textAlign:    "left" as const,
    cursor:       "pointer",
    width:        "100%",
  },
  lessonTabActive: {
    background:  "#ede9fe",
    borderColor: "#a78bfa",
  },
  lessonTabTitle: { fontSize: 13, fontWeight: 600, color: "#111111", marginBottom: 3 },
  lessonTabMeta:  { fontSize: 11, color: "#6b7280" },
  doneCheck:      { color: "#16a34a", fontWeight: 700 },

  panel:       { flex: 1, minWidth: 0 },
  panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  panelTitle:  { fontSize: 17, fontWeight: 700, color: "#111111" },
  panelCount:  { fontSize: 12, color: "#6b7280" },

  itemList: { display: "flex", flexDirection: "column" as const, gap: 10 },

  // Item card
  itemCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "18px 22px",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  itemCardDone: {
    background:  "#f0fdf4",
    borderColor: "#86efac",
    boxShadow:   "0 1px 4px rgba(22,163,74,0.10)",
  },
  itemTop:     { display: "flex", alignItems: "center", gap: 8, marginBottom: 7 },
  typeBadge:   { fontSize: 10, fontWeight: 800, borderRadius: 99, padding: "3px 10px", textTransform: "capitalize" as const, letterSpacing: "0.04em" },
  orderBadge:  { fontSize: 11, color: "#9ca3af", fontFamily: "monospace" },
  completedBadge: {
    fontSize:     10,
    fontWeight:   800,
    background:   "#dcfce7",
    color:        "#16a34a",
    borderRadius: 99,
    padding:      "3px 10px",
    border:       "1px solid #86efac",
  },

  itemTitle: { fontSize: 14, fontWeight: 600, color: "#111111", marginBottom: 12 },

  // Attempt dots
  attemptsRow:  { display: "flex", alignItems: "center", gap: 7, marginBottom: 10 },
  dot: {
    width:        13,
    height:       13,
    borderRadius: "50%",
    display:      "inline-block",
    transition:   "background 0.2s",
  },
  attemptsLabel: { fontSize: 11, color: "#6b7280", marginLeft: 6 },

  // Attempt history
  attemptHistory: {
    background:   "#f9fafb",
    border:       "1px solid #e5e7eb",
    borderRadius: 8,
    padding:      "10px 14px",
    marginBottom: 10,
  },
  historyLabel: {
    fontSize:      10,
    fontWeight:    700,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    marginBottom:  6,
  },
  attemptRow: {
    display:      "flex",
    gap:          10,
    alignItems:   "center",
    fontSize:     12,
    padding:      "4px 0",
    borderBottom: "1px solid #f3f4f6",
  },
  attemptDone:   { background: "#dcfce7", borderRadius: 4, padding: "4px 6px" },
  attemptNo:     { fontFamily: "monospace", fontWeight: 700, color: "#111111", minWidth: 28 },
  attemptDate:   { color: "#6b7280", minWidth: 80 },
  attemptStatus: { fontWeight: 600, minWidth: 70 },
  attemptNotes:  { color: "#374151", fontStyle: "italic" as const, flex: 1 },

  analyticsRow: { display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 10 },
  analyticChip: {
    fontSize:     11,
    color:        "#6b7280",
    background:   "#f3f4f6",
    borderRadius: 99,
    padding:      "3px 10px",
    border:       "1px solid #e5e7eb",
  },

  errMsg: { fontSize: 12, color: "#dc2626", marginBottom: 8, padding: "6px 10px", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" },

  // Item actions
  itemActions: {
    display:    "flex",
    gap:        8,
    marginTop:  6,
    alignItems: "center",
    flexWrap:   "wrap" as const,
  },
  notesInput: {
    flex:         1,
    minWidth:     160,
    padding:      "7px 12px",
    border:       "1px solid #d1d5db",
    borderRadius: 8,
    fontSize:     12,
    color:        "#111111",
    background:   "#fff",
    outline:      "none",
  },
  attemptBtn: {
    background:   "#f3f4f6",
    color:        "#374151",
    border:       "1px solid #d1d5db",
    padding:      "7px 14px",
    borderRadius: 8,
    fontSize:     12,
    fontWeight:   700,
    cursor:       "pointer",
  },
  doneBtn: {
    background:    "#16a34a",
    color:         "#fff",
    border:        "none",
    padding:       "7px 16px",
    borderRadius:  8,
    fontSize:      12,
    fontWeight:    800,
    cursor:        "pointer",
    letterSpacing: "0.02em",
  },
};
