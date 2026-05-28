"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening } from "@/services/screening/screening.service";
import { DiagnosticCard } from "@/components/DiagnosticCard";
import type { ScreeningConfig } from "@/types";

// ─── Interview questions ──────────────────────────────────────────────────────

const INTERVIEW_QUESTIONS = [
  {
    key:      "stageReadiness" as const,
    title:    "Performance Comfort",
    subtitle: "How does the student feel about performing in front of others?",
    options:  [
      { letter: "A" as const, text: "Prefers playing in one-on-one settings or small classrooms." },
      { letter: "B" as const, text: "Excited to perform on stage in front of large audiences." },
      { letter: "C" as const, text: "Wants to master both stage performances and competitive evaluations." },
    ],
  },
  {
    key:      "academicGoals" as const,
    title:    "Exam & Certification Drive",
    subtitle: "What are the student's goals with formal music education?",
    options:  [
      { letter: "A" as const, text: "Wants to learn structured technique without matching strict exam deadlines." },
      { letter: "B" as const, text: "Highly focused on clearing formal grade examinations and earning certificates." },
      { letter: "C" as const, text: "Aims to fast-track through grades to reach advanced certification quickly." },
    ],
  },
  {
    key:      "practiceCommitment" as const,
    title:    "Practice Discipline",
    subtitle: "How much daily practice can the student commit to?",
    options:  [
      { letter: "A" as const, text: "Can commit to 20–30 minutes of focused technical practice daily." },
      { letter: "B" as const, text: "Ready for 45 minutes of strict daily practice covering scales and exercises." },
      { letter: "C" as const, text: "Fully dedicated to rigorous, long-duration practice for top-tier results." },
    ],
  },
];

// ─── Score guidance ───────────────────────────────────────────────────────────

const SCORE_GUIDANCE = [
  {
    icon: "🥁",
    game: "Rhythm Test",
    desc: "Clapping back patterns at 80 BPM and 120 BPM across 3 trials.",
    hint: "Rhythm Score",
    guidelines: [
      { scores: "1–2", label: "Passes 1 of 3 trials.",   detail: "Struggles with a steady beat." },
      { scores: "3–4", label: "Passes 2 of 3 trials.",   detail: "Good basic rhythm, minor mistakes on fast beats." },
      { scores: "5",   label: "Passes all 3 trials.",    detail: "Flawless timing — handles 3/4 and 4/4 shifts instantly." },
    ],
  },
  {
    icon: "🎵",
    game: "Ear Test",
    desc: "Matching a played 3-note melody or identifying an octave interval.",
    hint: "Pitch Score",
    guidelines: [
      { scores: "1–2", label: "Passes 1 of 3.",          detail: "Struggles to match the note." },
      { scores: "3–4", label: "Passes 2 of 3.",          detail: "Matches single notes well, struggles with quick patterns." },
      { scores: "5",   label: "Passes all 3.",           detail: "Perfect pitch matching and octave tracking." },
    ],
  },
  {
    icon: "🎹",
    game: "Technical Play Test",
    desc: "Executing an exercise or a short prepared piece.",
    hint: "Motor Score",
    guidelines: [
      { scores: "1–2", label: "Score 1–2.",              detail: "Flat fingers, stiff wrists, weak hand posture." },
      { scores: "3–4", label: "Score 3–4.",              detail: "Decent posture, relaxed arms, basic finger coordination." },
      { scores: "5",   label: "Score 5.",                detail: "Naturally curved fingers, excellent wrist flexibility and control." },
    ],
  },
];

// ─── Track compute ────────────────────────────────────────────────────────────

function computeConfig(avg: number): ScreeningConfig {
  if (avg <= 2.5) {
    return {
      track:               "Explorer Track",
      syllabusStrategy:    "Beginner Foundations",
      metronome:           true,
      metronomeBpm:        55,
      handIntegration:     "Hands Separated",
      chords:              false,
      songsheetDifficulty: "Standard/Easier",
    };
  }
  if (avg <= 4.0) {
    return {
      track:               "Achiever Track",
      syllabusStrategy:    "Intermediate Integration",
      metronome:           true,
      metronomeBpm:        70,
      handIntegration:     "Hands Together",
      chords:              "Basic Blocks",
      songsheetDifficulty: "Mid-Tier",
    };
  }
  return {
    track:               "Prodigy Track",
    syllabusStrategy:    "Advanced Performance & 16-Bar Composition",
    metronome:           true,
    metronomeBpm:        80,
    handIntegration:     "Hands Together",
    chords:              "Full Harmonies & Inversions",
    songsheetDifficulty: "Advanced/16-Bar",
  };
}

function scoreColor(n: number): string {
  if (n <= 2) return "#dc2626";
  if (n === 3) return "#d97706";
  return "#16a34a";
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function FastTrackScreeningPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <FastTrackContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// ─── Student search type ──────────────────────────────────────────────────────

interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Score selector ───────────────────────────────────────────────────────────

function ScoreSelector({ value, onChange }: { value: number | null; onChange: (n: number) => void }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n} type="button" onClick={() => onChange(n)}
          style={{
            flex: 1, padding: "11px 0", borderRadius: 8,
            border: value === n ? "2px solid #6d28d9" : "1px solid #e5e7eb",
            background: value === n ? "#ede9fe" : "#f9fafb",
            color: value === n ? "#6d28d9" : "#6b7280",
            fontSize: 17, fontWeight: value === n ? 800 : 500,
            cursor: "pointer", transition: "all 0.12s", lineHeight: 1,
          }}>
          {n}
        </button>
      ))}
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function FastTrackContent() {
  const { user } = useAuthContext();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [childName,     setChildName]     = useState("");
  const [studentQuery,  setStudentQuery]  = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);

  // Step 2 — interview selections
  const [stageReadiness,     setStageReadiness]     = useState("");
  const [academicGoals,      setAcademicGoals]      = useState("");
  const [practiceCommitment, setPracticeCommitment] = useState("");

  // Step 3 — practical scores
  const [rhythmScore, setRhythmScore] = useState<number | null>(null);
  const [pitchScore,  setPitchScore]  = useState<number | null>(null);
  const [motorScore,  setMotorScore]  = useState<number | null>(null);

  // Save state
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

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

  const allScoresFilled = rhythmScore !== null && pitchScore !== null && motorScore !== null;
  const averageScore    = allScoresFilled ? Math.round(((rhythmScore! + pitchScore! + motorScore!) / 3) * 100) / 100 : null;
  const config          = averageScore !== null ? computeConfig(averageScore) : null;

  async function handleSave() {
    if (!allScoresFilled || !config || averageScore === null || !childName.trim()) return;
    setSaving(true); setSaveErr("");
    try {
      await saveScreening({
        screeningType:      "fast-track",
        childName:          childName.trim(),
        stageReadiness:     stageReadiness.trim(),
        academicGoals:      academicGoals.trim(),
        practiceCommitment: practiceCommitment.trim(),
        rhythmScore:        rhythmScore!,
        pitchScore:         pitchScore!,
        motorScore:         motorScore!,
        averageScore,
        config,
        screenedBy: user?.uid ?? "",
        screenedAt: new Date().toISOString(),
        studentId:  linkedStudent?.uid ?? null,
      });
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally { setSaving(false); }
  }

  function resetForm() {
    setStep(1);
    setChildName(""); setStudentQuery(""); setLinkedStudent(null); setShowDropdown(false);
    setStageReadiness(""); setAcademicGoals(""); setPracticeCommitment("");
    setRhythmScore(null); setPitchScore(null); setMotorScore(null);
    setSaved(false); setSaveErr("");
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (saved && config && averageScore !== null) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "32px 0" }}>
        <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 14, padding: "32px 28px", textAlign: "center" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>🎸</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#7e22ce", marginBottom: 6 }}>Screening Saved</div>
          <div style={{ fontSize: 14, color: "#6b21a8", marginBottom: 4 }}>
            <strong>{childName}</strong> → <strong>{config.track}</strong>
          </div>
          {linkedStudent && (
            <div style={{ fontSize: 13, color: "#6b21a8", marginBottom: 4 }}>
              Diagnostic saved to: {linkedStudent.name} ({linkedStudent.studentID})
            </div>
          )}
          <div style={{ fontSize: 13, color: "#6b21a8", marginBottom: 24 }}>Average score: {averageScore.toFixed(2)} / 5</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button onClick={resetForm} style={{ ...s.primaryBtn }}>+ New Screening</button>
            <Link href="/dashboard/screening" style={{ ...s.secondaryBtn, textDecoration: "none" }}>← Little Mozarts</Link>
          </div>
        </div>
      </div>
    );
  }

  const steps = [
    { n: 1 as const, label: "Student Info"   },
    { n: 2 as const, label: "Interview"      },
    { n: 3 as const, label: "Practical Test" },
  ];

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      {/* Module switcher */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        <Link href="/dashboard/screening" style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 16px", background: "#fafafa", textDecoration: "none", display: "block" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>🎹 Little Mozarts</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Ages 3–6 · Switch ←</div>
        </Link>
        <div style={{ flex: 1, border: "2px solid #7c3aed", borderRadius: 10, padding: "12px 16px", background: "#ede9fe" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#7c3aed" }}>🎸 Fast Track / Rising Stars</div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>Ages 7–30 · Active</div>
        </div>
      </div>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#111", marginBottom: 4 }}>
          🎸 Fast Track / Rising Stars Screening
        </div>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          Ages 7–30 — Determine starting level and track configuration for the 12-Session Keyboard Textbook.
        </div>
      </div>

      {/* Step indicator */}
      <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 28 }}>
        {steps.map(({ n, label }, i) => (
          <div key={n} style={{ display: "flex", alignItems: "center", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{
                width: 34, height: 34, borderRadius: "50%",
                background: step === n ? "#7c3aed" : step > n ? "#22c55e" : "#e5e7eb",
                color: step >= n ? "#fff" : "#9ca3af",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, flexShrink: 0,
              }}>
                {step > n ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, color: step === n ? "#7c3aed" : "#9ca3af", marginTop: 5, fontWeight: step === n ? 700 : 400, whiteSpace: "nowrap" }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ height: 2, width: 32, background: step > n ? "#22c55e" : "#e5e7eb", flexShrink: 0, margin: "0 0 20px" }} />
            )}
          </div>
        ))}
      </div>

      {/* ── Step 1: Student Info ─────────────────────────────────────────────── */}
      {step === 1 && (
        <div style={s.card}>
          <div style={s.sectionTitle}>Student Information</div>

          <div style={s.field}>
            <label style={s.label}>Student&apos;s Name *</label>
            <input value={childName} onChange={e => setChildName(e.target.value)} placeholder="e.g. Rahul Menon" style={s.input} />
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
                  <button type="button" onClick={() => { setLinkedStudent(null); setStudentQuery(""); }}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "#9ca3af", padding: 0, lineHeight: 1 }}>✕</button>
                </div>
              ) : (
                <input value={studentQuery}
                  onChange={e => { setStudentQuery(e.target.value); setShowDropdown(true); }}
                  onFocus={() => setShowDropdown(true)}
                  onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                  placeholder="Search by name or student ID…"
                  style={s.input} />
              )}
              {showDropdown && filteredStudents.length > 0 && !linkedStudent && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", boxShadow: "0 6px 18px rgba(0,0,0,0.10)", background: "#fff", marginTop: 2 }}>
                  {filteredStudents.map(st => (
                    <div key={st.uid}
                      onMouseDown={() => { setLinkedStudent(st); if (!childName.trim()) setChildName(st.name); setStudentQuery(""); setShowDropdown(false); }}
                      style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={e => (e.currentTarget.style.background = "#fff")}>
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
            <button type="button" disabled={!childName.trim()} onClick={() => setStep(2)}
              style={{ ...s.primaryBtn, opacity: childName.trim() ? 1 : 0.4, cursor: childName.trim() ? "pointer" : "not-allowed" }}>
              Next: Interview →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Interview ────────────────────────────────────────────────── */}
      {step === 2 && (
        <div style={s.card}>
          <div style={s.sectionTitle}>Student / Parent Interview</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
            Select the option that best describes the student. All three questions required.
          </div>

          {INTERVIEW_QUESTIONS.map((q, qi) => {
            const currentVal = q.key === "stageReadiness" ? stageReadiness
              : q.key === "academicGoals" ? academicGoals
              : practiceCommitment;
            const setter = q.key === "stageReadiness" ? setStageReadiness
              : q.key === "academicGoals" ? setAcademicGoals
              : setPracticeCommitment;

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
                      <div key={opt.letter} onClick={() => setter(selected ? "" : optValue)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 12,
                          border: selected ? "2px solid #7c3aed" : "1px solid #e5e7eb",
                          borderRadius: 10, padding: "12px 14px",
                          background: selected ? "#ede9fe" : "#fafafa",
                          cursor: "pointer", transition: "all 0.12s",
                        }}>
                        <div style={{
                          width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                          background: selected ? "#7c3aed" : "#e5e7eb",
                          color: selected ? "#fff" : "#6b7280",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 12, fontWeight: 800, marginTop: 1,
                        }}>
                          {selected ? "✓" : opt.letter}
                        </div>
                        <div style={{ fontSize: 14, color: selected ? "#4c1d95" : "#374151", lineHeight: 1.5, fontWeight: selected ? 600 : 400 }}>
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
            <button type="button" onClick={() => setStep(3)} style={s.primaryBtn}>Next: Practical Test →</button>
          </div>
        </div>
      )}

      {/* ── Step 3: Practical Scores ─────────────────────────────────────────── */}
      {step === 3 && (
        <>
          <div style={s.card}>
            <div style={s.sectionTitle}>Practical Assessment</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
              Run each test across 3 trials. Use the scoring guide below each test to assign a score.
            </div>

            {([
              { guidance: SCORE_GUIDANCE[0], value: rhythmScore, set: setRhythmScore },
              { guidance: SCORE_GUIDANCE[1], value: pitchScore,  set: setPitchScore  },
              { guidance: SCORE_GUIDANCE[2], value: motorScore,  set: setMotorScore  },
            ]).map((g, i) => (
              <div key={g.guidance.hint} style={{ marginBottom: i < 2 ? 30 : 8 }}>
                {/* Test header */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>{g.guidance.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>{g.guidance.game}</div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{g.guidance.desc}</div>
                  </div>
                  {g.value !== null && (
                    <div style={{ fontSize: 22, fontWeight: 900, color: scoreColor(g.value), minWidth: 32, textAlign: "right" }}>
                      {g.value}
                    </div>
                  )}
                </div>

                {/* Score buttons */}
                <ScoreSelector value={g.value} onChange={g.set} />

                {/* Trial criteria */}
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  {g.guidance.guidelines.map(gl => (
                    <div key={gl.scores} style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      padding: "8px 12px", borderRadius: 8,
                      background: g.value !== null && (
                        (gl.scores === "1–2" && g.value <= 2) ||
                        (gl.scores === "3–4" && g.value >= 3 && g.value <= 4) ||
                        (gl.scores === "5"   && g.value === 5)
                      ) ? "#f3f0ff" : "#f9fafb",
                    }}>
                      <span style={{
                        fontSize: 11, fontWeight: 800, color: "#7c3aed",
                        background: "#ede9fe", borderRadius: 5, padding: "2px 6px",
                        flexShrink: 0, marginTop: 1,
                      }}>
                        {gl.scores}
                      </span>
                      <div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{gl.label}</span>
                        {" "}
                        <span style={{ fontSize: 12, color: "#6b7280" }}>{gl.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Results panel */}
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
                  screenedAt:         new Date().toISOString(),
                  stageReadiness,
                  academicGoals,
                  practiceCommitment,
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
            <button type="button" disabled={!allScoresFilled || saving} onClick={handleSave}
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
  card:         { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "24px 24px" },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 18 },
  field:        { marginBottom: 18 },
  label:        { fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 },
  input: {
    width: "100%", boxSizing: "border-box",
    border: "1px solid #d1d5db", borderRadius: 7,
    padding: "9px 12px", fontSize: 14, outline: "none",
    fontFamily: "inherit", color: "#111", background: "#fff",
  },
  primaryBtn: {
    padding: "10px 22px", borderRadius: 8,
    border: "none", background: "#7c3aed",
    color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
    display: "inline-flex", alignItems: "center",
  },
  secondaryBtn: {
    padding: "10px 18px", borderRadius: 8,
    border: "1px solid #d1d5db", background: "#f9fafb",
    color: "#374151", fontSize: 14, cursor: "pointer",
    display: "inline-flex", alignItems: "center",
  },
};
