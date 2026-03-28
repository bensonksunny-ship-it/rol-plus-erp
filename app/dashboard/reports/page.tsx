"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import {
  getUnits,
  getStudentSyllabus,
  getStudentProgress,
} from "@/services/syllabus/syllabus.service";
import { getAttendanceByStudent } from "@/services/attendance/attendance.service";
import type { SyllabusUnit, StudentProgress, StudentSyllabus } from "@/types/syllabus";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StudentReport {
  uid:            string;
  name:           string;
  course:         string;
  centerId:       string;
  progressPct:    number;
  attendanceCount:number;
  pendingFees:    number;
}

interface TeacherReport {
  uid:         string;
  name:        string;
  totalStudents: number;
  avgProgress: number;
  centerIds:   string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function computePct(
  assignment:   StudentSyllabus | null,
  progressList: StudentProgress[],
  allUnits:     SyllabusUnit[]
): number {
  const assignedIds = assignment?.unitIds ?? [];
  const units = assignedIds.length > 0
    ? allUnits.filter(u => assignedIds.includes(u.id))
    : allUnits;
  if (units.length === 0) return 0;

  const progressMap: Record<string, StudentProgress> = {};
  progressList.forEach(p => { progressMap[p.unitId] = p; });

  let totalItems = 0, doneItems = 0;
  units.forEach(unit => {
    const p        = progressMap[unit.id];
    const total    = (unit.concepts?.length ?? 0) + (unit.exercises?.length ?? 0);
    if (total === 0) { totalItems += 1; if (p?.status === "completed") doneItems += 1; }
    else {
      totalItems += total;
      doneItems  += (p?.completedConcepts?.length ?? 0) + (p?.completedExercises?.length ?? 0);
    }
  });
  return totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);
}

function escapeCsv(val: string | number): string {
  const s = String(val);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function downloadCsv(filename: string, rows: string[][]): void {
  const content = rows.map(r => r.map(escapeCsv).join(",")).join("\n");
  const blob    = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement("a");
  a.href        = url;
  a.download    = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <ReportsContent />
    </ProtectedRoute>
  );
}

function ReportsContent() {
  const [studentReports, setStudentReports] = useState<StudentReport[]>([]);
  const [teacherReports, setTeacherReports] = useState<TeacherReport[]>([]);
  const [loading, setLoading]               = useState(true);
  const [activeTab, setActiveTab]           = useState<"students" | "teachers">("students");

  useEffect(() => {
    async function load() {
      try {
        // ── Shared data ─────────────────────────────────────────────────────
        const allUnits = await getUnits();

        // ── Students ────────────────────────────────────────────────────────
        const studentsSnap = await getDocs(
          query(collection(db, "users"), where("role", "==", "student"))
        );
        const rawStudents = studentsSnap.docs.map(d => ({ uid: d.id, ...d.data() } as Record<string, unknown> & { uid: string }));

        const studentRows: StudentReport[] = await Promise.all(
          rawStudents.map(async (s) => {
            const [assignment, progressList, attendance] = await Promise.all([
              getStudentSyllabus(s.uid),
              getStudentProgress(s.uid),
              getAttendanceByStudent(s.uid).catch(() => []),
            ]);

            return {
              uid:             s.uid,
              name:            (s.name as string)           ?? "—",
              course:          (s.course as string)         ?? "—",
              centerId:        (s.centerId as string)       ?? "—",
              progressPct:     computePct(assignment, progressList, allUnits),
              attendanceCount: attendance.length,
              pendingFees:     Number(s.currentBalance ?? 0),
            };
          })
        );

        // Sort by name
        studentRows.sort((a, b) => a.name.localeCompare(b.name));
        setStudentReports(studentRows);

        // ── Teachers ────────────────────────────────────────────────────────
        const teachersSnap = await getDocs(
          query(collection(db, "users"), where("role", "==", "teacher"))
        );
        const rawTeachers = teachersSnap.docs.map(d => ({ uid: d.id, ...d.data() } as Record<string, unknown> & { uid: string }));

        const teacherRows: TeacherReport[] = await Promise.all(
          rawTeachers.map(async (t) => {
            const centerIds = (t.centerIds as string[]) ?? [];

            // Students belonging to teacher's centers
            const myStudents = rawStudents.filter(s =>
              centerIds.length === 0 || centerIds.includes(s.centerId as string)
            );

            let totalPct = 0;
            if (myStudents.length > 0) {
              const pcts = await Promise.all(
                myStudents.map(async (s) => {
                  const [assignment, progressList] = await Promise.all([
                    getStudentSyllabus(s.uid),
                    getStudentProgress(s.uid),
                  ]);
                  return computePct(assignment, progressList, allUnits);
                })
              );
              totalPct = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
            }

            return {
              uid:           t.uid,
              name:          (t.name as string) ?? (t.displayName as string) ?? "—",
              totalStudents: myStudents.length,
              avgProgress:   totalPct,
              centerIds,
            };
          })
        );

        teacherRows.sort((a, b) => a.name.localeCompare(b.name));
        setTeacherReports(teacherRows);
      } catch (err) {
        console.error("Failed to load reports:", err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  // ── Export handlers ─────────────────────────────────────────────────────────

  function exportStudentsCsv() {
    const header = ["Name", "Course", "Center ID", "Progress %", "Attendance", "Pending Fees (₹)"];
    const rows = studentReports.map(r => [
      r.name, r.course, r.centerId,
      String(r.progressPct),
      String(r.attendanceCount),
      String(r.pendingFees),
    ]);
    downloadCsv("student_report.csv", [header, ...rows]);
  }

  function exportTeachersCsv() {
    const header = ["Name", "Total Students", "Avg Progress %", "Centers"];
    const rows = teacherReports.map(r => [
      r.name,
      String(r.totalStudents),
      String(r.avgProgress),
      r.centerIds.join("; "),
    ]);
    downloadCsv("teacher_report.csv", [header, ...rows]);
  }

  return (
    <div>

      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.heading}>Reports</h1>
        <button
          onClick={activeTab === "students" ? exportStudentsCsv : exportTeachersCsv}
          disabled={loading}
          style={{ ...styles.exportBtn, opacity: loading ? 0.5 : 1 }}
        >
          ↓ Export CSV
        </button>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        <button
          onClick={() => setActiveTab("students")}
          style={{ ...styles.tab, ...(activeTab === "students" ? styles.tabActive : {}) }}
        >
          Students ({studentReports.length})
        </button>
        <button
          onClick={() => setActiveTab("teachers")}
          style={{ ...styles.tab, ...(activeTab === "teachers" ? styles.tabActive : {}) }}
        >
          Teachers ({teacherReports.length})
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div style={styles.stateRow}>Generating report…</div>
      ) : activeTab === "students" ? (
        <StudentsTable rows={studentReports} />
      ) : (
        <TeachersTable rows={teacherReports} />
      )}

    </div>
  );
}

// ─── Students Table ────────────────────────────────────────────────────────────

function StudentsTable({ rows }: { rows: StudentReport[] }) {
  if (rows.length === 0) return <div style={styles.stateRow}>No students found.</div>;

  return (
    <div style={styles.tableWrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Name</th>
            <th style={styles.th}>Course</th>
            <th style={styles.th}>Center</th>
            <th style={styles.th}>Progress</th>
            <th style={styles.th}>Attendance</th>
            <th style={styles.th}>Pending Fees</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.uid} style={i % 2 === 0 ? styles.rowEven : styles.rowOdd}>
              <td style={styles.td}>
                <div style={styles.nameCell}>
                  <span style={styles.initial}>{r.name.charAt(0).toUpperCase()}</span>
                  {r.name}
                </div>
              </td>
              <td style={styles.td}>{r.course}</td>
              <td style={{ ...styles.td, ...styles.mono }}>{r.centerId}</td>
              <td style={{ ...styles.td, minWidth: 160 }}>
                <div style={styles.progressCell}>
                  <MiniBar pct={r.progressPct} />
                  <span style={styles.pctLabel}>{r.progressPct}%</span>
                </div>
              </td>
              <td style={styles.td}>{r.attendanceCount}</td>
              <td style={styles.td}>
                <span style={{
                  ...styles.feeVal,
                  color: r.pendingFees > 0 ? "#dc2626" : "#16a34a",
                }}>
                  {r.pendingFees > 0 ? `₹${r.pendingFees.toLocaleString("en-IN")}` : "—"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Teachers Table ────────────────────────────────────────────────────────────

function TeachersTable({ rows }: { rows: TeacherReport[] }) {
  if (rows.length === 0) return <div style={styles.stateRow}>No teachers found.</div>;

  return (
    <div style={styles.tableWrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Teacher</th>
            <th style={styles.th}>Centers</th>
            <th style={styles.th}>Total Students</th>
            <th style={styles.th}>Avg Progress</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.uid} style={i % 2 === 0 ? styles.rowEven : styles.rowOdd}>
              <td style={styles.td}>
                <div style={styles.nameCell}>
                  <span style={{ ...styles.initial, background: "#fef3c7", color: "#d97706" }}>
                    {r.name.charAt(0).toUpperCase()}
                  </span>
                  {r.name}
                </div>
              </td>
              <td style={styles.td}>
                <div style={styles.chipRow}>
                  {r.centerIds.length === 0
                    ? <span style={styles.dimText}>—</span>
                    : r.centerIds.map(id => (
                      <span key={id} style={styles.chip}>{id}</span>
                    ))
                  }
                </div>
              </td>
              <td style={styles.td}>{r.totalStudents}</td>
              <td style={{ ...styles.td, minWidth: 160 }}>
                <div style={styles.progressCell}>
                  <MiniBar pct={r.avgProgress} />
                  <span style={styles.pctLabel}>{r.avgProgress}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Mini progress bar ─────────────────────────────────────────────────────────

function MiniBar({ pct }: { pct: number }) {
  const color = pct === 100 ? "#16a34a" : pct < 40 ? "#dc2626" : "#4f46e5";
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   20,
  },
  heading: {
    fontSize:   22,
    fontWeight: 600,
    color:      "var(--color-text-primary)",
  },
  exportBtn: {
    background:   "#059669",
    color:        "#fff",
    border:       "none",
    padding:      "8px 18px",
    borderRadius: 6,
    fontSize:     13,
    fontWeight:   600,
    cursor:       "pointer",
  },
  tabs: {
    display:      "flex",
    gap:          4,
    marginBottom: 16,
    borderBottom: "2px solid var(--color-border)",
    paddingBottom: 0,
  },
  tab: {
    background:   "transparent",
    border:       "none",
    borderBottom: "2px solid transparent",
    marginBottom: "-2px",
    padding:      "8px 16px",
    fontSize:     13,
    fontWeight:   600,
    color:        "var(--color-text-secondary)",
    cursor:       "pointer",
  },
  tabActive: {
    borderBottom: "2px solid #4f46e5",
    color:        "#4f46e5",
  },
  stateRow: {
    padding:   "32px 0",
    textAlign: "center",
    fontSize:  13,
    color:     "var(--color-text-secondary)",
  },
  tableWrapper: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    overflow:     "hidden",
  },
  table: {
    width:          "100%",
    borderCollapse: "collapse",
  },
  th: {
    padding:       "11px 16px",
    textAlign:     "left",
    fontSize:      12,
    fontWeight:    600,
    color:         "var(--color-text-secondary)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    borderBottom:  "1px solid var(--color-border)",
    background:    "#f9fafb",
  },
  td: {
    padding:     "11px 16px",
    fontSize:    13,
    color:       "var(--color-text-primary)",
    borderBottom:"1px solid var(--color-border)",
  },
  rowEven: { background: "var(--color-surface)" },
  rowOdd:  { background: "#fafafa" },
  nameCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
  },
  initial: {
    width:          26,
    height:         26,
    borderRadius:   "50%",
    background:     "#e0e7ff",
    color:          "#4f46e5",
    fontSize:       11,
    fontWeight:     700,
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    flexShrink:     0,
  } as React.CSSProperties,
  mono: {
    fontFamily: "monospace",
    fontSize:   11,
    color:      "var(--color-text-secondary)",
  },
  progressCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
  },
  pctLabel: {
    fontSize:   11,
    fontWeight: 700,
    color:      "#6b7280",
    minWidth:   30,
    textAlign:  "right",
    flexShrink: 0,
  },
  barTrack: {
    flex:         1,
    height:       6,
    background:   "#e5e7eb",
    borderRadius: 99,
    overflow:     "hidden",
    minWidth:     80,
  },
  barFill: {
    height:       "100%",
    borderRadius: 99,
    transition:   "width 0.3s ease",
  },
  feeVal: {
    fontWeight: 600,
    fontSize:   13,
  },
  chipRow: {
    display:  "flex",
    flexWrap: "wrap",
    gap:      4,
  },
  chip: {
    display:      "inline-block",
    padding:      "1px 7px",
    borderRadius: 99,
    fontSize:     10,
    fontWeight:   500,
    background:   "#e0e7ff",
    color:        "#4f46e5",
    fontFamily:   "monospace",
  },
  dimText: {
    color:    "#9ca3af",
    fontSize: 13,
  },
};
