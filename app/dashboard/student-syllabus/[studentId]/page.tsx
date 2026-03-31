"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/config/firebase";
import {
  getAssignedLessonsWithItems,
  getProgressByStudent,
  addAttempt,
  markItemCompleted,
} from "@/services/lesson/lesson.service";
import type { Lesson, LessonItem, StudentLessonProgress, Attempt } from "@/types/lesson";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StudentSyllabusPage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  const { studentId } = use(params);
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
        getAssignedLessonsWithItems(studentId),
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
          Import lessons via Excel, then assign them to this student from the Syllabus &gt; Assign page.
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
      const isAdmin = teacherRole === "admin" || teacherRole === "super_admin";
      await addAttempt(
        studentId,
        lessonId,
        item.id,
        teacherId,
        teacherRole as import("@/types").Role,
        notes.trim() || null,
        isAdmin ? teacherId : null,
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
      const isAdmin = teacherRole === "admin" || teacherRole === "super_admin";
      await markItemCompleted(
        studentId,
        lessonId,
        item.id,
        teacherId,
        teacherRole as import("@/types").Role,
        isAdmin ? teacherId : null,
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

      {/* Attempt dots (5 slots) */}
      <div style={s.attemptsRow}>
        {Array.from({ length: 5 }).map((_, i) => (
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
        <span style={s.attemptsLabel}>{attemptCount}/5 attempts</span>
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
            disabled={busy || attemptCount >= 5}
          />
          <button
            onClick={handleAttempt}
            disabled={busy || attemptCount >= 5}
            style={{
              ...s.attemptBtn,
              opacity: (busy || attemptCount >= 5) ? 0.5 : 1,
              cursor:  (busy || attemptCount >= 5) ? "not-allowed" : "pointer",
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

// ─── 2026 Design Tokens ───────────────────────────────────────────────────────

const T = {
  charcoal:      "#1a1a2e",
  surface:       "#16213e",
  glass:         "rgba(255,255,255,0.04)",
  glassHover:    "rgba(255,255,255,0.08)",
  gold:          "#e2b96f",
  goldGlow:      "rgba(226,185,111,0.18)",
  goldGlowStr:   "rgba(226,185,111,0.35)",
  lavender:      "#a78bfa",
  lavenderGlow:  "rgba(167,139,250,0.18)",
  sage:          "#6ee7b7",
  sageGlow:      "rgba(110,231,183,0.18)",
  rose:          "#f87171",
  roseGlow:      "rgba(248,113,113,0.15)",
  border:        "rgba(255,255,255,0.08)",
  borderActive:  "rgba(167,139,250,0.4)",
  textPrimary:   "#f1f5f9",
  textSecondary: "#94a3b8",
  textMuted:     "#64748b",
  radius:        12,
  radiusSm:      8,
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  state: {
    padding: "56px 16px",
    textAlign: "center",
    fontSize: 13,
    color: T.textSecondary,
    background: `radial-gradient(ellipse at 50% 0%, ${T.lavenderGlow}, transparent 70%)`,
    borderRadius: T.radius,
  },

  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "72px 16px",
    textAlign: "center",
  },
  emptyIcon:  { fontSize: 48, marginBottom: 14 },
  emptyTitle: { fontSize: 20, fontWeight: 700, color: T.textPrimary, marginBottom: 10 },
  emptySub:   { fontSize: 13, color: T.textSecondary, maxWidth: 380, lineHeight: 1.6 },

  // Page header
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 20,
    flexWrap: "wrap" as const,
    gap: 14,
  },
  heading:     { fontSize: 24, fontWeight: 700, color: T.textPrimary, margin: 0, letterSpacing: "-0.5px" },
  studentMeta: { display: "flex", gap: 10, alignItems: "center", marginTop: 6 },
  studentName: { fontSize: 14, fontWeight: 600, color: T.textPrimary },
  admNo: {
    fontSize: 11,
    fontFamily: "monospace",
    background: T.goldGlow,
    color: T.gold,
    padding: "3px 10px",
    borderRadius: 99,
    border: `1px solid ${T.gold}33`,
    fontWeight: 700,
  },

  // Progress chip
  progressChip: { textAlign: "right" as const },
  progressNum:  { fontSize: 26, fontWeight: 800, color: T.textPrimary, display: "block", lineHeight: 1.1 },
  progressLabel:{ fontSize: 11, color: T.textMuted },
  progressBarOuter: {
    height: 5,
    background: "rgba(255,255,255,0.06)",
    borderRadius: 99,
    width: "100%",
    minWidth: 120,
    maxWidth: 160,
    marginTop: 8,
    overflow: "hidden",
  },
  progressBarInner: {
    height: "100%",
    background: `linear-gradient(90deg, ${T.lavender}, ${T.sage})`,
    borderRadius: 99,
    transition: "width 0.5s cubic-bezier(0.34,1.56,0.64,1)",
    boxShadow: `0 0 8px ${T.lavenderGlow}`,
  },

  layout:      { display: "flex", gap: 16, alignItems: "flex-start" },
  mobileLayout:{ display: "flex", flexDirection: "column" as const, gap: 12 },

  // Mobile tab strip
  tabStrip:    {
    display: "flex",
    gap: 6,
    overflowX: "auto" as const,
    paddingBottom: 10,
    marginBottom: 10,
    WebkitOverflowScrolling: "touch" as unknown as undefined,
  },
  tabChip: {
    flexShrink: 0,
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: 20,
    padding: "7px 14px",
    cursor: "pointer",
    textAlign: "left" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    backdropFilter: "blur(8px)",
    transition: "all 0.18s",
  },
  tabChipActive: {
    background: T.lavenderGlow,
    borderColor: T.lavender + "66",
    boxShadow: `0 0 12px ${T.lavenderGlow}`,
  },
  tabChipTitle: { fontSize: 12, fontWeight: 600, color: T.textPrimary, whiteSpace: "nowrap" as const },
  tabChipMeta:  { fontSize: 10, color: T.textMuted },

  // Lesson sidebar
  sidebar: { width: 228, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 4 },
  lessonTab: {
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    padding: "11px 14px",
    textAlign: "left" as const,
    cursor: "pointer",
    transition: "all 0.18s",
    width: "100%",
    backdropFilter: "blur(8px)",
  },
  lessonTabActive: {
    background: T.lavenderGlow,
    borderColor: T.lavender + "55",
    boxShadow: `0 0 14px ${T.lavenderGlow}`,
  },
  lessonTabTitle: { fontSize: 13, fontWeight: 600, color: T.textPrimary, marginBottom: 3 },
  lessonTabMeta:  { fontSize: 11, color: T.textMuted },
  doneCheck:      { color: T.sage, fontWeight: 700 },

  panel:       { flex: 1, minWidth: 0 },
  panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  panelTitle:  { fontSize: 17, fontWeight: 700, color: T.textPrimary },
  panelCount:  { fontSize: 12, color: T.textMuted },

  itemList: { display: "flex", flexDirection: "column" as const, gap: 10 },

  // Item card
  itemCard: {
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    padding: "18px 22px",
    backdropFilter: "blur(12px)",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  itemCardDone: {
    background: T.sageGlow,
    borderColor: T.sage + "44",
    boxShadow: `0 0 16px ${T.sageGlow}`,
  },
  itemTop:     { display: "flex", alignItems: "center", gap: 8, marginBottom: 7 },
  typeBadge:   { fontSize: 10, fontWeight: 800, borderRadius: 99, padding: "3px 10px", textTransform: "capitalize" as const, letterSpacing: "0.04em" },
  orderBadge:  { fontSize: 11, color: T.textMuted, fontFamily: "monospace" },
  completedBadge: {
    fontSize: 10,
    fontWeight: 800,
    background: T.sageGlow,
    color: T.sage,
    borderRadius: 99,
    padding: "3px 10px",
    border: `1px solid ${T.sage}33`,
  },

  itemTitle: { fontSize: 14, fontWeight: 600, color: T.textPrimary, marginBottom: 12 },

  // Attempt dots
  attemptsRow:  { display: "flex", alignItems: "center", gap: 7, marginBottom: 10 },
  dot: {
    width: 13,
    height: 13,
    borderRadius: "50%",
    display: "inline-block",
    transition: "background 0.25s, box-shadow 0.25s",
  },
  attemptsLabel: { fontSize: 11, color: T.textMuted, marginLeft: 6 },

  // Attempt history
  attemptHistory: {
    background: "rgba(255,255,255,0.025)",
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    padding: "10px 14px",
    marginBottom: 10,
  },
  historyLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: T.gold,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    marginBottom: 6,
  },
  attemptRow:   {
    display: "flex",
    gap: 10,
    alignItems: "center",
    fontSize: 12,
    padding: "4px 0",
    borderBottom: `1px solid ${T.border}`,
  },
  attemptDone:   { background: T.sageGlow, borderRadius: 4, padding: "4px 6px" },
  attemptNo:     { fontFamily: "monospace", fontWeight: 700, color: T.textPrimary, minWidth: 28 },
  attemptDate:   { color: T.textMuted, minWidth: 80 },
  attemptStatus: { fontWeight: 600, minWidth: 70 },
  attemptNotes:  { color: T.textSecondary, fontStyle: "italic" as const, flex: 1 },

  analyticsRow: { display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 10 },
  analyticChip: {
    fontSize: 11,
    color: T.textMuted,
    background: T.glass,
    borderRadius: 99,
    padding: "3px 10px",
    border: `1px solid ${T.border}`,
  },

  errMsg: { fontSize: 12, color: T.rose, marginBottom: 8, padding: "6px 10px", background: T.roseGlow, borderRadius: 6 },

  // Item actions
  itemActions: {
    display: "flex",
    gap: 8,
    marginTop: 6,
    alignItems: "center",
    flexWrap: "wrap" as const,
  },
  notesInput: {
    flex: 1,
    minWidth: 160,
    padding: "7px 12px",
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    fontSize: 12,
    color: T.textPrimary,
    background: T.glass,
    outline: "none",
    backdropFilter: "blur(8px)",
  },
  attemptBtn: {
    background: T.glass,
    color: T.textSecondary,
    border: `1px solid ${T.border}`,
    padding: "7px 14px",
    borderRadius: T.radiusSm,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    transition: "all 0.15s",
  },
  doneBtn: {
    background: `linear-gradient(135deg, ${T.sage}, #34d399)`,
    color: T.charcoal,
    border: "none",
    padding: "7px 16px",
    borderRadius: T.radiusSm,
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: `0 4px 14px ${T.sageGlow}`,
    transition: "all 0.2s",
    letterSpacing: "0.02em",
  },
};
