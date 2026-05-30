"use client";

import { useState, useEffect, useMemo } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening } from "@/services/screening/screening.service";
import type { ScreeningConfig } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────
type PatternResult = "ease" | "support" | null;
type PracticeTime  = "casual" | "weekly" | "regular" | "daily" | null;
type PrimaryFocus  = "stress-relief" | "brain-exercise" | "leisure" | null;
interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Constants ────────────────────────────────────────────────────────────────
const ACCENT = "#db2777";

const GENRES = [
  { id: "classical",    label: "Classical",   icon: "🎻" },
  { id: "pop",          label: "Pop",          icon: "🎤" },
  { id: "hymns",        label: "Hymns",        icon: "🙏" },
  { id: "classic-rock", label: "Classic Rock", icon: "🎸" },
  { id: "jazz",         label: "Jazz",         icon: "🎷" },
  { id: "devotional",   label: "Devotional",   icon: "✨" },
  { id: "folk",         label: "Folk",         icon: "🪕" },
  { id: "film",         label: "Film Music",   icon: "🎬" },
] as const;
type GenreId = typeof GENRES[number]["id"];

const FOCUS_OPTIONS: { id: PrimaryFocus; icon: string; label: string; desc: string }[] = [
  { id: "stress-relief",  icon: "🌿", label: "Stress Relief",   desc: "Music as a calm, therapeutic escape from daily demands" },
  { id: "brain-exercise", icon: "🧠", label: "Brain Exercise",  desc: "Keeping the mind sharp and memory active through music"  },
  { id: "leisure",        icon: "☀️",  label: "Leisure Playing", desc: "Pure enjoyment — playing favourite tunes at your own pace" },
];

const PRACTICE_OPTIONS: { id: PracticeTime; label: string; sub: string }[] = [
  { id: "casual",  label: "Casual",      sub: "Under 30 min / week — whenever the mood strikes" },
  { id: "weekly",  label: "Once a Week", sub: "Around 1–2 sessions per week, roughly 30–60 min" },
  { id: "regular", label: "A Few Times", sub: "3–5 short sessions a week, 15–30 min each"       },
  { id: "daily",   label: "Daily Habit", sub: "A little every day, building a gentle routine"   },
];

const PHYSICAL_NEEDS = [
  { id: "arthritis", label: "Arthritis or Joint Sensitivity",   desc: "Needs lower-tension keys or warm-up guidance"        },
  { id: "stiffness", label: "Finger Stiffness",                 desc: "Reduced grip strength or reduced dexterity"          },
  { id: "vision",    label: "Vision Support (Larger Notation)", desc: "Benefits from enlarged sheet music print size"        },
  { id: "posture",   label: "Posture or Seating Needs",         desc: "Requires chair height or wrist position adjustments" },
  { id: "hearing",   label: "Hearing Sensitivity",              desc: "Prefers lower volume or specific tone ranges"         },
  { id: "memory",    label: "Memory Support",                   desc: "Benefits from slower repetition and review loops"    },
] as const;
type PhysicalNeedId = typeof PHYSICAL_NEEDS[number]["id"];

const PATTERNS = [
  { id: "seq-a", display: "C → E → G", notes: [{ shape: "circle", color: "#f97316", label: "DO" }, { shape: "triangle", color: "#8b5cf6", label: "MI" }, { shape: "square", color: "#0ea5e9", label: "SOL" }] },
  { id: "seq-b", display: "G → C → E", notes: [{ shape: "square", color: "#0ea5e9", label: "SOL" }, { shape: "circle", color: "#f97316", label: "DO" }, { shape: "triangle", color: "#8b5cf6", label: "MI" }] },
  { id: "seq-c", display: "E → G → C", notes: [{ shape: "triangle", color: "#8b5cf6", label: "MI" }, { shape: "square", color: "#0ea5e9", label: "SOL" }, { shape: "circle", color: "#f97316", label: "DO" }] },
];

// ─── Config ───────────────────────────────────────────────────────────────────
function computeJoyfulConfig(pattern: PatternResult, practice: PracticeTime): ScreeningConfig {
  const isEpsilon = pattern === "ease" || practice === "regular" || practice === "daily";
  if (isEpsilon) return {
    track: "Epsilon Slab", syllabusStrategy: "Joyful Progression — Melody-First, Comfortable Pacing",
    metronome: true, metronomeBpm: 65, handIntegration: "Hands Separated",
    chords: "Basic Blocks", songsheetDifficulty: "Standard/Easier",
  };
  return {
    track: "Delta Slab", syllabusStrategy: "Gentle Beginnings — Stress-Free Rote and Listening",
    metronome: false, metronomeBpm: null, handIntegration: "RH Only",
    chords: false, songsheetDifficulty: "Simplified/Rote",
  };
}

function practiceScore(p: PracticeTime): number {
  if (p === "daily")   return 4.5;
  if (p === "regular") return 3.5;
  if (p === "weekly")  return 3.0;
  return 2.5;
}

// ─── Design primitives ────────────────────────────────────────────────────────
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
  const steps = ["Student & Goals", "Wellbeing", "Pattern & Result"];
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
                boxShadow: active ? `0 0 0 5px rgba(219,39,119,0.1)` : "none",
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

// ─── Note shape ───────────────────────────────────────────────────────────────
function NoteShape({ shape, color, label }: { shape: string; color: string; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
      <div style={{
        width: 44, height: 44,
        background: color,
        borderRadius: shape === "circle" ? "50%" : shape === "square" ? 10 : 0,
        clipPath: shape === "triangle" ? "polygon(50% 4%, 96% 92%, 4% 92%)" : undefined,
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: `0 4px 14px ${color}44`,
      }}>
        {shape !== "triangle" && <span style={{ color: "#fff", fontWeight: 900, fontSize: 12 }}>{label}</span>}
      </div>
      {shape === "triangle" && <span style={{ fontWeight: 900, fontSize: 11, color }}>{label}</span>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export function JoyfulTrackContent({ onBack }: { onBack?: () => void } = {}) {
  const { user } = useAuthContext();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [students,        setStudents]        = useState<StudentOption[]>([]);
  const [studentSearch,   setStudentSearch]   = useState("");
  const [selectedStudent, setSelectedStudent] = useState<StudentOption | null>(null);
  const [studentName,     setStudentName]     = useState("");
  const [showDropdown,    setShowDropdown]    = useState(false);

  const [genres,       setGenres]       = useState<GenreId[]>([]);
  const [primaryFocus, setPrimaryFocus] = useState<PrimaryFocus>(null);
  const [practiceTime, setPracticeTime] = useState<PracticeTime>(null);

  const [physicalNeeds, setPhysicalNeeds] = useState<PhysicalNeedId[]>([]);

  const [patternIdx,      setPatternIdx]      = useState(0);
  const [patternRevealed, setPatternRevealed] = useState(false);
  const [patternResult,   setPatternResult]   = useState<PatternResult>(null);

  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [assessmentId] = useState(() => {
    const d = new Date();
    return `JT-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${Math.floor(Math.random()*0x10000).toString(16).toUpperCase().padStart(4,"0")}`;
  });

  useEffect(() => {
    if (!db) return;
    getDocs(query(collection(db, "users"), where("role", "==", "student"))).then(snap => {
      setStudents(snap.docs.map(d => ({ uid: d.id, name: (d.data().displayName ?? "") as string, studentID: (d.data().studentID ?? "") as string })).sort((a, b) => a.name.localeCompare(b.name)));
    });
  }, []);

  const filteredStudents = useMemo(() =>
    studentSearch.length < 2 ? [] :
    students.filter(s => s.name.toLowerCase().includes(studentSearch.toLowerCase()) || s.studentID.toLowerCase().includes(studentSearch.toLowerCase())).slice(0, 6),
    [students, studentSearch]
  );

  function toggleGenre(id: GenreId) { setGenres(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]); }
  function togglePhysical(id: PhysicalNeedId) { setPhysicalNeeds(prev => prev.includes(id) ? prev.filter(n => n !== id) : [...prev, id]); }

  const currentPattern = PATTERNS[patternIdx];

  const config = useMemo<ScreeningConfig | null>(() => {
    if (!patternResult || !practiceTime) return null;
    return computeJoyfulConfig(patternResult, practiceTime);
  }, [patternResult, practiceTime]);

  const canSave = !!studentName.trim() && genres.length > 0 && !!primaryFocus && !!practiceTime && !!patternResult && !!config;

  async function handleSave() {
    if (!canSave || !config) return;
    setSaving(true); setSaveErr("");
    try {
      const baseScore = practiceScore(practiceTime);
      await saveScreening({
        screeningType: "joyful-track", childName: studentName.trim(),
        rhythmScore: baseScore, pitchScore: baseScore, motorScore: baseScore, averageScore: baseScore,
        config, screenedBy: user?.uid ?? "", screenedAt: new Date().toISOString(),
        studentId: selectedStudent?.uid ?? null,
        learningMotivation: primaryFocus === "stress-relief" ? "Option A: Stress Relief" : primaryFocus === "brain-exercise" ? "Option B: Brain Exercise" : "Option C: Leisure Playing",
        pacingPreference: practiceTime === "casual" ? "Option A: Casual" : practiceTime === "weekly" ? "Option B: Once a Week" : practiceTime === "regular" ? "Option C: A Few Times" : "Option D: Daily Habit",
        musicalBackground: genres.join(", "),
        sensoryProfile: physicalNeeds.length > 0 ? physicalNeeds.join(", ") : undefined,
      });
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (saved && config) {
    const isEpsilon = config.track === "Epsilon Slab";
    const sc = isEpsilon
      ? { bg: "#fffbeb", border: "#fde68a", color: "#92400e", glow: "rgba(217,119,6,0.13)" }
      : { bg: "#fef2f2", border: "#fecaca", color: "#991b1b", glow: "rgba(220,38,38,0.13)" };
    return (
      <div style={{ maxWidth: 540, margin: "40px auto", padding: "0 16px", textAlign: "center" }}>
        <div style={{ ...card, border: `2px solid ${sc.border}`, background: sc.bg, boxShadow: `0 8px 40px ${sc.glow}`, padding: "48px 36px" }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>🌻</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#831843", marginBottom: 6 }}>Welcome to the Joyful Track!</div>
          <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 28 }}>Screening saved for <strong style={{ color: "#374151" }}>{studentName}</strong></div>
          <div style={{ background: "rgba(255,255,255,0.6)", borderRadius: 14, padding: "20px", marginBottom: 28, textAlign: "left" as const }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: sc.color, marginBottom: 6 }}>{config.track}</div>
            <div style={{ fontSize: 12, color: sc.color, fontWeight: 600 }}>{config.syllabusStrategy}</div>
          </div>
          {onBack
            ? <button onClick={onBack} style={{ ...btnBase, background: ACCENT, color: "#fff", justifyContent: "center" }}>← Back to Hub</button>
            : <Link href="/dashboard/screening" style={{ ...btnBase, background: ACCENT, color: "#fff", justifyContent: "center", textDecoration: "none" }}>← Back to Hub</Link>
          }
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 0 60px" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        background: "linear-gradient(135deg, #fdf2f8, #fce7f3, #fff7ed)",
        border: "1px solid #fbcfe8", borderRadius: 20, padding: "22px 28px",
        marginBottom: 22, display: "flex", alignItems: "center",
        justifyContent: "space-between", flexWrap: "wrap" as const, gap: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🌻</div>
          <div>
            <div style={{ fontSize: 19, fontWeight: 900, color: "#831843" }}>The Joyful Track</div>
            <div style={{ fontSize: 12, color: "#9d174d", opacity: 0.8, marginTop: 2 }}>Adult Hobby Screening · Ages 31+ · Relaxed & Self-Paced</div>
          </div>
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "monospace" }}>ASSESSMENT ID</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, fontFamily: "monospace" }}>{assessmentId}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>{new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
      </div>

      {/* ── Stepper ────────────────────────────────────────────────────────── */}
      <Stepper step={step} />

      {/* ── Step 1: Student & Goals ─────────────────────────────────────────── */}
      {step === 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          {/* Student search */}
          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Who is this screening for?</div>
            <div style={{ position: "relative" }}>
              <input value={studentSearch}
                onChange={e => { setStudentSearch(e.target.value); setStudentName(e.target.value); setSelectedStudent(null); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                placeholder="Search by name or student ID…"
                style={inputStyle} />
              {showDropdown && filteredStudents.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #fbcfe8", borderRadius: "0 0 12px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.08)", marginTop: 2, overflow: "hidden" }}>
                  {filteredStudents.map(s => (
                    <div key={s.uid} onClick={() => { setSelectedStudent(s); setStudentName(s.name); setStudentSearch(s.name); setShowDropdown(false); }}
                      style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #fce7f3", fontSize: 13, display: "flex", justifyContent: "space-between" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#fdf2f8")}
                      onMouseLeave={e => (e.currentTarget.style.background = "#fff")}>
                      <span style={{ fontWeight: 700 }}>{s.name}</span>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>{s.studentID}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedStudent && <div style={{ marginTop: 8, fontSize: 12, color: "#16a34a" }}>✓ Linked — {selectedStudent.studentID}</div>}
          </div>

          {/* Genres */}
          <div style={{ ...card, gridColumn: "span 7" }}>
            <div style={labelStyle}>Musical Genres</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>Select all that apply — shapes which repertoire we introduce first.</div>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
              {GENRES.map(g => {
                const active = genres.includes(g.id);
                return (
                  <button key={g.id} type="button" onClick={() => toggleGenre(g.id)} style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "8px 15px", borderRadius: 99, fontFamily: "inherit",
                    border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    background: active ? "#fdf2f8" : "#fafafa",
                    color: active ? "#9d174d" : "#6b7280",
                    fontSize: 12, fontWeight: active ? 700 : 500, cursor: "pointer",
                  }}>
                    <span style={{ fontSize: 15 }}>{g.icon}</span>{g.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Primary focus */}
          <div style={{ ...card, gridColumn: "span 5" }}>
            <div style={labelStyle}>Primary Reason</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>Guides the emotional tone and pacing.</div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 9 }}>
              {FOCUS_OPTIONS.map(f => {
                const active = primaryFocus === f.id;
                return (
                  <div key={f.id} onClick={() => setPrimaryFocus(f.id)} style={{
                    border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    borderRadius: 14, background: active ? "#fdf2f8" : "#fafafa",
                    padding: "13px 14px", cursor: "pointer", transition: "all 0.12s",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 18 }}>{f.icon}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: active ? "#9d174d" : "#374151" }}>{f.label}</span>
                      {active && <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 800, background: "#fce7f3", color: "#9d174d", borderRadius: 99, padding: "2px 8px" }}>SELECTED</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", paddingLeft: 26 }}>{f.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Practice time */}
          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Weekly Practice Estimate</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16 }}>Honest estimates help match lesson density to lifestyle — there is no wrong answer.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {PRACTICE_OPTIONS.map(p => {
                const active = practiceTime === p.id;
                return (
                  <div key={p.id} onClick={() => setPracticeTime(p.id)} style={{
                    border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    borderRadius: 14, background: active ? "#fdf2f8" : "#fafafa",
                    padding: "14px 16px", cursor: "pointer", transition: "all 0.12s",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${active ? ACCENT : "#d1d5db"}`, background: active ? ACCENT : "transparent", flexShrink: 0, transition: "all 0.12s" }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: active ? "#9d174d" : "#374151" }}>{p.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{p.sub}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
            {onBack
              ? <button onClick={onBack} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Hub</button>
              : <Link href="/dashboard/screening" style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280", textDecoration: "none" }}>← Hub</Link>
            }
            <button onClick={() => setStep(2)} disabled={!studentName.trim() || genres.length === 0} style={{
              ...btnBase, background: studentName.trim() && genres.length > 0 ? ACCENT : "#e5e7eb",
              color: studentName.trim() && genres.length > 0 ? "#fff" : "#9ca3af",
              cursor: studentName.trim() && genres.length > 0 ? "pointer" : "not-allowed",
            }}>
              Next: Wellbeing →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Wellbeing ──────────────────────────────────────────────── */}
      {step === 2 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Comfort & Physical Notes</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 18, lineHeight: 1.6 }}>Private care notes — helps the teacher plan warm-ups, font sizes, and keyboard adjustments in advance.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
              {PHYSICAL_NEEDS.map(n => {
                const checked = physicalNeeds.includes(n.id);
                return (
                  <div key={n.id} onClick={() => togglePhysical(n.id)} style={{
                    display: "flex", alignItems: "flex-start", gap: 12,
                    border: checked ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                    borderRadius: 12, background: checked ? "#fdf2f8" : "#fafafa",
                    padding: "12px 14px", cursor: "pointer", transition: "all 0.12s",
                  }}>
                    <div style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, border: `2px solid ${checked ? ACCENT : "#d1d5db"}`, background: checked ? ACCENT : "transparent", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1, transition: "all 0.12s" }}>
                      {checked && <span style={{ color: "#fff", fontSize: 12, fontWeight: 900 }}>✓</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: checked ? "#9d174d" : "#374151", marginBottom: 2 }}>{n.label}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{n.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            {physicalNeeds.length > 0 && (
              <div style={{ marginTop: 14, padding: "10px 14px", background: "#fdf2f8", border: "1px solid #fbcfe8", borderRadius: 10, fontSize: 12, color: "#9d174d" }}>
                <strong>{physicalNeeds.length} note{physicalNeeds.length > 1 ? "s" : ""} logged</strong> — teacher will be briefed before the first session.
              </div>
            )}
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep(1)} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
            <button onClick={() => setStep(3)} style={{ ...btnBase, background: ACCENT, color: "#fff" }}>Next: Pattern Check →</button>
          </div>
        </div>
      )}

      {/* ── Step 3: Pattern & Result ────────────────────────────────────────── */}
      {step === 3 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          {/* Pattern recognition */}
          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Cognitive Pattern Recognition</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 20, lineHeight: 1.6 }}>
              Low-stakes observation — not a test. Helps the teacher choose the best memorisation approach for this student.
            </div>

            {/* Pattern selector */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>Choose a sequence to present</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                {PATTERNS.map((p, i) => {
                  const active = patternIdx === i;
                  return (
                    <button key={p.id} type="button" onClick={() => { setPatternIdx(i); setPatternRevealed(false); setPatternResult(null); }} style={{
                      padding: "7px 16px", borderRadius: 99, fontFamily: "inherit",
                      border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                      background: active ? "#fdf2f8" : "#fafafa",
                      color: active ? "#9d174d" : "#6b7280",
                      fontSize: 12, fontWeight: active ? 700 : 500, cursor: "pointer",
                    }}>
                      {p.display}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Pattern display */}
            <div style={{ background: "linear-gradient(135deg, #fdf2f8, #fce7f3)", border: "1.5px solid #fbcfe8", borderRadius: 16, padding: "28px 24px", textAlign: "center" as const, marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#9d174d", fontWeight: 600, marginBottom: 18 }}>Pattern: <strong>{currentPattern.display}</strong></div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 22 }}>
                {currentPattern.notes.map((n, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <NoteShape shape={n.shape} color={n.color} label={n.label} />
                    {i < currentPattern.notes.length - 1 && <span style={{ color: "#d1d5db", fontSize: 20, fontWeight: 700 }}>→</span>}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16, lineHeight: 1.6 }}>
                Show this sequence to the student — play it on the keyboard or tap the shapes. Then cover it and ask them to recall the order.
              </div>
              {!patternRevealed ? (
                <button type="button" onClick={() => setPatternRevealed(true)} style={{ ...btnBase, background: ACCENT, color: "#fff", justifyContent: "center" }}>
                  I&apos;ve shown the pattern — record result
                </button>
              ) : (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 14 }}>How did the student recall the sequence?</div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" as const }}>
                    {([
                      { id: "ease",    emoji: "🌟", label: "Recalled with ease",    desc: "Correct order, minimal prompting"   },
                      { id: "support", emoji: "🌱", label: "Recalled with support", desc: "Needed a reminder or extra attempt" },
                    ] as { id: PatternResult; emoji: string; label: string; desc: string }[]).map(r => {
                      const active = patternResult === r.id;
                      return (
                        <div key={r.id!} onClick={() => setPatternResult(r.id)} style={{
                          border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0",
                          borderRadius: 14, background: active ? "#fdf2f8" : "#fafafa",
                          padding: "14px 20px", cursor: "pointer", minWidth: 180,
                          textAlign: "center" as const, transition: "all 0.12s",
                        }}>
                          <div style={{ fontSize: 26, marginBottom: 6 }}>{r.emoji}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#9d174d" : "#374151", marginBottom: 4 }}>{r.label}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>{r.desc}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Result — only shown when config is ready */}
          {config && (() => {
            const isEpsilon = config.track === "Epsilon Slab";
            const sc = isEpsilon
              ? { bg: "#fffbeb", border: "#fde68a", color: "#92400e", pill: "#d97706" }
              : { bg: "#fef2f2", border: "#fecaca", color: "#991b1b", pill: "#dc2626" };
            return (
              <>
                <div style={{ ...card, gridColumn: "span 8", border: `1.5px solid ${sc.border}`, background: sc.bg }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6, letterSpacing: "0.06em" }}>Entry Recommendation</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: sc.color, marginBottom: 8 }}>{config.track}</div>
                  <div style={{ display: "inline-block", background: sc.pill, color: "#fff", borderRadius: 8, padding: "5px 14px", fontSize: 11, fontWeight: 700, marginBottom: 16 }}>
                    {config.syllabusStrategy}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                    {[
                      { label: "Metronome",   value: config.metronome ? `Yes — ${config.metronomeBpm} BPM` : "No — free rhythm" },
                      { label: "Hands",       value: config.handIntegration },
                      { label: "Chords",      value: config.chords === false ? "None" : config.chords },
                      { label: "Difficulty",  value: config.songsheetDifficulty },
                    ].map(f => (
                      <div key={f.label} style={{ background: "rgba(255,255,255,0.65)", borderRadius: 10, padding: "9px 12px" }}>
                        <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>{f.label}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ ...card, gridColumn: "span 4", display: "flex", flexDirection: "column" as const, gap: 14 }}>
                  <div>
                    <div style={labelStyle}>Student</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#111" }}>{studentName || "—"}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                      {genres.length > 0 && <span>{genres.slice(0, 3).join(", ")}{genres.length > 3 ? "…" : ""}</span>}
                    </div>
                  </div>
                  {saveErr && (
                    <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#dc2626" }}>{saveErr}</div>
                  )}
                  <button type="button" onClick={handleSave} disabled={saving || !canSave} style={{
                    ...btnBase, justifyContent: "center", width: "100%",
                    background: canSave ? ACCENT : "#e5e7eb",
                    color: canSave ? "#fff" : "#9ca3af",
                    cursor: canSave ? "pointer" : "not-allowed", padding: "13px 22px",
                  }}>
                    {saving ? "Saving…" : "Save Screening"}
                  </button>
                </div>
              </>
            );
          })()}

          {!config && (
            <div style={{ gridColumn: "span 12", border: "1.5px dashed #fbcfe8", borderRadius: 16, padding: "28px", textAlign: "center" as const, background: "#fdf2f8" }}>
              <div style={{ fontSize: 24, marginBottom: 10 }}>🗺️</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#9d174d", marginBottom: 6 }}>Complete the pattern check above to reveal the entry recommendation</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" as const, marginTop: 14 }}>
                {[{ label: "Pattern Result", done: !!patternResult }, { label: "Practice Time", done: !!practiceTime }].map(p => (
                  <div key={p.label} style={{ fontSize: 12, fontWeight: 600, padding: "5px 14px", borderRadius: 99, background: p.done ? "#fce7f3" : "#f3f4f6", color: p.done ? "#9d174d" : "#9ca3af", border: `1px solid ${p.done ? "#fbcfe8" : "#e5e7eb"}` }}>
                    {p.done ? "✓" : "○"} {p.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
            <button onClick={() => setStep(2)} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
