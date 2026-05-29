"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening } from "@/services/screening/screening.service";
import type { ScreeningConfig } from "@/types";

// ─── Domain types ─────────────────────────────────────────────────────────────

type PatternResult = "ease" | "support" | null;
type PracticeTime  = "casual" | "weekly" | "regular" | "daily" | null;
type PrimaryFocus  = "stress-relief" | "brain-exercise" | "leisure" | null;

interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Genre options ────────────────────────────────────────────────────────────

const GENRES = [
  { id: "classical",   label: "Classical",    icon: "🎻" },
  { id: "pop",         label: "Pop",           icon: "🎤" },
  { id: "hymns",       label: "Hymns",         icon: "🙏" },
  { id: "classic-rock",label: "Classic Rock",  icon: "🎸" },
  { id: "jazz",        label: "Jazz",          icon: "🎷" },
  { id: "devotional",  label: "Devotional",    icon: "✨" },
  { id: "folk",        label: "Folk",          icon: "🪕" },
  { id: "film",        label: "Film Music",    icon: "🎬" },
] as const;

type GenreId = typeof GENRES[number]["id"];

// ─── Focus options ────────────────────────────────────────────────────────────

const FOCUS_OPTIONS: { id: PrimaryFocus; icon: string; label: string; desc: string }[] = [
  { id: "stress-relief",  icon: "🌿", label: "Stress Relief",    desc: "Music as a calm, therapeutic escape from daily demands" },
  { id: "brain-exercise", icon: "🧠", label: "Brain Exercise",   desc: "Keeping the mind sharp and memory active through music"  },
  { id: "leisure",        icon: "☀️",  label: "Leisure Playing",  desc: "Pure enjoyment — playing favourite tunes at your own pace" },
];

// ─── Practice time options ────────────────────────────────────────────────────

const PRACTICE_OPTIONS: { id: PracticeTime; label: string; sub: string }[] = [
  { id: "casual",  label: "Casual",         sub: "Under 30 min / week — whenever the mood strikes" },
  { id: "weekly",  label: "Once a Week",    sub: "Around 1–2 sessions per week, roughly 30–60 min" },
  { id: "regular", label: "A Few Times",    sub: "3–5 short sessions a week, 15–30 min each"       },
  { id: "daily",   label: "Daily Habit",    sub: "A little every day, building a gentle routine"   },
];

// ─── Physical needs ───────────────────────────────────────────────────────────

const PHYSICAL_NEEDS = [
  { id: "arthritis",    label: "Arthritis or Joint Sensitivity",  desc: "Needs lower-tension keys or warm-up guidance"  },
  { id: "stiffness",    label: "Finger Stiffness",                desc: "Reduced grip strength or reduced dexterity"    },
  { id: "vision",       label: "Vision Support (Larger Notation)",desc: "Benefits from enlarged sheet music print size"  },
  { id: "posture",      label: "Posture or Seating Needs",        desc: "Requires chair height or wrist position adjustments" },
  { id: "hearing",      label: "Hearing Sensitivity",             desc: "Prefers lower volume or specific tone ranges"  },
  { id: "memory",       label: "Memory Support",                  desc: "Benefits from slower repetition and review loops" },
] as const;

type PhysicalNeedId = typeof PHYSICAL_NEEDS[number]["id"];

// ─── Pattern sequences ────────────────────────────────────────────────────────

const PATTERNS = [
  {
    id: "seq-a",
    notes: [
      { shape: "circle",   color: "#f97316", label: "DO",  note: "C" },
      { shape: "triangle", color: "#8b5cf6", label: "MI",  note: "E" },
      { shape: "square",   color: "#0ea5e9", label: "SOL", note: "G" },
    ],
    display: "C → E → G",
  },
  {
    id: "seq-b",
    notes: [
      { shape: "square",   color: "#0ea5e9", label: "SOL", note: "G" },
      { shape: "circle",   color: "#f97316", label: "DO",  note: "C" },
      { shape: "triangle", color: "#8b5cf6", label: "MI",  note: "E" },
    ],
    display: "G → C → E",
  },
  {
    id: "seq-c",
    notes: [
      { shape: "triangle", color: "#8b5cf6", label: "MI",  note: "E" },
      { shape: "square",   color: "#0ea5e9", label: "SOL", note: "G" },
      { shape: "circle",   color: "#f97316", label: "DO",  note: "C" },
    ],
    display: "E → G → C",
  },
];

// ─── Config compute ───────────────────────────────────────────────────────────

function computeJoyfulConfig(pattern: PatternResult, practice: PracticeTime): ScreeningConfig {
  const isEpsilon =
    pattern === "ease" ||
    practice === "regular" ||
    practice === "daily";

  if (isEpsilon) {
    return {
      track:               "Epsilon Slab",
      syllabusStrategy:    "Joyful Progression — Melody-First, Comfortable Pacing",
      metronome:           true,
      metronomeBpm:        65,
      handIntegration:     "Hands Separated",
      chords:              "Basic Blocks",
      songsheetDifficulty: "Standard/Easier",
    };
  }
  return {
    track:               "Delta Slab",
    syllabusStrategy:    "Gentle Beginnings — Stress-Free Rote and Listening",
    metronome:           false,
    metronomeBpm:        null,
    handIntegration:     "RH Only",
    chords:              false,
    songsheetDifficulty: "Simplified/Rote",
  };
}

function practiceScore(p: PracticeTime): number {
  if (p === "daily")   return 4.5;
  if (p === "regular") return 3.5;
  if (p === "weekly")  return 3.0;
  return 2.5;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function WarmSectionBar({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div style={{
      display:      "flex",
      alignItems:   "center",
      gap:          14,
      background:   "linear-gradient(135deg, #fdf2f8 0%, #fce7f3 100%)",
      borderBottom: "1px solid #fbcfe8",
      borderRadius: "12px 12px 0 0",
      padding:      "16px 22px",
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 12,
        background: "#fff", border: "1.5px solid #fbcfe8",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 20, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#831843", letterSpacing: "0.01em" }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: "#9d174d", marginTop: 2, opacity: 0.75 }}>{sub}</div>}
      </div>
    </div>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border:       "1.5px solid #fbcfe8",
      borderRadius: 14,
      background:   "#fff",
      marginBottom: 20,
      overflow:     "hidden",
    }}>
      {children}
    </div>
  );
}

function NoteShape({ shape, color, label }: { shape: string; color: string; label: string }) {
  const size = 52;
  const clipPath =
    shape === "triangle" ? "polygon(50% 4%, 96% 92%, 4% 92%)" :
    shape === "square"   ? undefined : undefined;
  const borderRadius =
    shape === "circle" ? "50%" :
    shape === "square" ? 10   : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{
        width:        size,
        height:       size,
        background:   color,
        borderRadius: shape === "circle" ? "50%" : shape === "square" ? 10 : 0,
        clipPath:     shape === "triangle" ? clipPath : undefined,
        display:      "flex",
        alignItems:   "center",
        justifyContent: "center",
        boxShadow:    `0 4px 14px ${color}44`,
      }}>
        {shape !== "triangle" && (
          <span style={{ color: "#fff", fontWeight: 900, fontSize: 13 }}>{label}</span>
        )}
      </div>
      {shape === "triangle" && (
        <span style={{ fontWeight: 900, fontSize: 12, color }}>{label}</span>
      )}
    </div>
  );
}

function PatternArrow() {
  return (
    <div style={{
      display: "flex", alignItems: "center", alignSelf: "center",
      color: "#d1d5db", fontSize: 22, fontWeight: 700, marginTop: -6,
    }}>
      →
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function JoyfulTrackContent() {
  const { user } = useAuthContext();

  // Student search
  const [students,       setStudents]       = useState<StudentOption[]>([]);
  const [studentSearch,  setStudentSearch]  = useState("");
  const [selectedStudent,setSelectedStudent]= useState<StudentOption | null>(null);
  const [studentName,    setStudentName]    = useState("");

  // Section 01 — Lifestyle & Goals
  const [genres,        setGenres]        = useState<GenreId[]>([]);
  const [primaryFocus,  setPrimaryFocus]  = useState<PrimaryFocus>(null);
  const [practiceTime,  setPracticeTime]  = useState<PracticeTime>(null);

  // Section 02 — Physical
  const [physicalNeeds, setPhysicalNeeds] = useState<PhysicalNeedId[]>([]);

  // Section 03 — Pattern test
  const [patternIdx,      setPatternIdx]      = useState(0);
  const [patternRevealed, setPatternRevealed] = useState(false);
  const [patternResult,   setPatternResult]   = useState<PatternResult>(null);

  // Saving
  const [saving, setSaving]     = useState(false);
  const [saved,  setSaved]      = useState(false);
  const [saveErr,setSaveErr]    = useState("");

  // Assessment ID (generated once)
  const [assessmentId] = useState(() => {
    const d  = new Date();
    const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const sx = Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, "0");
    return `JT-${ds}-${sx}`;
  });

  useEffect(() => {
    if (!db) return;
    getDocs(
      query(collection(db, "users"), where("role", "==", "student"))
    ).then(snap => {
      setStudents(
        snap.docs
          .map(d => ({ uid: d.id, name: (d.data().displayName ?? "") as string, studentID: (d.data().studentID ?? "") as string }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
    });
  }, []);

  const filteredStudents = useMemo(() =>
    studentSearch.length < 2
      ? []
      : students.filter(s =>
          s.name.toLowerCase().includes(studentSearch.toLowerCase()) ||
          s.studentID.toLowerCase().includes(studentSearch.toLowerCase())
        ).slice(0, 6),
    [students, studentSearch]
  );

  function toggleGenre(id: GenreId) {
    setGenres(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);
  }

  function togglePhysical(id: PhysicalNeedId) {
    setPhysicalNeeds(prev => prev.includes(id) ? prev.filter(n => n !== id) : [...prev, id]);
  }

  const currentPattern = PATTERNS[patternIdx];

  const config = useMemo<ScreeningConfig | null>(() => {
    if (!patternResult || !practiceTime) return null;
    return computeJoyfulConfig(patternResult, practiceTime);
  }, [patternResult, practiceTime]);

  const canSave =
    !!studentName.trim() &&
    genres.length > 0 &&
    !!primaryFocus &&
    !!practiceTime &&
    !!patternResult &&
    !!config;

  async function handleSave() {
    if (!canSave || !config) return;
    setSaving(true);
    setSaveErr("");
    try {
      const baseScore = practiceScore(practiceTime);
      await saveScreening({
        screeningType:     "joyful-track",
        childName:         studentName.trim(),
        rhythmScore:       baseScore,
        pitchScore:        baseScore,
        motorScore:        baseScore,
        averageScore:      baseScore,
        config,
        screenedBy:        user?.uid ?? "",
        screenedAt:        new Date().toISOString(),
        studentId:         selectedStudent?.uid ?? null,
        learningMotivation:
          primaryFocus === "stress-relief"  ? "Option A: Stress Relief — music as calm escape" :
          primaryFocus === "brain-exercise" ? "Option B: Brain Exercise — keeping mind sharp"  :
                                             "Option C: Leisure Playing — pure enjoyment",
        pacingPreference:
          practiceTime === "casual"  ? "Option A: Casual — whenever the mood strikes" :
          practiceTime === "weekly"  ? "Option B: Once a Week — 1–2 sessions"         :
          practiceTime === "regular" ? "Option C: A Few Times a Week — short sessions" :
                                       "Option C: Daily Habit — gentle daily routine",
        musicalBackground: genres.join(", "),
        // Physical needs stored as comma-separated list via sensoryProfile field
        sensoryProfile: physicalNeeds.length > 0 ? physicalNeeds.join(", ") : undefined,
      });
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ─── Success screen ──────────────────────────────────────────────────────────

  if (saved && config) {
    const isEpsilon = config.track === "Epsilon Slab";
    const sc = isEpsilon
      ? { bg: "#fffbeb", border: "#fde68a", color: "#92400e", glow: "rgba(217,119,6,0.13)", pill: "#d97706" }
      : { bg: "#fef2f2", border: "#fecaca", color: "#991b1b", glow: "rgba(220,38,38,0.13)", pill: "#dc2626" };
    return (
      <div style={{ maxWidth: 540, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 52, marginBottom: 16 }}>🌻</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#831843", marginBottom: 6 }}>
          All done — welcome to the Joyful Track!
        </div>
        <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 32 }}>
          Screening saved for <strong style={{ color: "#374151" }}>{studentName}</strong>
        </div>
        <div style={{
          border:       `1.5px solid ${sc.border}`,
          borderRadius: 16,
          background:   sc.bg,
          padding:      "28px 24px",
          boxShadow:    `0 0 32px ${sc.glow}`,
          marginBottom: 28,
        }}>
          <div style={{ fontSize: 12, color: sc.color, fontWeight: 600, marginBottom: 8, opacity: 0.8 }}>
            Entry Recommendation
          </div>
          <div style={{ fontSize: 30, fontWeight: 900, color: sc.color, marginBottom: 10 }}>
            {config.track}
          </div>
          <div style={{
            display:         "inline-block",
            background:      sc.pill,
            color:           "#fff",
            borderRadius:    8,
            padding:         "6px 14px",
            fontSize:        12,
            fontWeight:      700,
            marginBottom:    18,
          }}>
            {config.syllabusStrategy}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, textAlign: "left" }}>
            {[
              { label: "Metronome",       value: config.metronome ? `Yes — ${config.metronomeBpm} BPM` : "No" },
              { label: "Hands",           value: config.handIntegration },
              { label: "Chords",          value: config.chords === false ? "None" : config.chords },
              { label: "Song Difficulty", value: config.songsheetDifficulty },
            ].map(f => (
              <div key={f.label} style={{ background: "rgba(255,255,255,0.65)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{f.label}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
              </div>
            ))}
          </div>
        </div>
        <Link
          href="/dashboard/screening"
          style={{ display: "inline-block", background: "#db2777", color: "#fff", borderRadius: 10, padding: "12px 28px", fontSize: 14, fontWeight: 700, textDecoration: "none" }}
        >
          ← Back to Screening Hub
        </Link>
      </div>
    );
  }

  // ─── Main form ───────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 16px 60px" }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <Link
          href="/dashboard/screening"
          style={{ fontSize: 12, color: "#9ca3af", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 20, marginTop: 24 }}
        >
          ← Screening Hub
        </Link>
        <div style={{
          background:   "linear-gradient(135deg, #fdf2f8 0%, #fce7f3 50%, #fff7ed 100%)",
          border:       "1.5px solid #fbcfe8",
          borderRadius: 16,
          padding:      "28px 28px 24px",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 28 }}>🌻</span>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#831843", letterSpacing: "-0.01em" }}>
                  The Joyful Track
                </div>
              </div>
              <div style={{ fontSize: 14, color: "#9d174d", opacity: 0.8, marginBottom: 12 }}>
                Adult Hobby Screening — Ages 31 and above
              </div>
              <div style={{
                display:        "inline-block",
                background:     "rgba(219,39,119,0.08)",
                border:         "1px solid #fbcfe8",
                borderRadius:   8,
                padding:        "5px 14px",
                fontSize:       11,
                fontWeight:     700,
                color:          "#9d174d",
                letterSpacing:  "0.04em",
              }}>
                {assessmentId}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>
                {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
              </div>
              <div style={{ fontSize: 11, color: "#db2777", marginTop: 4, fontWeight: 600 }}>
                Relaxed · Stress-Free · Self-Paced
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Student name ──────────────────────────────────────────────────────── */}
      <SectionCard>
        <WarmSectionBar icon="👤" title="Who is this screening for?" />
        <div style={{ padding: "20px 22px" }}>
          <div style={{ position: "relative" }}>
            <input
              value={studentSearch}
              onChange={e => {
                setStudentSearch(e.target.value);
                setStudentName(e.target.value);
                setSelectedStudent(null);
              }}
              placeholder="Search by name or student ID…"
              style={{
                width: "100%", boxSizing: "border-box",
                border: "1.5px solid #fbcfe8", borderRadius: 10,
                padding: "11px 14px", fontSize: 14, color: "#111",
                background: "#fff", outline: "none",
              }}
            />
            {filteredStudents.length > 0 && (
              <div style={{
                position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
                background: "#fff", border: "1.5px solid #fbcfe8",
                borderRadius: "0 0 10px 10px", boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
              }}>
                {filteredStudents.map(s => (
                  <div
                    key={s.uid}
                    onClick={() => { setSelectedStudent(s); setStudentName(s.name); setStudentSearch(s.name); }}
                    style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #fce7f3", fontSize: 14 }}
                  >
                    <span style={{ fontWeight: 700, color: "#111" }}>{s.name}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 8 }}>{s.studentID}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {selectedStudent && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#16a34a" }}>
              ✓ Linked to student record — {selectedStudent.studentID}
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Section 01 — Lifestyle & Goals ─────────────────────────────────── */}
      <SectionCard>
        <WarmSectionBar
          icon="🎵"
          title="Lifestyle & Goals Profile"
          sub="Section 01 — Musical preferences, focus, and practice availability"
        />
        <div style={{ padding: "22px" }}>

          {/* Genre chips */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
              Musical genres you enjoy
            </div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>
              Select all that apply — this shapes which repertoire we introduce first.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
              {GENRES.map(g => {
                const active = genres.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGenre(g.id)}
                    style={{
                      display:      "flex",
                      alignItems:   "center",
                      gap:          7,
                      padding:      "8px 16px",
                      borderRadius: 99,
                      border:       active ? "2px solid #db2777" : "1.5px solid #e5e7eb",
                      background:   active ? "#fdf2f8" : "#fafafa",
                      color:        active ? "#9d174d" : "#6b7280",
                      fontSize:     13,
                      fontWeight:   active ? 700 : 500,
                      cursor:       "pointer",
                      transition:   "all 0.12s",
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{g.icon}</span>
                    {g.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Primary focus */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
              Primary reason for learning piano
            </div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>
              Choose one — this guides the emotional tone and pacing of lessons.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
              {FOCUS_OPTIONS.map(f => {
                const active = primaryFocus === f.id;
                return (
                  <div
                    key={f.id}
                    onClick={() => setPrimaryFocus(f.id)}
                    style={{
                      border:       active ? "2px solid #db2777" : "1.5px solid #e5e7eb",
                      borderRadius: 12,
                      background:   active ? "#fdf2f8" : "#fafafa",
                      padding:      "14px 16px",
                      cursor:       "pointer",
                      transition:   "all 0.12s",
                    }}
                  >
                    <div style={{ fontSize: 24, marginBottom: 8 }}>{f.icon}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#9d174d" : "#374151", marginBottom: 5 }}>
                      {f.label}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.5 }}>{f.desc}</div>
                    {active && (
                      <div style={{
                        marginTop: 10, display: "inline-block",
                        background: "#fce7f3", color: "#9d174d",
                        fontSize: 10, fontWeight: 800, borderRadius: 99, padding: "2px 10px",
                      }}>
                        SELECTED
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Practice time */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
              Estimated weekly practice time
            </div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>
              Honest estimates help us match lesson density to lifestyle — there is no wrong answer.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {PRACTICE_OPTIONS.map(p => {
                const active = practiceTime === p.id;
                return (
                  <div
                    key={p.id}
                    onClick={() => setPracticeTime(p.id)}
                    style={{
                      display:      "flex",
                      alignItems:   "center",
                      gap:          14,
                      border:       active ? "2px solid #db2777" : "1.5px solid #e5e7eb",
                      borderRadius: 10,
                      background:   active ? "#fdf2f8" : "#fafafa",
                      padding:      "12px 16px",
                      cursor:       "pointer",
                      transition:   "all 0.12s",
                    }}
                  >
                    <div style={{
                      width:      20, height: 20, borderRadius: "50%", flexShrink: 0,
                      border:     `2px solid ${active ? "#db2777" : "#d1d5db"}`,
                      background: active ? "#db2777" : "transparent",
                      transition: "all 0.12s",
                    }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#9d174d" : "#374151" }}>
                        {p.label}
                      </div>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{p.sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* ── Section 02 — Physical Needs ─────────────────────────────────────── */}
      <SectionCard>
        <WarmSectionBar
          icon="🌿"
          title="Comfort & Physical Assessment"
          sub="Section 02 — Log any accommodations the teacher should be aware of"
        />
        <div style={{ padding: "22px" }}>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 18, lineHeight: 1.6 }}>
            These are private care notes — not judgements. Logging them helps the teacher
            plan warm-ups, font sizes, and keyboard height adjustments in advance.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {PHYSICAL_NEEDS.map(n => {
              const checked = physicalNeeds.includes(n.id);
              return (
                <div
                  key={n.id}
                  onClick={() => togglePhysical(n.id)}
                  style={{
                    display:      "flex",
                    alignItems:   "flex-start",
                    gap:          12,
                    border:       checked ? "2px solid #db2777" : "1.5px solid #e5e7eb",
                    borderRadius: 10,
                    background:   checked ? "#fdf2f8" : "#fafafa",
                    padding:      "12px 14px",
                    cursor:       "pointer",
                    transition:   "all 0.12s",
                  }}
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                    border:       `2px solid ${checked ? "#db2777" : "#d1d5db"}`,
                    background:   checked ? "#db2777" : "transparent",
                    display:      "flex",
                    alignItems:   "center",
                    justifyContent: "center",
                    marginTop:    1,
                    transition:   "all 0.12s",
                  }}>
                    {checked && <span style={{ color: "#fff", fontSize: 12, fontWeight: 900 }}>✓</span>}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: checked ? "#9d174d" : "#374151", marginBottom: 3 }}>
                      {n.label}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.5 }}>{n.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {physicalNeeds.length === 0 && (
            <div style={{
              marginTop: 14, padding: "10px 14px",
              background: "#f9fafb", borderRadius: 8,
              fontSize: 12, color: "#9ca3af", textAlign: "center",
            }}>
              No accommodations selected — all clear.
            </div>
          )}
          {physicalNeeds.length > 0 && (
            <div style={{
              marginTop: 14, padding: "10px 14px",
              background: "#fdf2f8", border: "1px solid #fbcfe8",
              borderRadius: 8, fontSize: 12, color: "#9d174d",
            }}>
              <strong>{physicalNeeds.length} note{physicalNeeds.length > 1 ? "s" : ""} logged</strong> — teacher will be briefed on these before first session.
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Section 03 — Pattern Recognition ────────────────────────────────── */}
      <SectionCard>
        <WarmSectionBar
          icon="🎼"
          title="Cognitive Pattern Recognition"
          sub="Section 03 — A gentle 3-note sequence memory check in a calm environment"
        />
        <div style={{ padding: "22px" }}>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 20, lineHeight: 1.6 }}>
            This is a low-stakes observation — not a test with a right or wrong answer.
            The aim is simply to understand how the student holds musical sequences in
            short-term memory, so the teacher can choose the best memorisation approach.
          </div>

          {/* Pattern selector */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>
              Choose a pattern sequence to present
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {PATTERNS.map((p, i) => {
                const active = patternIdx === i;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setPatternIdx(i); setPatternRevealed(false); setPatternResult(null); }}
                    style={{
                      padding:      "7px 16px",
                      borderRadius: 99,
                      border:       active ? "2px solid #db2777" : "1.5px solid #e5e7eb",
                      background:   active ? "#fdf2f8" : "#fafafa",
                      color:        active ? "#9d174d" : "#6b7280",
                      fontSize:     12,
                      fontWeight:   active ? 700 : 500,
                      cursor:       "pointer",
                    }}
                  >
                    {p.display}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pattern display */}
          <div style={{
            background:   "linear-gradient(135deg, #fdf2f8 0%, #fce7f3 100%)",
            border:       "1.5px solid #fbcfe8",
            borderRadius: 14,
            padding:      "28px 24px",
            textAlign:    "center",
            marginBottom: 20,
          }}>
            <div style={{ fontSize: 12, color: "#9d174d", fontWeight: 600, marginBottom: 20 }}>
              Pattern: <strong>{currentPattern.display}</strong>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 24 }}>
              {currentPattern.notes.map((n, i) => (
                <>
                  <NoteShape key={n.note} shape={n.shape} color={n.color} label={n.label} />
                  {i < currentPattern.notes.length - 1 && <PatternArrow key={`arrow-${i}`} />}
                </>
              ))}
            </div>

            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16, lineHeight: 1.6 }}>
              Show this sequence to the student — play it on the keyboard or
              tap the shapes in order. Then cover it and ask them to recall the order.
            </div>

            {!patternRevealed ? (
              <button
                type="button"
                onClick={() => setPatternRevealed(true)}
                style={{
                  background:   "#db2777",
                  color:        "#fff",
                  border:       "none",
                  borderRadius: 10,
                  padding:      "10px 24px",
                  fontSize:     13,
                  fontWeight:   700,
                  cursor:       "pointer",
                }}
              >
                I&apos;ve shown the pattern — record result
              </button>
            ) : (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 14 }}>
                  How did the student recall the sequence?
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  {([
                    { id: "ease",    emoji: "🌟", label: "Recalled with ease",    desc: "Correct order, minimal prompting needed"   },
                    { id: "support", emoji: "🌱", label: "Recalled with support", desc: "Needed a reminder or took an extra attempt" },
                  ] as { id: PatternResult; emoji: string; label: string; desc: string }[]).map(r => {
                    const active = patternResult === r.id;
                    return (
                      <div
                        key={r.id!}
                        onClick={() => setPatternResult(r.id)}
                        style={{
                          border:       active ? "2px solid #db2777" : "1.5px solid #e5e7eb",
                          borderRadius: 12,
                          background:   active ? "#fdf2f8" : "#fafafa",
                          padding:      "14px 20px",
                          cursor:       "pointer",
                          minWidth:     180,
                          textAlign:    "center",
                          transition:   "all 0.12s",
                        }}
                      >
                        <div style={{ fontSize: 26, marginBottom: 6 }}>{r.emoji}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#9d174d" : "#374151", marginBottom: 4 }}>
                          {r.label}
                        </div>
                        <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.5 }}>{r.desc}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      {/* ── Section 04 — Entry Slab Recommendation ──────────────────────────── */}
      {config ? (
        <SectionCard>
          <WarmSectionBar
            icon="🗺️"
            title="Entry Slab Recommendation"
            sub="Section 04 — Auto-mapped based on pattern recall and weekly availability"
          />
          <div style={{ padding: "22px" }}>

            {/* Score row */}
            <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
              {[
                { label: "Pattern Recall", value: patternResult === "ease" ? "With Ease 🌟" : "With Support 🌱" },
                { label: "Practice",       value: PRACTICE_OPTIONS.find(p => p.id === practiceTime)?.label ?? "" },
                { label: "Focus",          value: FOCUS_OPTIONS.find(f => f.id === primaryFocus)?.label ?? "" },
              ].map(i => (
                <div key={i.label} style={{
                  flex:         "1 1 140px",
                  background:   "#fdf2f8",
                  border:       "1px solid #fbcfe8",
                  borderRadius: 10,
                  padding:      "12px 14px",
                }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                    {i.label}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#831843" }}>{i.value}</div>
                </div>
              ))}
            </div>

            {/* Recommendation logic note */}
            <div style={{
              fontSize: 12, color: "#9ca3af", fontStyle: "italic",
              marginBottom: 18, lineHeight: 1.6,
            }}>
              {config.track === "Epsilon Slab"
                ? "Pattern recalled with ease or regular practice sessions → Epsilon Slab. A comfortable, melody-first path with gradual hands-together work."
                : "Pattern needed support or very casual schedule → Delta Slab. A stress-free rote-learning beginning, building confidence before notation."
              }
            </div>

            {/* Slab result card */}
            {(() => {
              const isEpsilon = config.track === "Epsilon Slab";
              const sc = isEpsilon
                ? { bg: "#fffbeb", border: "#fde68a", color: "#92400e", pill: "#d97706" }
                : { bg: "#fef2f2", border: "#fecaca", color: "#991b1b", pill: "#dc2626" };
              return (
                <div style={{
                  border:       `1.5px solid ${sc.border}`,
                  borderRadius: 14,
                  background:   sc.bg,
                  padding:      "22px",
                  marginBottom: 20,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3 }}>Recommended Entry Slab</div>
                      <div style={{ fontSize: 28, fontWeight: 900, color: sc.color }}>{config.track}</div>
                    </div>
                    <div style={{
                      background:   sc.pill,
                      color:        "#fff",
                      borderRadius: 8,
                      padding:      "8px 14px",
                      fontSize:     12,
                      fontWeight:   700,
                    }}>
                      {isEpsilon ? "Self-Paced Comfort" : "Gentle Beginnings"}
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: sc.color, fontWeight: 600, marginBottom: 14 }}>
                    {config.syllabusStrategy}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                    {[
                      { label: "Metronome",       value: config.metronome ? `Yes — ${config.metronomeBpm} BPM` : "No — free rhythm" },
                      { label: "Hands",           value: config.handIntegration },
                      { label: "Chords",          value: config.chords === false ? "None" : config.chords },
                      { label: "Song Difficulty", value: config.songsheetDifficulty },
                    ].map(f => (
                      <div key={f.label} style={{ background: "rgba(255,255,255,0.65)", borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>
                          {f.label}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Student summary */}
            <div style={{
              background:   "#f9fafb",
              border:       "1px solid #e5e7eb",
              borderRadius: 10,
              padding:      "14px 16px",
              marginBottom: 20,
              display:      "flex",
              alignItems:   "center",
              justifyContent: "space-between",
              flexWrap:     "wrap",
              gap:          10,
            }}>
              <div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>Student</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>{studentName || "—"}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>Genres</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                  {genres.length > 0 ? genres.join(", ") : "—"}
                </div>
              </div>
              {physicalNeeds.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>Accommodations</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#db2777" }}>
                    {physicalNeeds.length} noted
                  </div>
                </div>
              )}
            </div>

            {saveErr && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#dc2626" }}>
                {saveErr}
              </div>
            )}

            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !canSave}
              style={{
                width:        "100%",
                background:   canSave ? "#db2777" : "#e5e7eb",
                color:        canSave ? "#fff" : "#9ca3af",
                border:       "none",
                borderRadius: 12,
                padding:      "15px",
                fontSize:     15,
                fontWeight:   800,
                cursor:       canSave ? "pointer" : "not-allowed",
                transition:   "background 0.15s",
              }}
            >
              {saving ? "Saving…" : "Save Joyful Track Screening"}
            </button>
          </div>
        </SectionCard>
      ) : (
        /* Pending state */
        <div style={{
          border:       "1.5px dashed #fbcfe8",
          borderRadius: 14,
          padding:      "32px",
          textAlign:    "center",
          background:   "#fdf2f8",
        }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>🗺️</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#9d174d", marginBottom: 6 }}>
            Entry Recommendation Pending
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.6 }}>
            Complete the pattern recognition check and select a weekly practice estimate above to reveal the recommended slab.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 18 }}>
            {[
              { label: "Pattern Result",  done: !!patternResult },
              { label: "Practice Time",   done: !!practiceTime  },
            ].map(p => (
              <div key={p.label} style={{
                fontSize:     12,
                fontWeight:   600,
                padding:      "6px 14px",
                borderRadius: 99,
                background:   p.done ? "#fce7f3" : "#f3f4f6",
                color:        p.done ? "#9d174d" : "#9ca3af",
                border:       `1px solid ${p.done ? "#fbcfe8" : "#e5e7eb"}`,
              }}>
                {p.done ? "✓" : "○"} {p.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page export ──────────────────────────────────────────────────────────────

export default function JoyfulTrackPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <JoyfulTrackContent />
      </Suspense>
    </ProtectedRoute>
  );
}
