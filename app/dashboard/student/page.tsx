"use client";

import { useState, useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getUnits,
  getStudentSyllabus,
  getStudentProgress,
} from "@/services/syllabus/syllabus.service";
import type { SyllabusUnit, StudentProgress } from "@/types/syllabus";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StudentInfo {
  name:     string;
  course:   string;
  centerId: string;
}

interface UnitWithProgress {
  unit:     SyllabusUnit;
  progress: StudentProgress | null;
  pct:      number;   // 0–100 computed from concepts + exercises
}

// ─── Status config ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  completed:   { background: "#dcfce7", color: "#16a34a" },
  in_progress: { background: "#fef9c3", color: "#b45309" },
  not_started: { background: "#f3f4f6", color: "#6b7280" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function unitPercent(unit: SyllabusUnit, progress: StudentProgress | null): number {
  const totalConcepts   = unit.concepts?.length   ?? 0;
  const totalExercises  = unit.exercises?.length  ?? 0;
  const total           = totalConcepts + totalExercises;
  if (total === 0) {
    return progress?.status === "completed" ? 100 : 0;
  }
  const doneConcepts  = progress?.completedConcepts?.length  ?? 0;
  const doneExercises = progress?.completedExercises?.length ?? 0;
  return Math.round(((doneConcepts + doneExercises) / total) * 100);
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ ...styles.badge, ...(STATUS_STYLES[status] ?? STATUS_STYLES.not_started) }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ProgressBar({ pct, color = "#4f46e5" }: { pct: number; color?: string }) {
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── Gamification helpers ───────────────────────────────────────────────────────

const LEVEL_THRESHOLDS = [
  { label: "Beginner",     min: 0,   max: 199,  color: "#6b7280", bg: "#f3f4f6" },
  { label: "Intermediate", min: 200, max: 499,  color: "#1d4ed8", bg: "#dbeafe" },
  { label: "Advanced",     min: 500, max: Infinity, color: "#7c3aed", bg: "#ede9fe" },
] as const;

function getLevel(points: number) {
  return LEVEL_THRESHOLDS.find(l => points >= l.min && points <= l.max)
    ?? LEVEL_THRESHOLDS[0];
}

function nextLevelPct(points: number): { label: string; pct: number; needed: number } {
  if (points >= 500) return { label: "Max level", pct: 100, needed: 0 };
  if (points >= 200) {
    const pct = Math.round(((points - 200) / 300) * 100);
    return { label: "Advanced", pct, needed: 500 - points };
  }
  const pct = Math.round((points / 200) * 100);
  return { label: "Intermediate", pct, needed: 200 - points };
}

interface BadgeDef {
  id:    string;
  label: string;
  icon:  string;
  color: string;
  bg:    string;
  earned:(completedCount: number, totalCount: number) => boolean;
}

const BADGES: BadgeDef[] = [
  {
    id:     "first_unit",
    label:  "First Unit",
    icon:   "🎯",
    color:  "#1d4ed8",
    bg:     "#dbeafe",
    earned: (c) => c >= 1,
  },
  {
    id:     "five_units",
    label:  "5 Units Done",
    icon:   "⭐",
    color:  "#d97706",
    bg:     "#fef3c7",
    earned: (c) => c >= 5,
  },
  {
    id:     "all_units",
    label:  "All Complete",
    icon:   "🏆",
    color:  "#16a34a",
    bg:     "#dcfce7",
    earned: (c, t) => t > 0 && c >= t,
  },
];

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StudentDashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.STUDENT, ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <StudentDashboardContent />
    </ProtectedRoute>
  );
}

function StudentDashboardContent() {
  const { user }                        = useAuth();
  const [info, setInfo]                 = useState<StudentInfo | null>(null);
  const [units, setUnits]               = useState<UnitWithProgress[]>([]);
  const [loading, setLoading]           = useState(true);

  const studentUid = user?.uid ?? "";

  useEffect(() => {
    if (!studentUid) return;

    async function load() {
      try {
        // Parallel fetch: user doc + syllabus data
        const [userSnap, assignment, allUnits, allProgress] = await Promise.all([
          getDoc(doc(db, "users", studentUid)),
          getStudentSyllabus(studentUid),
          getUnits(),
          getStudentProgress(studentUid),
        ]);

        // Student info
        if (userSnap.exists()) {
          const d = userSnap.data();
          setInfo({
            name:     d.name     ?? "—",
            course:   d.course   ?? "—",
            centerId: d.centerId ?? "—",
          });
        }

        // Build progress map
        const progressMap: Record<string, StudentProgress> = {};
        allProgress.forEach(p => { progressMap[p.unitId] = p; });

        // Filter to assigned units
        const assignedIds = assignment?.unitIds ?? [];
        const filtered = assignedIds.length > 0
          ? allUnits.filter(u => assignedIds.includes(u.id))
          : allUnits;

        const rows: UnitWithProgress[] = filtered.map(unit => {
          const progress = progressMap[unit.id] ?? null;
          return { unit, progress, pct: unitPercent(unit, progress) };
        });

        setUnits(rows);
      } catch (err) {
        console.error("Failed to load student dashboard:", err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [studentUid]);

  // ── Summary stats ──────────────────────────────────────────────────────────

  const totalUnits     = units.length;
  const completedUnits = units.filter(u => u.progress?.status === "completed").length;
  const overallPct     = totalUnits === 0 ? 0 : Math.round((completedUnits / totalUnits) * 100);

  // ── Gamification ───────────────────────────────────────────────────────────

  const totalPoints = units.reduce((sum, u) => sum + (u.progress?.points ?? 0), 0);
  const level       = getLevel(totalPoints);
  const levelProg   = nextLevelPct(totalPoints);
  const earnedBadges = BADGES.filter(b => b.earned(completedUnits, totalUnits));

  // ── Pending items ──────────────────────────────────────────────────────────

  const nextUnit = units.find(u => u.progress?.status !== "completed") ?? null;

  const incompleteConcepts: { unitTitle: string; concept: string }[] = [];
  const incompleteExercises: { unitTitle: string; exercise: string }[] = [];

  if (nextUnit) {
    const done = nextUnit.progress;
    const doneConcepts  = done?.completedConcepts  ?? [];
    const doneExercises = done?.completedExercises ?? [];
    (nextUnit.unit.concepts  ?? []).forEach(c => { if (!doneConcepts.includes(c))  incompleteConcepts.push({ unitTitle: nextUnit.unit.title, concept: c }); });
    (nextUnit.unit.exercises ?? []).forEach(e => { if (!doneExercises.includes(e)) incompleteExercises.push({ unitTitle: nextUnit.unit.title, exercise: e }); });
  }

  if (loading) {
    return <div style={styles.stateRow}>Loading dashboard…</div>;
  }

  return (
    <div>

      {/* ── Student Info ──────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <h1 style={styles.heading}>My Dashboard</h1>
      </div>

      {info && (
        <div style={styles.infoCard}>
          <div style={styles.avatar}>{info.name.charAt(0).toUpperCase()}</div>
          <div style={styles.infoBody}>
            <div style={styles.infoName}>{info.name}</div>
            <div style={styles.infoMeta}>
              <span style={styles.infoTag}>
                <span style={styles.infoTagLabel}>Course</span>
                {info.course}
              </span>
              <span style={styles.infoDot}>·</span>
              <span style={styles.infoTag}>
                <span style={styles.infoTagLabel}>Center</span>
                <span style={styles.mono}>{info.centerId}</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Progress Summary ──────────────────────────────────────────────── */}
      <div style={styles.summaryGrid}>
        <SummaryCard label="Total Units"     value={String(totalUnits)}     accent="#4f46e5" />
        <SummaryCard label="Completed"       value={String(completedUnits)} accent="#16a34a" />
        <SummaryCard label="Overall Progress" value={`${overallPct}%`}      accent="#d97706" />
      </div>

      {/* Overall progress bar */}
      <div style={styles.overallBarWrapper}>
        <div style={styles.overallBarLabel}>
          <span>Overall Progress</span>
          <span style={styles.overallBarPct}>{overallPct}%</span>
        </div>
        <ProgressBar
          pct={overallPct}
          color={overallPct === 100 ? "#16a34a" : "#4f46e5"}
        />
      </div>

      {/* ── Gamification Panel ───────────────────────────────────────────── */}
      <div style={styles.sectionTitle}>Progress &amp; Achievements</div>
      <div style={gStyles.panel}>

        {/* Level + points */}
        <div style={gStyles.levelBlock}>
          <div style={gStyles.levelHeader}>
            <div>
              <span style={{ ...gStyles.levelBadge, background: level.bg, color: level.color }}>
                {level.label}
              </span>
              <span style={gStyles.pointsCount}>{totalPoints} pts</span>
            </div>
            {levelProg.needed > 0 && (
              <span style={gStyles.nextLabel}>
                {levelProg.needed} pts to {levelProg.label}
              </span>
            )}
          </div>
          <div style={gStyles.levelBarTrack}>
            <div style={{
              ...gStyles.levelBarFill,
              width:      `${levelProg.pct}%`,
              background: level.color,
            }} />
          </div>
        </div>

        {/* Badges */}
        <div style={gStyles.badgesRow}>
          {BADGES.map(badge => {
            const earned = earnedBadges.some(b => b.id === badge.id);
            return (
              <div key={badge.id} style={{
                ...gStyles.badgeCard,
                background: earned ? badge.bg    : "#f9fafb",
                borderColor:earned ? badge.color : "#e5e7eb",
                opacity:    earned ? 1           : 0.45,
              }}>
                <span style={gStyles.badgeIcon}>{badge.icon}</span>
                <span style={{ ...gStyles.badgeLabel, color: earned ? badge.color : "#9ca3af" }}>
                  {badge.label}
                </span>
                {earned && <span style={gStyles.earnedMark}>✓</span>}
              </div>
            );
          })}
        </div>

      </div>

      {/* ── Syllabus Progress ─────────────────────────────────────────────── */}
      <div style={styles.sectionTitle}>Syllabus Progress</div>

      {units.length === 0 ? (
        <div style={styles.emptyState}>No syllabus assigned. Contact your teacher.</div>
      ) : (
        <div style={styles.unitList}>
          {units.map(({ unit, progress, pct }, idx) => {
            const status    = progress?.status ?? "not_started";
            const doneConcepts  = progress?.completedConcepts  ?? [];
            const doneExercises = progress?.completedExercises ?? [];
            const totalItems = (unit.concepts?.length ?? 0) + (unit.exercises?.length ?? 0);
            const doneItems  = doneConcepts.length + doneExercises.length;

            return (
              <div key={unit.id} style={styles.unitCard}>
                <div style={styles.unitHeader}>
                  <div style={styles.unitLeft}>
                    <span style={styles.unitIndex}>{idx + 1}</span>
                    <div>
                      <div style={styles.unitTitle}>{unit.title}</div>
                      <div style={styles.unitLevel}>{unit.level}</div>
                    </div>
                  </div>
                  <div style={styles.unitRight}>
                    <StatusBadge status={status} />
                    <span style={styles.unitPct}>{pct}%</span>
                  </div>
                </div>

                {/* Progress bar */}
                <div style={styles.unitBarRow}>
                  <ProgressBar
                    pct={pct}
                    color={status === "completed" ? "#16a34a" : status === "in_progress" ? "#f59e0b" : "#e5e7eb"}
                  />
                  {totalItems > 0 && (
                    <span style={styles.unitItemCount}>{doneItems}/{totalItems} items</span>
                  )}
                </div>

                {/* Concept + exercise chips */}
                {(unit.concepts?.length > 0 || unit.exercises?.length > 0) && (
                  <div style={styles.chipsRow}>
                    {unit.concepts?.map(c => (
                      <span key={c} style={{
                        ...styles.chip,
                        ...(doneConcepts.includes(c)
                          ? styles.chipDone
                          : styles.chipTodo),
                      }}>
                        {doneConcepts.includes(c) ? "✓ " : ""}{c}
                      </span>
                    ))}
                    {unit.exercises?.map(e => (
                      <span key={e} style={{
                        ...styles.chip,
                        ...(doneExercises.includes(e)
                          ? styles.chipExDone
                          : styles.chipExTodo),
                      }}>
                        {doneExercises.includes(e) ? "✓ " : ""}{e}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Pending Items ─────────────────────────────────────────────────── */}
      {nextUnit && (
        <>
          <div style={styles.sectionTitle}>Pending Items</div>
          <div style={styles.pendingCard}>
            <div style={styles.pendingNext}>
              <span style={styles.pendingLabel}>Next Unit</span>
              <span style={styles.pendingUnitName}>{nextUnit.unit.title}</span>
              <StatusBadge status={nextUnit.progress?.status ?? "not_started"} />
            </div>

            {(incompleteConcepts.length > 0 || incompleteExercises.length > 0) && (
              <div style={styles.pendingBody}>
                {incompleteConcepts.length > 0 && (
                  <div style={styles.pendingGroup}>
                    <div style={styles.pendingGroupLabel}>Concepts to complete</div>
                    <div style={styles.pendingList}>
                      {incompleteConcepts.map(({ concept }) => (
                        <span key={concept} style={styles.pendingItem}>{concept}</span>
                      ))}
                    </div>
                  </div>
                )}
                {incompleteExercises.length > 0 && (
                  <div style={styles.pendingGroup}>
                    <div style={styles.pendingGroupLabel}>Exercises to complete</div>
                    <div style={styles.pendingList}>
                      {incompleteExercises.map(({ exercise }) => (
                        <span key={exercise} style={{ ...styles.pendingItem, ...styles.pendingItemEx }}>{exercise}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {incompleteConcepts.length === 0 && incompleteExercises.length === 0 && (
              <div style={styles.pendingEmpty}>All items checked — mark the unit complete in your syllabus.</div>
            )}
          </div>
        </>
      )}

      {/* All done */}
      {units.length > 0 && completedUnits === totalUnits && (
        <div style={styles.allDone}>
          🎉 All units completed!
        </div>
      )}

    </div>
  );
}

// ─── Summary Card ──────────────────────────────────────────────────────────────

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

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {

  // Layout
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
    padding:      "18px 20px",
    display:      "flex",
    alignItems:   "center",
    gap:          16,
    marginBottom: 20,
    boxShadow:    "var(--shadow-sm)",
  },
  avatar: {
    width:           44,
    height:          44,
    borderRadius:    "50%",
    background:      "#e0e7ff",
    color:           "#4f46e5",
    fontSize:        18,
    fontWeight:      700,
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
  } as React.CSSProperties,
  infoBody: {
    flex: 1,
  },
  infoName: {
    fontSize:   16,
    fontWeight: 600,
    color:      "#111827",
    marginBottom: 4,
  },
  infoMeta: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    fontSize:   12,
    color:      "#6b7280",
  },
  infoTag: {
    display:    "flex",
    alignItems: "center",
    gap:        4,
  },
  infoTagLabel: {
    fontWeight:    600,
    color:         "#9ca3af",
    textTransform: "uppercase",
    fontSize:      10,
    letterSpacing: "0.05em",
  },
  infoDot: {
    color: "#d1d5db",
  },
  mono: {
    fontFamily: "monospace",
    fontSize:   11,
    color:      "#6b7280",
  },

  // Summary cards
  summaryGrid: {
    display:              "grid",
    gridTemplateColumns:  "repeat(auto-fit, minmax(160px, 1fr))",
    gap:                  14,
    marginBottom:         20,
  },
  summaryCard: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    overflow:     "hidden",
    display:      "flex",
    flexDirection:"column",
    boxShadow:    "var(--shadow-sm)",
  },
  summaryAccent: {
    height: 4,
  },
  summaryBody: {
    padding: "14px 18px",
  },
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

  // Overall bar
  overallBarWrapper: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    padding:      "14px 18px",
    marginBottom: 28,
  },
  overallBarLabel: {
    display:        "flex",
    justifyContent: "space-between",
    fontSize:       12,
    fontWeight:     600,
    color:          "#374151",
    marginBottom:   8,
  },
  overallBarPct: {
    color: "#4f46e5",
  },

  // Progress bar
  barTrack: {
    height:       8,
    background:   "#e5e7eb",
    borderRadius: 99,
    overflow:     "hidden",
  },
  barFill: {
    height:       "100%",
    borderRadius: 99,
    transition:   "width 0.4s ease",
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

  // Unit list
  unitList: {
    display:       "flex",
    flexDirection: "column",
    gap:           12,
    marginBottom:  28,
  },
  unitCard: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    overflow:     "hidden",
  },
  unitHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "14px 18px 10px",
  },
  unitLeft: {
    display:    "flex",
    alignItems: "center",
    gap:        10,
  },
  unitIndex: {
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
  unitTitle: {
    fontSize:   13,
    fontWeight: 600,
    color:      "#111827",
  },
  unitLevel: {
    fontSize: 11,
    color:    "#9ca3af",
    marginTop: 1,
  },
  unitRight: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
  },
  unitPct: {
    fontSize:   12,
    fontWeight: 700,
    color:      "#4f46e5",
    minWidth:   34,
    textAlign:  "right",
  },
  unitBarRow: {
    display:    "flex",
    alignItems: "center",
    gap:        10,
    padding:    "0 18px 12px",
  },
  unitItemCount: {
    fontSize:  11,
    color:     "#9ca3af",
    flexShrink: 0,
  },
  chipsRow: {
    display:    "flex",
    flexWrap:   "wrap",
    gap:        6,
    padding:    "0 18px 14px",
  },
  chip: {
    display:      "inline-block",
    padding:      "2px 9px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   500,
  },
  chipDone: {
    background: "#dcfce7",
    color:      "#15803d",
  },
  chipTodo: {
    background: "#f3f4f6",
    color:      "#6b7280",
  },
  chipExDone: {
    background: "#dbeafe",
    color:      "#1d4ed8",
  },
  chipExTodo: {
    background: "#fef9c3",
    color:      "#b45309",
  },

  // Pending
  pendingCard: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    overflow:     "hidden",
    marginBottom: 24,
  },
  pendingNext: {
    display:      "flex",
    alignItems:   "center",
    gap:          10,
    padding:      "14px 18px",
    borderBottom: "1px solid var(--color-border)",
    background:   "#f9fafb",
  },
  pendingLabel: {
    fontSize:      10,
    fontWeight:    700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color:         "#9ca3af",
    flexShrink:    0,
  },
  pendingUnitName: {
    fontSize:   13,
    fontWeight: 600,
    color:      "#111827",
    flex:       1,
  },
  pendingBody: {
    padding: "14px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  pendingGroup: {
    display:       "flex",
    flexDirection: "column",
    gap:           8,
  },
  pendingGroupLabel: {
    fontSize:      11,
    fontWeight:    600,
    color:         "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  pendingList: {
    display:  "flex",
    flexWrap: "wrap",
    gap:      6,
  },
  pendingItem: {
    display:      "inline-block",
    padding:      "3px 10px",
    borderRadius: 6,
    fontSize:     12,
    fontWeight:   500,
    background:   "#fff1f2",
    color:        "#dc2626",
    border:       "1px solid #fecaca",
  },
  pendingItemEx: {
    background: "#fef9c3",
    color:      "#b45309",
    border:     "1px solid #fde68a",
  },
  pendingEmpty: {
    padding:  "14px 18px",
    fontSize: 12,
    color:    "#6b7280",
  },

  // All done
  allDone: {
    textAlign:    "center",
    padding:      "20px",
    fontSize:     16,
    fontWeight:   600,
    color:        "#16a34a",
    background:   "#f0fdf4",
    border:       "1px solid #bbf7d0",
    borderRadius: 10,
  },

  // Badge
  badge: {
    display:      "inline-block",
    padding:      "2px 10px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   600,
    textTransform:"capitalize",
  },

  // Empty
  emptyState: {
    padding:      "24px",
    textAlign:    "center",
    fontSize:     13,
    color:        "var(--color-text-secondary)",
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    marginBottom: 24,
  },
};

// ─── Gamification Styles ───────────────────────────────────────────────────────

const gStyles: Record<string, React.CSSProperties> = {
  panel: {
    background:   "var(--color-surface)",
    border:       "1px solid var(--color-border)",
    borderRadius: 10,
    overflow:     "hidden",
    marginBottom: 28,
  },
  levelBlock: {
    padding:      "16px 20px",
    borderBottom: "1px solid var(--color-border)",
  },
  levelHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   10,
  },
  levelBadge: {
    display:      "inline-block",
    padding:      "3px 12px",
    borderRadius: 99,
    fontSize:     12,
    fontWeight:   700,
    marginRight:  10,
  },
  pointsCount: {
    fontSize:   18,
    fontWeight: 700,
    color:      "#111827",
  },
  nextLabel: {
    fontSize: 11,
    color:    "#9ca3af",
  },
  levelBarTrack: {
    height:       10,
    background:   "#e5e7eb",
    borderRadius: 99,
    overflow:     "hidden",
  },
  levelBarFill: {
    height:       "100%",
    borderRadius: 99,
    transition:   "width 0.5s ease",
  },
  badgesRow: {
    display:   "flex",
    flexWrap:  "wrap",
    gap:       12,
    padding:   "16px 20px",
  },
  badgeCard: {
    display:      "flex",
    alignItems:   "center",
    gap:          6,
    padding:      "8px 14px",
    borderRadius: 8,
    border:       "1px solid",
    flexShrink:   0,
  },
  badgeIcon: {
    fontSize:   18,
    lineHeight: 1,
  },
  badgeLabel: {
    fontSize:   12,
    fontWeight: 600,
  },
  earnedMark: {
    fontSize:   10,
    fontWeight: 700,
    color:      "#16a34a",
    marginLeft: 2,
  },
};
