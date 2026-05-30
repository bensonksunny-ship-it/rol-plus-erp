"use client";

import { useState, useEffect, useMemo } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening } from "@/services/screening/screening.service";
import type { ScreeningConfig } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────
type SensoryResponse = "positive" | "neutral" | "withdrawal" | "distress" | null;
interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Constants ────────────────────────────────────────────────────────────────
const ACCENT = "#7c3aed";

const RESPONSE_OPTIONS: { id: SensoryResponse; emoji: string; label: string; desc: string; border: string; bg: string; color: string; score: number }[] = [
  { id: "positive",   emoji: "🟢", label: "Positive",   desc: "Engaged, calm, visibly interested",          border: "#16a34a", bg: "#f0fdf4", color: "#15803d", score: 4 },
  { id: "neutral",    emoji: "⚪", label: "Neutral",    desc: "No strong reaction — passive or observing",   border: "#9ca3af", bg: "#f9fafb", color: "#6b7280", score: 3 },
  { id: "withdrawal", emoji: "🟡", label: "Withdrawal", desc: "Pulling back, looking away, disengaging",     border: "#d97706", bg: "#fffbeb", color: "#92400e", score: 2 },
  { id: "distress",   emoji: "🔴", label: "Distress",   desc: "Visible discomfort or shutting down",        border: "#dc2626", bg: "#fef2f2", color: "#991b1b", score: 1 },
];

const NOTATION_OPTIONS = [
  "Standard Black Notation",
  "Color-Coded by Hand (RH / LH)",
  "Rainbow Solfège",
  "High-Contrast Black & White",
  "Large Print Monochrome",
  "No notation — rote / listen-only",
] as const;
type NotationOption = typeof NOTATION_OPTIONS[number];

const TACTILE_OPTIONS = [
  "No specific preference",
  "Textured stickers on landmark keys",
  "Colored dots on C and F positions",
  "Weighted finger guides",
  "Foam/cushion keyboard overlay",
  "Adaptive one-handed keyboard",
] as const;
type TactileOption = typeof TACTILE_OPTIONS[number];

const VISUAL_STYLE_OPTIONS = [
  "Standard notation sheets",
  "Gamified icon-based symbols",
  "Picture / image-based cues",
  "Color-block graphic notation",
  "Digital screen with visual animations",
  "Simplified single-line melody strips",
] as const;
type VisualStyleOption = typeof VISUAL_STYLE_OPTIONS[number];

const FOCUS_TRIGGER_OPTIONS = [
  "Musical reward sounds",
  "Visual progress chart / sticker board",
  "Repetition & consistent routine",
  "Peer or family social encouragement",
  "Gamified score / points system",
  "Movement breaks between activities",
  "Choice-based participation",
] as const;
type FocusTriggerOption = typeof FOCUS_TRIGGER_OPTIONS[number];

const BENCHMARKS: { code: string; icon: string; title: string; procedure: string[] }[] = [
  {
    code: "B-01", icon: "🎹", title: "Initial Keyboard Sound Range",
    procedure: [
      "Sit at the keyboard with the student beside you — do not prompt them to touch it.",
      "Play a single soft middle C (mp dynamic). Pause 5 seconds.",
      "Play a slow ascending C–E–G with a 2-second gap between each note.",
      "Observe body language, eye contact, vocalisations, and physical proximity.",
    ],
  },
  {
    code: "B-02", icon: "🥁", title: "Soft Percussive Beat Response",
    procedure: [
      "Use a padded drum pad or tabletop surface — not a metronome click.",
      "Tap a slow, steady beat at roughly 50–60 BPM using a soft fingertip.",
      "Maintain for 8–10 beats. Do not speak — let the sound be the only stimulus.",
      "Observe whether the student leans in, mirrors the motion, withdraws, or shows distress.",
    ],
  },
  {
    code: "B-03", icon: "☝️", title: "Single-Finger Key Contact Mechanics",
    procedure: [
      "Invite — do not instruct — the student to rest one finger on any key.",
      "If accepted, gently ask them to press it down slowly. No sound targets, no correction.",
      "Note which finger they choose, how they hold their hand, and comfort with key contact.",
      "If the student declines, mark as Withdrawal and log any cues given.",
    ],
  },
];

interface TeacherOverrides {
  metronomeEnabled: boolean;
  metronomeBpm:     number;
  handIntegration:  "RH Only" | "Hands Separated";
  songDifficulty:   "Simplified/Rote" | "Standard/Easier";
}

const DEFAULT_OVERRIDES: TeacherOverrides = { metronomeEnabled: false, metronomeBpm: 45, handIntegration: "RH Only", songDifficulty: "Simplified/Rote" };

function buildConfig(overrides: TeacherOverrides): ScreeningConfig {
  return {
    track: "Delta Slab",
    syllabusStrategy: "Adaptive Creative Pathway — Fully Personalised Sensory Support",
    metronome: overrides.metronomeEnabled,
    metronomeBpm: overrides.metronomeEnabled ? overrides.metronomeBpm : null,
    handIntegration: overrides.handIntegration,
    chords: false,
    songsheetDifficulty: overrides.songDifficulty,
  };
}

// ─── Design primitives ────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
  padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const btnBase: React.CSSProperties = {
  padding: "11px 22px", borderRadius: 12, border: "none",
  fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center",
};
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
  padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle, resize: "vertical" as const, lineHeight: 1.6, padding: "11px 13px",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.09em", display: "block", marginBottom: 10,
};

// ─── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step }: { step: number }) {
  const steps = ["Student & Needs", "Engagement & Tests", "Config & Save"];
  return (
    <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 26 }}>
      {steps.map((label, i) => {
        const n = i + 1; const done = step > n; const active = step === n;
        return (
          <div key={n} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{ width: 34, height: 34, borderRadius: "50%", background: done || active ? ACCENT : "#f3f4f6", color: done || active ? "#fff" : "#9ca3af", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0, boxShadow: active ? `0 0 0 5px rgba(124,58,237,0.1)` : "none", transition: "all 0.2s" }}>
                {done ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, marginTop: 6, fontWeight: active ? 700 : 400, color: active ? ACCENT : done ? "#6b7280" : "#9ca3af", whiteSpace: "nowrap" }}>{label}</div>
            </div>
            {i < steps.length - 1 && <div style={{ height: 2, width: 48, flexShrink: 0, alignSelf: "flex-start", marginTop: 16, background: done ? ACCENT : "#f0f0f0", transition: "background 0.3s" }} />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Select component ─────────────────────────────────────────────────────────
function AdaptiveSelect<T extends string>({ label, hint, value, options, onChange }: { label: string; hint: string; value: T | ""; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>{hint}</div>
      <select value={value} onChange={e => onChange(e.target.value as T)} style={{ ...inputStyle, appearance: "none" as const, backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath fill='%237c3aed' d='M1 1l5 5 5-5'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 14px center", paddingRight: 38 }}>
        <option value="" disabled>Select…</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ─── Benchmark panel ──────────────────────────────────────────────────────────
function BenchmarkPanel({ code, icon, title, procedure, response, notes, onResponse, onNotes }: { code: string; icon: string; title: string; procedure: string[]; response: SensoryResponse; notes: string; onResponse: (r: SensoryResponse) => void; onNotes: (n: string) => void }) {
  const resp = response ? RESPONSE_OPTIONS.find(r => r.id === response) : null;
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#1e1b4b", padding: "14px 18px" }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#a78bfa", fontFamily: "monospace", background: "rgba(167,139,250,0.12)", borderRadius: 5, padding: "3px 9px", flexShrink: 0 }}>{code}</div>
        <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#f8fafc", flex: 1 }}>{title}</div>
        {resp && <div style={{ fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 99, background: resp.bg, color: resp.color, border: `1px solid ${resp.border}`, flexShrink: 0 }}>{resp.label.toUpperCase()}</div>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <div style={{ background: "#0f0a2e", padding: "16px 18px", borderRight: "1px solid #1e1b4b" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", letterSpacing: "0.08em", marginBottom: 12, fontFamily: "monospace" }}>PROCEDURE</div>
          {procedure.map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, background: "rgba(167,139,250,0.12)", border: "1px solid #4c1d95", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#a78bfa" }}>{i + 1}</div>
              <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.55 }}>{step}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", letterSpacing: "0.08em", marginBottom: 12, fontFamily: "monospace" }}>OBSERVED RESPONSE</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 12 }}>
            {RESPONSE_OPTIONS.map(r => {
              const active = response === r.id;
              return (
                <div key={r.id} onClick={() => onResponse(active ? null : r.id)} style={{ border: active ? `2px solid ${r.border}` : "1.5px solid #f0f0f0", borderRadius: 10, background: active ? r.bg : "#fafafa", padding: "9px 10px", cursor: "pointer", textAlign: "center" as const, transition: "all 0.12s" }}>
                  <div style={{ fontSize: 15, marginBottom: 3 }}>{r.emoji}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: active ? r.color : "#374151" }}>{r.label}</div>
                  <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.4, marginTop: 2 }}>{r.desc}</div>
                </div>
              );
            })}
          </div>
          <textarea value={notes} onChange={e => onNotes(e.target.value)} placeholder="Observation notes — describe specific reactions, body language…" rows={3} style={{ ...textareaStyle, fontSize: 12 }} />
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export function CreativeTrackContent({ onBack }: { onBack?: () => void } = {}) {
  const { user } = useAuthContext();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [students,        setStudents]        = useState<StudentOption[]>([]);
  const [studentSearch,   setStudentSearch]   = useState("");
  const [selectedStudent, setSelectedStudent] = useState<StudentOption | null>(null);
  const [studentName,     setStudentName]     = useState("");
  const [showDropdown,    setShowDropdown]    = useState(false);

  const [emotionalAnchors,     setEmotionalAnchors]     = useState("");
  const [sensorySensitivities, setSensorySensitivities] = useState("");
  const [physicalSupport,      setPhysicalSupport]      = useState("");

  const [notation,     setNotation]     = useState<NotationOption | "">("");
  const [tactile,      setTactile]      = useState<TactileOption | "">("");
  const [visualStyle,  setVisualStyle]  = useState<VisualStyleOption | "">("");
  const [focusTrigger, setFocusTrigger] = useState<FocusTriggerOption | "">("");

  const [soundResponse, setSoundResponse] = useState<SensoryResponse>(null);
  const [soundNotes,    setSoundNotes]    = useState("");
  const [beatResponse,  setBeatResponse]  = useState<SensoryResponse>(null);
  const [beatNotes,     setBeatNotes]     = useState("");
  const [touchResponse, setTouchResponse] = useState<SensoryResponse>(null);
  const [touchNotes,    setTouchNotes]    = useState("");

  const [overrides, setOverrides] = useState<TeacherOverrides>(DEFAULT_OVERRIDES);

  const [saving, setSaving]  = useState(false);
  const [saved,  setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [assessmentId] = useState(() => {
    const d = new Date();
    return `CT-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${Math.floor(Math.random()*0x10000).toString(16).toUpperCase().padStart(4,"0")}`;
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

  function updateOverride<K extends keyof TeacherOverrides>(key: K, val: TeacherOverrides[K]) {
    setOverrides(prev => ({ ...prev, [key]: val }));
  }

  const config = useMemo(() => buildConfig(overrides), [overrides]);

  const avgScore = useMemo(() => {
    const scored = [soundResponse, beatResponse, touchResponse].map(r => RESPONSE_OPTIONS.find(o => o.id === r)?.score ?? null).filter((s): s is number => s !== null);
    return scored.length === 0 ? 3 : scored.reduce((a, b) => a + b, 0) / scored.length;
  }, [soundResponse, beatResponse, touchResponse]);

  const benchmarksComplete = soundResponse !== null && beatResponse !== null && touchResponse !== null;
  const canSave = !!studentName.trim() && !!emotionalAnchors.trim() && !!notation && benchmarksComplete;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true); setSaveErr("");
    try {
      const notesBundle = [soundNotes ? `Sound: ${soundNotes}` : null, beatNotes ? `Beat: ${beatNotes}` : null, touchNotes ? `Touch: ${touchNotes}` : null].filter(Boolean).join(" | ");
      await saveScreening({
        screeningType: "creative-track", childName: studentName.trim(),
        rhythmScore: RESPONSE_OPTIONS.find(r => r.id === beatResponse)?.score ?? 3,
        pitchScore:  RESPONSE_OPTIONS.find(r => r.id === soundResponse)?.score ?? 3,
        motorScore:  RESPONSE_OPTIONS.find(r => r.id === touchResponse)?.score ?? 3,
        averageScore: Math.round(avgScore * 10) / 10,
        config, screenedBy: user?.uid ?? "", screenedAt: new Date().toISOString(),
        studentId: selectedStudent?.uid ?? null,
        sensoryProfile: [emotionalAnchors ? `Anchors: ${emotionalAnchors}` : null, sensorySensitivities ? `Sensitivities: ${sensorySensitivities}` : null].filter(Boolean).join(" | "),
        physicalNeeds: physicalSupport || undefined,
        learningStyle: [notation ? `Notation: ${notation}` : null, tactile ? `Tactile: ${tactile}` : null, visualStyle ? `Visual: ${visualStyle}` : null, focusTrigger ? `Trigger: ${focusTrigger}` : null].filter(Boolean).join(" | "),
        stageReadiness: notesBundle || undefined,
        academicGoals: `Sound: ${soundResponse ?? "—"} | Beat: ${beatResponse ?? "—"} | Touch: ${touchResponse ?? "—"}`,
        practiceCommitment: overrides.metronomeEnabled ? `Teacher override — Metronome: ${overrides.metronomeBpm} BPM, ${overrides.handIntegration}` : `Default Delta Slab — No metronome, ${overrides.handIntegration}`,
      });
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (saved) {
    return (
      <div style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px", textAlign: "center" }}>
        <div style={{ ...card, border: "2px solid #fecaca", background: "#fef2f2", boxShadow: "0 8px 40px rgba(220,38,38,0.10)", padding: "48px 36px" }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>🎨</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#4c1d95", marginBottom: 6 }}>Adaptive profile saved</div>
          <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 28 }}>Creative Track screening logged for <strong style={{ color: "#374151" }}>{studentName}</strong></div>
          <div style={{ background: "rgba(255,255,255,0.6)", borderRadius: 14, padding: "18px", marginBottom: 28, textAlign: "left" as const }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#991b1b", marginBottom: 6 }}>Delta Slab</div>
            <div style={{ fontSize: 12, color: "#991b1b", fontWeight: 600 }}>{config.syllabusStrategy}</div>
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
        background: "linear-gradient(135deg, #f5f3ff, #ede9fe, #faf5ff)",
        border: "1px solid #ddd6fe", borderRadius: 20, padding: "22px 28px",
        marginBottom: 22, display: "flex", alignItems: "center",
        justifyContent: "space-between", flexWrap: "wrap" as const, gap: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🎨</div>
          <div>
            <div style={{ fontSize: 19, fontWeight: 900, color: "#4c1d95" }}>The Creative Track</div>
            <div style={{ fontSize: 12, color: "#6d28d9", opacity: 0.8, marginTop: 2 }}>Inclusive Support Screening · Sensory & Adaptive Assessment</div>
          </div>
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "monospace" }}>ASSESSMENT ID</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, fontFamily: "monospace" }}>{assessmentId}</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const, justifyContent: "flex-end", marginTop: 6 }}>
            {["Adaptive", "Inclusive", "Personalised"].map(t => <span key={t} style={{ fontSize: 10, fontWeight: 700, color: ACCENT, background: "rgba(124,58,237,0.07)", border: "1px solid #ddd6fe", borderRadius: 99, padding: "2px 9px" }}>{t}</span>)}
          </div>
        </div>
      </div>

      <Stepper step={step} />

      {/* ── Step 1: Student & Adaptive Needs ──────────────────────────────── */}
      {step === 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          {/* Student search */}
          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Student Identification</div>
            <div style={{ position: "relative" }}>
              <input value={studentSearch}
                onChange={e => { setStudentSearch(e.target.value); setStudentName(e.target.value); setSelectedStudent(null); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                placeholder="Search by name or student ID…" style={inputStyle} />
              {showDropdown && filteredStudents.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #ede9fe", borderRadius: "0 0 12px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.08)", overflow: "hidden" }}>
                  {filteredStudents.map(s => (
                    <div key={s.uid} onClick={() => { setSelectedStudent(s); setStudentName(s.name); setStudentSearch(s.name); setShowDropdown(false); }}
                      style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #ede9fe", fontSize: 13, display: "flex", justifyContent: "space-between" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f5f3ff")}
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

          {/* Adaptive needs note */}
          <div style={{ ...card, gridColumn: "span 12", background: "#fafaff", border: "1px solid #ede9fe" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>📋</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#4c1d95" }}>Adaptive Need Logistics</div>
                <div style={{ fontSize: 11, color: "#7c3aed", marginTop: 1 }}>Private notes — shared with the assigned teacher only</div>
              </div>
            </div>
          </div>

          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>Emotional Anchors *</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>What helps this student feel calm and ready to learn?</div>
                <textarea value={emotionalAnchors} onChange={e => setEmotionalAnchors(e.target.value)}
                  placeholder="e.g. Arrives with a favourite toy; responds well to consistent greeting phrase…"
                  rows={4} style={textareaStyle} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>Sensory Sensitivities</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>Stimuli that may cause distress or disengagement.</div>
                <textarea value={sensorySensitivities} onChange={e => setSensorySensitivities(e.target.value)}
                  placeholder="e.g. Distressed by loud clicks; prefers dim lighting; dislikes sustained high-pitched sounds…"
                  rows={4} style={textareaStyle} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>Physical Support</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>Adaptive equipment or seating requirements.</div>
                <textarea value={physicalSupport} onChange={e => setPhysicalSupport(e.target.value)}
                  placeholder="e.g. Requires padded chair; keyboard raised 5 cm; uses adaptive one-handed controller…"
                  rows={4} style={textareaStyle} />
              </div>
            </div>
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
            {onBack
              ? <button onClick={onBack} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Hub</button>
              : <Link href="/dashboard/screening" style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280", textDecoration: "none" }}>← Hub</Link>
            }
            <button onClick={() => setStep(2)} disabled={!studentName.trim() || !emotionalAnchors.trim()} style={{
              ...btnBase,
              background: studentName.trim() && emotionalAnchors.trim() ? ACCENT : "#e5e7eb",
              color: studentName.trim() && emotionalAnchors.trim() ? "#fff" : "#9ca3af",
              cursor: studentName.trim() && emotionalAnchors.trim() ? "pointer" : "not-allowed",
            }}>
              Next: Engagement & Tests →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Engagement & Sensory Tests ─────────────────────────────── */}
      {step === 2 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          {/* Engagement profile */}
          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Engagement Profile</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <AdaptiveSelect label="Notation Colour Preference" hint="How should sheet music and note cards be presented?" value={notation} options={NOTATION_OPTIONS} onChange={setNotation} />
                <AdaptiveSelect label="Visual Engagement Style" hint="Which display format best supports attention?" value={visualStyle} options={VISUAL_STYLE_OPTIONS} onChange={setVisualStyle} />
              </div>
              <div>
                <AdaptiveSelect label="Tactile Feedback Preference" hint="What physical cues help differentiate keys?" value={tactile} options={TACTILE_OPTIONS} onChange={setTactile} />
                <AdaptiveSelect label="Focus Trigger / Motivator" hint="Which reinforcement strategy keeps the student engaged?" value={focusTrigger} options={FOCUS_TRIGGER_OPTIONS} onChange={setFocusTrigger} />
              </div>
            </div>
            {(notation || tactile || visualStyle || focusTrigger) && (
              <div style={{ marginTop: 4, padding: "12px 16px", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: ACCENT, letterSpacing: "0.06em", marginBottom: 8 }}>ENGAGEMENT SUMMARY</div>
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 7 }}>
                  {[notation, tactile, visualStyle, focusTrigger].filter(Boolean).map(v => (
                    <span key={v} style={{ fontSize: 11, fontWeight: 600, color: "#4c1d95", background: "rgba(124,58,237,0.07)", border: "1px solid #ddd6fe", borderRadius: 99, padding: "3px 11px" }}>{v}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sensory benchmarks */}
          <div style={{ ...card, gridColumn: "span 12" }}>
            <div style={labelStyle}>Sensory Response Benchmarks</div>
            <div style={{ background: "#0f0a2e", border: "1px solid #1e1b4b", borderRadius: 12, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>
              <span style={{ color: "#a78bfa", fontWeight: 700 }}>Protocol — </span>
              Administer each stimulus in a calm, unhurried environment. Allow the student to self-regulate between stimuli. Log the most pronounced reaction.
            </div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
              <BenchmarkPanel code="B-01" icon="🎹" title={BENCHMARKS[0].title} procedure={BENCHMARKS[0].procedure} response={soundResponse} notes={soundNotes} onResponse={setSoundResponse} onNotes={setSoundNotes} />
              <BenchmarkPanel code="B-02" icon="🥁" title={BENCHMARKS[1].title} procedure={BENCHMARKS[1].procedure} response={beatResponse} notes={beatNotes} onResponse={setBeatResponse} onNotes={setBeatNotes} />
              <BenchmarkPanel code="B-03" icon="☝️" title={BENCHMARKS[2].title} procedure={BENCHMARKS[2].procedure} response={touchResponse} notes={touchNotes} onResponse={setTouchResponse} onNotes={setTouchNotes} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, marginTop: 16 }}>
              {[{ label: "B-01 Sound", done: soundResponse !== null }, { label: "B-02 Beat", done: beatResponse !== null }, { label: "B-03 Touch", done: touchResponse !== null }].map(b => (
                <div key={b.label} style={{ fontSize: 11, fontWeight: 600, padding: "5px 14px", borderRadius: 99, background: b.done ? "#ede9fe" : "#f3f4f6", color: b.done ? "#6d28d9" : "#9ca3af", border: `1px solid ${b.done ? "#ddd6fe" : "#e5e7eb"}` }}>
                  {b.done ? "✓" : "○"} {b.label}
                </div>
              ))}
              {benchmarksComplete && <div style={{ fontSize: 11, fontWeight: 700, padding: "5px 14px", borderRadius: 99, background: "#f0fdf4", color: "#15803d", border: "1px solid #86efac" }}>All benchmarks recorded</div>}
            </div>
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep(1)} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
            <button onClick={() => setStep(3)} disabled={!benchmarksComplete || !notation} style={{
              ...btnBase,
              background: benchmarksComplete && notation ? ACCENT : "#e5e7eb",
              color: benchmarksComplete && notation ? "#fff" : "#9ca3af",
              cursor: benchmarksComplete && notation ? "pointer" : "not-allowed",
            }}>
              {!notation ? "Select notation preference ↑" : !benchmarksComplete ? `Complete all benchmarks (${[soundResponse, beatResponse, touchResponse].filter(Boolean).length}/3)` : "Next: Config & Save →"}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Config & Save ──────────────────────────────────────────── */}
      {step === 3 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

          {/* Locked slab notice */}
          <div style={{ ...card, gridColumn: "span 12", background: "#fef2f2", border: "1.5px solid #fecaca" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "#dc2626", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🔒</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#991b1b", marginBottom: 3 }}>Enrollment locked to Delta Slab</div>
                <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>All Creative Track students begin at Delta Slab — the most supportive, stress-free entry point. Teacher overrides are available but require deliberate configuration.</div>
              </div>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#dc2626", background: "rgba(220,38,38,0.08)", border: "1px solid #fecaca", borderRadius: 6, padding: "4px 10px", flexShrink: 0, fontFamily: "monospace" }}>DELTA SLAB</div>
            </div>
          </div>

          {/* Teacher overrides */}
          <div style={{ ...card, gridColumn: "span 7" }}>
            <div style={labelStyle}>Teacher Override Parameters</div>

            {/* Metronome */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>Metronome</div>
                  <div style={{ fontSize: 11, color: "#9ca3af" }}>Default: OFF — enable only if student shows readiness</div>
                </div>
                <button type="button" onClick={() => updateOverride("metronomeEnabled", !overrides.metronomeEnabled)} style={{ width: 48, height: 26, borderRadius: 99, border: "none", cursor: "pointer", background: overrides.metronomeEnabled ? ACCENT : "#e5e7eb", position: "relative", flexShrink: 0, transition: "background 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: overrides.metronomeEnabled ? 24 : 4, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
                </button>
              </div>
              {overrides.metronomeEnabled && (
                <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#4c1d95" }}>BPM</span>
                    <span style={{ fontSize: 14, fontWeight: 900, color: ACCENT, background: "rgba(124,58,237,0.08)", border: "1px solid #ddd6fe", borderRadius: 8, padding: "3px 12px" }}>{overrides.metronomeBpm}</span>
                  </div>
                  <input type="range" min={30} max={60} step={5} value={overrides.metronomeBpm} onChange={e => updateOverride("metronomeBpm", Number(e.target.value))} style={{ width: "100%", accentColor: ACCENT }} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#9ca3af", marginTop: 4 }}>
                    <span>30 BPM</span><span>60 BPM</span>
                  </div>
                </div>
              )}
            </div>

            {/* Hand integration */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>Hand Integration</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>Default: RH Only</div>
              <div style={{ display: "flex", gap: 10 }}>
                {(["RH Only", "Hands Separated"] as const).map(opt => {
                  const active = overrides.handIntegration === opt;
                  return (
                    <div key={opt} onClick={() => updateOverride("handIntegration", opt)} style={{ flex: 1, border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0", borderRadius: 12, background: active ? "#f5f3ff" : "#fafafa", padding: "12px 14px", cursor: "pointer", textAlign: "center" as const }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#4c1d95" : "#374151" }}>{opt}</div>
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{opt === "RH Only" ? "Default" : "Teacher override"}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Song difficulty */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>Song Difficulty</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>Default: Simplified/Rote</div>
              <div style={{ display: "flex", gap: 10 }}>
                {(["Simplified/Rote", "Standard/Easier"] as const).map(opt => {
                  const active = overrides.songDifficulty === opt;
                  return (
                    <div key={opt} onClick={() => updateOverride("songDifficulty", opt)} style={{ flex: 1, border: active ? `2px solid ${ACCENT}` : "1.5px solid #f0f0f0", borderRadius: 12, background: active ? "#f5f3ff" : "#fafafa", padding: "12px 14px", cursor: "pointer", textAlign: "center" as const }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#4c1d95" : "#374151" }}>{opt}</div>
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{opt === "Simplified/Rote" ? "Default" : "Teacher override"}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Live config + save */}
          <div style={{ gridColumn: "span 5", display: "flex", flexDirection: "column" as const, gap: 14 }}>
            <div style={{ ...card, border: "1.5px solid #fecaca", background: "#fef2f2" }}>
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6 }}>Active Configuration</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#991b1b", marginBottom: 14 }}>Delta Slab</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { label: "Metronome",   value: config.metronome ? `Yes — ${config.metronomeBpm} BPM` : "No metronome" },
                  { label: "Hands",       value: config.handIntegration },
                  { label: "Chords",      value: "None (locked)" },
                  { label: "Difficulty",  value: config.songsheetDifficulty },
                ].map(f => (
                  <div key={f.label} style={{ background: "rgba(255,255,255,0.7)", borderRadius: 8, padding: "9px 11px" }}>
                    <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>{f.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ ...card }}>
              <div style={labelStyle}>Summary</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 4 }}>{studentName || "—"}</div>
              {notation && <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>Notation: {notation}</div>}
              {benchmarksComplete && <div style={{ fontSize: 11, color: "#7c3aed" }}>Sensory score: {avgScore.toFixed(1)} / 4.0</div>}

              {!canSave && (
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
                  {[{ label: "Student name", done: !!studentName.trim() }, { label: "Emotional anchors", done: !!emotionalAnchors.trim() }, { label: "Notation", done: !!notation }, { label: "All benchmarks", done: benchmarksComplete }].map(v => (
                    <div key={v.label} style={{ fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 99, background: v.done ? "#ede9fe" : "#f3f4f6", color: v.done ? "#6d28d9" : "#9ca3af", border: `1px solid ${v.done ? "#ddd6fe" : "#e5e7eb"}` }}>
                      {v.done ? "✓" : "○"} {v.label}
                    </div>
                  ))}
                </div>
              )}

              {saveErr && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#dc2626", marginTop: 12 }}>{saveErr}</div>}

              <button type="button" onClick={handleSave} disabled={saving || !canSave} style={{
                ...btnBase, justifyContent: "center", width: "100%", marginTop: 16,
                background: canSave ? ACCENT : "#e5e7eb",
                color: canSave ? "#fff" : "#9ca3af",
                cursor: canSave ? "pointer" : "not-allowed", padding: "13px 22px",
              }}>
                {saving ? "Saving…" : "Save Creative Track Screening"}
              </button>
            </div>
          </div>

          <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-start" }}>
            <button onClick={() => setStep(2)} style={{ ...btnBase, background: "#f3f4f6", color: "#6b7280" }}>← Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
