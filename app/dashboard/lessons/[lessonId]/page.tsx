"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { getDocFromServer, doc } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getItemsByLesson,
  getProgressByStudent,
  addAttempt,
  markItemCompleted,
} from "@/services/lesson/lesson.service";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { LessonItem, StudentLessonProgress, Attempt } from "@/types/lesson";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function LessonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ lessonId: string }>;
  searchParams: Promise<{ studentId?: string }>;
}) {
  const { lessonId }   = use(params);
  const { studentId }  = use(searchParams);

  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <LessonDetailContent lessonId={lessonId} studentId={studentId ?? ""} />
    </ProtectedRoute>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ItemWithProgress extends LessonItem {
  progress: StudentLessonProgress | null;
}

// ─── Content ──────────────────────────────────────────────────────────────────

function LessonDetailContent({
  lessonId,
  studentId,
}: {
  lessonId:  string;
  studentId: string;
}) {
  const { user, role }              = useAuth();
  const router                      = useRouter();
  const [lessonTitle, setLessonTitle] = useState<string>("");
  const [items, setItems]           = useState<ItemWithProgress[]>([]);
  const [studentName, setStudentName] = useState<string>("");
  const [loading, setLoading]       = useState(true);
  const [notesMap, setNotesMap]     = useState<Record<string, string>>({});
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [working, setWorking]       = useState(false);
  const { toasts, toast, remove }   = useToast();

  async function fetchData() {
    if (!studentId) return;
    setLoading(true);
    try {
      // Load lesson title
      const lessonSnap = await getDocFromServer(doc(db, "lessons", lessonId));
      if (lessonSnap.exists()) {
        setLessonTitle((lessonSnap.data().title as string) ?? "");
      }

      // Load student name
      const studentSnap = await getDocFromServer(doc(db, "users", studentId));
      if (studentSnap.exists()) {
        const d = studentSnap.data();
        setStudentName((d.displayName as string) ?? (d.name as string) ?? studentId);
      }

      // Load items + progress
      const [rawItems, allProgress] = await Promise.all([
        getItemsByLesson(lessonId),
        getProgressByStudent(studentId),
      ]);

      const progMap: Record<string, StudentLessonProgress> = {};
      allProgress.forEach(p => { progMap[p.itemId] = p; });

      setItems(rawItems.map(item => ({
        ...item,
        progress: progMap[item.id] ?? null,
      })));
    } catch (err) {
      console.error("Failed to load lesson data:", err);
      toast("Failed to load lesson data.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, [lessonId, studentId]);

  async function handleAddAttempt(item: ItemWithProgress) {
    if (!user || !studentId) return;
    setWorking(true);
    setActiveItemId(item.id);
    try {
      await addAttempt(
        studentId,
        lessonId,
        item.id,
        user.uid,
        role ?? "teacher",
        notesMap[item.id]?.trim() || null,
      );
      toast(`Attempt logged for "${item.title}".`, "success");
      setNotesMap(prev => ({ ...prev, [item.id]: "" }));
      await fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("ORDER_VIOLATION"))      toast("Complete items in the previous lesson first.", "error");
      else if (msg.startsWith("MAX_ATTEMPTS"))    toast("Maximum 5 attempts reached for this item.", "error");
      else if (msg.startsWith("ITEM_LOCKED"))     toast("This item is already completed.", "error");
      else                                         toast(`Error: ${msg}`, "error");
    } finally {
      setWorking(false);
      setActiveItemId(null);
    }
  }

  async function handleMarkCompleted(item: ItemWithProgress) {
    if (!user || !studentId) return;
    setWorking(true);
    setActiveItemId(item.id);
    try {
      await markItemCompleted(
        studentId,
        lessonId,
        item.id,
        user.uid,
        role ?? "teacher",
      );
      toast(`"${item.title}" marked as completed.`, "success");
      await fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("NO_ATTEMPTS"))        toast("Log at least 1 attempt before marking complete.", "error");
      else if (msg.startsWith("ALREADY_COMPLETED")) toast("Item is already completed.", "error");
      else                                        toast(`Error: ${msg}`, "error");
    } finally {
      setWorking(false);
      setActiveItemId(null);
    }
  }

  if (!studentId) {
    return (
      <div style={s.errorState}>
        Missing student ID. Navigate here from the Students page with a studentId query param.
      </div>
    );
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <div>
          <button onClick={() => router.back()} style={s.backBtn}>← Back</button>
          <h1 style={s.heading}>{lessonTitle || "Lesson"}</h1>
          {studentName && (
            <div style={s.subheading}>Student: {studentName}</div>
          )}
        </div>
      </div>

      {loading ? (
        <div style={s.stateRow}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={s.stateRow}>No items found for this lesson.</div>
      ) : (
        <div style={s.itemList}>
          {items.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              notes={notesMap[item.id] ?? ""}
              onNotesChange={(v) => setNotesMap(prev => ({ ...prev, [item.id]: v }))}
              onAddAttempt={() => handleAddAttempt(item)}
              onMarkCompleted={() => handleMarkCompleted(item)}
              isWorking={working && activeItemId === item.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Item Card ────────────────────────────────────────────────────────────────

function ItemCard({
  item,
  notes,
  onNotesChange,
  onAddAttempt,
  onMarkCompleted,
  isWorking,
}: {
  item:             ItemWithProgress;
  notes:            string;
  onNotesChange:    (v: string) => void;
  onAddAttempt:     () => void;
  onMarkCompleted:  () => void;
  isWorking:        boolean;
}) {
  const prog             = item.progress;
  const attemptCount     = prog?.attempts?.length ?? 0;
  const isCompleted      = prog?.completed ?? false;
  const canAddAttempt    = !isCompleted && attemptCount < 5;
  const canMarkCompleted = !isCompleted && attemptCount > 0;

  const typeStyle = TYPE_STYLES[item.type] ?? TYPE_STYLES.concept;

  return (
    <div style={{ ...s.card, ...(isCompleted ? s.cardDone : {}) }}>
      {/* Item header */}
      <div style={s.cardHeader}>
        <div style={s.cardLeft}>
          <span style={{ ...s.typeBadge, ...typeStyle }}>{item.type}</span>
          <span style={s.itemTitle}>{item.title}</span>
          {item.order && <span style={s.orderBadge}>#{item.order}</span>}
        </div>
        <div style={s.cardRight}>
          {isCompleted ? (
            <span style={s.completedBadge}>✓ Completed</span>
          ) : (
            <span style={s.attemptCountBadge}>
              {attemptCount} / 5 attempts
            </span>
          )}
        </div>
      </div>

      {/* Attempt history */}
      {prog && prog.attempts.length > 0 && (
        <div style={s.attemptHistory}>
          <div style={s.historyLabel}>Attempt history</div>
          <div style={s.attemptGrid}>
            {prog.attempts.map((a: Attempt) => (
              <div key={a.attemptNo} style={{ ...s.attemptRow, ...(a.status === "completed" ? s.attemptDone : {}) }}>
                <span style={s.attemptNo}>#{a.attemptNo}</span>
                <span style={s.attemptDate}>{a.date}</span>
                <span style={{ ...s.attemptStatus, color: a.status === "completed" ? "#16a34a" : "#374151" }}>
                  {a.status}
                </span>
                {a.notes && (
                  <span style={s.attemptNotes}>"{a.notes}"</span>
                )}
                <span style={s.attemptTeacher}>by {a.teacherId.slice(0, 8)}…</span>
              </div>
            ))}
          </div>

          {isCompleted && prog.completionDate && (
            <div style={s.completionInfo}>
              Completed on {prog.completionDate.slice(0, 10)} · {attemptCount} attempt{attemptCount !== 1 ? "s" : ""} taken
            </div>
          )}
        </div>
      )}

      {/* Actions — only when not completed */}
      {!isCompleted && (
        <div style={s.actions}>
          <input
            value={notes}
            onChange={e => onNotesChange(e.target.value)}
            placeholder="Notes (optional)…"
            style={s.notesInput}
            disabled={isWorking || !canAddAttempt}
          />
          <button
            onClick={onAddAttempt}
            disabled={isWorking || !canAddAttempt}
            style={{ ...s.attemptBtn, opacity: canAddAttempt ? 1 : 0.45 }}
          >
            {isWorking ? "…" : "Add Attempt"}
          </button>
          <button
            onClick={onMarkCompleted}
            disabled={isWorking || !canMarkCompleted}
            style={{ ...s.completeBtn, opacity: canMarkCompleted ? 1 : 0.45 }}
          >
            {isWorking ? "…" : "Mark Completed"}
          </button>
        </div>
      )}

      {/* Max attempts notice */}
      {!isCompleted && attemptCount >= 5 && (
        <div style={s.maxAttemptsNotice}>
          ⚠ Maximum 5 attempts reached. Cannot add more attempts or mark as completed.
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TYPE_STYLES: Record<string, React.CSSProperties> = {
  concept:   { background: "#ede9fe", color: "#4f46e5" },
  exercise:  { background: "#dcfce7", color: "#15803d" },
  songsheet: { background: "#fef9c3", color: "#a16207" },
};

const s: Record<string, React.CSSProperties> = {
  header:            { marginBottom: 24 },
  backBtn:           { background: "none", border: "none", color: "#6b7280", fontSize: 13, cursor: "pointer", padding: "0 0 6px 0", display: "block" },
  heading:           { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  subheading:        { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },
  stateRow:          { padding: "32px 16px", textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" },
  errorState:        { padding: "32px 16px", textAlign: "center", fontSize: 13, color: "#dc2626" },
  itemList:          { display: "flex", flexDirection: "column", gap: 14 },

  // Card
  card:              { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 20px", transition: "opacity 0.2s" },
  cardDone:          { borderColor: "#86efac", background: "#f0fdf4" },
  cardHeader:        { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  cardLeft:          { display: "flex", alignItems: "center", gap: 8 },
  cardRight:         { display: "flex", alignItems: "center", gap: 8 },

  typeBadge:         { padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, textTransform: "capitalize" as const },
  itemTitle:         { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" },
  orderBadge:        { fontSize: 11, color: "#9ca3af", fontFamily: "monospace" },
  completedBadge:    { background: "#dcfce7", color: "#16a34a", padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700 },
  attemptCountBadge: { background: "#f3f4f6", color: "#374151", padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600 },

  // Attempt history
  attemptHistory:    { background: "#f9fafb", border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 14px", marginBottom: 12 },
  historyLabel:      { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 8 },
  attemptGrid:       { display: "flex", flexDirection: "column" as const, gap: 4 },
  attemptRow:        { display: "flex", gap: 10, alignItems: "center", fontSize: 12, padding: "4px 0", borderBottom: "1px solid #f0f0f0" },
  attemptDone:       { background: "#f0fdf4", borderRadius: 4, padding: "4px 6px" },
  attemptNo:         { fontFamily: "monospace", fontWeight: 700, color: "#374151", minWidth: 28 },
  attemptDate:       { color: "#6b7280", minWidth: 90 },
  attemptStatus:     { fontWeight: 600, minWidth: 80 },
  attemptNotes:      { color: "#374151", fontStyle: "italic" as const, flex: 1 },
  attemptTeacher:    { color: "#9ca3af", fontFamily: "monospace", fontSize: 11 },
  completionInfo:    { fontSize: 11, color: "#16a34a", fontWeight: 600, marginTop: 8 },

  // Actions
  actions:           { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const },
  notesInput:        { flex: 1, minWidth: 200, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, color: "#111827", background: "#fff", outline: "none" },
  attemptBtn:        { background: "#4f46e5", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const },
  completeBtn:       { background: "#16a34a", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const },
  maxAttemptsNotice: { marginTop: 10, fontSize: 12, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "7px 12px" },
};
