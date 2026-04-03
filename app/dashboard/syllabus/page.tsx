"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
// Note: useAuth user field no longer needed (assign tab removed)
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getLessonsByCenter,
  getItemsByLesson,
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
  uid:         string;
  displayName: string;
  studentID:   string;    // ROL20260001 — preferred display ID
  admissionNo: string;    // fallback (old records may use admissionNumber)
  centerId:    string;
}

interface CenterOption {
  id:   string;
  name: string;
}

interface LessonWithCount extends Lesson {
  itemCount: number;
}

type Tab = "lessons" | "track";

// ─── Content ──────────────────────────────────────────────────────────────────

function SyllabusContent() {
  const { role }                              = useAuth();
  const router                                = useRouter();
  const [tab, setTab]                         = useState<Tab>("lessons");
  const [centers, setCenters]                 = useState<CenterOption[]>([]);
  const [students, setStudents]               = useState<StudentOption[]>([]);
  const [selectedCenter, setSelectedCenter]   = useState<string>("");
  const [lessons, setLessons]                 = useState<LessonWithCount[]>([]);
  const [loading, setLoading]                 = useState(false);
  const [initialising, setInitialising]       = useState(true);
  const { toasts, toast, remove }             = useToast();

  // Track tab state
  const [trackStudent, setTrackStudent]       = useState<string>("");

  // Load centers + students on mount
  useEffect(() => {
    async function init() {
      try {
        const [centersSnap, studentsSnap] = await Promise.all([
          getDocs(collection(db, "centers")),
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        ]);
        setCenters(centersSnap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id })));
        setStudents(studentsSnap.docs.map(d => {
          const dt = d.data();
          return {
            uid:         d.id,
            displayName: (dt.displayName as string) ?? (dt.name as string) ?? "",
            studentID:   (dt.studentID  as string) ?? "",
            admissionNo: (dt.admissionNo as string) ?? (dt.admissionNumber as string) ?? "",
            centerId:    (dt.centerId   as string) ?? "",
          };
        }));
      } catch {
        toast("Failed to load centers/students.", "error");
      } finally {
        setInitialising(false);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load lessons when center changes
  const loadLessons = useCallback(async (centerId: string) => {
    if (!centerId) { setLessons([]); return; }
    setLoading(true);
    setLessons([]);
    try {
      const data   = await getLessonsByCenter(centerId);
      const counts = await Promise.all(data.map(l => getItemsByLesson(l.id)));
      const withCounts: LessonWithCount[] = data.map((l, i) => ({
        ...l,
        itemCount: counts[i]?.length ?? 0,
      }));
      setLessons(withCounts);
      if (withCounts.length === 0) toast("No lessons found for this center.", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to load lessons: ${msg}`, "error");
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCenterChange(centerId: string) {
    setSelectedCenter(centerId);
    setLessons([]);
    loadLessons(centerId);
  }

  const isAdmin = role === "admin" || role === "super_admin";

  return (
    <div style={{ background: "#fff", minHeight: "100%", color: "#111" }}>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <h1 style={s.heading}>Syllabus</h1>
      </div>

      {/* Tabs — lessons + track only (no assign) */}
      <div style={s.tabs}>
        {(["lessons", "track"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
          >
            {t === "lessons" ? "📚 Lessons" : "📊 Track"}
          </button>
        ))}
      </div>

      {/* ─── LESSONS TAB ───────────────────────────────────────────────────── */}
      {tab === "lessons" && (
        <>
          <div style={s.filterCard}>
            <div style={s.filterTitle}>Select Center</div>
            <select
              value={selectedCenter}
              onChange={e => handleCenterChange(e.target.value)}
              style={s.select}
              disabled={initialising}
            >
              <option value="">— Select center —</option>
              {centers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {loading && <span style={s.loadingText}>Loading lessons…</span>}
            {isAdmin && selectedCenter && (
              <button
                onClick={() =>
                  router.push(`/dashboard/lessons/import?scope=center&id=${selectedCenter}`)
                }
                style={{ ...s.importBtn, marginLeft: "auto" }}
              >
                ↑ Import Syllabus
              </button>
            )}
          </div>

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
                    {["Order", "No.", "Title", "Items"].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lessons.map((lesson, i) => (
                    <tr key={lesson.id} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                      <td style={{ ...s.td, ...s.mono }}>{lesson.order}</td>
                      <td style={{ ...s.td, ...s.mono }}>{lesson.lessonNumber}</td>
                      <td style={{ ...s.td, fontWeight: 600, color: "#111" }}>{lesson.title}</td>
                      <td style={{ ...s.td, ...s.mono }}>
                        <span style={s.itemCountBadge}>{lesson.itemCount}</span>
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
              <div style={s.emptyText}>
                {selectedCenter
                  ? "No lessons found for this center."
                  : "Select a center above to view its lessons."}
              </div>
              {isAdmin && (
                <div style={s.emptyHint}>
                  No lessons yet?{" "}
                  <button
                    onClick={() =>
                      router.push(
                        selectedCenter
                          ? `/dashboard/lessons/import?scope=center&id=${selectedCenter}`
                          : "/dashboard/lessons/import"
                      )
                    }
                    style={s.linkBtn}
                  >
                    Import from Excel
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ─── TRACK TAB ───────────────────────────────────────────────────── */}
      {tab === "track" && (
        <div style={s.trackCard}>
          <div style={s.trackTitle}>Track Student Progress</div>
          <div style={s.fieldGroup}>
            <label style={s.label}>Student</label>
            <select
              value={trackStudent}
              onChange={e => setTrackStudent(e.target.value)}
              style={s.select}
              disabled={initialising}
            >
              <option value="">— Select student —</option>
              {students.map(st => (
                <option key={st.uid} value={st.uid}>
                  {st.studentID ? `[${st.studentID}] ` : (st.admissionNo ? `[${st.admissionNo}] ` : "")}{st.displayName || st.uid}
                  {st.centerId ? ` · ${centers.find(c => c.id === st.centerId)?.name ?? st.centerId}` : ""}
                </option>
              ))}
            </select>
          </div>
          {trackStudent ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <button
                onClick={() => router.push(`/dashboard/student-syllabus/${trackStudent}`)}
                style={s.viewProgressBtn}
              >
                View Full Syllabus Progress →
              </button>
              {isAdmin && (
                <button
                  onClick={() =>
                    router.push(`/dashboard/lessons/import?scope=student&id=${trackStudent}`)
                  }
                  style={s.importBtn}
                >
                  ↑ Import Custom Lessons
                </button>
              )}
            </div>
          ) : (
            <div style={s.emptyInline}>Select a student above to view their progress.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Styles (light-background safe — explicit hex only) ───────────────────────

const s: Record<string, React.CSSProperties> = {
  // Header
  header:    { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  heading:   { fontSize: 24, fontWeight: 700, color: "#111", margin: 0 },
  importBtn: {
    background:   "#4f46e5",
    color:        "#fff",
    border:       "none",
    padding:      "9px 18px",
    borderRadius: 8,
    fontSize:     13,
    fontWeight:   700,
    cursor:       "pointer",
  },

  // Tabs
  tabs: {
    display:       "flex",
    gap:           4,
    marginBottom:  20,
    background:    "#f3f4f6",
    borderRadius:  12,
    padding:       4,
    border:        "1px solid #e5e7eb",
  },
  tab: {
    flex:         1,
    padding:      "9px 0",
    borderRadius: 8,
    border:       "none",
    background:   "transparent",
    fontSize:     13,
    fontWeight:   500,
    color:        "#6b7280",
    cursor:       "pointer",
    textAlign:    "center" as const,
  },
  tabActive: {
    background: "#fff",
    color:      "#4f46e5",
    fontWeight: 700,
    boxShadow:  "0 1px 4px rgba(0,0,0,0.10)",
  },

  // Filter card (lessons tab)
  filterCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "16px 20px",
    marginBottom: 16,
    display:      "flex",
    alignItems:   "center",
    gap:          14,
    flexWrap:     "wrap" as const,
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  filterTitle: { fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.1em" },
  loadingText: { fontSize: 12, color: "#9ca3af", fontStyle: "italic" as const },

  select: {
    padding:      "9px 12px",
    border:       "1px solid #d1d5db",
    borderRadius: 8,
    fontSize:     13,
    color:        "#111",
    background:   "#fff",
    outline:      "none",
    minWidth:     200,
    cursor:       "pointer",
  },

  // Table
  tableWrapper: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    overflow:     "hidden",
    marginBottom: 16,
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  tableHeader: {
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "space-between",
    padding:         "14px 18px",
    borderBottom:    "1px solid #e5e7eb",
    background:      "#f9fafb",
  },
  tableTitle:  { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  table:       { width: "100%", borderCollapse: "collapse" as const },
  th: {
    padding:       "10px 18px",
    textAlign:     "left" as const,
    fontSize:      11,
    fontWeight:    600,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background:    "#f9fafb",
    borderBottom:  "1px solid #e5e7eb",
  },
  td: {
    padding:      "13px 18px",
    fontSize:     13,
    color:        "#111",
    borderBottom: "1px solid #f3f4f6",
  },
  rowEven:  { background: "#fff" },
  rowOdd:   { background: "#fafafa" },
  mono:     { fontFamily: "monospace", fontSize: 12, color: "#6b7280" },
  centerBadge: {
    background:   "#ede9fe",
    color:        "#6d28d9",
    padding:      "2px 10px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   700,
  },
  itemCountBadge: {
    background:   "#fef3c7",
    color:        "#92400e",
    padding:      "2px 8px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   700,
    fontFamily:   "monospace",
  },

  // Empty states
  emptyState:  { padding: "56px 16px", textAlign: "center" as const },
  emptyIcon:   { fontSize: 44, marginBottom: 14 },
  emptyText:   { fontSize: 14, color: "#374151", marginBottom: 8 },
  emptyHint:   { fontSize: 13, color: "#6b7280" },
  linkBtn: {
    background:     "none",
    border:         "none",
    color:          "#4f46e5",
    cursor:         "pointer",
    fontWeight:     700,
    fontSize:       13,
    padding:        0,
    textDecoration: "underline",
  },
  emptyInline: { padding: "16px 0", fontSize: 13, color: "#6b7280" },

  // Assign tab
  assignCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "22px",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  assignTitle: { fontSize: 15, fontWeight: 700, color: "#111", marginBottom: 18 },
  assignRow:   { display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" as const },
  fieldGroup:  { marginBottom: 18 },
  label: {
    display:       "block",
    fontSize:      11,
    fontWeight:    600,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    marginBottom:  7,
  },
  assignedTag: {
    marginTop:   7,
    fontSize:    12,
    color:       "#16a34a",
    fontWeight:  600,
    display:     "inline-flex",
    alignItems:  "center",
    gap:         5,
  },

  lessonSelectHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  lessonSelectTitle:  { fontSize: 12, fontWeight: 600, color: "#374151" },
  bulkActions:  { display: "flex", gap: 10 },
  bulkBtn: {
    background:   "none",
    border:       "1px solid #d1d5db",
    color:        "#4f46e5",
    fontSize:     11,
    fontWeight:   700,
    cursor:       "pointer",
    padding:      "3px 10px",
    borderRadius: 6,
  },

  checkList: {
    display:        "flex",
    flexDirection:  "column" as const,
    gap:            4,
    marginBottom:   18,
    maxHeight:      320,
    overflowY:      "auto" as const,
    padding:        "4px 0",
  },
  checkItem: {
    display:     "flex",
    alignItems:  "center",
    cursor:      "pointer",
    padding:     "8px 10px",
    borderRadius: 8,
    border:      "1px solid transparent",
  },
  checkItemActive: {
    background:  "#ede9fe",
    borderColor: "#c4b5fd",
  },
  checkOrder: { fontSize: 11, fontWeight: 700, color: "#9ca3af", fontFamily: "monospace", minWidth: 30 },
  checkLabel: { fontSize: 13, fontWeight: 500, color: "#111", flex: 1 },
  checkMeta:  { fontSize: 11, color: "#6b7280" },

  assignBtn: {
    background:    "#4f46e5",
    color:         "#fff",
    border:        "none",
    padding:       "11px 28px",
    borderRadius:  8,
    fontSize:      14,
    fontWeight:    700,
    cursor:        "pointer",
    letterSpacing: "0.02em",
  },

  // Track tab
  trackCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "22px",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  trackTitle:  { fontSize: 15, fontWeight: 700, color: "#111", marginBottom: 18 },
  viewProgressBtn: {
    background:   "#059669",
    color:        "#fff",
    border:       "none",
    padding:      "11px 24px",
    borderRadius: 8,
    fontSize:     13,
    fontWeight:   700,
    cursor:       "pointer",
    marginTop:    10,
  },
};
