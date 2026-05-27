"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening } from "@/services/screening/screening.service";
import Link from "next/link";
import type { ScreeningConfig, ScreeningTrack } from "@/types";

// ─── Parent interview option definitions ─────────────────────────────────────

interface InterviewOption {
  letter: "A" | "B" | "C";
  text:   string;
}
interface InterviewQuestion {
  key:     "languageSkills" | "coreStrengths" | "motorBaseline";
  title:   string;
  subtitle: string;
  options: InterviewOption[];
}

const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    key:      "languageSkills",
    title:    "Language & Listening Style",
    subtitle: "How does your child best take in and remember information?",
    options:  [
      { letter: "A", text: "Learns mostly from pictures. Struggles with long spoken instructions." },
      { letter: "B", text: "Easily remembers rhymes and songs. Can follow two simple instructions in a row." },
      { letter: "C", text: "Understands long instructions quickly and talks very clearly." },
    ],
  },
  {
    key:      "coreStrengths",
    title:    "Focus & Attention",
    subtitle: "How does your child stay interested during an activity?",
    options:  [
      { letter: "A", text: "Changes activities quickly. Needs new and exciting things to stay interested." },
      { letter: "B", text: "Can sit and play with one toy (like blocks or puzzles) for 15 minutes or more." },
      { letter: "C", text: "Loves finding patterns and figuring out how things work." },
    ],
  },
  {
    key:      "motorBaseline",
    title:    "Hand Control & Movement",
    subtitle: "How well does your child handle small, precise movements?",
    options:  [
      { letter: "A", text: "Prefers running and jumping. Small finger control is still developing." },
      { letter: "B", text: "Good hand control. Easily handles coloring, drawing, or playing with small blocks." },
      { letter: "C", text: "Excellent finger control. Easily picks up and handles very tiny objects." },
    ],
  },
];

// ─── Logic helpers ────────────────────────────────────────────────────────────

function computeConfig(avg: number): ScreeningConfig {
  if (avg <= 2.5) {
    return {
      track:               "Level 1 (Delta Track)",
      syllabusStrategy:    "Tactile/Pre-Staff Preparation",
      metronome:           false,
      metronomeBpm:        null,
      handIntegration:     "RH Only",
      chords:              false,
      songsheetDifficulty: "Simplified/Rote",
    };
  }
  if (avg <= 4.0) {
    return {
      track:               "Level 2 (Epsilon Track)",
      syllabusStrategy:    "Standard Method Integration",
      metronome:           true,
      metronomeBpm:        55,
      handIntegration:     "Hands Separated",
      chords:              "Basic Blocks",
      songsheetDifficulty: "Standard",
    };
  }
  return {
    track:               "Level 3 (Zeta Track)",
    syllabusStrategy:    "Accelerated Performance & Early Composition",
    metronome:           true,
    metronomeBpm:        70,
    handIntegration:     "Hands Together",
    chords:              "Full Harmonies",
    songsheetDifficulty: "Advanced/16-Bar",
  };
}

export const TRACK_STYLE: Record<ScreeningTrack, { bg: string; color: string; border: string; pill: string }> = {
  "Level 1 (Delta Track)":   { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe", pill: "#1d4ed8" },
  "Level 2 (Epsilon Track)": { bg: "#fefce8", color: "#92400e", border: "#fde68a", pill: "#d97706" },
  "Level 3 (Zeta Track)":    { bg: "#f0fdf4", color: "#15803d", border: "#86efac", pill: "#16a34a" },
  "Explorer Track":          { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa", pill: "#ea580c" },
  "Achiever Track":          { bg: "#f0fdfa", color: "#0f766e", border: "#99f6e4", pill: "#0d9488" },
  "Prodigy Track":           { bg: "#faf5ff", color: "#7e22ce", border: "#e9d5ff", pill: "#9333ea" },
};

function scoreColor(n: number): string {
  if (n <= 2) return "#dc2626";
  if (n === 3) return "#d97706";
  return "#16a34a";
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function ScreeningPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <ScreeningContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// ─── Student search type ──────────────────────────────────────────────────────

interface StudentOption {
  uid:       string;
  name:      string;
  studentID: string;
}

// ─── Score selector ───────────────────────────────────────────────────────────

function ScoreSelector({
  value, onChange,
}: { value: number | null; onChange: (n: number) => void }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            style={{
              flex: 1, padding: "11px 0", borderRadius: 8,
              border: value === n ? "2px solid #4f46e5" : "1px solid #e5e7eb",
              background: value === n ? "#ede9fe" : "#f9fafb",
              color: value === n ? "#4f46e5" : "#6b7280",
              fontSize: 17, fontWeight: value === n ? 800 : 500,
              cursor: "pointer", transition: "all 0.12s",
              lineHeight: 1,
            }}>
            {n}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>1 — Needs Support</span>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>5 — Exceptional</span>
      </div>
    </div>
  );
}

// ─── Diagnostic result card (reusable for teacher view too) ──────────────────

export function DiagnosticCard({
  result,
  compact = false,
}: {
  result: {
    childName:           string;
    rhythmScore:         number;
    pitchScore:          number;
    motorScore:          number;
    averageScore:        number;
    config:              ScreeningConfig;
    screenedAt:          string;
    // Little Mozarts
    languageSkills?:     string;
    coreStrengths?:      string;
    motorBaseline?:      string;
    // Fast Track
    stageReadiness?:     string;
    academicGoals?:      string;
    practiceCommitment?: string;
  };
  compact?: boolean;
}) {
  const ts = TRACK_STYLE[result.config.track];
  return (
    <div style={{ border: `1px solid ${ts.border}`, borderRadius: 12, background: ts.bg, padding: compact ? "14px 16px" : "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>Diagnostic Average</div>
          <div style={{ fontSize: compact ? 26 : 34, fontWeight: 900, color: ts.color, lineHeight: 1 }}>
            {result.averageScore.toFixed(2)}
            <span style={{ fontSize: 14, fontWeight: 400, color: "#9ca3af" }}> / 5</span>
          </div>
        </div>
        <div style={{ background: ts.pill, color: "#fff", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700 }}>
          {result.config.track}
        </div>
      </div>

      <div style={{ fontSize: 12, color: ts.color, fontWeight: 600, marginBottom: 14 }}>
        Strategy: {result.config.syllabusStrategy}
      </div>

      {/* Score breakdown */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {([
          { label: "🥁 Rhythm", val: result.rhythmScore },
          { label: "🎵 Pitch",  val: result.pitchScore  },
          { label: "🐾 Motor",  val: result.motorScore  },
        ]).map(sc => (
          <div key={sc.label} style={{ flex: 1, background: "rgba(255,255,255,0.7)", borderRadius: 7, padding: "8px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>{sc.label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: scoreColor(sc.val) }}>{sc.val}</div>
          </div>
        ))}
      </div>

      {/* Config flags */}
      {(() => {
        const bpmDisplay = result.config.track === "Prodigy Track"
          ? `${result.config.metronomeBpm}+ BPM`
          : `${result.config.metronomeBpm} BPM`;
        const metLabel = result.config.metronome ? `Yes — ${bpmDisplay}` : "No";
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: compact ? 0 : 14 }}>
            {([
              { label: "Metronome",       value: metLabel },
              { label: "Hands",           value: result.config.handIntegration },
              { label: "Chords",          value: result.config.chords === false ? "None" : result.config.chords },
              { label: "Song Difficulty", value: result.config.songsheetDifficulty },
            ] as { label: string; value: string }[]).map(f => (
              <div key={f.label} style={{ background: "rgba(255,255,255,0.7)", borderRadius: 7, padding: "8px 10px" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{f.label}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Interview answers — only in full view */}
      {!compact && (() => {
        const lmFields = [
          { label: "Language & Listening Style", val: result.languageSkills ?? "" },
          { label: "Focus & Attention",          val: result.coreStrengths  ?? "" },
          { label: "Hand Control & Movement",    val: result.motorBaseline  ?? "" },
        ];
        const ftFields = [
          { label: "Performance Comfort",      val: result.stageReadiness     ?? "" },
          { label: "Exam & Certification Drive", val: result.academicGoals   ?? "" },
          { label: "Practice Discipline",       val: result.practiceCommitment ?? "" },
        ];
        const fields = ftFields.some(f => f.val) ? ftFields : lmFields;
        const hasAny  = fields.some(f => f.val);
        if (!hasAny) return null;
        return (
          <div style={{ marginTop: 14, borderTop: `1px solid ${ts.border}`, paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>Interview</div>
            {fields.filter(n => n.val).map(n => {
              const match  = n.val.match(/^Option ([A-C]):\s*(.+)$/s);
              const letter = match?.[1] ?? "";
              const text   = match?.[2] ?? n.val;
              return (
                <div key={n.label} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                  {letter && (
                    <div style={{ width: 22, height: 22, borderRadius: "50%", background: "rgba(255,255,255,0.8)", border: `1px solid ${ts.border}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: ts.color, marginTop: 1 }}>
                      {letter}
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{n.label}</div>
                    <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{text}</div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: compact ? 10 : 14 }}>
        Screened {new Date(result.screenedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
      </div>
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function ScreeningContent() {
  const { user } = useAuthContext();

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [childName,     setChildName]     = useState("");
  const [studentQuery,  setStudentQuery]  = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);

  // Step 2
  const [languageSkills, setLanguageSkills] = useState("");
  const [coreStrengths,  setCoreStrengths]  = useState("");
  const [motorBaseline,  setMotorBaseline]  = useState("");

  // Step 3
  const [rhythmScore, setRhythmScore] = useState<number | null>(null);
  const [pitchScore,  setPitchScore]  = useState<number | null>(null);
  const [motorScore,  setMotorScore]  = useState<number | null>(null);

  // Save
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  useEffect(() => {
    setStudsLoading(true);
    getDocs(query(collection(db, "users"), where("role", "==", "student")))
      .then(snap => {
        setAllStudents(snap.docs.map(d => {
          const u = d.data();
          return {
            uid:       d.id,
            name:      (u.displayName ?? u.name ?? "—") as string,
            studentID: (u.studentID ?? "") as string,
          };
        }));
      })
      .catch(() => {})
      .finally(() => setStudsLoading(false));
  }, []);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q || linkedStudent) return [];
    return allStudents
      .filter(s => s.name.toLowerCase().includes(q) || s.studentID.toLowerCase().includes(q))
      .slice(0, 8);
  }, [studentQuery, allStudents, linkedStudent]);

  const allScoresFilled = rhythmScore !== null && pitchScore !== null && motorScore !== null;

  const averageScore = allScoresFilled
    ? Math.round(((rhythmScore! + pitchScore! + motorScore!) / 3) * 100) / 100
    : null;

  const config = averageScore !== null ? computeConfig(averageScore) : null;

  async function handleSave() {
    if (!allScoresFilled || !config || averageScore === null || !childName.trim()) return;
    setSaving(true);
    setSaveErr("");
    try {
      await saveScreening({
        screeningType:  "little-mozarts",
        childName:      childName.trim(),
        languageSkills: languageSkills.trim(),
        coreStrengths:  coreStrengths.trim(),
        motorBaseline:  motorBaseline.trim(),
        rhythmScore:    rhythmScore!,
        pitchScore:     pitchScore!,
        motorScore:     motorScore!,
        averageScore,
        config,
        screenedBy: user?.uid ?? "",
        screenedAt: new Date().toISOString(),
        studentId:  linkedStudent?.uid ?? null,
      });
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setStep(1);
    setChildName(""); setStudentQuery(""); setLinkedStudent(null);
    setShowDropdown(false);
    setLanguageSkills(""); setCoreStrengths(""); setMotorBaseline("");
    setRhythmScore(null); setPitchScore(null); setMotorScore(null);
    setSaved(false); setSaveErr("");
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (saved && config && averageScore !== null) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "32px 0" }}>
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 14, padding: "32px 28px", textAlign: "center" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#15803d", marginBottom: 6 }}>Screening Saved</div>
          <div style={{ fontSize: 14, color: "#166534", marginBottom: 4 }}>
            <strong>{childName}</strong> → <strong>{config.track}</strong>
          </div>
          {linkedStudent && (
            <div style={{ fontSize: 13, color: "#166534", marginBottom: 4 }}>
              Diagnostic saved to student profile: {linkedStudent.name} ({linkedStudent.studentID})
            </div>
          )}
          <div style={{ fontSize: 13, color: "#166534", marginBottom: 24 }}>
            Average score: {averageScore.toFixed(2)} / 5
          </div>
          <button onClick={resetForm} style={s.primaryBtn}>+ New Screening</button>
        </div>
      </div>
    );
  }

  // ── Step indicator ─────────────────────────────────────────────────────────
  const steps = [
    { n: 1 as const, label: "Student Info" },
    { n: 2 as const, label: "Parent Interview" },
    { n: 3 as const, label: "Practical Scores" },
  ];

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      {/* Module switcher */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        <div style={{ flex: 1, border: "2px solid #4f46e5", borderRadius: 10, padding: "12px 16px", background: "#ede9fe" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#4f46e5" }}>🎹 Little Mozarts</div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>Ages 3–6 · Active</div>
        </div>
        <Link href="/dashboard/screening/fast-track" style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 16px", background: "#fafafa", textDecoration: "none", display: "block" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>🎸 Fast Track</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Ages 7–30 · Switch →</div>
        </Link>
      </div>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#111", marginBottom: 4 }}>
          🎹 Pre-Admission Screening
        </div>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          Little Mozarts — Evaluate raw musical capacity and auto-assign the correct learning track.
        </div>
      </div>

      {/* Step indicator */}
      <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 28 }}>
        {steps.map(({ n, label }, i) => (
          <div key={n} style={{ display: "flex", alignItems: "center", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{
                width: 34, height: 34, borderRadius: "50%",
                background: step === n ? "#4f46e5" : step > n ? "#22c55e" : "#e5e7eb",
                color: step >= n ? "#fff" : "#9ca3af",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, flexShrink: 0,
              }}>
                {step > n ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, color: step === n ? "#4f46e5" : "#9ca3af", marginTop: 5, fontWeight: step === n ? 700 : 400, whiteSpace: "nowrap" }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ height: 2, width: 32, background: step > n ? "#22c55e" : "#e5e7eb", flexShrink: 0, marginBottom: 20, margin: "0 0 20px" }} />
            )}
          </div>
        ))}
      </div>

      {/* ── Step 1: Student Info ─────────────────────────────────────────────── */}
      {step === 1 && (
        <div style={s.card}>
          <div style={s.sectionTitle}>Child Information</div>

          <div style={s.field}>
            <label style={s.label}>Child&apos;s Name *</label>
            <input
              value={childName}
              onChange={e => setChildName(e.target.value)}
              placeholder="e.g. Aarav Sharma"
              style={s.input}
            />
          </div>

          <div style={s.field}>
            <label style={s.label}>
              Link to Enrolled Student{" "}
              <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional)</span>
            </label>
            <div style={{ position: "relative" }}>
              {linkedStudent ? (
                <div style={{ ...s.input, display: "flex", alignItems: "center", justifyContent: "space-between", color: "#374151", boxSizing: "border-box" }}>
                  <span>{linkedStudent.name} <span style={{ color: "#9ca3af" }}>({linkedStudent.studentID})</span></span>
                  <button
                    type="button"
                    onClick={() => { setLinkedStudent(null); setStudentQuery(""); }}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "#9ca3af", padding: 0, lineHeight: 1 }}>
                    ✕
                  </button>
                </div>
              ) : (
                <input
                  value={studentQuery}
                  onChange={e => { setStudentQuery(e.target.value); setShowDropdown(true); }}
                  onFocus={() => setShowDropdown(true)}
                  onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                  placeholder="Search by name or student ID…"
                  style={s.input}
                />
              )}

              {showDropdown && filteredStudents.length > 0 && !linkedStudent && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", boxShadow: "0 6px 18px rgba(0,0,0,0.10)", background: "#fff", marginTop: 2 }}>
                  {filteredStudents.map(st => (
                    <div
                      key={st.uid}
                      onMouseDown={() => { setLinkedStudent(st); if (!childName.trim()) setChildName(st.name); setStudentQuery(""); setShowDropdown(false); }}
                      style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
                    >
                      <span style={{ fontWeight: 600, color: "#111" }}>{st.name}</span>
                      <span style={{ fontSize: 12, color: "#9ca3af" }}>{st.studentID}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>
              {studsLoading ? "Loading students…" : "Links this diagnostic to the student's profile for instructor review."}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button
              type="button"
              disabled={!childName.trim()}
              onClick={() => setStep(2)}
              style={{ ...s.primaryBtn, opacity: childName.trim() ? 1 : 0.4, cursor: childName.trim() ? "pointer" : "not-allowed" }}>
              Next: Parent Interview →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Parent Interview ─────────────────────────────────────────── */}
      {step === 2 && (
        <div style={s.card}>
          <div style={s.sectionTitle}>Parent Screening Interview</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
            Select the option that best describes your child. Ask the parent to help choose.
          </div>

          {INTERVIEW_QUESTIONS.map((q, qi) => {
            const currentVal = q.key === "languageSkills" ? languageSkills
              : q.key === "coreStrengths" ? coreStrengths
              : motorBaseline;
            const setter = q.key === "languageSkills" ? setLanguageSkills
              : q.key === "coreStrengths" ? setCoreStrengths
              : setMotorBaseline;

            return (
              <div key={q.key} style={{ marginBottom: qi < 2 ? 28 : 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 2 }}>
                  {qi + 1}. {q.title}
                </div>
                <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>{q.subtitle}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {q.options.map(opt => {
                    const optValue = `Option ${opt.letter}: ${opt.text}`;
                    const selected = currentVal === optValue;
                    return (
                      <div
                        key={opt.letter}
                        onClick={() => setter(selected ? "" : optValue)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 12,
                          border: selected ? "2px solid #4f46e5" : "1px solid #e5e7eb",
                          borderRadius: 10, padding: "12px 14px",
                          background: selected ? "#ede9fe" : "#fafafa",
                          cursor: "pointer", transition: "all 0.12s",
                        }}
                      >
                        <div style={{
                          width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                          background: selected ? "#4f46e5" : "#e5e7eb",
                          color: selected ? "#fff" : "#6b7280",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 12, fontWeight: 800, marginTop: 1,
                        }}>
                          {selected ? "✓" : opt.letter}
                        </div>
                        <div style={{ fontSize: 14, color: selected ? "#3730a3" : "#374151", lineHeight: 1.5, fontWeight: selected ? 600 : 400 }}>
                          {opt.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
            <button type="button" onClick={() => setStep(1)} style={s.secondaryBtn}>← Back</button>
            <button type="button" onClick={() => setStep(3)} style={s.primaryBtn}>Next: Practical Scores →</button>
          </div>
        </div>
      )}

      {/* ── Step 3: Practical Scores ─────────────────────────────────────────── */}
      {step === 3 && (
        <>
          <div style={s.card}>
            <div style={s.sectionTitle}>Practical Assessment</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
              Score each activity 1–5. Results compute automatically once all three are filled.
            </div>

            {([
              { icon: "🥁", game: "The Heartbeat Sync Game", hint: "Rhythm Score",  value: rhythmScore, set: setRhythmScore },
              { icon: "🎵", game: "The Bird vs. Bear Game",  hint: "Pitch Score",   value: pitchScore,  set: setPitchScore  },
              { icon: "🐾", game: "The Animal Footsteps Game", hint: "Motor Score", value: motorScore,  set: setMotorScore  },
            ]).map((g, i) => (
              <div key={g.hint} style={{ marginBottom: i < 2 ? 28 : 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 22, lineHeight: 1 }}>{g.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>{g.game}</div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>{g.hint}</div>
                  </div>
                  {g.value !== null && (
                    <div style={{ fontSize: 22, fontWeight: 900, color: scoreColor(g.value), minWidth: 36, textAlign: "right" }}>
                      {g.value}
                    </div>
                  )}
                </div>
                <ScoreSelector value={g.value} onChange={g.set} />
              </div>
            ))}
          </div>

          {/* Results panel — auto-shown when all scores filled */}
          {allScoresFilled && config && averageScore !== null ? (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                Diagnostic Result
              </div>
              <DiagnosticCard
                result={{
                  childName,
                  rhythmScore: rhythmScore!,
                  pitchScore:  pitchScore!,
                  motorScore:  motorScore!,
                  averageScore,
                  config,
                  screenedAt:     new Date().toISOString(),
                  languageSkills, coreStrengths, motorBaseline,
                }}
              />
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "18px 0", fontSize: 13, color: "#9ca3af" }}>
              Fill all three scores above to see the diagnostic result.
            </div>
          )}

          {saveErr && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginTop: 14 }}>
              {saveErr}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
            <button type="button" onClick={() => setStep(2)} style={s.secondaryBtn}>← Back</button>
            <button
              type="button"
              disabled={!allScoresFilled || saving}
              onClick={handleSave}
              style={{ ...s.primaryBtn, opacity: allScoresFilled && !saving ? 1 : 0.4, cursor: allScoresFilled && !saving ? "pointer" : "not-allowed" }}>
              {saving ? "Saving…" : "💾 Save Screening"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "24px 24px",
  },
  sectionTitle: {
    fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 18,
  },
  field: { marginBottom: 18 },
  label: {
    fontSize: 13, fontWeight: 600, color: "#374151",
    display: "block", marginBottom: 6,
  },
  input: {
    width: "100%", boxSizing: "border-box",
    border: "1px solid #d1d5db", borderRadius: 7,
    padding: "9px 12px", fontSize: 14, outline: "none",
    fontFamily: "inherit", color: "#111", background: "#fff",
  },
  primaryBtn: {
    padding: "10px 22px", borderRadius: 8,
    border: "none", background: "#4f46e5",
    color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
  },
  secondaryBtn: {
    padding: "10px 18px", borderRadius: 8,
    border: "1px solid #d1d5db", background: "#f9fafb",
    color: "#374151", fontSize: 14, cursor: "pointer",
  },
};
