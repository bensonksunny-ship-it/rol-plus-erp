"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, getDoc, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getUnits,
  getStudentSyllabus,
  getStudentProgress,
} from "@/services/syllabus/syllabus.service";
import type { SyllabusUnit, StudentProgress, StudentSyllabus } from "@/types/syllabus";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TeacherInfo {
  name:      string;
  centerIds: string[];
}

interface StudentRow {
  uid:       string;
  name:      string;
  course:    string;
  centerId:  string;
  status:    string;
  pct:       number;           // 0–100 overall progress
  trackStatus: "on_track" | "behind" | "completed" | "not_started";
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function computeOverallPct(
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

  let totalItems = 0;
  let doneItems  = 0;

  units.forEach(unit => {
    const p            = progressMap[unit.id];
    const concepts     = unit.concepts?.length  ?? 0;
    const exercises    = unit.exercises?.length ?? 0;
    const total        = concepts + exercises;

    if (total === 0) {
      totalItems += 1;
      if (p?.status === "completed") doneItems += 1;
    } else {
      totalItems += total;
      doneItems  += (p?.completedConcepts?.length  ?? 0)
                  + (p?.completedExercises?.length ?? 0);
    }
  });

  return totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);
}

function trackStatus(pct: number, status: string): StudentRow["trackStatus"] {
  if (status === "inactive") return "behind";
  if (pct === 100)           return "completed";
  if (pct < 40)              return "behind";
  return "on_track";
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  const color = pct === 100 ? "#16a34a" : pct < 40 ? "#dc2626" : "#4f46e5";
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${pct}%`, background: color }} />
    </div>
  );
}

const TRACK_STYLES: Record<string, React.CSSProperties> = {
  completed:   { background: "#dcfce7", color: "#16a34a" },
  on_track:    { background: "#dbeafe", color: "#1d4ed8" },
  behind:      { background: "#fee2e2", color: "#dc2626" },
  not_started: { background: "#f3f4f6", color: "#6b7280" },
};

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  active:   { background: "#dcfce7", color: "#16a34a" },
  inactive: { background: "#f3f4f6", color: "#6b7280" },
};

function Badge({ label, styleMap, value }: { label: string; styleMap: Record<string, React.CSSProperties>; value: string }) {
  return (
    <span style={{ ...styles.badge, ...(styleMap[value] ?? { background: "#f3f4f6", color: "#6b7280" }) }}>
      {label}
    </span>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={styles.summaryCard}>
      <div style={{ ...styles.summaryAccent, background: accent }} />
      <div style={styles.summaryBody}>
        <div style={styles.summaryLabel}>{label}</div>
        <div style={{ ...styles.summaryValue, color: accent }}>{value}</div>
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TeacherDashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.TEACHER, ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <TeacherDashboardContent />
    </ProtectedRoute>
  );
}

function TeacherDashboardContent() {
  const { user }                      = useAuth();
  const [teacherInfo, setTeacherInfo] = useState<TeacherInfo | null>(null);
  const [students, setStudents]       = useState<StudentRow[]>([]);
  const [loading, setLoading]         = useState(true);

  const teacherUid = user?.uid ?? "";

  useEffect(() => {
    if (!teacherUid) return;

    async function load() {
      try {
        // 1. Fetch teacher doc for name + centerIds
        const teacherSnap = await getDoc(doc(db, "users", teacherUid));
        let centerIds: string[] = [];
        if (teacherSnap.exists()) {
          const d = teacherSnap.data();
          setTeacherInfo({
            name:      d.name ?? d.displayName ?? "—",
            centerIds: d.centerIds ?? [],
          });
          centerIds = d.centerIds ?? [];
        }

        // 2. Fetch all students (filter by teacher's centers)
        const studentsSnap = await getDocs(
          query(collection(db, "users"), where("role", "==", "student"))
        );
        const rawStudents = studentsSnap.docs
          .map(d => ({ uid: d.id, ...d.data() } as Record<string, unknown> & { uid: string }))
          .filter(s =>
            centerIds.length === 0 || centerIds.includes(s.centerId as string)
          );

        // 3. Fetch shared unit master once
        const allUnits = await getUnits();

        // 4. For each student, fetch syllabus + progress in parallel
        const rows: StudentRow[] = await Promise.all(
          rawStudents.map(async (s) => {
            const [assignment, progressList] = await Promise.all([
              getStudentSyllabus(s.uid),
              getStudentProgress(s.uid),
            ]);

            const pct   = computeOverallPct(assignment, progressList, allUnits);
            const track = trackStatus(pct, (s.status as string) ?? "active");

            return {
              uid:         s.uid,
              name:        (s.name as string)     ?? "—",
              course:      (s.course as string)   ?? "—",
              centerId:    (s.centerId as string)  ?? "—",
              status:      (s.status as string)   ?? "active",
              pct,
              trackStatus: track,
            };
          })
        );

        // Sort: behind first, then by pct asc
        rows.sort((a, b) => {
          const order: Record<string, number> = { behind: 0, not_started: 1, on_track: 2, completed: 3 };
          const diff = (order[a.trackStatus] ?? 2) - (order[b.trackStatus] ?? 2);
          return diff !== 0 ? diff : a.pct - b.pct;
        });

        setStudents(rows);
      } catch (err) {
        console.error("Failed to load teacher dashboard:", err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [teacherUid]);

  // ── Stats ───────────────────────────────────────────────────────────────────

  const total      = students.length;
  const inProgress = students.filter(s => s.trackStatus === "on_track").length;
  const completed  = students.filter(s => s.trackStatus === "completed").length;

  // ── Alerts ──────────────────────────────────────────────────────────────────

  const lowProgress = students.filter(s => s.pct < 40 && s.trackStatus !== "completed");
  const inactive    = students.filter(s => s.status === "inactive");

  if (loading) {
    return <div style={styles.stateRow}>Loading dashboard…</div>;
  }

  return (
    <div>

      {/* ── Teacher Info ──────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <h1 style={styles.heading}>Teacher Dashboard</h1>
      </div>

      {teacherInfo && (
        <div style={styles.infoCard}>
          <div style={styles.avatar}>{teacherInfo.name.charAt(0).toUpperCase()}</div>
          <div style={styles.infoBody}>
            <div style={styles.infoName}>{teacherInfo.name}</div>
            <div style={styles.infoMeta}>
              {teacherInfo.centerIds.length === 0 ? (
                <span style={styles.infoChip}>No centers assigned</span>
              ) : (
                teacherInfo.centerIds.map(id => (
                  <span key={id} style={styles.infoChip}>{id}</span>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Quick Stats ───────────────────────────────────────────────────── */}
      <div style={styles.summaryGrid}>
        <SummaryCard label="Total Students"    value={String(total)}      accent="#4f46e5" />
        <SummaryCard label="On Track"          value={String(inProgress)} accent="#1d4ed8" />
        <SummaryCard label="Completed"         value={String(completed)}  accent="#16a34a" />
        <SummaryCard label="Need Attention"    value={String(lowProgress.length)} accent="#dc2626" />
      </div>

      {/* ── Alerts ───────────────────────────────────────────────────────── */}
      {(lowProgress.length > 0 || inactive.length > 0) && (
        <div style={styles.alertsSection}>
          {lowProgress.length > 0 && (
            <div style={styles.alertCard}>
              <div style={styles.alertHeader}>
                <span style={styles.alertDot} />
                <span style={styles.alertTitle}>Low Progress (below 40%)</span>
                <span style={styles.alertCount}>{lowProgress.length}</span>
              </div>
              <div style={styles.alertList}>
                {lowProgress.map(s => (
                  <div key={s.uid} style={styles.alertRow}>
                    <span style={styles.alertName}>{s.name}</span>
                    <span style={styles.alertCourse}>{s.course}</span>
                    <div style={styles.alertBarWrap}>
                      <ProgressBar pct={s.pct} />
                    </div>
                    <span style={styles.alertPct}>{s.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {inactive.length > 0 && (
            <div style={{ ...styles.alertCard, borderColor: "#d1d5db" }}>
              <div style={styles.alertHeader}>
                <span style={{ ...styles.alertDot, background: "#6b7280" }} />
                <span style={styles.alertTitle}>Inactive Students</span>
                <span style={{ ...styles.alertCount, background: "#f3f4f6", color: "#374151" }}>
                  {inactive.length}
                </span>
              </div>
              <div style={styles.alertList}>
                {inactive.map(s => (
                  <div key={s.uid} style={styles.alertRow}>
                    <span style={styles.alertName}>{s.name}</span>
                    <span style={styles.alertCourse}>{s.course}</span>
                    <Badge label="Inactive" styleMap={STATUS_STYLES} value="inactive" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Student Overview Table ────────────────────────────────────────── */}
      <div style={styles.sectionTitle}>Student Overview</div>

      <div style={styles.tableWrapper}>
        {students.length === 0 ? (
          <div style={styles.emptyState}>No students found for your centers.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Student</th>
                <th style={styles.th}>Course</th>
                <th style={styles.th}>Center</th>
                <th style={styles.th}>Progress</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Track</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s, i) => (
                <StudentTableRow key={s.uid} student={s} index={i} />
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

// ─── Student Table Row ─────────────────────────────────────────────────────────

function StudentTableRow({ student: s, index }: { student: StudentRow; index: number }) {
  const [hover, setHover] = useState(false);

  const rowBase  = index % 2 === 0 ? styles.rowEven : styles.rowOdd;
  const rowStyle: React.CSSProperties = { ...rowBase, ...(hover ? styles.rowHover : {}) };

  const trackLabel: Record<string, string> = {
    completed:   "Completed",
    on_track:    "On Track",
    behind:      "Behind",
    not_started: "Not Started",
  };

  return (
    <tr
      style={rowStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <td style={styles.td}>
        <div style={styles.studentCell}>
          <span style={styles.studentInitial}>{s.name.charAt(0).toUpperCase()}</span>
          <span style={styles.studentName}>{s.name}</span>
        </div>
      </td>
      <td style={styles.td}>{s.course}</td>
      <td style={{ ...styles.td, ...styles.mono }}>{s.centerId}</td>
      <td style={{ ...styles.td, minWidth: 140 }}>
        <div style={styles.progressCell}>
          <ProgressBar pct={s.pct} />
          <span style={styles.pctLabel}>{s.pct}%</span>
        </div>
      </td>
      <td style={styles.td}>
        <Badge label={s.status} styleMap={STATUS_STYLES} value={s.status} />
      </td>
      <td style={styles.td}>
        <Badge
          label={trackLabel[s.trackStatus] ?? s.trackStatus}
          styleMap={TRACK_STYLES}
          value={s.trackStatus}
        />
      </td>
    </tr>
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
  stateRow: {
    padding:   "40px 0",
    textAlign: "center",
    fontSize:  13,
    color:     "var(--color-text-secondary)",
  },

  // Info card
  infoCard: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    padding:      "16px 20px",
    display:      "flex",
    alignItems:   "center",
    gap:          14,
    marginBottom: 20,
    boxShadow:    "var(--shadow-sm)",
  },
  avatar: {
    width:          44,
    height:         44,
    borderRadius:   "50%",
    background:     "#fef3c7",
    color:          "#d97706",
    fontSize:       18,
    fontWeight:     700,
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    flexShrink:     0,
  } as React.CSSProperties,
  infoBody: { flex: 1 },
  infoName: {
    fontSize:     15,
    fontWeight:   600,
    color:        "#111827",
    marginBottom: 6,
  },
  infoMeta: {
    display:  "flex",
    flexWrap: "wrap",
    gap:      6,
  },
  infoChip: {
    display:      "inline-block",
    padding:      "2px 9px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   500,
    background:   "#e0e7ff",
    color:        "#4f46e5",
    fontFamily:   "monospace",
  },

  // Summary cards
  summaryGrid: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap:                 14,
    marginBottom:        20,
  },
  summaryCard: {
    background:    "var(--color-surface)",
    border:        "1px solid var(--color-border)",
    borderRadius:  10,
    overflow:      "hidden",
    display:       "flex",
    flexDirection: "column",
    boxShadow:     "var(--shadow-sm)",
  },
  summaryAccent: { height: 4 },
  summaryBody:   { padding: "14px 18px" },
  summaryLabel: {
    fontSize:      11,
    color:         "var(--color-text-secondary)",
    fontWeight:    500,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom:  6,
  },
  summaryValue: {
    fontSize:   24,
    fontWeight: 700,
  },

  // Alerts
  alertsSection: {
    display:       "flex",
    flexDirection: "column",
    gap:           12,
    marginBottom:  24,
  },
  alertCard: {
    background:   "var(--color-surface)",
    border:       "1px solid #fecaca",
    borderRadius: 10,
    overflow:     "hidden",
  },
  alertHeader: {
    display:      "flex",
    alignItems:   "center",
    gap:          8,
    padding:      "12px 16px",
    borderBottom: "1px solid #fee2e2",
    background:   "#fff5f5",
  },
  alertDot: {
    width:        8,
    height:       8,
    borderRadius: "50%",
    background:   "#dc2626",
    flexShrink:   0,
  } as React.CSSProperties,
  alertTitle: {
    fontSize:   13,
    fontWeight: 600,
    color:      "#111827",
    flex:       1,
  },
  alertCount: {
    fontSize:     11,
    fontWeight:   700,
    background:   "#fee2e2",
    color:        "#dc2626",
    padding:      "1px 8px",
    borderRadius: 99,
  },
  alertList: {
    display:       "flex",
    flexDirection: "column",
    padding:       "8px 0",
  },
  alertRow: {
    display:    "flex",
    alignItems: "center",
    gap:        12,
    padding:    "8px 16px",
    fontSize:   13,
  },
  alertName: {
    fontWeight: 500,
    color:      "#111827",
    minWidth:   140,
    flexShrink: 0,
  },
  alertCourse: {
    color:      "#6b7280",
    fontSize:   12,
    minWidth:   100,
    flexShrink: 0,
  },
  alertBarWrap: {
    flex: 1,
  },
  alertPct: {
    fontSize:   12,
    fontWeight: 700,
    color:      "#dc2626",
    minWidth:   34,
    textAlign:  "right",
    flexShrink: 0,
  },

  // Section title
  sectionTitle: {
    fontSize:      13,
    fontWeight:    700,
    color:         "#374151",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom:  12,
  },

  // Table
  tableWrapper: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    overflow:     "hidden",
  },
  emptyState: {
    padding:   "24px",
    textAlign: "center",
    fontSize:  13,
    color:     "var(--color-text-secondary)",
  },
  table: {
    width:           "100%",
    borderCollapse:  "collapse",
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
    padding:     "12px 16px",
    fontSize:    13,
    color:       "var(--color-text-primary)",
    borderBottom:"1px solid var(--color-border)",
  },
  rowEven:  { background: "var(--color-surface)" },
  rowOdd:   { background: "#fafafa" },
  rowHover: { background: "#f0f4ff" },
  mono: {
    fontFamily: "monospace",
    fontSize:   11,
    color:      "var(--color-text-secondary)",
  },

  // Student cell
  studentCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
  },
  studentInitial: {
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
  studentName: {
    fontWeight: 500,
    color:      "#111827",
  },

  // Progress cell
  progressCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
  },
  pctLabel: {
    fontSize:   11,
    fontWeight: 700,
    color:      "#6b7280",
    flexShrink: 0,
    minWidth:   28,
    textAlign:  "right",
  },

  // Progress bar
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
    transition:   "width 0.4s ease",
  },

  // Badge
  badge: {
    display:       "inline-block",
    padding:       "2px 10px",
    borderRadius:  99,
    fontSize:      11,
    fontWeight:    600,
    textTransform: "capitalize",
  },
};
