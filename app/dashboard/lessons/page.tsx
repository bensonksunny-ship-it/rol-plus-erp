"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { getLessonsByCenter, getLessonsByStudent } from "@/services/lesson/lesson.service";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { Lesson } from "@/types/lesson";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function LessonsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <LessonsContent />
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

// ─── Content ──────────────────────────────────────────────────────────────────

function LessonsContent() {
  const { user, role }                  = useAuth();
  const router                          = useRouter();
  const [scopeType, setScopeType]       = useState<"center" | "student">("center");
  const [centers, setCenters]           = useState<CenterOption[]>([]);
  const [students, setStudents]         = useState<StudentOption[]>([]);
  const [selectedCenter, setSelectedCenter] = useState<string>("");
  const [selectedStudent, setSelectedStudent] = useState<string>("");
  const [lessons, setLessons]           = useState<Lesson[]>([]);
  const [loading, setLoading]           = useState(false);
  const [initialising, setInitialising] = useState(true);
  const { toasts, toast, remove }       = useToast();

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
      } catch (err) {
        console.error("Failed to load filters:", err);
        toast("Failed to load centers/students.", "error");
      } finally {
        setInitialising(false);
      }
    }
    init();
  }, []);

  async function loadLessons() {
    const id = scopeType === "center" ? selectedCenter : selectedStudent;
    if (!id) { toast("Select a center or student first.", "error"); return; }
    setLoading(true);
    setLessons([]);
    try {
      const data = scopeType === "center"
        ? await getLessonsByCenter(id)
        : await getLessonsByStudent(id);
      setLessons(data);
      if (data.length === 0) toast("No lessons found for this selection.", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to load lessons: ${msg}`, "error");
    } finally {
      setLoading(false);
    }
  }

  // Filtered students when scoped to a specific center
  const visibleStudents = selectedCenter && scopeType === "student"
    ? students.filter(s => s.centerId === selectedCenter)
    : students;

  const selectedStudentObj = students.find(s => s.uid === selectedStudent);

  function navigateToLesson(lesson: Lesson) {
    // For center scope → must pick a student first
    if (scopeType === "center") {
      // Navigate to lesson without student for review (teacher picks student on detail page)
      router.push(`/dashboard/lessons/${lesson.id}`);
    } else {
      router.push(`/dashboard/lessons/${lesson.id}?studentId=${selectedStudent}`);
    }
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <h1 style={s.heading}>Lessons</h1>
        {(role === "admin" || role === "super_admin") && (
          <button
            onClick={() => router.push("/dashboard/lessons/import")}
            style={s.importBtn}
          >
            Import from Excel
          </button>
        )}
      </div>

      {/* Filter panel */}
      <div style={s.filterCard}>
        <div style={s.filterTitle}>Filter lessons</div>

        {/* Scope toggle */}
        <div style={s.row}>
          <label style={s.radioLabel}>
            <input
              type="radio"
              checked={scopeType === "center"}
              onChange={() => { setScopeType("center"); setLessons([]); }}
              style={{ marginRight: 6 }}
            />
            By Center
          </label>
          <label style={s.radioLabel}>
            <input
              type="radio"
              checked={scopeType === "student"}
              onChange={() => { setScopeType("student"); setLessons([]); }}
              style={{ marginRight: 6 }}
            />
            By Student
          </label>
        </div>

        {/* Center selector */}
        <div style={s.selectRow}>
          <div style={s.selectGroup}>
            <label style={s.label}>Center</label>
            <select
              value={selectedCenter}
              onChange={e => { setSelectedCenter(e.target.value); setLessons([]); }}
              style={s.select}
              disabled={initialising}
            >
              <option value="">— Select center —</option>
              {centers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Student selector (only in student scope) */}
          {scopeType === "student" && (
            <div style={s.selectGroup}>
              <label style={s.label}>Student</label>
              <select
                value={selectedStudent}
                onChange={e => { setSelectedStudent(e.target.value); setLessons([]); }}
                style={s.select}
                disabled={initialising}
              >
                <option value="">— Select student —</option>
                {visibleStudents.map(st => (
                  <option key={st.uid} value={st.uid}>
                    {st.admissionNumber ? `[${st.admissionNumber}] ` : ""}{st.displayName || st.uid}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={loadLessons}
            disabled={loading || initialising}
            style={{ ...s.loadBtn, opacity: loading ? 0.6 : 1, alignSelf: "flex-end" }}
          >
            {loading ? "Loading…" : "Load Lessons"}
          </button>
        </div>
      </div>

      {/* Lessons table */}
      {lessons.length > 0 && (
        <div style={s.tableWrapper}>
          <div style={s.tableHeader}>
            <span style={s.tableTitle}>
              {lessons.length} lesson{lessons.length !== 1 ? "s" : ""}
              {scopeType === "student" && selectedStudentObj
                ? ` · ${selectedStudentObj.admissionNumber || selectedStudentObj.displayName}`
                : selectedCenter
                ? ` · ${centers.find(c => c.id === selectedCenter)?.name ?? selectedCenter}`
                : ""}
            </span>
          </div>
          <table style={s.table}>
            <thead>
              <tr>
                {["Order", "Lesson No.", "Title", "Scope", ""].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lessons.map((lesson, i) => (
                <tr
                  key={lesson.id}
                  style={i % 2 === 0 ? s.rowEven : s.rowOdd}
                >
                  <td style={{ ...s.td, ...s.mono }}>{lesson.order}</td>
                  <td style={{ ...s.td, ...s.mono }}>{lesson.lessonNumber}</td>
                  <td style={{ ...s.td, fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {lesson.title}
                  </td>
                  <td style={s.td}>
                    {lesson.centerId ? (
                      <span style={s.centerBadge}>Center</span>
                    ) : (
                      <span style={s.studentBadge}>Student</span>
                    )}
                  </td>
                  <td style={s.td}>
                    {scopeType === "student" && selectedStudent ? (
                      <button
                        onClick={() => navigateToLesson(lesson)}
                        style={s.viewBtn}
                      >
                        View Items →
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>
                        Select a student to track
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty / initial state */}
      {!loading && lessons.length === 0 && (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>📚</div>
          <div style={s.emptyText}>Select a center or student and click "Load Lessons".</div>
          {(role === "admin" || role === "super_admin") && (
            <div style={s.emptyHint}>
              No lessons yet? <button onClick={() => router.push("/dashboard/lessons/import")} style={s.linkBtn}>Import from Excel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header:       { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  heading:      { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  importBtn:    { background: "#4f46e5", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  filterCard:   { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 20px", marginBottom: 20 },
  filterTitle:  { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 12 },
  row:          { display: "flex", gap: 20, marginBottom: 14 },
  radioLabel:   { display: "flex", alignItems: "center", fontSize: 13, fontWeight: 500, color: "#111827", cursor: "pointer" },
  selectRow:    { display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" as const },
  selectGroup:  { display: "flex", flexDirection: "column" as const, gap: 4, minWidth: 200 },
  label:        { fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.03em" },
  select:       { padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, color: "#111827", background: "#fff", outline: "none", minWidth: 200 },
  loadBtn:      { background: "#111827", color: "#fff", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  tableWrapper: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  tableHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--color-border)" },
  tableTitle:   { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  table:        { width: "100%", borderCollapse: "collapse" as const },
  th:           { padding: "10px 16px", textAlign: "left" as const, fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", background: "#f9fafb", borderBottom: "1px solid var(--color-border)" },
  td:           { padding: "12px 16px", fontSize: 13, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:      { background: "var(--color-surface)" },
  rowOdd:       { background: "#fafafa" },
  mono:         { fontFamily: "monospace", fontSize: 12, color: "var(--color-text-secondary)" },

  centerBadge:  { background: "#ede9fe", color: "#4f46e5", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600 },
  studentBadge: { background: "#dcfce7", color: "#16a34a", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600 },
  viewBtn:      { background: "none", border: "none", color: "#4f46e5", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 },

  emptyState:   { padding: "48px 16px", textAlign: "center" as const },
  emptyIcon:    { fontSize: 40, marginBottom: 12 },
  emptyText:    { fontSize: 14, color: "var(--color-text-secondary)", marginBottom: 8 },
  emptyHint:    { fontSize: 13, color: "#9ca3af" },
  linkBtn:      { background: "none", border: "none", color: "#4f46e5", cursor: "pointer", fontWeight: 600, fontSize: 13, padding: 0, textDecoration: "underline" },
};
