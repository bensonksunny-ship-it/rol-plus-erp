"use client";

import { useState, useEffect } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getUnits,
  getStudentSyllabus,
  getStudentProgress,
  updateProgress,
  toggleConcept,
  toggleExercise,
} from "@/services/syllabus/syllabus.service";
import type { SyllabusUnit, StudentProgress } from "@/types/syllabus";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";

// ─── Status helpers ────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  completed:   { background: "#dcfce7", color: "#16a34a" },
  in_progress: { background: "#fef9c3", color: "#b45309" },
  not_started: { background: "#f3f4f6", color: "#6b7280" },
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ ...styles.badge, ...(STATUS_STYLES[status] ?? STATUS_STYLES.not_started) }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SyllabusPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT]}>
      <SyllabusContent />
    </ProtectedRoute>
  );
}

function SyllabusContent() {
  const { user } = useAuth();

  const [units, setUnits]           = useState<SyllabusUnit[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, StudentProgress>>({});
  const [loading, setLoading]       = useState(true);
  const [toggling, setToggling]     = useState<Record<string, boolean>>({});
  const { toasts, toast, remove }   = useToast();

  const studentUid = user?.uid ?? "";

  async function loadData() {
    if (!studentUid) return;
    try {
      const [assignment, allUnits, allProgress] = await Promise.all([
        getStudentSyllabus(studentUid),
        getUnits(),
        getStudentProgress(studentUid),
      ]);

      // Filter to assigned units only; fall back to all units if no assignment
      const assignedIds = assignment?.unitIds ?? [];
      const filtered = assignedIds.length > 0
        ? allUnits.filter(u => assignedIds.includes(u.id))
        : allUnits;

      setUnits(filtered);

      // Build progress map keyed by unitId
      const map: Record<string, StudentProgress> = {};
      allProgress.forEach(p => { map[p.unitId] = p; });
      setProgressMap(map);
    } catch (err) {
      console.error("Failed to load syllabus:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [studentUid]);

  // ── Toggle concept ──────────────────────────────────────────────────────────

  async function handleToggleConcept(unit: SyllabusUnit, concept: string) {
    const key = `concept_${unit.id}_${concept}`;
    if (toggling[key]) return;
    const progress = progressMap[unit.id];
    const alreadyDone = progress?.completedConcepts?.includes(concept) ?? false;

    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      await toggleConcept(studentUid, unit.id, concept, !alreadyDone);

      // Optimistic local update
      setProgressMap(prev => {
        const existing = prev[unit.id] ?? emptyProgress(studentUid, unit.id);
        const updated  = { ...existing };
        const set      = new Set(updated.completedConcepts ?? []);
        alreadyDone ? set.delete(concept) : set.add(concept);
        updated.completedConcepts = Array.from(set);

        // Auto-advance status to in_progress when first item is checked
        if (updated.status === "not_started" && (set.size > 0 || (updated.completedExercises?.length ?? 0) > 0)) {
          updated.status = "in_progress";
          triggerStatusUpdate(unit, updated, "in_progress");
        }
        return { ...prev, [unit.id]: updated };
      });
    } catch (err) {
      console.error("Failed to toggle concept:", err);
      toast("Failed to update concept.", "error");
    } finally {
      setToggling(prev => ({ ...prev, [key]: false }));
    }
  }

  // ── Toggle exercise ─────────────────────────────────────────────────────────

  async function handleToggleExercise(unit: SyllabusUnit, exercise: string) {
    const key = `exercise_${unit.id}_${exercise}`;
    if (toggling[key]) return;
    const progress = progressMap[unit.id];
    const alreadyDone = progress?.completedExercises?.includes(exercise) ?? false;

    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      await toggleExercise(studentUid, unit.id, exercise, !alreadyDone);

      setProgressMap(prev => {
        const existing = prev[unit.id] ?? emptyProgress(studentUid, unit.id);
        const updated  = { ...existing };
        const set      = new Set(updated.completedExercises ?? []);
        alreadyDone ? set.delete(exercise) : set.add(exercise);
        updated.completedExercises = Array.from(set);

        if (updated.status === "not_started" && (set.size > 0 || (updated.completedConcepts?.length ?? 0) > 0)) {
          updated.status = "in_progress";
          triggerStatusUpdate(unit, updated, "in_progress");
        }
        return { ...prev, [unit.id]: updated };
      });
    } catch (err) {
      console.error("Failed to toggle exercise:", err);
      toast("Failed to update exercise.", "error");
    } finally {
      setToggling(prev => ({ ...prev, [key]: false }));
    }
  }

  // ── Mark unit status ────────────────────────────────────────────────────────

  async function handleMarkStatus(unit: SyllabusUnit, status: "in_progress" | "completed") {
    const key = `status_${unit.id}`;
    if (toggling[key]) return;
    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      const result = await updateProgress(studentUid, unit.id, {
        status,
        teacherSignOff: null,
        feedback:       null,
        overrideBy:     null,
      });
      setProgressMap(prev => ({ ...prev, [unit.id]: result }));
      toast(
        status === "completed" ? "Unit marked as completed." : "Unit marked as in progress.",
        "success"
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ORDER_VIOLATION")) {
        toast("Complete the prerequisite unit first.", "error");
      } else {
        toast("Failed to update status.", "error");
      }
    } finally {
      setToggling(prev => ({ ...prev, [key]: false }));
    }
  }

  // Non-blocking background status push (used from toggleConcept/Exercise)
  function triggerStatusUpdate(unit: SyllabusUnit, _progress: StudentProgress, status: "in_progress") {
    updateProgress(studentUid, unit.id, {
      status,
      teacherSignOff: null,
      feedback:       null,
      overrideBy:     null,
    }).catch(() => {/* silent — optimistic update already applied */});
  }

  if (loading) {
    return (
      <div style={styles.stateRow}>Loading syllabus…</div>
    );
  }

  if (units.length === 0) {
    return (
      <div>
        <h1 style={styles.heading}>My Syllabus</h1>
        <div style={styles.stateRow}>No syllabus assigned yet. Contact your admin.</div>
      </div>
    );
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      <div style={styles.header}>
        <h1 style={styles.heading}>My Syllabus</h1>
        <span style={styles.unitCount}>{units.length} unit{units.length !== 1 ? "s" : ""}</span>
      </div>

      <div style={styles.unitList}>
        {units.map((unit, idx) => {
          const progress  = progressMap[unit.id];
          const status    = progress?.status ?? "not_started";
          const doneConcepts   = progress?.completedConcepts  ?? [];
          const doneExercises  = progress?.completedExercises ?? [];
          const statusKey = `status_${unit.id}`;
          const isUpdating = !!toggling[statusKey];

          return (
            <div key={unit.id} style={styles.unitCard}>
              {/* Unit header */}
              <div style={styles.unitHeader}>
                <div style={styles.unitMeta}>
                  <span style={styles.unitOrder}>{idx + 1}</span>
                  <div>
                    <div style={styles.unitTitle}>{unit.title}</div>
                    <div style={styles.unitLevel}>{unit.level}</div>
                  </div>
                </div>
                <div style={styles.unitActions}>
                  <StatusBadge status={status} />
                  {status !== "completed" && (
                    <button
                      onClick={() => handleMarkStatus(unit, status === "not_started" ? "in_progress" : "completed")}
                      disabled={isUpdating}
                      style={{ ...styles.markBtn, opacity: isUpdating ? 0.6 : 1 }}
                    >
                      {isUpdating
                        ? "…"
                        : status === "not_started"
                        ? "Start"
                        : "Mark Complete"}
                    </button>
                  )}
                </div>
              </div>

              {/* Concepts */}
              {unit.concepts?.length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionLabel}>Concepts</div>
                  <div style={styles.checkList}>
                    {unit.concepts.map(concept => {
                      const done = doneConcepts.includes(concept);
                      const key  = `concept_${unit.id}_${concept}`;
                      return (
                        <label key={concept} style={styles.checkItem}>
                          <input
                            type="checkbox"
                            checked={done}
                            disabled={!!toggling[key]}
                            onChange={() => handleToggleConcept(unit, concept)}
                            style={{ marginRight: 8, accentColor: "#4f46e5" }}
                          />
                          <span style={{ ...styles.checkLabel, textDecoration: done ? "line-through" : "none", color: done ? "#9ca3af" : "#111827" }}>
                            {concept}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Exercises */}
              {unit.exercises?.length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionLabel}>Exercises</div>
                  <div style={styles.checkList}>
                    {unit.exercises.map(exercise => {
                      const done = doneExercises.includes(exercise);
                      const key  = `exercise_${unit.id}_${exercise}`;
                      return (
                        <label key={exercise} style={styles.checkItem}>
                          <input
                            type="checkbox"
                            checked={done}
                            disabled={!!toggling[key]}
                            onChange={() => handleToggleExercise(unit, exercise)}
                            style={{ marginRight: 8, accentColor: "#059669" }}
                          />
                          <span style={{ ...styles.checkLabel, textDecoration: done ? "line-through" : "none", color: done ? "#9ca3af" : "#111827" }}>
                            {exercise}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Empty unit */}
              {(!unit.concepts?.length && !unit.exercises?.length) && (
                <div style={styles.emptyUnit}>No concepts or exercises added yet.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function emptyProgress(studentUid: string, unitId: string): StudentProgress {
  return {
    id:                 `${studentUid}_${unitId}`,
    studentUid,
    unitId,
    status:             "not_started",
    completionDate:     null,
    teacherSignOff:     null,
    feedback:           null,
    overrideBy:         null,
    completedConcepts:  [],
    completedExercises: [],
    points:             0,
    createdAt:          "",
    updatedAt:          "",
  };
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   24,
  },
  heading: {
    fontSize:   22,
    fontWeight: 600,
    color:      "var(--color-text-primary)",
  },
  unitCount: {
    fontSize:    12,
    color:       "var(--color-text-secondary)",
    fontWeight:  500,
  },
  stateRow: {
    padding:   "24px 0",
    fontSize:  13,
    color:     "var(--color-text-secondary)",
    textAlign: "center",
  },
  unitList: {
    display:       "flex",
    flexDirection: "column",
    gap:           16,
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
    padding:        "16px 20px",
    borderBottom:   "1px solid var(--color-border)",
    background:     "#f9fafb",
  },
  unitMeta: {
    display:    "flex",
    alignItems: "center",
    gap:        12,
  },
  unitOrder: {
    width:        28,
    height:       28,
    borderRadius: "50%",
    background:   "#e0e7ff",
    color:        "#4f46e5",
    fontSize:     12,
    fontWeight:   700,
    display:      "flex",
    alignItems:   "center",
    justifyContent:"center",
    flexShrink:   0,
  } as React.CSSProperties,
  unitTitle: {
    fontSize:   14,
    fontWeight: 600,
    color:      "#111827",
  },
  unitLevel: {
    fontSize: 12,
    color:    "#6b7280",
    marginTop: 2,
  },
  unitActions: {
    display:    "flex",
    alignItems: "center",
    gap:        10,
  },
  markBtn: {
    background:   "#4f46e5",
    color:        "#fff",
    border:       "none",
    padding:      "5px 14px",
    borderRadius: 6,
    fontSize:     12,
    fontWeight:   600,
    cursor:       "pointer",
  },
  section: {
    padding:      "14px 20px",
    borderBottom: "1px solid #f3f4f6",
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    700,
    color:         "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom:  10,
  },
  checkList: {
    display:       "flex",
    flexDirection: "column",
    gap:           8,
  },
  checkItem: {
    display:    "flex",
    alignItems: "center",
    cursor:     "pointer",
  },
  checkLabel: {
    fontSize:   13,
    transition: "color 0.15s",
  },
  emptyUnit: {
    padding:  "14px 20px",
    fontSize: 12,
    color:    "#9ca3af",
  },
  badge: {
    display:      "inline-block",
    padding:      "2px 10px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   600,
    textTransform:"capitalize",
  },
};
