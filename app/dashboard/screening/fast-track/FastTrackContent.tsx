"use client";

import { useState, useEffect, useMemo } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useWing } from "@/hooks/useWing";
import { saveScreening } from "@/services/screening/screening.service";
import type { ScreeningConfig, ScreeningResult } from "@/types";

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

const TESTS = [
  {
    code: "T-01", title: "Metronome Rhythm Sync",
    sub: "80 BPM · Quarter note → eighth-note shift across 4 bars",
    steps: [
      { tag: "Setup",    text: "Set metronome to 80 BPM. Student claps in time with the click." },
      { tag: "Bars 1–4", text: "Quarter notes — one clap per beat, four beats per bar" },
      { tag: "→ Shift",  text: "Switch immediately — no warning given to the student" },
      { tag: "Bars 5–8", text: "Eighth notes — two claps per beat, double subdivision" },
    ],
    tip: "Run 2 trials. Score the better attempt. Key focus: whether the subdivision shift is instantaneous or delayed.",
    rubric: [
      { grade: "High"   as Grade, desc: "Locks in from bar 1 at 80 BPM. Switch to double-time is immediate — zero hesitation." },
      { grade: "Medium" as Grade, desc: "Mostly on-beat. Hesitates 1–2 beats at the shift but self-corrects within the bar." },
      { grade: "Low"    as Grade, desc: "Struggles at 80 BPM, or loses beat entirely at the subdivision shift." },
    ],
  },
  {
    code: "T-02", title: "5-Finger Dexterity Run",
    sub: "Independent isolation · Ascending 1→5 and descending 5→1",
    steps: [
      { tag: "Setup",      text: "Student places one hand flat on a table." },
      { tag: "Ascending",  text: "Fingers 1 → 2 → 3 → 4 → 5 — each taps individually and rapidly." },
      { tag: "Descending", text: "Fingers 5 → 4 → 3 → 2 → 1 — same individual tap sequence." },
      { tag: "Repeat",     text: "3× each direction · Both hands. Watch for mirroring in the idle hand." },
    ],
    tip: "Watch for mirroring in the idle hand, grouping of fingers 4–5, stiffness at the 3→4 transition, or wrist involvement.",
    rubric: [
      { grade: "High"   as Grade, desc: "Clean, rapid, fully independent isolation in all 5 fingers. No mirroring or stiffness." },
      { grade: "Medium" as Grade, desc: "Minor hesitation at finger 4 or 5. Slight idle-hand mirroring that self-corrects." },
      { grade: "Low"    as Grade, desc: "Visible stiffness, persistent mirroring, or fingers 4–5 moving as a pair." },
    ],
  },
  {
    code: "T-03", title: "Pitch & Interval Echo",
    sub: "3-note melodic phrase · Hum-back from memory · No replays",
    steps: [
      { tag: "Round 1", text: "Play C–E–G ascending (major triad). Simple, bright interval." },
      { tag: "Round 2", text: "Play C–E–C (step up, return). Tests interval memory & direction." },
      { tag: "Round 3", text: "Evaluator's choice — any 3-note phrase of moderate range." },
    ],
    tip: "Accept humming or singing. Score on pitch accuracy and contour — not voice quality. No replays between rounds.",
    rubric: [
      { grade: "High"   as Grade, desc: "Reproduces all 3 rounds accurately within 2 seconds. Correct pitch, contour, and interval direction." },
      { grade: "Medium" as Grade, desc: "Accurate on Rounds 1–2 but drifts in Round 3. Contour correct but one or two pitches off." },
      { grade: "Low"    as Grade, desc: "Cannot accurately reproduce even the first phrase. Hums in approximate range only." },
    ],
  },
] as const;

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

// ─── Grade selector card ──────────────────────────────────────────────────────
function GradeCard({ grade, desc, selected, onSelect }: { grade: Grade; desc: string; selected: boolean; onSelect: () => void }) {
  const cfg = GRADE_CFG[grade];
  return (
    <div onClick={onSelect} style={{
      border: selected ? `2px solid ${cfg.border}` : "1.5px solid #f0f0f0",
      borderRadius: 12, background: selected ? cfg.bg : "#fafafa",
      padding: "12px 14px", cursor: "pointer", marginBottom: 8,
      display: "flex", alignItems: "flex-start", gap: 12,
      transition: "all 0.15s",
    }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0, marginTop: 2,
        border: `2px solid ${selected ? cfg.border : "#d1d5db"}`,
        background: selected ? cfg.border : "transparent",
        transition: "all 0.15s",
      }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: selected ? cfg.color : "#374151", letterSpacing: "0.06em", textTransform: "uppercase" as const, marginBottom: 3 }}>
          {grade}
          {selected && (
            <span style={{ marginLeft: 8, fontSize: 9, background: cfg.badgeBg, color: cfg.color, borderRadius: 99, padding: "1px 7px" }}>SELECTED · {GRADE_SCORE[grade]}/5</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: selected ? "#374151" : "#9ca3af", lineHeight: 1.55 }}>{desc}</div>
      </div>
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
export function FastTrackContent({
  onBack,
  onSaved,
  lockedStudentName,
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
} = {}) {
  const { user } = useAuthContext();
  const { wing } = useWing();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [studentName,   setStudentName]   = useState(lockedStudentName ?? "");
  const [studentQuery,  setStudentQuery]  = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);

  const [priorInstruments, setPriorInstruments] = useState<string[]>([]);
  const [performanceGoal,  setPerformanceGoal]  = useState("");
  const [sightReading,     setSightReading]     = useState("");

  const [rhythmGrade, setRhythmGrade] = useState<Grade | null>(null);
  const [dexGrade,    setDexGrade]    = useState<Grade | null>(null);
  const [pitchGrade,  setPitchGrade]  = useState<Grade | null>(null);

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

  const testGrades = [rhythmGrade, dexGrade, pitchGrade] as const;
  const allGraded  = testGrades.every(g => g !== null);
  const slabConfig = allGraded ? computeSlabConfig(rhythmGrade!, dexGrade!, pitchGrade!) : null;
  const avgScore   = allGraded ? parseFloat(((GRADE_SCORE[rhythmGrade!]+GRADE_SCORE[dexGrade!]+GRADE_SCORE[pitchGrade!])/3).toFixed(2)) : null;
  const canSave    = allGraded && studentName.trim().length > 0;

  async function handleSave() {
    if (!canSave || !slabConfig || avgScore === null || saving) return;
    setSaving(true); setSaveErr("");
    try {
      const payload: Omit<ScreeningResult, "id"> = {
        wing,
        screeningType: "fast-track", childName: studentName.trim(),
        rhythmSyncGrade: rhythmGrade!, dexterityGrade: dexGrade!, pitchEchoGrade: pitchGrade!,
        rhythmScore: GRADE_SCORE[rhythmGrade!], pitchScore: GRADE_SCORE[pitchGrade!], motorScore: GRADE_SCORE[dexGrade!],
        averageScore: avgScore, config: slabConfig,
        screenedBy: user?.uid ?? "", screenedAt: new Date().toISOString(),
        studentId: linkedStudent?.uid ?? null,
        ...(performanceGoal ? { stageReadiness: performanceGoal } : {}),
        ...(priorInstruments.length ? { academicGoals: priorInstruments.join(", ") } : {}),
        ...(sightReading ? { practiceCommitment: sightReading } : {}),
      };
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
    setRhythmGrade(null); setDexGrade(null); setPitchGrade(null);
    setSaved(false); setSaveErr("");
  }

  const gradeSetters = [setRhythmGrade, setDexGrade, setPitchGrade] as const;
  const gradeValues  = [rhythmGrade, dexGrade, pitchGrade] as const;

  // ── Success ────────────────────────────────────────────────────────────────
  if (saved) {
    return (
      <div style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
        <div style={{ ...card, border: "2px solid #16a34a", background: "#f0fdf4", boxShadow: "0 8px 40px rgba(22,163,74,0.12)", textAlign: "center", padding: "48px 36px" }}>
          <div style={{ fontSize: 52, marginBottom: 20 }}>✅</div>
          <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.1em", marginBottom: 8, fontFamily: "monospace" }}>{assessmentId}</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#15803d", marginBottom: 6 }}>Assessment Saved</div>
          <div style={{ fontSize: 15, color: "#6b7280", marginBottom: 10 }}>{studentName}</div>
          {avgScore !== null && (
            <div style={{ fontSize: 14, color: "#374151", marginBottom: 4 }}>
              Composite score <strong>{avgScore.toFixed(2)}</strong> / 5
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
          {TESTS.map((test, ti) => {
            const value = gradeValues[ti];
            const setter = gradeSetters[ti];
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
                  {value && (
                    <div style={{ fontSize: 11, fontWeight: 800, padding: "4px 12px", borderRadius: 99, background: GRADE_CFG[value].badgeBg, color: GRADE_CFG[value].color, flexShrink: 0 }}>
                      {value.toUpperCase()} · {GRADE_SCORE[value]}/5
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
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 14 }}>Score Entry</div>
                    {test.rubric.map(r => (
                      <GradeCard key={r.grade} grade={r.grade} desc={r.desc} selected={value === r.grade} onSelect={() => setter(r.grade)} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep(1)} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
            <button onClick={() => setStep(3)} disabled={!allGraded} style={{
              ...btnBase, background: allGraded ? ACCENT : "#e5e7eb",
              color: allGraded ? "#fff" : "#9ca3af",
              cursor: allGraded ? "pointer" : "not-allowed",
            }}>
              {allGraded ? "View Result →" : `Score all 3 tests (${gradeValues.filter(Boolean).length}/3)`}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Result ─────────────────────────────────────────────────── */}
      {step === 3 && allGraded && slabConfig && avgScore !== null && (() => {
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

            {/* Score bento tiles */}
            {([
              { code: "T-01", name: "Rhythm Sync", grade: rhythmGrade! },
              { code: "T-02", name: "Dexterity",   grade: dexGrade!   },
              { code: "T-03", name: "Pitch Echo",  grade: pitchGrade! },
            ]).map(t => {
              const cfg = GRADE_CFG[t.grade];
              return (
                <div key={t.code} style={{ ...card, gridColumn: "span 4", textAlign: "center" as const, border: `1.5px solid ${cfg.border}`, background: cfg.bg }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8, letterSpacing: "0.04em" }}>{t.code} · {t.name}</div>
                  <div style={{ fontSize: 26, fontWeight: 900, color: cfg.color }}>{t.grade.toUpperCase()}</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>{GRADE_SCORE[t.grade]} / 5 pts</div>
                </div>
              );
            })}

            {/* Composite score */}
            <div style={{ ...card, gridColumn: "span 12", border: "2px solid #d1d5db", background: "#f8f9fb" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 16 }}>
                <div>
                  <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 6, fontFamily: "monospace" }}>COMPOSITE SCORE</div>
                  <div style={{ fontSize: 40, fontWeight: 900, color: "#111", lineHeight: 1 }}>
                    {avgScore.toFixed(2)}<span style={{ fontSize: 14, fontWeight: 400, color: "#9ca3af" }}>/5</span>
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
                  {saving ? "Saving…" : !studentName.trim() ? "Enter student name in Step 1 ↑" : "💾 Save Assessment"}
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
