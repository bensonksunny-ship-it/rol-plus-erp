"use client";

import { useState, useEffect, useCallback } from "react";
import {
  collection, getDocs, query, where,
  addDoc, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────
type DrumStream = "little-mozarts" | "fast-track" | "joyful-track" | "creative-track";
type Grade = "High" | "Medium" | "Low";
type SensoryResp = "Positive" | "Neutral" | "Withdrawal" | "Distress";

interface StudentOption { uid: string; name: string; studentID: string; }

interface DrumConfig {
  track: string;
  syllabusStrategy: string;
  metronome: boolean;
  metronomeBpm: number;
  stickType: "Drumsticks" | "Brushes" | "Mallets";
  kickPedalTechnique: "Heel Down" | "Heel Up" | "Both";
  tempoRange: "Slow (< 80 BPM)" | "Medium (80–120 BPM)" | "Fast (120+ BPM)";
  grooveComplexity: "Basic 4/4" | "Syncopated Patterns" | "Polyrhythmic";
}

// ─── Constants ────────────────────────────────────────────────────────────────
const GRADE_SCORE: Record<Grade, number> = { High: 5, Medium: 3, Low: 1 };
const SENSORY_SCORE: Record<SensoryResp, number> = { Positive: 4, Neutral: 3, Withdrawal: 2, Distress: 1 };

const GRADE_CFG: Record<Grade, { border: string; bg: string; color: string }> = {
  High:   { border: "#16a34a", bg: "#f0fdf4", color: "#15803d" },
  Medium: { border: "#d97706", bg: "#fffbeb", color: "#92400e" },
  Low:    { border: "#dc2626", bg: "#fef2f2", color: "#991b1b" },
};

const SLAB_CFG: Record<string, { border: string; bg: string; color: string; glow: string }> = {
  "Zeta Slab":    { border: "#16a34a", bg: "#f0fdf4", color: "#15803d", glow: "rgba(22,163,74,0.12)"  },
  "Epsilon Slab": { border: "#d97706", bg: "#fffbeb", color: "#92400e", glow: "rgba(217,119,6,0.12)"  },
  "Delta Slab":   { border: "#dc2626", bg: "#fef2f2", color: "#991b1b", glow: "rgba(220,38,38,0.12)"  },
};

const STREAM_CFG = {
  "little-mozarts": { label: "Little Mozarts",  accent: "#059669", prefix: "DM-LM", age: "Ages 3–6"  },
  "fast-track":     { label: "Fast Track",       accent: "#d97706", prefix: "DM-FT", age: "Ages 7–30" },
  "joyful-track":   { label: "Joyful Track",     accent: "#db2777", prefix: "DM-JT", age: "Ages 31+"  },
  "creative-track": { label: "Creative Track",   accent: "#7c3aed", prefix: "DM-CT", age: "Adaptive"  },
} as const;

const STEP_LABELS: Record<DrumStream, string[]> = {
  "little-mozarts": ["Student Info", "Early Rhythm",    "Config & Save"],
  "fast-track":     ["Student Info", "Background",      "Assessment & Save"],
  "joyful-track":   ["Student Info", "Background",      "Pattern & Save"],
  "creative-track": ["Student Info", "Sensory Eval",    "Config & Save"],
};

const PERF_GOALS = [
  { id: "exams",    label: "Formal Exams",         desc: "Grade exams, certifications"        },
  { id: "stage",    label: "Stage Performances",   desc: "Live bands, recitals, showcases"    },
  { id: "both",     label: "Both",                 desc: "Exam certification & stage ready"   },
  { id: "personal", label: "Personal Development", desc: "Skill-building without pressure"    },
] as const;

const JT_GENRES = [
  "Bollywood", "Rock / Pop", "Jazz / Blues", "Classical (Percussion)",
  "Folk / World", "Carnatic", "Electronic / EDM", "Other",
] as const;

const PRIOR_INSTRUMENTS = ["Drums / Percussion", "Piano", "Guitar", "Keyboard", "Tabla", "None"] as const;

const SENSORY_TESTS = [
  {
    id: "soundImpact",
    title: "Sound Impact Response",
    sub: "Strike a snare drum at medium force — observe the student's immediate reaction",
    procedure: "Strike once without warning the student. Note flinching, covering ears, leaning toward the sound, or no reaction. Repeat only if the student appears unaware.",
  },
  {
    id: "vibrationResponse",
    title: "Vibration & Tactile Sensitivity",
    sub: "Place the student's hand on the drumhead while you tap lightly — note their response",
    procedure: "Ask the student to feel the drum as you tap. Observe tolerance to vibration through the hand. Note hesitation, withdrawal, or curiosity.",
  },
  {
    id: "rhythmMirror",
    title: "Rhythmic Mirror Response",
    sub: "Tap a 4-beat pulse on a practice pad — invite the student to mirror it",
    procedure: "Demonstrate tap tap tap tap. Hand student a stick or invite them to use their hand. Observe whether they mirror immediately, delay, or avoid.",
  },
] as const;

const DRUM_TESTS = [
  {
    code: "DR-01", title: "Steady Beat Maintenance",
    sub: "Basic kick + snare on beats 1 & 3 / 2 & 4 · 80 BPM · 8 bars",
    rubric: [
      { grade: "High"   as Grade, desc: "Locked-in pulse from bar 1. Zero rushing or dragging through all 8 bars." },
      { grade: "Medium" as Grade, desc: "Generally steady with minor rushes in bars 5–6. Self-corrects by bar 7." },
      { grade: "Low"    as Grade, desc: "Cannot maintain steady pulse — either speeds up consistently or loses the beat." },
    ],
  },
  {
    code: "DR-02", title: "Limb Independence",
    sub: "Hi-hat 8th notes + kick on beat 1 + snare on beat 3 · simultaneously",
    rubric: [
      { grade: "High"   as Grade, desc: "All three limbs operate independently. No tension or stiffness between limbs." },
      { grade: "Medium" as Grade, desc: "Hi-hat slows when kick or snare fires. Minor sympathy movement but recovers." },
      { grade: "Low"    as Grade, desc: "Cannot maintain two limbs simultaneously. One limb stops when another plays." },
    ],
  },
  {
    code: "DR-03", title: "Rudiment Execution",
    sub: "Single stroke roll (R-L-R-L) then double stroke roll (R-R-L-L) · 4 bars each",
    rubric: [
      { grade: "High"   as Grade, desc: "Clean alternation on single strokes. Doubles rebound naturally without forcing." },
      { grade: "Medium" as Grade, desc: "Singles clean, but doubles require effort — wrist tension visible at faster tempo." },
      { grade: "Low"    as Grade, desc: "Strokes uneven or arm-heavy. Rebound not used — pushing each stroke manually." },
    ],
  },
] as const;

// ─── Config computations ──────────────────────────────────────────────────────
function computeFtConfig(r: Grade, d: Grade, p: Grade): DrumConfig {
  const all = [r, d, p];
  if (all.every(g => g === "High")) return {
    track: "Zeta Slab", syllabusStrategy: "Advanced Performance Track — Stage & Exam Ready",
    metronome: true, metronomeBpm: 100, stickType: "Drumsticks",
    kickPedalTechnique: "Both", tempoRange: "Fast (120+ BPM)", grooveComplexity: "Polyrhythmic",
  };
  if (all.some(g => g === "Low")) return {
    track: "Delta Slab", syllabusStrategy: "Structured Foundations — Rhythm Groundwork First",
    metronome: true, metronomeBpm: 60, stickType: "Drumsticks",
    kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
  };
  return {
    track: "Epsilon Slab", syllabusStrategy: "Accelerated Integration — Groove to Performance",
    metronome: true, metronomeBpm: 80, stickType: "Drumsticks",
    kickPedalTechnique: "Heel Down", tempoRange: "Medium (80–120 BPM)", grooveComplexity: "Syncopated Patterns",
  };
}

function computeJtConfig(posture: SensoryResp | null, flex: SensoryResp | null): DrumConfig {
  const low = posture === "Distress" || flex === "Distress" || posture === "Withdrawal" || flex === "Withdrawal";
  return low
    ? {
        track: "Delta Slab", syllabusStrategy: "Gentle Engagement — Comfort-First Approach",
        metronome: false, metronomeBpm: 60, stickType: "Brushes",
        kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
      }
    : {
        track: "Epsilon Slab", syllabusStrategy: "Joyful Groove — Leisure & Wellness Track",
        metronome: true, metronomeBpm: 70, stickType: "Drumsticks",
        kickPedalTechnique: "Heel Down", tempoRange: "Medium (80–120 BPM)", grooveComplexity: "Basic 4/4",
      };
}

function lmConfig(): DrumConfig {
  return {
    track: "Delta Slab", syllabusStrategy: "Early Rhythm Foundations — Play, Tap, Explore",
    metronome: false, metronomeBpm: 60, stickType: "Mallets",
    kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
  };
}

function ctConfig(enabled: boolean, bpm: number, stick: DrumConfig["stickType"]): DrumConfig {
  return {
    track: "Delta Slab", syllabusStrategy: "Creative Adaptive Track — Sensory-Safe Percussion Exploration",
    metronome: enabled, metronomeBpm: bpm, stickType: stick,
    kickPedalTechnique: "Heel Down", tempoRange: "Slow (< 80 BPM)", grooveComplexity: "Basic 4/4",
  };
}

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

// ─── Design primitives ────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18, padding: 24,
  boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
  padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.09em", display: "block", marginBottom: 8,
};
const grid12: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 };

// ─── Sub-components ───────────────────────────────────────────────────────────
function GradeCard({ code, title, sub, rubric, value, onChange, accent }: {
  code: string; title: string; sub: string;
  rubric: readonly { grade: Grade; desc: string }[];
  value: Grade | null; onChange: (g: Grade) => void; accent: string;
}) {
  return (
    <div style={{ ...card, gridColumn: "span 4" }}>
      <div style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: "0.1em",
          textTransform: "uppercase", background: `${accent}18`, padding: "2px 8px", borderRadius: 6 }}>
          {code}
        </span>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#111", marginTop: 8 }}>{title}</div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {rubric.map(({ grade, desc }) => {
          const sel = value === grade; const cfg = GRADE_CFG[grade];
          return (
            <button key={grade} onClick={() => onChange(grade)}
              style={{ textAlign: "left", border: `1.5px solid ${sel ? cfg.border : "#f0f0f0"}`,
                background: sel ? cfg.bg : "#fafafa", borderRadius: 10, padding: "9px 12px",
                cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: sel ? cfg.color : "#374151" }}>{grade}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stepper({ steps, current, accent }: { steps: string[]; current: number; accent: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", marginBottom: 28 }}>
      {steps.map((label, i) => {
        const n = i + 1; const done = current > n; const active = current === n;
        return (
          <div key={n} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{ width: 34, height: 34, borderRadius: "50%",
                background: done || active ? accent : "#f3f4f6",
                color: done || active ? "#fff" : "#9ca3af",
                boxShadow: active ? `0 0 0 5px ${accent}1a` : "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, flexShrink: 0, transition: "all 0.2s" }}>
                {done ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, marginTop: 6, fontWeight: active ? 700 : 400,
                color: active ? accent : done ? "#6b7280" : "#9ca3af", whiteSpace: "nowrap" }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ height: 2, width: 48, flexShrink: 0, alignSelf: "flex-start", marginTop: 16,
                background: done ? accent : "#f0f0f0", transition: "background 0.3s" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StudentSearch({ value, onChange, onSelect, onBlur, results, loading, showDropdown }: {
  value: string; onChange: (v: string) => void; onSelect: (s: StudentOption) => void;
  onBlur: () => void; results: StudentOption[]; loading: boolean; showDropdown: boolean;
}) {
  return (
    <div style={{ position: "relative" }}>
      <input value={value} onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="Search and select from the list…"
        style={{ ...inputStyle, paddingRight: loading ? 36 : 13 }} />
      {loading && (
        <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
          width: 14, height: 14, border: "2px solid #e5e7eb", borderTopColor: "#6b7280",
          borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      )}
      {showDropdown && results.length > 0 && (
        <div style={{ position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12,
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)", marginTop: 4, overflow: "hidden" }}>
          {results.map(s => (
            <button key={s.uid}
              onMouseDown={e => e.preventDefault()}
              onClick={() => onSelect(s)}
              style={{ width: "100%", textAlign: "left", padding: "10px 14px", border: "none",
                background: "none", cursor: "pointer", fontFamily: "inherit", display: "flex",
                alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #f3f4f6" }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "#111" }}>{s.name}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{s.studentID}</span>
            </button>
          ))}
        </div>
      )}
      {showDropdown && !loading && results.length === 0 && (
        <div style={{ position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12,
          padding: "12px 14px", marginTop: 4, fontSize: 13, color: "#9ca3af",
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)" }}>
          No students found.
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function DrumScreeningContent({ onBack }: { onBack?: () => void }) {
  const { user } = useAuthContext();
  const [stream, setStream]     = useState<DrumStream>("fast-track");
  const [step, setStep]         = useState(1);
  const [assessmentId, setAssessmentId] = useState(() => genId(STREAM_CFG["fast-track"].prefix));

  // Student search
  const [studentName,   setStudentName]   = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);

  // Save state
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  // ── LM state ──────────────────────────────────────────────────────────────
  const [lm_devFocus,         setLmDevFocus]    = useState("");
  const [lm_attention,        setLmAttention]   = useState("");
  const [lm_interactionStyle, setLmInteraction] = useState("");
  const [lm_grossMotor,       setLmGrossMotor]  = useState("");
  const [lm_tactile,          setLmTactile]     = useState<SensoryResp | null>(null);
  const [lm_rhythm,           setLmRhythm]      = useState<Grade | null>(null);
  const [lm_stickGrip,        setLmGrip]        = useState<Grade | null>(null);

  // ── FT state ──────────────────────────────────────────────────────────────
  const [ft_priorInstruments, setFtPrior]   = useState<string[]>([]);
  const [ft_performanceGoal,  setFtGoal]    = useState("");
  const [ft_drumLevel,        setFtLevel]   = useState("");
  const [ft_sightReading,     setFtSight]   = useState("");
  const [ft_rhythmGrade,      setFtRhythm]  = useState<Grade | null>(null);
  const [ft_dexterityGrade,   setFtDex]     = useState<Grade | null>(null);
  const [ft_rudimentGrade,    setFtRudiment]= useState<Grade | null>(null);

  // ── JT state ──────────────────────────────────────────────────────────────
  const [jt_genres,          setJtGenres]     = useState<string[]>([]);
  const [jt_motivation,      setJtMotivation] = useState("");
  const [jt_practiceTime,    setJtPractice]   = useState("");
  const [jt_physicalNotes,   setJtPhysical]   = useState("");
  const [jt_posture,         setJtPosture]    = useState<SensoryResp | null>(null);
  const [jt_handFlexibility, setJtFlex]       = useState<SensoryResp | null>(null);
  const [jt_visualMemory,    setJtVisual]     = useState<Grade | null>(null);

  // ── CT state ──────────────────────────────────────────────────────────────
  const [ct_emotionalTriggers, setCtTriggers]  = useState("");
  const [ct_soundThreshold,    setCtSound]     = useState("");
  const [ct_visualMods,        setCtVisual]    = useState("");
  const [ct_soundImpact,       setCtSoundImpact]  = useState<SensoryResp | null>(null);
  const [ct_vibration,         setCtVibration]    = useState<SensoryResp | null>(null);
  const [ct_rhythmMirror,      setCtRhythm]       = useState<SensoryResp | null>(null);
  const [ct_metronomeEnabled,  setCtMetronome] = useState(false);
  const [ct_metronomeBpm,      setCtBpm]       = useState(60);
  const [ct_stickType,         setCtStick]     = useState<DrumConfig["stickType"]>("Mallets");

  // ── Reset on stream change ─────────────────────────────────────────────────
  const resetAll = useCallback((s: DrumStream) => {
    setStep(1); setAssessmentId(genId(STREAM_CFG[s].prefix));
    setStudentName(""); setLinkedStudent(null); setShowDropdown(false);
    setSaved(false); setSaveErr(""); setSaving(false);
    setLmDevFocus(""); setLmAttention(""); setLmInteraction(""); setLmGrossMotor("");
    setLmTactile(null); setLmRhythm(null); setLmGrip(null);
    setFtPrior([]); setFtGoal(""); setFtLevel(""); setFtSight("");
    setFtRhythm(null); setFtDex(null); setFtRudiment(null);
    setJtGenres([]); setJtMotivation(""); setJtPractice(""); setJtPhysical("");
    setJtPosture(null); setJtFlex(null); setJtVisual(null);
    setCtTriggers(""); setCtSound(""); setCtVisual("");
    setCtSoundImpact(null); setCtVibration(null); setCtRhythm(null);
    setCtMetronome(false); setCtBpm(60); setCtStick("Mallets");
  }, []);

  useEffect(() => { resetAll(stream); }, [stream, resetAll]);

  // ── Student search (users + admissions) ───────────────────────────────────
  useEffect(() => {
    if (!studentName.trim() || linkedStudent) { setAllStudents([]); setShowDropdown(false); return; }
    const t = setTimeout(async () => {
      setStudsLoading(true);
      try {
        const term = studentName.toLowerCase();
        const uq = query(collection(db, "users"), where("role", "==", "student"));
        const [uSnap, aSnap] = await Promise.all([getDocs(uq), getDocs(collection(db, "admissions"))]);
        const users: StudentOption[] = uSnap.docs
          .map(d => ({ uid: d.id, ...(d.data() as { name: string; studentID: string }) }))
          .filter(s => s.name?.toLowerCase().includes(term) || s.studentID?.toLowerCase().includes(term));
        const applicants: StudentOption[] = aSnap.docs
          .map(d => {
            const data = d.data() as Record<string, string>;
            return { uid: d.id, name: data.fullName ?? "", studentID: "Applicant" };
          })
          .filter(s => s.name?.toLowerCase().includes(term) && s.name);
        const seen = new Set<string>();
        const merged: StudentOption[] = [];
        for (const s of [...users, ...applicants]) {
          if (!seen.has(s.name)) { seen.add(s.name); merged.push(s); }
          if (merged.length >= 8) break;
        }
        setAllStudents(merged); setShowDropdown(true);
      } finally { setStudsLoading(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [studentName, linkedStudent]);

  const selectStudent = (s: StudentOption) => {
    setLinkedStudent(s); setStudentName(s.name); setShowDropdown(false);
  };

  // ── Config derivation ──────────────────────────────────────────────────────
  const derivedConfig: DrumConfig | null = (() => {
    if (stream === "little-mozarts") return lmConfig();
    if (stream === "fast-track" && ft_rhythmGrade && ft_dexterityGrade && ft_rudimentGrade)
      return computeFtConfig(ft_rhythmGrade, ft_dexterityGrade, ft_rudimentGrade);
    if (stream === "joyful-track") return computeJtConfig(jt_posture, jt_handFlexibility);
    if (stream === "creative-track") return ctConfig(ct_metronomeEnabled, ct_metronomeBpm, ct_stickType);
    return null;
  })();

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!derivedConfig) return;
    setSaving(true); setSaveErr("");
    try {
      const payload: Record<string, unknown> = {
        assessmentId, stream, instrument: "drums",
        teacherId: user?.uid, teacherEmail: user?.email,
        studentId: linkedStudent?.uid ?? null,
        studentName: linkedStudent?.name ?? studentName,
        config: derivedConfig, createdAt: serverTimestamp(),
      };
      if (stream === "little-mozarts") Object.assign(payload, {
        lm_devFocus, lm_attention, lm_interactionStyle, lm_grossMotor,
        lm_tactile, lm_rhythm, lm_stickGrip: lm_stickGrip,
        lm_tactileScore: lm_tactile   ? SENSORY_SCORE[lm_tactile] : null,
        lm_rhythmScore:  lm_rhythm    ? GRADE_SCORE[lm_rhythm]    : null,
        lm_gripScore:    lm_stickGrip ? GRADE_SCORE[lm_stickGrip] : null,
      });
      if (stream === "fast-track") Object.assign(payload, {
        ft_priorInstruments, ft_performanceGoal, ft_drumLevel, ft_sightReading,
        ft_rhythmGrade, ft_dexterityGrade, ft_rudimentGrade,
        ft_totalScore: [ft_rhythmGrade, ft_dexterityGrade, ft_rudimentGrade]
          .filter(Boolean).reduce((a, g) => a + GRADE_SCORE[g!], 0),
      });
      if (stream === "joyful-track") Object.assign(payload, {
        jt_genres, jt_motivation, jt_practiceTime, jt_physicalNotes,
        jt_posture, jt_handFlexibility, jt_visualMemory,
      });
      if (stream === "creative-track") Object.assign(payload, {
        ct_emotionalTriggers, ct_soundThreshold, ct_visualMods,
        ct_soundImpact, ct_vibration, ct_rhythmMirror,
        ct_metronomeEnabled, ct_metronomeBpm, ct_stickType,
      });
      await addDoc(collection(db, "drum-screenings"), payload);
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };

  const sc = STREAM_CFG[stream];
  const ACCENT = sc.accent;
  const stepLabels = STEP_LABELS[stream];

  const btnPrimary: React.CSSProperties = {
    padding: "11px 22px", borderRadius: 12, border: "none", fontSize: 13, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center",
    background: ACCENT, color: "#fff", transition: "opacity 0.15s",
  };
  const btnSec: React.CSSProperties = { ...btnPrimary, background: "#f3f4f6", color: "#374151" };

  const sensoryColors: Record<SensoryResp, string> = {
    Positive: "#16a34a", Neutral: "#2563eb", Withdrawal: "#d97706", Distress: "#dc2626",
  };

  function SensoryPicker({ value, onChange }: { value: SensoryResp | null; onChange: (r: SensoryResp) => void }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {(["Positive", "Neutral", "Withdrawal", "Distress"] as SensoryResp[]).map(opt => {
          const sel = value === opt; const c = sensoryColors[opt];
          return (
            <button key={opt} onClick={() => onChange(opt)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                border: `1.5px solid ${sel ? c : "#f0f0f0"}`, background: sel ? `${c}14` : "#fafafa",
                borderRadius: 10, padding: "9px 12px", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
              <div style={{ width: 9, height: 9, borderRadius: "50%", background: sel ? c : "#d1d5db", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: sel ? 700 : 500, color: sel ? c : "#374151" }}>{opt}</span>
            </button>
          );
        })}
      </div>
    );
  }

  function SensoryRow({ value, onChange }: { value: SensoryResp | null; onChange: (r: SensoryResp) => void }) {
    return (
      <div style={{ display: "flex", gap: 6 }}>
        {(["Positive", "Neutral", "Withdrawal", "Distress"] as SensoryResp[]).map(opt => {
          const sel = value === opt; const c = sensoryColors[opt];
          return (
            <button key={opt} onClick={() => onChange(opt)}
              style={{ flex: 1, padding: "6px 4px", borderRadius: 8,
                border: `1.5px solid ${sel ? c : "#f0f0f0"}`, background: sel ? `${c}14` : "#fafafa",
                fontSize: 10, fontWeight: sel ? 700 : 500, color: sel ? c : "#6b7280",
                cursor: "pointer", fontFamily: "inherit" }}>
              {opt}
            </button>
          );
        })}
      </div>
    );
  }

  function ConfigRows({ cfg }: { cfg: DrumConfig }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[
          { label: "Track",            val: cfg.track },
          { label: "Strategy",         val: cfg.syllabusStrategy },
          { label: "Metronome",        val: cfg.metronome ? `Yes @ ${cfg.metronomeBpm} BPM` : "No" },
          { label: "Stick Type",       val: cfg.stickType },
          { label: "Kick Pedal",       val: cfg.kickPedalTechnique },
          { label: "Tempo Range",      val: cfg.tempoRange },
          { label: "Groove Complexity",val: cfg.grooveComplexity },
        ].map(({ label, val }) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 12px", background: "#f8f9fa", borderRadius: 10 }}>
            <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{val}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderSaveRow() {
    if (saved) {
      return (
        <div style={{ ...card, gridColumn: "span 12", textAlign: "center", borderColor: "#16a34a", background: "#f0fdf4" }}>
          <div style={{ fontSize: 20, marginBottom: 6 }}>✓</div>
          <div style={{ fontWeight: 700, color: "#15803d", fontSize: 15 }}>Screening Saved</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>Assessment ID: {assessmentId}</div>
        </div>
      );
    }
    return (
      <div style={{ ...card, gridColumn: "span 12" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111" }}>Save to Firebase</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
              Saves to{" "}
              <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4 }}>drum-screenings</code>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <button onClick={handleSave} disabled={saving || !derivedConfig}
              style={{ ...btnPrimary, opacity: saving || !derivedConfig ? 0.5 : 1, minWidth: 160 }}>
              {saving ? "Saving…" : "Save Screening"}
            </button>
            {saveErr && <div style={{ fontSize: 12, color: "#dc2626" }}>{saveErr}</div>}
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa", padding: "24px 0" }}>
      <style>{`@keyframes spin{to{transform:translateY(-50%) rotate(360deg)}}`}</style>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 24px" }}>

        {/* Back + ID row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
          {onBack
            ? <button onClick={onBack} style={{ ...btnSec, padding: "8px 16px", fontSize: 12 }}>← Back</button>
            : <Link href="/dashboard/screening" style={{ ...btnSec, padding: "8px 16px", fontSize: 12, textDecoration: "none" }}>← Back</Link>
          }
          <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.06em" }}>
            ID: {assessmentId}
          </div>
        </div>

        {/* Gradient header */}
        <div style={{ background: "linear-gradient(135deg, #dc2626 0%, #dc262699 100%)",
          borderRadius: 20, padding: "28px 32px", marginBottom: 22, color: "#fff",
          boxShadow: "0 8px 32px rgba(220,38,38,0.35)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, opacity: 0.75, textTransform: "uppercase",
            letterSpacing: "0.12em", marginBottom: 6 }}>Drum Screening</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{sc.label}</div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>{sc.age} · Drum-specific adaptive questionnaire</div>
        </div>

        {/* Stream tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
          {(Object.entries(STREAM_CFG) as [DrumStream, typeof STREAM_CFG["fast-track"]][]).map(([key, cfg]) => {
            const active = stream === key;
            return (
              <button key={key} onClick={() => setStream(key)}
                style={{ padding: "9px 18px", borderRadius: 12,
                  border: `1.5px solid ${active ? cfg.accent : "#e5e7eb"}`,
                  background: active ? cfg.accent : "#fff",
                  color: active ? "#fff" : "#6b7280",
                  fontSize: 12, fontWeight: active ? 700 : 500, cursor: "pointer",
                  fontFamily: "inherit", transition: "all 0.18s" }}>
                {cfg.label}
              </button>
            );
          })}
        </div>

        {/* Stepper */}
        <Stepper steps={stepLabels} current={step} accent={ACCENT} />

        {/* ── Step 1: Student Info ─────────────────────────────────────────── */}
        {step === 1 && (
          <div style={grid12}>
            <div style={{ ...card, gridColumn: "span 7" }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#111", marginBottom: 18 }}>
                Student Information
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Search Student</label>
                <StudentSearch value={studentName}
                  onChange={v => { setStudentName(v); setLinkedStudent(null); }}
                  onSelect={selectStudent} results={allStudents}
                  loading={studsLoading} showDropdown={showDropdown}
                  onBlur={() => { if (!linkedStudent) { setStudentName(""); setShowDropdown(false); } }} />
                {linkedStudent && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#059669", fontWeight: 600 }}>
                    ✓ Linked: {linkedStudent.name} ({linkedStudent.studentID})
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>Assessment ID</label>
                <input value={assessmentId} readOnly
                  style={{ ...inputStyle, color: "#9ca3af", background: "#f8f9fa" }} />
              </div>
            </div>

            <div style={{ ...card, gridColumn: "span 5" }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#111", marginBottom: 14 }}>
                Stream Overview
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { label: "Instrument", val: "Drums" },
                  { label: "Stream",     val: sc.label },
                  { label: "Age Group",  val: sc.age   },
                  { label: "Steps",      val: `${stepLabels.length} phases` },
                ].map(({ label, val }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "9px 13px", background: "#f8f9fa", borderRadius: 10 }}>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setStep(2)} disabled={!linkedStudent}
                style={{ ...btnPrimary, opacity: !linkedStudent ? 0.4 : 1 }}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Stream questionnaire ─────────────────────────────────── */}
        {step === 2 && (
          <>
            {/* LITTLE MOZARTS */}
            {stream === "little-mozarts" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Early Development Profile
                  </div>
                  {[
                    { label: "Developmental Focus",   val: lm_devFocus,        set: setLmDevFocus,    ph: "Gross motor, exploratory play, social…"        },
                    { label: "Attention Span",         val: lm_attention,       set: setLmAttention,   ph: "Estimated in minutes, context…"                },
                    { label: "Interaction Style",      val: lm_interactionStyle,set: setLmInteraction, ph: "Verbal, guided, observer, parallel play…"      },
                    { label: "Gross Motor Observation",val: lm_grossMotor,      set: setLmGrossMotor,  ph: "Arm reach, bilateral coordination, energy…"    },
                  ].map(({ label, val, set, ph }) => (
                    <div key={label} style={{ marginBottom: 14 }}>
                      <label style={labelStyle}>{label}</label>
                      <input value={val} onChange={e => set(e.target.value)} placeholder={ph} style={inputStyle} />
                    </div>
                  ))}
                </div>

                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Sound Impact Sensitivity
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16, lineHeight: 1.6 }}>
                    Strike a practice pad once with a mallet — observe the child's immediate reaction without prompting.
                  </div>
                  <SensoryPicker value={lm_tactile} onChange={setLmTactile} />
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} style={btnPrimary}>Continue →</button>
                </div>
              </div>
            )}

            {/* FAST TRACK */}
            {stream === "fast-track" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Background Information
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Prior Instruments</label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {PRIOR_INSTRUMENTS.map(inst => {
                        const sel = ft_priorInstruments.includes(inst);
                        return (
                          <button key={inst}
                            onClick={() => setFtPrior(p => sel ? p.filter(x => x !== inst) : [...p, inst])}
                            style={{ padding: "6px 12px", borderRadius: 8,
                              border: `1.5px solid ${sel ? ACCENT : "#e5e7eb"}`,
                              background: sel ? `${ACCENT}18` : "#fafafa",
                              color: sel ? ACCENT : "#6b7280",
                              fontSize: 12, fontWeight: sel ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>
                            {inst}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Self-Reported Drum Level</label>
                    <select value={ft_drumLevel} onChange={e => setFtLevel(e.target.value)}
                      style={{ ...inputStyle, appearance: "none" }}>
                      <option value="">Select level…</option>
                      {["Complete Beginner", "Beginner", "Elementary", "Intermediate", "Advanced"].map(v =>
                        <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Sheet Music / Notation Ability</label>
                    <select value={ft_sightReading} onChange={e => setFtSight(e.target.value)}
                      style={{ ...inputStyle, appearance: "none" }}>
                      <option value="">Select…</option>
                      {["None", "Some", "Regular"].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Performance Goals
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {PERF_GOALS.map(g => {
                      const sel = ft_performanceGoal === g.id;
                      return (
                        <button key={g.id} onClick={() => setFtGoal(g.id)}
                          style={{ textAlign: "left", border: `1.5px solid ${sel ? ACCENT : "#f0f0f0"}`,
                            background: sel ? `${ACCENT}10` : "#fafafa", borderRadius: 10,
                            padding: "10px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: sel ? ACCENT : "#111" }}>{g.label}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{g.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} disabled={!ft_drumLevel || !ft_performanceGoal}
                    style={{ ...btnPrimary, opacity: !ft_drumLevel || !ft_performanceGoal ? 0.4 : 1 }}>
                    Continue →
                  </button>
                </div>
              </div>
            )}

            {/* JOYFUL TRACK */}
            {stream === "joyful-track" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 7" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Musical Background
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Favourite Genres</label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {JT_GENRES.map(g => {
                        const sel = jt_genres.includes(g);
                        return (
                          <button key={g}
                            onClick={() => setJtGenres(gs => sel ? gs.filter(x => x !== g) : [...gs, g])}
                            style={{ padding: "6px 12px", borderRadius: 8,
                              border: `1.5px solid ${sel ? ACCENT : "#e5e7eb"}`,
                              background: sel ? `${ACCENT}18` : "#fafafa",
                              color: sel ? ACCENT : "#6b7280",
                              fontSize: 12, fontWeight: sel ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>
                            {g}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>Motivation for Drums</label>
                    <textarea value={jt_motivation} onChange={e => setJtMotivation(e.target.value)}
                      rows={3} placeholder="Why do they want to learn drums at this stage of life?"
                      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Available Practice Time (per week)</label>
                    <select value={jt_practiceTime} onChange={e => setJtPractice(e.target.value)}
                      style={{ ...inputStyle, appearance: "none" }}>
                      <option value="">Select…</option>
                      {["< 1 hour", "1–2 hours", "3–5 hours", "5+ hours"].map(v =>
                        <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 5" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Physical Considerations
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={labelStyle}>Physical Notes</label>
                    <textarea value={jt_physicalNotes} onChange={e => setJtPhysical(e.target.value)}
                      rows={3} placeholder="Shoulder/wrist issues, grip strength, stamina, joint mobility…"
                      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, marginBottom: 8 }}>
                    Seated Posture at Kit
                  </div>
                  <SensoryPicker value={jt_posture} onChange={setJtPosture} />
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} style={btnPrimary}>Continue →</button>
                </div>
              </div>
            )}

            {/* CREATIVE TRACK */}
            {stream === "creative-track" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Sensory Profile
                  </div>
                  {[
                    { label: "Emotional Triggers",          val: ct_emotionalTriggers, set: setCtTriggers,
                      ph: "Loud sounds, sudden impacts, vibration sensitivity…"        },
                    { label: "Sound / Volume Threshold",    val: ct_soundThreshold,    set: setCtSound,
                      ph: "Reactions to snare crack, cymbal wash, bass drum thud…"    },
                    { label: "Visual Modifications Needed", val: ct_visualMods,        set: setCtVisual,
                      ph: "Low-light preference, visual clutter, music stand needs…"  },
                  ].map(({ label, val, set, ph }) => (
                    <div key={label} style={{ marginBottom: 14 }}>
                      <label style={labelStyle}>{label}</label>
                      <textarea value={val} onChange={e => set(e.target.value)} rows={3}
                        placeholder={ph} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
                    </div>
                  ))}
                </div>

                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Drum Sensory Tests
                  </div>
                  {SENSORY_TESTS.map(({ id, title, sub }) => {
                    const val = id === "soundImpact" ? ct_soundImpact
                              : id === "vibrationResponse" ? ct_vibration
                              : ct_rhythmMirror;
                    const set = id === "soundImpact" ? setCtSoundImpact
                              : id === "vibrationResponse" ? setCtVibration
                              : setCtRhythm;
                    return (
                      <div key={id} style={{ marginBottom: 18 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#111", marginBottom: 2 }}>{title}</div>
                        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>{sub}</div>
                        <SensoryRow value={val} onChange={set} />
                      </div>
                    );
                  })}
                </div>

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
                  <button onClick={() => setStep(1)} style={btnSec}>← Back</button>
                  <button onClick={() => setStep(3)} style={btnPrimary}>Continue →</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Step 3: Assessment / Config & Save ───────────────────────────── */}
        {step === 3 && (
          <>
            {/* LITTLE MOZARTS */}
            {stream === "little-mozarts" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Early Drum Assessment
                  </div>
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ ...labelStyle, marginBottom: 10 }}>Rhythmic Tapping Response</label>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.6 }}>
                      Teacher taps a 4-beat pulse on a practice pad — observe if the child joins in.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {(["High", "Medium", "Low"] as Grade[]).map(g => {
                        const sel = lm_rhythm === g; const cfg = GRADE_CFG[g];
                        return (
                          <button key={g} onClick={() => setLmRhythm(g)}
                            style={{ textAlign: "left", border: `1.5px solid ${sel ? cfg.border : "#f0f0f0"}`,
                              background: sel ? cfg.bg : "#fafafa", borderRadius: 10,
                              padding: "9px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: sel ? cfg.color : "#374151" }}>{g}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label style={{ ...labelStyle, marginBottom: 10 }}>Stick Grip Comfort</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {(["High", "Medium", "Low"] as Grade[]).map(g => {
                        const sel = lm_stickGrip === g; const cfg = GRADE_CFG[g];
                        return (
                          <button key={g} onClick={() => setLmGrip(g)}
                            style={{ textAlign: "left", border: `1.5px solid ${sel ? cfg.border : "#f0f0f0"}`,
                              background: sel ? cfg.bg : "#fafafa", borderRadius: 10,
                              padding: "9px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: sel ? cfg.color : "#374151" }}>{g}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 14 }}>
                    Recommended Config
                  </div>
                  <ConfigRows cfg={lmConfig()} />
                </div>

                {renderSaveRow()}
                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                  <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                </div>
              </div>
            )}

            {/* FAST TRACK */}
            {stream === "fast-track" && (
              <div style={grid12}>
                {DRUM_TESTS.map((t, i) => (
                  <GradeCard key={t.code} code={t.code} title={t.title} sub={t.sub}
                    rubric={t.rubric} accent={ACCENT}
                    value={i === 0 ? ft_rhythmGrade : i === 1 ? ft_dexterityGrade : ft_rudimentGrade}
                    onChange={g => {
                      if (i === 0) setFtRhythm(g);
                      else if (i === 1) setFtDex(g);
                      else setFtRudiment(g);
                    }} />
                ))}

                {ft_rhythmGrade && ft_dexterityGrade && ft_rudimentGrade && (() => {
                  const cfg = computeFtConfig(ft_rhythmGrade, ft_dexterityGrade, ft_rudimentGrade);
                  const sc2 = SLAB_CFG[cfg.track];
                  const total = GRADE_SCORE[ft_rhythmGrade] + GRADE_SCORE[ft_dexterityGrade] + GRADE_SCORE[ft_rudimentGrade];
                  return (
                    <>
                      <div style={{ ...card, gridColumn: "span 12",
                        border: `2px solid ${sc2.border}`, background: sc2.bg,
                        boxShadow: `0 0 0 4px ${sc2.glow}, 0 4px 14px rgba(0,0,0,0.04)` }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 800, color: sc2.color }}>{cfg.track}</div>
                            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{cfg.syllabusStrategy}</div>
                          </div>
                          <div style={{ background: sc2.border, color: "#fff",
                            padding: "6px 16px", borderRadius: 10, fontSize: 14, fontWeight: 800 }}>
                            {total}/15
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                          {[
                            { label: "Stick Type",        val: cfg.stickType },
                            { label: "Kick Pedal",        val: cfg.kickPedalTechnique },
                            { label: "Tempo Range",       val: cfg.tempoRange },
                            { label: "Groove Complexity", val: cfg.grooveComplexity },
                          ].map(({ label, val }) => (
                            <div key={label} style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.08)",
                              borderRadius: 10, padding: "7px 14px" }}>
                              <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: sc2.color, marginTop: 2 }}>{val}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      {renderSaveRow()}
                    </>
                  );
                })()}

                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                  <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                </div>
              </div>
            )}

            {/* JOYFUL TRACK */}
            {stream === "joyful-track" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Wrist & Arm Flexibility Check
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 14, lineHeight: 1.6 }}>
                    Ask the student to rotate both wrists in full circles, then extend arms outward for 5 seconds.
                    Observe range of motion and any discomfort.
                  </div>
                  <SensoryPicker value={jt_handFlexibility} onChange={setJtFlex} />
                </div>

                <div style={{ ...card, gridColumn: "span 6" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Recommended Config
                  </div>
                  {(() => {
                    const cfg = computeJtConfig(jt_posture, jt_handFlexibility);
                    const sc2 = SLAB_CFG[cfg.track];
                    return (
                      <>
                        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 12,
                          background: sc2.bg, border: `1.5px solid ${sc2.border}` }}>
                          <div style={{ fontWeight: 800, fontSize: 16, color: sc2.color }}>{cfg.track}</div>
                          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{cfg.syllabusStrategy}</div>
                        </div>
                        <ConfigRows cfg={cfg} />
                      </>
                    );
                  })()}
                </div>

                {renderSaveRow()}
                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                  <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                </div>
              </div>
            )}

            {/* CREATIVE TRACK */}
            {stream === "creative-track" && (
              <div style={grid12}>
                <div style={{ ...card, gridColumn: "span 7" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 16 }}>
                    Teacher Overrides
                  </div>

                  <div style={{ marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#111" }}>Enable Metronome / Click Track</div>
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>Only if the student shows no pulse sensitivity</div>
                    </div>
                    <div onClick={() => setCtMetronome(m => !m)}
                      style={{ width: 42, height: 24, borderRadius: 12, cursor: "pointer",
                        background: ct_metronomeEnabled ? ACCENT : "#e5e7eb", position: "relative",
                        transition: "background 0.2s" }}>
                      <div style={{ position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%",
                        background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "left 0.2s",
                        left: ct_metronomeEnabled ? 21 : 3 }} />
                    </div>
                  </div>

                  {ct_metronomeEnabled && (
                    <div style={{ marginBottom: 18 }}>
                      <label style={labelStyle}>Click Track BPM</label>
                      <input type="number" min={40} max={120} value={ct_metronomeBpm}
                        onChange={e => setCtBpm(Number(e.target.value))} style={inputStyle} />
                    </div>
                  )}

                  <div>
                    <label style={labelStyle}>Stick / Mallet Type</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["Drumsticks", "Brushes", "Mallets"] as DrumConfig["stickType"][]).map(opt => {
                        const sel = ct_stickType === opt;
                        return (
                          <button key={opt} onClick={() => setCtStick(opt)}
                            style={{ flex: 1, padding: "9px 10px", borderRadius: 10, cursor: "pointer",
                              fontFamily: "inherit", border: `1.5px solid ${sel ? ACCENT : "#e5e7eb"}`,
                              background: sel ? `${ACCENT}14` : "#fafafa",
                              color: sel ? ACCENT : "#6b7280", fontSize: 12, fontWeight: sel ? 700 : 400 }}>
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 5" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111", marginBottom: 14 }}>
                    Adaptive Config
                  </div>
                  {(() => {
                    const cfg = ctConfig(ct_metronomeEnabled, ct_metronomeBpm, ct_stickType);
                    const sc2 = SLAB_CFG[cfg.track];
                    return (
                      <>
                        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 12,
                          background: sc2.bg, border: `1.5px solid ${sc2.border}` }}>
                          <div style={{ fontWeight: 800, fontSize: 16, color: sc2.color }}>{cfg.track}</div>
                          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{cfg.syllabusStrategy}</div>
                        </div>
                        <ConfigRows cfg={cfg} />
                      </>
                    );
                  })()}
                </div>

                {renderSaveRow()}
                <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
                  <button onClick={() => setStep(2)} style={btnSec}>← Back</button>
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
