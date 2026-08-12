"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/useIsMobile";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/config/firebase";
import {
  getLessonsForStudent,
  getProgressByStudent,
  markItemCompleted,
  calcLessonPercent,
} from "@/services/lesson/lesson.service";
import {
  updateLessonTitle,
  updateLessonItem,
  deleteLessonItem,
  deleteLesson,
} from "@/services/admin/delete.service";
import type { Lesson, LessonItem, StudentLessonProgress } from "@/types/lesson";

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
  const router          = useRouter();

  // Admins/teachers arrive here from the Students list (usually via the
  // Student Detail modal) — send them back there, reopening that student's
  // drawer. Students viewing their own syllabus have no Students list to
  // return to, so send them to their own dashboard instead.
  const isStaff = role === "admin" || role === "super_admin" || role === "teacher";
  function goBack() {
    if (isStaff) router.push(`/dashboard/students?studentId=${studentId}`);
    else router.push("/dashboard");
  }
  const backBar = (
    <div style={s.backBar}>
      <button onClick={goBack} style={s.backBtn}>
        ← {isStaff ? "Back to Students" : "Back to Dashboard"}
      </button>
    </div>
  );

  const [lessons, setLessons]               = useState<LessonWithItems[]>([]);
  const [progressMap, setProgressMap]        = useState<Record<string, StudentLessonProgress>>({});
  const [student, setStudent]               = useState<StudentMeta | null>(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState<string | null>(null);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);

  // Edit state
  const [editLessonTarget, setEditLessonTarget] = useState<LessonWithItems | null>(null);
  const [editItemTarget, setEditItemTarget]     = useState<{ item: LessonItem; lessonId: string } | null>(null);

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

  if (loading) return <>{backBar}<div style={s.state}>Loading syllabus…</div></>;
  if (error)   return <>{backBar}<div style={{ ...s.state, color: "#dc2626" }}>{error}</div></>;

  if (lessons.length === 0) {
    return (
      <>
        {backBar}
        <div style={s.empty}>
          <div style={s.emptyIcon}>📋</div>
          <div style={s.emptyTitle}>No syllabus assigned yet</div>
          <div style={s.emptySub}>
            No lessons are available for this student yet. You can import lessons two ways:
            <br /><br />
            <strong>1. Center-wide</strong> — Import lessons for the student&apos;s center (all students
            in that center will see them) via <strong>Syllabus → Import from Excel</strong>.<br />
            <strong>2. Student-specific</strong> — Import lessons directly for this student only.
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <a href={`/dashboard/lessons/import?scope=student&id=${studentId}`} style={s.importLink}>
              Import for this student →
            </a>
            <a href="/dashboard/lessons/import?scope=center" style={{ ...s.importLink, background: "#6b7280" }}>
              Import for center →
            </a>
          </div>
        </div>
      </>
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
      {/* Edit Lesson Modal */}
      {editLessonTarget && (
        <EditLessonModal
          lesson={editLessonTarget}
          onClose={() => setEditLessonTarget(null)}
          onSaved={() => { setEditLessonTarget(null); load(); }}
        />
      )}
      {/* Edit Item Modal */}
      {editItemTarget && (
        <EditItemModal
          item={editItemTarget.item}
          lessonId={editItemTarget.lessonId}
          teacherId={user?.uid ?? ""}
          teacherRole={role ?? "admin"}
          onClose={() => setEditItemTarget(null)}
          onSaved={() => { setEditItemTarget(null); load(); }}
        />
      )}

      {backBar}

      {/* Student header */}
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Quest</h1>
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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={s.panelCount}>{activeLesson.items.length} items</span>
              {canModify && (
                <>
                  <button onClick={() => setEditLessonTarget(activeLesson)} style={s.editIconBtn} title="Edit lesson title">
                    ✏
                  </button>
                  <button onClick={async () => {
                    if (!confirm(`Delete lesson "${activeLesson.title}" and all its items?`)) return;
                    const res = await deleteLesson(activeLesson.id, user?.uid ?? "", role as import("@/types").Role ?? "admin");
                    if (res.success) { load(); } else { alert(res.error); }
                  }} style={s.deleteIconBtn} title="Delete lesson">
                    🗑
                  </button>
                </>
              )}
            </div>
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
                onEdit={canModify ? () => setEditItemTarget({ item, lessonId: activeLesson.id }) : undefined}
                onDelete={canModify ? async () => {
                  if (!confirm(`Delete item "${item.title}"?`)) return;
                  const res = await deleteLessonItem(item.id, user?.uid ?? "", role as import("@/types").Role ?? "admin");
                  if (res.success) load(); else alert(res.error);
                } : undefined}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Progress Overview ── */}
      <div style={s.poSectionTitle}>Progress Overview</div>
      <div style={s.poList}>
        {lessons.map(lesson => {
          const items      = lesson.items;
          const pct        = calcLessonPercent(items, progressMap);
          const allDone    = items.length > 0 && items.every(i => progressMap[i.id]?.completed);
          const anyStarted = items.some(i => (progressMap[i.id]?.totalAttempts ?? 0) > 0);
          const status     = allDone ? "completed" : anyStarted ? "in_progress" : "locked";
          return (
            <div key={lesson.id} style={s.poRow}>
              <div style={s.poLeft}>
                <SyllabusStatusIcon status={status} />
                <div>
                  <div style={s.poTitle}>{lesson.title}</div>
                  <div style={s.poSub}>{items.length} activities</div>
                </div>
              </div>
              <div style={s.poRight}>
                <div style={s.poPct}>{pct}%</div>
                <div style={s.poBarTrack}>
                  <div style={{ ...s.poBarFill, width: `${pct}%`, background: allDone ? "#16a34a" : anyStarted ? "#f59e0b" : "#d1d5db" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Attempts Tracker ── */}
      <div style={s.poSectionTitle}>Attempts Tracker — {activeLesson.title}</div>
      <div style={s.atCard}>
        {activeLesson.items.length === 0 ? (
          <div style={s.atEmpty}>No activities in this lesson.</div>
        ) : (
          activeLesson.items.map(item => {
            const prog     = progressMap[item.id];
            const attempts = prog?.totalAttempts ?? 0;
            const done     = prog?.completed ?? false;
            const tc       = { concept: { bg: "#dbeafe", fg: "#1d4ed8" }, exercise: { bg: "#fef3c7", fg: "#b45309" }, songsheet: { bg: "#f3e8ff", fg: "#7c3aed" } }[item.type] ?? { bg: "#f3f4f6", fg: "#374151" };
            return (
              <div key={item.id} style={s.atRow}>
                <div style={s.atLeft}>
                  <span style={{ ...s.atBadge, background: tc.bg, color: tc.fg }}>{item.type}</span>
                  <span style={s.atTitle}>{item.title}</span>
                </div>
                <div style={s.atRight}>
                  {done ? (
                    <span style={s.atDone}>✔ Completed</span>
                  ) : (
                    <span style={s.atCount}>{attempts}/{item.maxAttempts} attempts</span>
                  )}
                  <div style={s.atDots}>
                    {Array.from({ length: item.maxAttempts }).map((_, i) => (
                      <div key={i} style={{ ...s.atDot, background: done ? "#16a34a" : i < attempts ? "#4f46e5" : "#e5e7eb" }} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SyllabusStatusIcon({ status }: { status: "completed" | "in_progress" | "locked" }) {
  if (status === "completed")  return <span style={{ fontSize: 16, flexShrink: 0, color: "#16a34a" }}>✔</span>;
  if (status === "in_progress") return <span style={{ fontSize: 16, flexShrink: 0, color: "#f59e0b" }}>🔄</span>;
  return <span style={{ fontSize: 16, flexShrink: 0, color: "#9ca3af" }}>🔒</span>;
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
  onEdit,
  onDelete,
}: {
  item:         LessonItem;
  progress:     StudentLessonProgress | null;
  lessonId:     string;
  studentId:    string;
  canModify:    boolean;
  teacherId:    string;
  teacherRole:  string;
  onUpdated:    () => void;
  onEdit?:      () => void;
  onDelete?:    () => void;
}) {
  const [busy, setBusy]     = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const isCompleted = progress?.completed ?? false;

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
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          {onEdit && (
            <button onClick={onEdit} style={s.editIconBtn} title="Edit item">✏</button>
          )}
          {onDelete && (
            <button onClick={onDelete} style={s.deleteIconBtn} title="Delete item">🗑</button>
          )}
        </div>
      </div>

      {/* Title */}
      <div style={s.itemTitle}>{item.title}</div>

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
          <button
            onClick={handleComplete}
            disabled={busy}
            style={{
              ...s.doneBtn,
              opacity: busy ? 0.5 : 1,
              cursor:  busy ? "not-allowed" : "pointer",
            }}
          >
            Mark Done
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Edit Lesson Modal ────────────────────────────────────────────────────────

function EditLessonModal({ lesson, onClose, onSaved }: {
  lesson:  { id: string; title: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(lesson.title);
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState("");

  async function handleSave() {
    if (!title.trim()) { setErr("Title cannot be empty."); return; }
    setBusy(true);
    const res = await updateLessonTitle(lesson.id, title);
    if (res.success) onSaved();
    else { setErr(res.error ?? "Failed to save."); setBusy(false); }
  }

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalBox} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <div style={s.heading}>Edit Lesson Title</div>
          <button onClick={onClose} style={s.modalCloseBtn}>✕</button>
        </div>
        <div style={{ padding: "16px 20px" }}>
          <label style={s.modalLabel}>Lesson Title</label>
          <input value={title} onChange={e => { setTitle(e.target.value); setErr(""); }}
            style={{ ...s.modalInput, borderColor: err ? "#fca5a5" : "#d1d5db" }} />
          {err && <div style={s.modalErr}>{err}</div>}
          <div style={s.modalFooter}>
            <button onClick={onClose} style={s.modalCancelBtn}>Cancel</button>
            <button onClick={handleSave} disabled={busy}
              style={{ ...s.modalSaveBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Item Modal ──────────────────────────────────────────────────────────

function EditItemModal({ item, lessonId, teacherId, teacherRole, onClose, onSaved }: {
  item:        LessonItem;
  lessonId:    string;
  teacherId:   string;
  teacherRole: string;
  onClose:     () => void;
  onSaved:     () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [type, setType]   = useState<"concept" | "exercise" | "songsheet">(item.type as "concept" | "exercise" | "songsheet");
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState("");

  async function handleSave() {
    if (!title.trim()) { setErr("Title cannot be empty."); return; }
    setBusy(true);
    const res = await updateLessonItem(item.id, { title, type });
    if (res.success) onSaved();
    else { setErr(res.error ?? "Failed to save."); setBusy(false); }
  }

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalBox} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <div style={s.heading}>Edit Item</div>
          <button onClick={onClose} style={s.modalCloseBtn}>✕</button>
        </div>
        <div style={{ padding: "16px 20px" }}>
          <label style={s.modalLabel}>Item Title</label>
          <input value={title} onChange={e => { setTitle(e.target.value); setErr(""); }}
            style={{ ...s.modalInput, borderColor: err ? "#fca5a5" : "#d1d5db" }} />
          <label style={{ ...s.modalLabel, marginTop: 12 }}>Type</label>
          <select value={type} onChange={e => setType(e.target.value as "concept" | "exercise" | "songsheet")} style={s.modalInput}>
            <option value="concept">Concept</option>
            <option value="exercise">Exercise</option>
            <option value="songsheet">Songsheet</option>
          </select>
          {err && <div style={s.modalErr}>{err}</div>}
          <div style={s.modalFooter}>
            <button onClick={onClose} style={s.modalCancelBtn}>Cancel</button>
            <button onClick={handleSave} disabled={busy}
              style={{ ...s.modalSaveBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
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

  backBar: { marginBottom: 14 },
  backBtn: {
    display:      "inline-flex",
    alignItems:   "center",
    gap:          6,
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 8,
    padding:      "7px 14px",
    fontSize:     13,
    fontWeight:   600,
    color:        "#374151",
    cursor:       "pointer",
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

  // Edit / delete icon buttons
  editIconBtn:   { background: "#fef9c3", color: "#92400e", border: "1px solid #fde68a", borderRadius: 5, padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  deleteIconBtn: { background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 5, padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" },

  // Edit modal
  modalOverlay:    { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  modalBox:        { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 420, boxShadow: "0 16px 48px rgba(0,0,0,0.18)", overflow: "hidden" },
  modalHeader:     { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #e5e7eb" },
  modalCloseBtn:   { background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "#9ca3af", padding: 4 },
  modalLabel:      { display: "block", fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 6 },
  modalInput:      { width: "100%", padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111", boxSizing: "border-box" as const },
  modalErr:        { fontSize: 12, color: "#dc2626", marginTop: 6 },
  modalFooter:     { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 },
  modalCancelBtn:  { background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", padding: "7px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  modalSaveBtn:    { background: "#4f46e5", color: "#fff", border: "none", padding: "7px 18px", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer" },

  // Item actions
  itemActions: {
    display:    "flex",
    gap:        8,
    marginTop:  6,
    alignItems: "center",
    flexWrap:   "wrap" as const,
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

  // ── Progress Overview ─────────────────────────────────────────────────────
  poSectionTitle: {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase" as const, letterSpacing: "0.06em",
    marginBottom: 10, marginTop: 28,
  },
  poList: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" },
  poRow:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #f3f4f6", gap: 12 },
  poLeft: { display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 },
  poRight:{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  poTitle:{ fontSize: 13, fontWeight: 600, color: "#111111", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  poSub:  { fontSize: 11, color: "#9ca3af", marginTop: 1 },
  poPct:  { fontSize: 12, fontWeight: 700, color: "#4f46e5", minWidth: 32, textAlign: "right" as const },
  poBarTrack: { width: 100, height: 6, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", flexShrink: 0 },
  poBarFill:  { height: "100%", borderRadius: 99, transition: "width 0.3s ease" },

  // ── Attempts Tracker ──────────────────────────────────────────────────────
  atCard:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" },
  atRow:   { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #f3f4f6", gap: 12, flexWrap: "wrap" as const },
  atLeft:  { display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 },
  atRight: { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 },
  atBadge: { display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, flexShrink: 0, textTransform: "capitalize" as const },
  atTitle: { fontSize: 13, color: "#111111", fontWeight: 500 },
  atDone:  { fontSize: 12, fontWeight: 600, color: "#16a34a", background: "#dcfce7", borderRadius: 6, padding: "2px 10px" },
  atCount: { fontSize: 12, color: "#6b7280", fontWeight: 500, minWidth: 70, textAlign: "right" as const },
  atDots:  { display: "flex", alignItems: "center", gap: 4 },
  atDot:   { width: 10, height: 10, borderRadius: "50%" },
  atEmpty: { padding: "20px", fontSize: 13, color: "#9ca3af" },
};
