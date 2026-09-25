"use client";

import { useState, useEffect, useMemo } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useWing } from "@/hooks/useWing";
import { saveScreening, updateScreening } from "@/services/screening/screening.service";
import type { ScreeningConfig, ScreeningResult } from "@/types";
import {
  DEFAULT_FAST_TRACK_TESTS, FAST_TRACK_TEST_CODES, FAST_TRACK_TEST_MEASURES, GRADE_MARK_RANGE, GRADE_TO_MARK,
  MAX_SECTION_MARKS, MAX_TOTAL_MARKS, SECTION_COUNT, gradeForMarks, readScreeningMarks,
  type FastTrackTest, type ScreeningRubric,
} from "@/lib/screeningQuestions";
import { getFastTrackTests } from "@/services/screening/screeningQuestions.service";

/** The saved fast-track screening, handed back to an embedding wizard. */
export type FastTrackScreeningResult = Omit<ScreeningResult, "id"> & { id: string };

// ─── Types ────────────────────────────────────────────────────────────────────
type Grade = "High" | "Medium" | "Low";
interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Constants ────────────────────────────────────────────────────────────────
const ACCENT = "#d97706";

const GRADE_SCORE: Record<Grade, number> = { High: 5, Medium: 3, Low: 1 };

const GRADE_CFG: Record<Grade, { border: string; bg: string; color: string; badgeBg: string }> = {
  High:   { border: "#16a34a", bg: "#f0fdf4", color: "#15803d", badgeBg: "#dcfce7" },
  Medium: { border: "#d97706", bg: "#fffbeb", color: "#92400e", badgeBg: "#fef3c7" },
  Low:    { border: "#dc2626", bg: "#fef2f2", color: "#991b1b", badgeBg: "#fee2e2" },
};

const INSTRUMENTS = ["Piano", "Keyboard", "Guitar", "Violin", "Drums", "Vocal", "None"] as const;

const PERF_GOALS = [
  { id: "exams",    label: "Formal Exams",         desc: "ABRSM, Trinity, or equivalent grade exams" },
  { id: "stage",    label: "Stage Performances",   desc: "Recitals, concerts, and public showcases"  },
  { id: "both",     label: "Both",                 desc: "Exam certification and stage readiness"    },
  { id: "personal", label: "Personal Development", desc: "Skill-building without exam pressure"      },
] as const;

const SIGHT_OPTIONS = [
  { id: "none",    label: "None",    desc: "No prior sight-reading experience"       },
  { id: "some",    label: "Some",    desc: "Occasional exposure, not yet systematic" },
  { id: "regular", label: "Regular", desc: "Reads from sheet music regularly"        },
] as const;

// The five sections (procedure + rubric) are configurable per wing by leadership
// on the "Screening Questions" tab — see lib/screeningQuestions.ts. Teachers
// only see them here, read-only, with the grade selectors.

// ─── Slab logic ───────────────────────────────────────────────────────────────
function computeSlabConfig(r: Grade, d: Grade, p: Grade): ScreeningConfig {
  const all = [r, d, p];
  if (all.every(g => g === "High")) return {
    track: "Zeta Slab", syllabusStrategy: "Advanced Performance Track — Exam & Stage Ready",
    metronome: true, metronomeBpm: 80, handIntegration: "Hands Together",
    chords: "Full Harmonies & Inversions", songsheetDifficulty: "Advanced/16-Bar",
  };
  if (all.some(g => g === "Low")) return {
    track: "Delta Slab", syllabusStrategy: "Structured Foundations — Technical Groundwork First",
    metronome: true, metronomeBpm: 55, handIntegration: "Hands Separated",
    chords: false, songsheetDifficulty: "Standard/Easier",
  };
  return {
    track: "Epsilon Slab", syllabusStrategy: "Accelerated Integration — Bridging Foundations to Performance",
    metronome: true, metronomeBpm: 70, handIntegration: "Hands Together",
    chords: "Basic Blocks", songsheetDifficulty: "Mid-Tier",
  };
}

// ─── Shared design primitives ─────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(0,0,0,0.07)",
  borderRadius: 18,
  padding: 24,
  boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const btnBase: React.CSSProperties = {
  padding: "11px 22px", borderRadius: 12, border: "none",
  fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center",
};
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  border: "1.5px solid #f0f0f0", borderRadius: 10,
  padding: "10px 13px", fontSize: 13, outline: "none",
  fontFamily: "inherit", color: "#111", background: "#fafafa",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.09em",
  display: "block", marginBottom: 10,
};

// ─── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step }: { step: number }) {
  const steps = ["Background", "Clinical Tests", "Result"];
  return (
    <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 26 }}>
      {steps.map((label, i) => {
        const n = i + 1;
        const done = step > n;
        const active = step === n;
        return (
          <div key={n} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{
                width: 34, height: 34, borderRadius: "50%",
                background: done || active ? ACCENT : "#f3f4f6",
                color: done || active ? "#fff" : "#9ca3af",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, flexShrink: 0,
                boxShadow: active ? `0 0 0 5px rgba(217,119,6,0.1)` : "none",
                transition: "all 0.2s",
              }}>
                {done ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, marginTop: 6, fontWeight: active ? 700 : 400, color: active ? ACCENT : done ? "#6b7280" : "#9ca3af", whiteSpace: "nowrap" }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ height: 2, width: 48, flexShrink: 0, alignSelf: "flex-start", marginTop: 16, background: done ? ACCENT : "#f0f0f0", transition: "background 0.3s" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Mark entry (1–3) ─────────────────────────────────────────────────────────
// Teachers pick a mark out of 3 (High 3 · Medium 2 · Low 1); the rubric bands
// are shown read-only and light up for the chosen mark. Clicking a band picks
// its mark as a shortcut.
function MarkEntry({ rubric, marks, onSelect }: {
  rubric: ScreeningRubric[]; marks: number | null; onSelect: (m: number) => void;
}) {
  const band = marks !== null ? gradeForMarks(marks) : null;
  return (
    <div>
      <div role="radiogroup" aria-label={`Marks out of ${MAX_SECTION_MARKS}`} style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {Array.from({ length: MAX_SECTION_MARKS }, (_, i) => i + 1).map(m => {
          const cfg = GRADE_CFG[gradeForMarks(m)];
          const on = marks === m;
          return (
            <button key={m} type="button" role="radio" aria-checked={on} onClick={() => onSelect(m)}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                fontSize: 16, fontWeight: 900, transition: "all 0.15s",
                border: on ? `2px solid ${cfg.border}` : "1.5px solid #e5e7eb",
                background: on ? cfg.border : "#fff", color: on ? "#fff" : cfg.color,
              }}>
              {m}
            </button>
          );
        })}
      </div>
      {rubric.map(r => {
        const cfg = GRADE_CFG[r.grade];
        const selected = band === r.grade;
        return (
          <div key={r.grade} onClick={() => onSelect(GRADE_MARK_RANGE[r.grade].max)} style={{
            border: selected ? `2px solid ${cfg.border}` : "1.5px solid #f0f0f0",
            borderRadius: 12, background: selected ? cfg.bg : "#fafafa",
            padding: "10px 14px", cursor: "pointer", marginBottom: 8, transition: "all 0.15s",
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: selected ? cfg.color : "#374151", letterSpacing: "0.06em", textTransform: "uppercase" as const, marginBottom: 3 }}>
              {r.grade} <span style={{ fontWeight: 600, textTransform: "none" as const, letterSpacing: 0, color: selected ? cfg.color : "#9ca3af" }}>· {GRADE_MARK_RANGE[r.grade].label}</span>
            </div>
            <div style={{ fontSize: 12, color: selected ? "#374151" : "#9ca3af", lineHeight: 1.55 }}>{r.desc}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Student search field (shared) ────────────────────────────────────────────
function StudentSearch({ studentName, setStudentName, studentQuery, setStudentQuery, linkedStudent, setLinkedStudent, showDropdown, setShowDropdown, filteredStudents, studsLoading }: {
  studentName: string; setStudentName: (v: string) => void;
  studentQuery: string; setStudentQuery: (v: string) => void;
  linkedStudent: StudentOption | null; setLinkedStudent: (v: StudentOption | null) => void;
  showDropdown: boolean; setShowDropdown: (v: boolean) => void;
  filteredStudents: StudentOption[]; studsLoading: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        <label style={labelStyle}>Student Name *</label>
        <input value={studentName} onChange={e => setStudentName(e.target.value)} placeholder="Full name" style={inputStyle} />
      </div>
      <div>
        <label style={labelStyle}>Link to Enrolled Student <span style={{ textTransform: "none", fontWeight: 400, color: "#9ca3af", letterSpacing: 0 }}>(optional)</span></label>
        <div style={{ position: "relative" }}>
          {linkedStudent ? (
            <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "space-between", boxSizing: "border-box" as const }}>
              <span style={{ fontSize: 13 }}>{linkedStudent.name} <span style={{ color: "#9ca3af", fontSize: 11, fontFamily: "monospace" }}>({linkedStudent.studentID})</span></span>
              <button type="button" onClick={() => { setLinkedStudent(null); setStudentQuery(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16, padding: 0, lineHeight: 1 }}>✕</button>
            </div>
          ) : (
            <input value={studentQuery} onChange={e => { setStudentQuery(e.target.value); setShowDropdown(true); }}
              onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              placeholder="Search by name or ID…" style={inputStyle} />
          )}
          {showDropdown && filteredStudents.length > 0 && !linkedStudent && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, border: "1px solid #f0f0f0", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", background: "#fff", marginTop: 4, overflow: "hidden" }}>
              {filteredStudents.map(st => (
                <div key={st.uid}
                  onMouseDown={() => { setLinkedStudent(st); if (!studentName.trim()) setStudentName(st.name); setStudentQuery(""); setShowDropdown(false); }}
                  style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f9fafb", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#fafafa")}
                  onMouseLeave={e => (e.currentTarget.style.background = "#fff")}>
                  <span style={{ fontWeight: 600, color: "#111" }}>{st.name}</span>
                  <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>{st.studentID}</span>
                </div>
              ))}
              {studsLoading && <div style={{ padding: "10px 14px", fontSize: 12, color: "#9ca3af" }}>Loading…</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const EMPTY_MARKS = (): (number | null)[] => Array(SECTION_COUNT).fill(null);

/**
 * Saved marks as five values on the current 1–3 scale (for the edit form).
 * An older 3-section screening (marks out of 5) carries its bands over —
 * High → 3, Medium → 2, Low → 1 — and S-4 / S-5 start blank.
 */
function savedMarks(sc: FastTrackScreeningResult | null | undefined): (number | null)[] {
  if (!sc) return EMPTY_MARKS();
  const r = readScreeningMarks(sc as unknown as Record<string, unknown>);
  const marks = r.legacy
    ? r.marks.map(m => (m === null ? null : GRADE_TO_MARK[gradeForMarks(m, r.outOf)]))
    : r.marks.map(m => (m !== null && m >= 1 && m <= MAX_SECTION_MARKS ? m : null));
  return [...marks, ...EMPTY_MARKS()].slice(0, SECTION_COUNT);
}

export function FastTrackContent({
  onBack,
  onSaved,
  lockedStudentName,
  initial,
  onUpdated,
}: {
  onBack?:  () => void;
  /**
   * When provided, the screening is saved and handed back instead of showing
   * the built-in success card — used by the Wing 2 admissions wizard.
   */
  onSaved?: (screening: FastTrackScreeningResult) => void;
  /**
   * When set (wizard context), the student is already known — the name is fixed
   * and the "link to enrolled student" search is hidden.
   */
  lockedStudentName?: string;
  /**
   * An already-completed screening. The component opens on a read-only
   * summary of it; "Edit Assessment" unlocks the form, and saving overwrites
   * this same screening (same id) instead of creating a new one.
   * Parents should remount on change (key={initial?.id}).
   */
  initial?: FastTrackScreeningResult | null;
  /** Called after an edited screening is saved (summary view shows it again). */
  onUpdated?: (screening: FastTrackScreeningResult) => void;
} = {}) {
  const { user } = useAuthContext();
  const { wing } = useWing();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [tests, setTests] = useState<FastTrackTest[]>(DEFAULT_FAST_TRACK_TESTS);
  useEffect(() => {
    let live = true;
    getFastTrackTests(wing)
      .then(r => { if (live) setTests(r.tests); })
      .catch(err => console.error("[FastTrack] could not load screening questions, using defaults:", err));
    return () => { live = false; };
  }, [wing]);

  // The saved screening being viewed/edited (null = a brand-new assessment).
  const [current, setCurrent] = useState<FastTrackScreeningResult | null>(initial ?? null);
  const [editing, setEditing] = useState(!initial);

  const [studentName,   setStudentName]   = useState(lockedStudentName ?? initial?.childName ?? "");
  const [studentQuery,  setStudentQuery]  = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);

  const [priorInstruments, setPriorInstruments] = useState<string[]>(
    () => (initial?.academicGoals ?? "").split(",").map(x => x.trim()).filter(Boolean),
  );
  const [performanceGoal,  setPerformanceGoal]  = useState(initial?.stageReadiness ?? "");
  const [sightReading,     setSightReading]     = useState(initial?.practiceCommitment ?? "");

  // Marks out of 3 for S-1 Rhythm Sync … S-5 Musical Awareness.
  const [marks, setMarks] = useState<(number | null)[]>(() => savedMarks(initial));

  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [assessmentId] = useState(() => {
    const d = new Date();
    return `FT-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  });

  useEffect(() => {
    setStudsLoading(true);
    getDocs(query(collection(db, "users"), where("role", "==", "student")))
      .then(snap => setAllStudents(snap.docs.map(d => {
        const u = d.data();
        return { uid: d.id, name: (u.displayName ?? u.name ?? "—") as string, studentID: (u.studentID ?? "") as string };
      })))
      .catch(() => {})
      .finally(() => setStudsLoading(false));
  }, []);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q || linkedStudent) return [];
    return allStudents.filter(s => s.name.toLowerCase().includes(q) || s.studentID.toLowerCase().includes(q)).slice(0, 8);
  }, [studentQuery, allStudents, linkedStudent]);

  function toggleInstrument(inst: string) {
    if (inst === "None") {
      setPriorInstruments(prev => prev.includes("None") ? [] : ["None"]);
    } else {
      setPriorInstruments(prev => {
        const sans = prev.filter(i => i !== "None");
        return sans.includes(inst) ? sans.filter(i => i !== inst) : [...sans, inst];
      });
    }
  }

  const allGraded  = marks.every(m => m !== null);
  const scored     = marks.filter((m): m is number => m !== null);
  const totalMarks = scored.reduce((sum, m) => sum + m, 0);
  const grades     = allGraded ? (marks as number[]).map(gradeForMarks) : null;
  // Same slab rule as before, on each section's band: all High → Zeta, any Low → Delta.
  const slabConfig = grades ? computeSlabConfig(grades[0], grades[1], grades[2]) : null;
  // averageScore stays on the 0–5 scale older screens show ("x.xx / 5"):
  // the total is always out of 15, so total ÷ 3.
  const avgScore   = allGraded ? parseFloat((totalMarks / 3).toFixed(2)) : null;
  const canSave    = allGraded && studentName.trim().length > 0;

  async function handleSave() {
    if (!canSave || !slabConfig || avgScore === null || saving) return;
    setSaving(true); setSaveErr("");
    try {
      const payload: Omit<ScreeningResult, "id"> = {
        wing,
        screeningType: "fast-track", childName: studentName.trim(),
        rhythmSyncGrade: grades![0], pitchConsciousnessGrade: grades![1], sheetTappingGrade: grades![2],
        attentionSpanGrade: grades![3], musicalAwarenessGrade: grades![4],
        screeningScores: {
          rhythmSync: marks[0]!, pitchConsciousness: marks[1]!, sheetTapping: marks[2]!,
          attentionSpan: marks[3]!, musicalAwareness: marks[4]!,
          total: totalMarks, sectionMax: MAX_SECTION_MARKS,
        },
        // Legacy per-skill fields (0–5 scale), still read by the screening
        // list / diagnostic card — High 5 · Medium 3 · Low 1.
        rhythmScore: GRADE_SCORE[grades![0]], pitchScore: GRADE_SCORE[grades![1]], motorScore: GRADE_SCORE[grades![2]],
        averageScore: avgScore, config: slabConfig,
        // An edit keeps the original evaluator + date and records who changed it.
        screenedBy: current?.screenedBy || (user?.uid ?? ""),
        screenedAt: current?.screenedAt || new Date().toISOString(),
        ...(current ? { updatedBy: user?.uid ?? "", updatedAt: new Date().toISOString() } : {}),
        studentId: linkedStudent?.uid ?? current?.studentId ?? null,
        ...(performanceGoal ? { stageReadiness: performanceGoal } : {}),
        ...(priorInstruments.length ? { academicGoals: priorInstruments.join(", ") } : {}),
        ...(sightReading ? { practiceCommitment: sightReading } : {}),
      };
      if (current) {
        await updateScreening(current.id, payload);
        const updated = { ...payload, id: current.id } as FastTrackScreeningResult;
        setCurrent(updated);
        setEditing(false);
        setStep(1);
        onUpdated?.(updated);
        return;
      }
      const screeningId = await saveScreening(payload);
      if (onSaved) {
        onSaved({ ...payload, id: screeningId });
        return;
      }
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setStep(1);
    setStudentName(""); setStudentQuery(""); setLinkedStudent(null); setShowDropdown(false);
    setPriorInstruments([]); setPerformanceGoal(""); setSightReading("");
    setMarks(EMPTY_MARKS());
    setSaved(false); setSaveErr("");
  }

  const setMark = (i: number, m: number) => setMarks(prev => prev.map((v, j) => (j === i ? m : v)));

  // ── Completed screening: read-only summary ─────────────────────────────────
  if (current && !editing) {
    const r = readScreeningMarks(current as unknown as Record<string, unknown>);
    const total = r.total;
    const when = current.screenedAt ? new Date(current.screenedAt) : null;
    const goal = PERF_GOALS.find(g => g.id === current.stageReadiness)?.label ?? current.stageReadiness;
    const sight = SIGHT_OPTIONS.find(o => o.id === current.practiceCommitment)?.label ?? current.practiceCommitment;
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 0 60px" }}>
        <div style={{ ...card, border: "1.5px solid #c7d2fe", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" as const }}>
            <div>
              <span style={{ display: "inline-block", fontSize: 11, fontWeight: 800, color: "#3730a3", background: "#e0e7ff", padding: "3px 10px", borderRadius: 99 }}>
                ✓ Screening Complete
              </span>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#111", marginTop: 8 }}>{current.childName || studentName}</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                Fast Track assessment{when && !isNaN(when.getTime()) ? ` · ${when.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                {current.config?.track ? ` · ${current.config.track}` : ""}
              </div>
            </div>
            <button onClick={() => { setEditing(true); setStep(1); }}
              style={{ ...btnBase, background: "#fff", color: "#3730a3", border: "1.5px solid #a5b4fc" }}>
              ✏️ Edit Assessment
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 12 }}>
          {r.labels.map((label, i) => {
            const v = r.marks[i];
            const cfg = v !== null ? GRADE_CFG[gradeForMarks(v, r.outOf)] : null;
            return (
              <div key={label} style={{ ...card, textAlign: "center" as const, border: `1.5px solid ${cfg?.border ?? "#e5e7eb"}`, background: cfg?.bg ?? "#fff" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6, letterSpacing: "0.04em" }}>{FAST_TRACK_TEST_CODES[i]} · {label}</div>
                <div style={{ fontSize: 26, fontWeight: 900, color: cfg?.color ?? "#9ca3af" }}>
                  {v ?? "—"}<span style={{ fontSize: 13, fontWeight: 600 }}> / {r.outOf}</span>
                </div>
                {v !== null && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{gradeForMarks(v, r.outOf).toUpperCase()}</div>}
              </div>
            );
          })}
        </div>
        {r.legacy && (
          <div style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 12px", marginBottom: 12 }}>
            Scored on the older 3-section rubric (out of 5 each). Use Edit Assessment to re-score it on the
            5-section rubric — current bands carry over and Attention Span / Musical Awareness need scoring.
          </div>
        )}

        <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" as const, background: "#f8f9fb", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 4, fontFamily: "monospace" }}>TOTAL SCREENING SCORE</div>
            <div style={{ fontSize: 34, fontWeight: 900, color: "#111", lineHeight: 1 }}>
              {total ?? "—"}<span style={{ fontSize: 14, fontWeight: 400, color: "#9ca3af" }}> / {MAX_TOTAL_MARKS} marks</span>
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: "#374151", lineHeight: 1.7 }}>
            {priorInstruments.length > 0 && <div><b>Instruments played:</b> {priorInstruments.join(", ")}</div>}
            {goal && <div><b>Performance goal:</b> {goal}</div>}
            {sight && <div><b>Sight reading:</b> {sight}</div>}
          </div>
        </div>

        {/* View-only: no enrol action here — enrolment starts from the
            applicant card ("Enroll Student") once screening + photo are done. */}
        {onBack && (
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onBack} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
          </div>
        )}
      </div>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (saved) {
    return (
      <div style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
        <div style={{ ...card, border: "2px solid #16a34a", background: "#f0fdf4", boxShadow: "0 8px 40px rgba(22,163,74,0.12)", textAlign: "center", padding: "48px 36px" }}>
          <div style={{ fontSize: 52, marginBottom: 20 }}>✅</div>
          <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.1em", marginBottom: 8, fontFamily: "monospace" }}>{assessmentId}</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#15803d", marginBottom: 6 }}>Assessment Saved</div>
          <div style={{ fontSize: 15, color: "#6b7280", marginBottom: 10 }}>{studentName}</div>
          {allGraded && (
            <div style={{ fontSize: 14, color: "#374151", marginBottom: 4 }}>
              Total screening score <strong>{totalMarks}</strong> / {MAX_TOTAL_MARKS} marks
            </div>
          )}
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 32 }}>Fast Track — same syllabus for every student</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" as const }}>
            <button onClick={reset} style={{ ...btnBase, background: ACCENT, color: "#fff" }}>+ New Assessment</button>
            {onBack
              ? <button onClick={onBack} style={{ ...btnBase, background: "#f3f4f6", color: "#374151" }}>← Back to Hub</button>
              : <Link href="/dashboard/screening" style={{ ...btnBase, background: "#f3f4f6", color: "#374151", textDecoration: "none" }}>← Back to Hub</Link>
            }
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 0 60px" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        background: "linear-gradient(135deg, #fffbeb, #fef9ee)",
        border: "1px solid #fde68a", borderRadius: 20, padding: "22px 28px",
        marginBottom: 22, display: "flex", alignItems: "center",
        justifyContent: "space-between", flexWrap: "wrap" as const, gap: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>⚡</div>
          <div>
            <div style={{ fontSize: 19, fontWeight: 900, color: "#78350f" }}>Fast Track Assessment</div>
            <div style={{ fontSize: 12, color: "#92400e", opacity: 0.8, marginTop: 2 }}>Ages 7–30 · Clinical Protocol · Score Record</div>
          </div>
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "monospace" }}>ASSESSMENT ID</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, fontFamily: "monospace" }}>{assessmentId}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>
            {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
          </div>
        </div>
      </div>

      {current && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" as const, background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 12, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#3730a3" }}>
          <span>✏️ Editing the saved assessment — saving updates it in place.</span>
          <button onClick={() => {
            // Discard edits: restore the saved values and go back to the summary.
            setMarks(savedMarks(current));
            setPriorInstruments((current.academicGoals ?? "").split(",").map(x => x.trim()).filter(Boolean));
            setPerformanceGoal(current.stageReadiness ?? "");
            setSightReading(current.practiceCommitment ?? "");
            setSaveErr("");
            setEditing(false);
          }} style={{ background: "none", border: "none", color: "#3730a3", fontWeight: 700, cursor: "pointer", textDecoration: "underline", fontSize: 13 }}>
            Cancel editing
          </button>
        </div>
      )}

      {/* ── Stepper ────────────────────────────────────────────────────────── */}
      <Stepper step={step} />

      {/* ── Step 1: Background ─────────────────────────────────────────────── */}
      {step === 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Student</div>
            {lockedStudentName ? (
              <div style={{ fontSize: 15, fontWeight: 700, color: "#111" }}>{lockedStudentName}</div>
            ) : (
              <StudentSearch {...{ studentName, setStudentName, studentQuery, setStudentQuery, linkedStudent, setLinkedStudent, showDropdown, setShowDropdown, filteredStudents, studsLoading }} />
            )}
          </div>

          <div style={{ ...card, gridColumn: "span 7" }}>
            <div style={labelStyle}>Prior Instrument Training</div>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
              {INSTRUMENTS.map(inst => {
                const sel = priorInstruments.includes(inst);
                return (
                  <button key={inst} type="button" onClick={() => toggleInstrument(inst)} style={{
                    padding: "7px 15px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 12, fontWeight: sel ? 700 : 500,
                    border: sel ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    background: sel ? "#fef3c7" : "#fafafa",
                    color: sel ? "#92400e" : "#6b7280", transition: "all 0.12s",
                  }}>
                    {sel && "✓ "}{inst}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ ...card, gridColumn: "span 5" }}>
            <div style={labelStyle}>Primary Goal</div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
              {PERF_GOALS.map(g => {
                const sel = performanceGoal === g.id;
                return (
                  <div key={g.id} onClick={() => setPerformanceGoal(sel ? "" : g.id)} style={{
                    border: sel ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    borderRadius: 12, padding: "10px 14px", cursor: "pointer",
                    background: sel ? "#fef9ee" : "#fafafa", transition: "all 0.12s",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: sel ? "#92400e" : "#374151", marginBottom: 2 }}>
                      {sel && "✓ "}{g.label}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{g.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Sight-Reading Exposure</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {SIGHT_OPTIONS.map(opt => {
                const sel = sightReading === opt.id;
                return (
                  <div key={opt.id} onClick={() => setSightReading(sel ? "" : opt.id)} style={{
                    border: sel ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    borderRadius: 14, padding: "16px 18px", cursor: "pointer",
                    background: sel ? "#fef9ee" : "#fafafa", transition: "all 0.12s",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${sel ? ACCENT : "#d1d5db"}`, background: sel ? ACCENT : "transparent", flexShrink: 0, transition: "all 0.12s" }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: sel ? "#92400e" : "#374151" }}>{opt.label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>{opt.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {onBack
              ? <button onClick={onBack} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Hub</button>
              : <Link href="/dashboard/screening" style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280", textDecoration: "none" }}>← Hub</Link>
            }
            <button onClick={() => setStep(2)} disabled={!studentName.trim()} style={{
              ...btnBase, background: studentName.trim() ? ACCENT : "#e5e7eb",
              color: studentName.trim() ? "#fff" : "#9ca3af",
              cursor: studentName.trim() ? "pointer" : "not-allowed",
            }}>
              Next: Tests →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Tests ──────────────────────────────────────────────────── */}
      {step === 2 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>
          {tests.map((test, ti) => {
            const value = marks[ti];
            const band  = value !== null ? gradeForMarks(value) : null;
            return (
              <div key={test.code} style={{ ...card, gridColumn: "span 12" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 20 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: ACCENT, background: "#fef3c7", borderRadius: 8, padding: "4px 11px", letterSpacing: "0.08em", fontFamily: "monospace", flexShrink: 0, marginTop: 2 }}>
                    {test.code}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#111" }}>{test.title}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{test.sub}</div>
                  </div>
                  {value !== null && band && (
                    <div style={{ fontSize: 11, fontWeight: 800, padding: "4px 12px", borderRadius: 99, background: GRADE_CFG[band].badgeBg, color: GRADE_CFG[band].color, flexShrink: 0 }}>
                      {value} / {MAX_SECTION_MARKS} · {band.toUpperCase()}
                    </div>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div style={{ background: "#f8f9fb", border: "1px solid #f0f0f0", borderRadius: 14, padding: "18px 20px" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 14 }}>Procedure</div>
                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 10, marginBottom: 14 }}>
                      {test.steps.map((s, si) => (
                        <div key={si} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: ACCENT, minWidth: 66, flexShrink: 0 }}>{s.tag}</span>
                          <span style={{ fontSize: 12, color: "#374151", lineHeight: 1.55 }}>{s.text}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.6, borderTop: "1px solid #f0f0f0", paddingTop: 10 }}>{test.tip}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 14 }}>Score Entry · out of {MAX_SECTION_MARKS}</div>
                    <MarkEntry rubric={test.rubric} marks={value} onSelect={m => setMark(ti, m)} />
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ gridColumn: "span 12", ...card, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", border: "2px solid #fde68a", background: "#fffbeb" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#78350f" }}>
              Total Screening Score: <span style={{ fontSize: 22, fontWeight: 900 }}>{totalMarks}</span> / {MAX_TOTAL_MARKS} Marks
            </div>
            <div style={{ fontSize: 12, color: "#92400e" }}>
              {marks.map((m, i) => `${FAST_TRACK_TEST_MEASURES[i]} ${m ?? "–"}/${MAX_SECTION_MARKS}`).join(" · ")}
            </div>
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep(1)} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
            <button onClick={() => setStep(3)} disabled={!allGraded} style={{
              ...btnBase, background: allGraded ? ACCENT : "#e5e7eb",
              color: allGraded ? "#fff" : "#9ca3af",
              cursor: allGraded ? "pointer" : "not-allowed",
            }}>
              {allGraded ? "View Result →" : `Score all ${SECTION_COUNT} sections (${scored.length}/${SECTION_COUNT})`}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Result ─────────────────────────────────────────────────── */}
      {step === 3 && allGraded && slabConfig && avgScore !== null && (() => {
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

            {/* Score bento tiles */}
            {tests.map((t, i) => {
              const m = marks[i]!;
              const cfg = GRADE_CFG[gradeForMarks(m)];
              return (
                <div key={t.code} style={{ ...card, gridColumn: i < 3 ? "span 4" : "span 6", textAlign: "center" as const, border: `1.5px solid ${cfg.border}`, background: cfg.bg }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8, letterSpacing: "0.04em" }}>{t.code} · {FAST_TRACK_TEST_MEASURES[i]}</div>
                  <div style={{ fontSize: 26, fontWeight: 900, color: cfg.color }}>{m}<span style={{ fontSize: 13, fontWeight: 600 }}> / {MAX_SECTION_MARKS}</span></div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>{gradeForMarks(m).toUpperCase()}</div>
                </div>
              );
            })}

            {/* Composite score */}
            <div style={{ ...card, gridColumn: "span 12", border: "2px solid #d1d5db", background: "#f8f9fb" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 16 }}>
                <div>
                  <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 6, fontFamily: "monospace" }}>TOTAL SCREENING SCORE</div>
                  <div style={{ fontSize: 40, fontWeight: 900, color: "#111", lineHeight: 1 }}>
                    {totalMarks}<span style={{ fontSize: 14, fontWeight: 400, color: "#9ca3af" }}> / {MAX_TOTAL_MARKS} marks</span>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", maxWidth: 260, textAlign: "right" as const, lineHeight: 1.5 }}>
                  Every Fast Track student follows the same syllabus. These marks are recorded on
                  the student&apos;s profile for reference only.
                </div>
              </div>
            </div>

            {/* Summary + Save */}
            <div style={{ ...card, gridColumn: "span 5", background: "#f8f9fb" }}>
              <div style={labelStyle}>Assessment Summary</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111" }}>{studentName}</div>
              {linkedStudent && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3, fontFamily: "monospace" }}>{linkedStudent.studentID}</div>}
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6, fontFamily: "monospace" }}>{assessmentId}</div>
            </div>

            <div style={{ ...card, gridColumn: "span 7" }}>
              {saveErr && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 14 }}>
                  {saveErr}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
                <button onClick={handleSave} disabled={!canSave || saving} style={{
                  ...btnBase, justifyContent: "center", width: "100%",
                  background: canSave && !saving ? ACCENT : "#e5e7eb",
                  color: canSave && !saving ? "#fff" : "#9ca3af",
                  cursor: canSave && !saving ? "pointer" : "not-allowed",
                  padding: "13px 22px",
                }}>
                  {saving ? "Saving…" : !studentName.trim() ? "Enter student name in Step 1 ↑" : current ? "💾 Save Changes" : "💾 Save Assessment"}
                </button>
                <button onClick={() => setStep(2)} style={{ ...btnBase, justifyContent: "center", background: "#f3f4f6", color: "#6b7280" }}>
                  ← Revise Tests
                </button>
              </div>
            </div>

          </div>
        );
      })()}

    </div>
  );
}
