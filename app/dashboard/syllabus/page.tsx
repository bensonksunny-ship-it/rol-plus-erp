"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getLessonsByCenter,
  assignLessonsToStudent,
  getLessonAssignment,
} from "@/services/lesson/lesson.service";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { Lesson } from "@/types/lesson";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SyllabusPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <SyllabusContent />
    </ProtectedRoute>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StudentOption {
  uid:             string;
  displayName:     string;
  admissionNumber: string;
  centerId:        string;
}

interface CenterOption {
  id:   string;
  name: string;
}

type Tab = "lessons" | "assign" | "track";

// ─── Content ──────────────────────────────────────────────────────────────────

function SyllabusContent() {
  const { user, role }                          = useAuth();
  const router                                  = useRouter();
  const [tab, setTab]                           = useState<Tab>("lessons");
  const [centers, setCenters]                   = useState<CenterOption[]>([]);
  const [students, setStudents]                 = useState<StudentOption[]>([]);
  const [selectedCenter, setSelectedCenter]     = useState<string>("");
  const [lessons, setLessons]                   = useState<Lesson[]>([]);
  const [loading, setLoading]                   = useState(false);
  const [initialising, setInitialising]         = useState(true);
  const { toasts, toast, remove }               = useToast();

  // Assign tab state
  const [assignStudent, setAssignStudent]       = useState<string>("");
  const [selectedLessonIds, setSelectedLessonIds] = useState<Set<string>>(new Set());
  const [assigning, setAssigning]               = useState(false);
  const [assignedInfo, setAssignedInfo]         = useState<string | null>(null);

  // Load centers + students on mount
  useEffect(() => {
    async function init() {
      try {
        const [centersSnap, studentsSnap] = await Promise.all([
          getDocs(collection(db, "centers")),
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        ]);
        setCenters(centersSnap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id })));
        setStudents(studentsSnap.docs.map(d => ({
          uid:             d.id,
          displayName:     (d.data().displayName as string) ?? (d.data().name as string) ?? "",
          admissionNumber: (d.data().admissionNumber as string) ?? "",
          centerId:        (d.data().centerId as string) ?? "",
        })));
      } catch {
        toast("Failed to load centers/students.", "error");
      } finally {
        setInitialising(false);
      }
    }
    init();
  }, []);

  async function loadLessons() {
    if (!selectedCenter) { toast("Select a center first.", "error"); return; }
    setLoading(true);
    setLessons([]);
    try {
      const data = await getLessonsByCenter(selectedCenter);
      setLessons(data);
      if (data.length === 0) toast("No lessons found for this center.", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to load lessons: ${msg}`, "error");
    } finally {
      setLoading(false);
    }
  }

  // When student is selected in assign tab, load their current assignment
  async function loadStudentAssignment(studentId: string) {
    if (!studentId) {
      setAssignedInfo(null);
      setSelectedLessonIds(new Set());
      return;
    }
    try {
      const assignment = await getLessonAssignment(studentId);
      if (assignment && assignment.lessonIds.length > 0) {
        setSelectedLessonIds(new Set(assignment.lessonIds));
        setAssignedInfo(`Currently assigned: ${assignment.lessonIds.length} lessons`);
      } else {
        setSelectedLessonIds(new Set());
        setAssignedInfo("No lessons assigned yet");
      }
    } catch {
      setAssignedInfo(null);
    }
  }

  function toggleLessonSelection(lessonId: string) {
    setSelectedLessonIds(prev => {
      const next = new Set(prev);
      next.has(lessonId) ? next.delete(lessonId) : next.add(lessonId);
      return next;
    });
  }

  function selectAll() {
    setSelectedLessonIds(new Set(lessons.map(l => l.id)));
  }

  function deselectAll() {
    setSelectedLessonIds(new Set());
  }

  async function handleAssign() {
    if (!user || !assignStudent || !selectedCenter) {
      toast("Select a student and center first.", "error");
      return;
    }
    if (selectedLessonIds.size === 0) {
      toast("Select at least one lesson to assign.", "error");
      return;
    }
    setAssigning(true);
    try {
      // Preserve order from the lessons array
      const orderedIds = lessons
        .filter(l => selectedLessonIds.has(l.id))
        .map(l => l.id);

      await assignLessonsToStudent(
        assignStudent,
        selectedCenter,
        orderedIds,
        user.uid,
        role ?? "admin",
      );
      toast(`${orderedIds.length} lessons assigned successfully.`, "success");
      setAssignedInfo(`Currently assigned: ${orderedIds.length} lessons`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Assignment failed: ${msg}`, "error");
    } finally {
      setAssigning(false);
    }
  }

  const visibleStudents = selectedCenter
    ? students.filter(s => s.centerId === selectedCenter)
    : students;

  const isAdmin = role === "admin" || role === "super_admin";

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <h1 style={s.heading}>Syllabus</h1>
        {isAdmin && (
          <button
            onClick={() => router.push("/dashboard/lessons/import")}
            style={s.importBtn}
          >
            Import from Excel
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        {(["lessons", "assign", "track"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
          >
            {t === "lessons" ? "📚 Lessons" : t === "assign" ? "🎯 Assign" : "📊 Track"}
          </button>
        ))}
      </div>

      {/* Center selector — shared across tabs */}
      <div style={s.filterCard}>
        <div style={s.filterTitle}>Select Center</div>
        <div style={s.selectRow}>
          <select
            value={selectedCenter}
            onChange={e => { setSelectedCenter(e.target.value); setLessons([]); setAssignedInfo(null); }}
            style={s.select}
            disabled={initialising}
          >
            <option value="">— Select center —</option>
            {centers.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            onClick={loadLessons}
            disabled={loading || !selectedCenter || initialising}
            style={{ ...s.loadBtn, opacity: (loading || !selectedCenter) ? 0.5 : 1 }}
          >
            {loading ? "Loading…" : "Load Lessons"}
          </button>
        </div>
      </div>

      {/* ─── LESSONS TAB ───────────────────────────────────────────────────── */}
      {tab === "lessons" && (
        <>
          {lessons.length > 0 && (
            <div style={s.tableWrapper}>
              <div style={s.tableHeader}>
                <span style={s.tableTitle}>
                  {lessons.length} lesson{lessons.length !== 1 ? "s" : ""}
                  {" · "}{centers.find(c => c.id === selectedCenter)?.name ?? ""}
                </span>
              </div>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["Order", "No.", "Title", ""].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lessons.map((lesson, i) => (
                    <tr key={lesson.id} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                      <td style={{ ...s.td, ...s.mono }}>{lesson.order}</td>
                      <td style={{ ...s.td, ...s.mono }}>{lesson.lessonNumber}</td>
                      <td style={{ ...s.td, fontWeight: 600, color: "var(--color-text-primary)" }}>
                        {lesson.title}
                      </td>
                      <td style={s.td}>
                        <span style={s.centerBadge}>Center</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && lessons.length === 0 && (
            <div style={s.emptyState}>
              <div style={s.emptyIcon}>📚</div>
              <div style={s.emptyText}>Select a center and click "Load Lessons".</div>
              {isAdmin && (
                <div style={s.emptyHint}>
                  No lessons yet?{" "}
                  <button onClick={() => router.push("/dashboard/lessons/import")} style={s.linkBtn}>
                    Import from Excel
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ─── ASSIGN TAB ──────────────────────────────────────────────────── */}
      {tab === "assign" && (
        <div style={s.assignCard}>
          <div style={s.assignTitle}>Assign Lessons to Student</div>

          {/* Student selector */}
          <div style={s.fieldGroup}>
            <label style={s.label}>Student</label>
            <select
              value={assignStudent}
              onChange={e => {
                setAssignStudent(e.target.value);
                loadStudentAssignment(e.target.value);
              }}
              style={s.select}
              disabled={initialising || !selectedCenter}
            >
              <option value="">— Select student —</option>
              {visibleStudents.map(st => (
                <option key={st.uid} value={st.uid}>
                  {st.admissionNumber ? `[${st.admissionNumber}] ` : ""}{st.displayName || st.uid}
                </option>
              ))}
            </select>
            {assignedInfo && <div style={s.assignedTag}>{assignedInfo}</div>}
          </div>

          {/* Lesson checkboxes */}
          {lessons.length > 0 ? (
            <>
              <div style={s.lessonSelectHeader}>
                <span style={s.lessonSelectTitle}>Select lessons to assign ({selectedLessonIds.size}/{lessons.length})</span>
                <div style={s.bulkActions}>
                  <button onClick={selectAll} style={s.bulkBtn}>Select All</button>
                  <button onClick={deselectAll} style={s.bulkBtn}>Deselect All</button>
                </div>
              </div>
              <div style={s.checkList}>
                {lessons.map(lesson => (
                  <label key={lesson.id} style={s.checkItem}>
                    <input
                      type="checkbox"
                      checked={selectedLessonIds.has(lesson.id)}
                      onChange={() => toggleLessonSelection(lesson.id)}
                      style={{ marginRight: 10, accentColor: "#a78bfa" }}
                    />
                    <span style={s.checkOrder}>{lesson.order}.</span>
                    <span style={s.checkLabel}>{lesson.title}</span>
                  </label>
                ))}
              </div>
              <button
                onClick={handleAssign}
                disabled={assigning || !assignStudent || selectedLessonIds.size === 0}
                style={{
                  ...s.assignBtn,
                  opacity: (assigning || !assignStudent || selectedLessonIds.size === 0) ? 0.5 : 1,
                }}
              >
                {assigning ? "Assigning…" : `Assign ${selectedLessonIds.size} Lessons`}
              </button>
            </>
          ) : (
            <div style={s.emptyInline}>Load lessons from a center first.</div>
          )}
        </div>
      )}

      {/* ─── TRACK TAB ───────────────────────────────────────────────────── */}
      {tab === "track" && (
        <div style={s.trackCard}>
          <div style={s.trackTitle}>Track Student Progress</div>
          <div style={s.fieldGroup}>
            <label style={s.label}>Student</label>
            <select
              value={assignStudent}
              onChange={e => setAssignStudent(e.target.value)}
              style={s.select}
              disabled={initialising || !selectedCenter}
            >
              <option value="">— Select student —</option>
              {visibleStudents.map(st => (
                <option key={st.uid} value={st.uid}>
                  {st.admissionNumber ? `[${st.admissionNumber}] ` : ""}{st.displayName || st.uid}
                </option>
              ))}
            </select>
          </div>
          {assignStudent ? (
            <button
              onClick={() => router.push(`/dashboard/student-syllabus/${assignStudent}`)}
              style={s.viewProgressBtn}
            >
              View Full Syllabus Progress →
            </button>
          ) : (
            <div style={s.emptyInline}>Select a student to view their progress.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 2026 Design Tokens ───────────────────────────────────────────────────────

const T = {
  charcoal:      "#1a1a2e",
  surface:       "#16213e",
  surfaceAlt:    "#0f3460",
  gold:          "#e2b96f",
  goldGlow:      "rgba(226,185,111,0.18)",
  lavender:      "#a78bfa",
  lavenderGlow:  "rgba(167,139,250,0.18)",
  sage:          "#6ee7b7",
  sageGlow:      "rgba(110,231,183,0.15)",
  rose:          "#f87171",
  border:        "rgba(255,255,255,0.08)",
  borderGold:    "rgba(226,185,111,0.28)",
  textPrimary:   "#f1f5f9",
  textSecondary: "#94a3b8",
  textMuted:     "#64748b",
  glass:         "rgba(255,255,255,0.04)",
  glassHover:    "rgba(255,255,255,0.07)",
  radius:        12,
  radiusSm:      8,
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  // Header
  header:       { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  heading:      { fontSize: 24, fontWeight: 700, color: T.textPrimary, margin: 0, letterSpacing: "-0.5px" },
  importBtn:    {
    background: `linear-gradient(135deg, ${T.gold}, #c99a4e)`,
    color: T.charcoal,
    border: "none",
    padding: "9px 18px",
    borderRadius: T.radiusSm,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: `0 4px 14px ${T.goldGlow}`,
    transition: "all 0.2s",
  },

  // Tabs
  tabs:         {
    display: "flex",
    gap: 4,
    marginBottom: 20,
    background: T.glass,
    borderRadius: T.radius,
    padding: 4,
    border: `1px solid ${T.border}`,
    backdropFilter: "blur(10px)",
  },
  tab:          {
    flex: 1,
    padding: "9px 0",
    borderRadius: T.radiusSm,
    border: "none",
    background: "transparent",
    fontSize: 13,
    fontWeight: 500,
    color: T.textSecondary,
    cursor: "pointer",
    textAlign: "center" as const,
    transition: "all 0.18s",
  },
  tabActive:    {
    background: `linear-gradient(135deg, ${T.lavender}22, ${T.lavender}11)`,
    color: T.lavender,
    fontWeight: 700,
    boxShadow: `0 1px 8px ${T.lavenderGlow}, inset 0 0 0 1px ${T.lavender}44`,
  },

  // Filter card
  filterCard:   {
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    padding: "16px 20px",
    marginBottom: 16,
    backdropFilter: "blur(12px)",
  },
  filterTitle:  { fontSize: 10, fontWeight: 700, color: T.gold, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 10 },
  selectRow:    { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const },
  select:       {
    padding: "9px 12px",
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    fontSize: 13,
    color: T.textPrimary,
    background: T.glass,
    outline: "none",
    minWidth: 200,
    backdropFilter: "blur(8px)",
  },
  loadBtn:      {
    background: `linear-gradient(135deg, ${T.lavender}, #7c3aed)`,
    color: "#fff",
    border: "none",
    padding: "9px 20px",
    borderRadius: T.radiusSm,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: `0 4px 14px ${T.lavenderGlow}`,
    transition: "all 0.2s",
  },

  // Table
  tableWrapper: {
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    overflow: "hidden",
    marginBottom: 16,
    backdropFilter: "blur(12px)",
  },
  tableHeader:  {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    borderBottom: `1px solid ${T.border}`,
    background: `linear-gradient(90deg, ${T.goldGlow}, transparent)`,
  },
  tableTitle:   { fontSize: 11, fontWeight: 700, color: T.gold, textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  table:        { width: "100%", borderCollapse: "collapse" as const },
  th:           {
    padding: "10px 18px",
    textAlign: "left" as const,
    fontSize: 10,
    fontWeight: 700,
    color: T.textMuted,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background: "rgba(255,255,255,0.02)",
    borderBottom: `1px solid ${T.border}`,
  },
  td:           {
    padding: "13px 18px",
    fontSize: 13,
    color: T.textPrimary,
    borderBottom: `1px solid ${T.border}`,
    transition: "background 0.15s",
  },
  rowEven:      { background: "transparent" },
  rowOdd:       { background: "rgba(255,255,255,0.015)" },
  mono:         { fontFamily: "monospace", fontSize: 12, color: T.textMuted },
  centerBadge:  {
    background: T.lavenderGlow,
    color: T.lavender,
    padding: "2px 10px",
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 700,
    border: `1px solid ${T.lavender}33`,
  },

  // Empty states
  emptyState:   { padding: "56px 16px", textAlign: "center" as const },
  emptyIcon:    { fontSize: 44, marginBottom: 14 },
  emptyText:    { fontSize: 14, color: T.textSecondary, marginBottom: 8 },
  emptyHint:    { fontSize: 13, color: T.textMuted },
  linkBtn:      {
    background: "none",
    border: "none",
    color: T.gold,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
    padding: 0,
    textDecoration: "underline",
  },
  emptyInline:  { padding: "16px 0", fontSize: 13, color: T.textMuted },

  // Assign tab
  assignCard:   {
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    padding: "22px",
    backdropFilter: "blur(12px)",
  },
  assignTitle:  { fontSize: 15, fontWeight: 700, color: T.textPrimary, marginBottom: 18 },
  fieldGroup:   { marginBottom: 18 },
  label:        {
    display: "block",
    fontSize: 10,
    fontWeight: 700,
    color: T.gold,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    marginBottom: 7,
  },
  assignedTag:  {
    marginTop: 7,
    fontSize: 12,
    color: T.sage,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  },

  lessonSelectHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  lessonSelectTitle:  { fontSize: 12, fontWeight: 600, color: T.textSecondary },
  bulkActions:  { display: "flex", gap: 10 },
  bulkBtn:      {
    background: "none",
    border: `1px solid ${T.border}`,
    color: T.lavender,
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    padding: "3px 10px",
    borderRadius: 6,
    transition: "all 0.15s",
  },

  checkList:    {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginBottom: 18,
    maxHeight: 320,
    overflowY: "auto" as const,
    padding: "4px 0",
  },
  checkItem:    {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    padding: "8px 10px",
    borderRadius: T.radiusSm,
    transition: "background 0.12s",
    border: `1px solid transparent`,
  },
  checkOrder:   { fontSize: 11, fontWeight: 700, color: T.textMuted, fontFamily: "monospace", minWidth: 30 },
  checkLabel:   { fontSize: 13, fontWeight: 500, color: T.textPrimary },

  assignBtn:    {
    background: `linear-gradient(135deg, ${T.lavender}, #7c3aed)`,
    color: "#fff",
    border: "none",
    padding: "11px 28px",
    borderRadius: T.radiusSm,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: `0 4px 20px ${T.lavenderGlow}`,
    transition: "all 0.2s",
    letterSpacing: "0.02em",
  },

  // Track tab
  trackCard:    {
    background: T.glass,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    padding: "22px",
    backdropFilter: "blur(12px)",
  },
  trackTitle:   { fontSize: 15, fontWeight: 700, color: T.textPrimary, marginBottom: 18 },
  viewProgressBtn: {
    background: `linear-gradient(135deg, ${T.sage}, #34d399)`,
    color: T.charcoal,
    border: "none",
    padding: "11px 24px",
    borderRadius: T.radiusSm,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 10,
    boxShadow: `0 4px 16px ${T.sageGlow}`,
    transition: "all 0.2s",
  },
};
