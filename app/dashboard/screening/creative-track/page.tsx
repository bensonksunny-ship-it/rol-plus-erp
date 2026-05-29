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

type SensoryResponse = "positive" | "neutral" | "withdrawal" | "distress" | null;

interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Observation response options ─────────────────────────────────────────────

const RESPONSE_OPTIONS: {
  id: SensoryResponse;
  emoji: string;
  label: string;
  desc: string;
  border: string;
  bg: string;
  color: string;
  score: number;
}[] = [
  { id: "positive",   emoji: "🟢", label: "Positive",   desc: "Engaged, calm, and visibly interested",        border: "#16a34a", bg: "#f0fdf4", color: "#15803d", score: 4 },
  { id: "neutral",    emoji: "⚪", label: "Neutral",    desc: "No strong reaction — passive or observing",     border: "#9ca3af", bg: "#f9fafb", color: "#6b7280", score: 3 },
  { id: "withdrawal", emoji: "🟡", label: "Withdrawal", desc: "Pulling back, looking away, or disengaging",    border: "#d97706", bg: "#fffbeb", color: "#92400e", score: 2 },
  { id: "distress",   emoji: "🔴", label: "Distress",   desc: "Visible discomfort, covering ears, or shutting down", border: "#dc2626", bg: "#fef2f2", color: "#991b1b", score: 1 },
];

// ─── Engagement profile options ────────────────────────────────────────────────

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

// ─── Teacher override config ───────────────────────────────────────────────────

interface TeacherOverrides {
  metronomeEnabled: boolean;
  metronomeBpm:     number;
  handIntegration:  "RH Only" | "Hands Separated";
  songDifficulty:   "Simplified/Rote" | "Standard/Easier";
}

const DEFAULT_OVERRIDES: TeacherOverrides = {
  metronomeEnabled: false,
  metronomeBpm:     45,
  handIntegration:  "RH Only",
  songDifficulty:   "Simplified/Rote",
};

function buildConfig(overrides: TeacherOverrides): ScreeningConfig {
  return {
    track:               "Delta Slab",
    syllabusStrategy:    "Adaptive Creative Pathway — Fully Personalised Sensory Support",
    metronome:           overrides.metronomeEnabled,
    metronomeBpm:        overrides.metronomeEnabled ? overrides.metronomeBpm : null,
    handIntegration:     overrides.handIntegration,
    chords:              false,
    songsheetDifficulty: overrides.songDifficulty,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function AdaptiveSectionBar({ icon, code, title, sub }: { icon: string; code: string; title: string; sub?: string }) {
  return (
    <div style={{
      display:      "flex",
      alignItems:   "center",
      gap:          14,
      background:   "linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)",
      borderBottom: "1.5px solid #ddd6fe",
      borderRadius: "13px 13px 0 0",
      padding:      "16px 22px",
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: 12,
        background: "rgba(124,58,237,0.08)",
        border: "1.5px solid #ddd6fe",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 20, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#4c1d95", letterSpacing: "0.01em" }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: "#7c3aed", marginTop: 2, opacity: 0.8 }}>{sub}</div>}
      </div>
      <div style={{
        fontSize: 10, fontWeight: 800, color: "#7c3aed", letterSpacing: "0.1em",
        background: "rgba(124,58,237,0.08)", border: "1px solid #ddd6fe",
        borderRadius: 6, padding: "4px 10px", flexShrink: 0, fontFamily: "monospace",
      }}>
        {code}
      </div>
    </div>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border:       "1.5px solid #ddd6fe",
      borderRadius: 14,
      background:   "#fff",
      marginBottom: 20,
      overflow:     "hidden",
    }}>
      {children}
    </div>
  );
}

function AdaptiveTextArea({
  label, hint, value, onChange, placeholder, rows = 3,
}: {
  label: string; hint: string; value: string;
  onChange: (v: string) => void; placeholder: string; rows?: number;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10, lineHeight: 1.55 }}>{hint}</div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          width:        "100%",
          boxSizing:    "border-box",
          border:       "1.5px solid #ddd6fe",
          borderRadius: 10,
          padding:      "12px 14px",
          fontSize:     13,
          color:        "#374151",
          background:   "#fafaff",
          outline:      "none",
          resize:       "vertical",
          lineHeight:   1.6,
          fontFamily:   "inherit",
        }}
      />
    </div>
  );
}

function AdaptiveSelect<T extends string>({
  label, hint, value, options, onChange,
}: {
  label: string; hint: string; value: T | "";
  options: readonly T[]; onChange: (v: T) => void;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>{hint}</div>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        style={{
          width:        "100%",
          border:       "1.5px solid #ddd6fe",
          borderRadius: 10,
          padding:      "11px 14px",
          fontSize:     13,
          color:        value ? "#374151" : "#9ca3af",
          background:   "#fafaff",
          outline:      "none",
          appearance:   "none",
          backgroundImage:    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%237c3aed' d='M1 1l5 5 5-5'/%3E%3C/svg%3E\")",
          backgroundRepeat:   "no-repeat",
          backgroundPosition: "right 14px center",
          paddingRight:       "38px",
        }}
      >
        <option value="" disabled>Select…</option>
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function BenchmarkPanel({
  code, icon, title, procedure, response, notes,
  onResponse, onNotes,
}: {
  code:       string;
  icon:       string;
  title:      string;
  procedure:  string[];
  response:   SensoryResponse;
  notes:      string;
  onResponse: (r: SensoryResponse) => void;
  onNotes:    (n: string) => void;
}) {
  return (
    <div style={{
      border:       "1.5px solid #ddd6fe",
      borderRadius: 12,
      overflow:     "hidden",
      marginBottom: 16,
    }}>
      {/* Benchmark header */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        gap:          12,
        background:   "#1e1b4b",
        padding:      "14px 18px",
      }}>
        <div style={{
          fontSize: 10, fontWeight: 800, color: "#a78bfa",
          fontFamily: "monospace", background: "rgba(167,139,250,0.12)",
          borderRadius: 5, padding: "3px 9px", flexShrink: 0,
        }}>
          {code}
        </div>
        <div style={{ fontSize: 18, flexShrink: 0 }}>{icon}</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#f8fafc", flex: 1 }}>{title}</div>
        {response && (
          <div style={{
            fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 99,
            background: RESPONSE_OPTIONS.find(r => r.id === response)?.bg ?? "#f9fafb",
            color:      RESPONSE_OPTIONS.find(r => r.id === response)?.color ?? "#6b7280",
            border:     `1px solid ${RESPONSE_OPTIONS.find(r => r.id === response)?.border ?? "#e5e7eb"}`,
          }}>
            {RESPONSE_OPTIONS.find(r => r.id === response)?.label.toUpperCase()}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
        {/* Procedure */}
        <div style={{ background: "#0f0a2e", padding: "18px 20px", borderRight: "1px solid #1e1b4b" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", letterSpacing: "0.08em", marginBottom: 12, fontFamily: "monospace" }}>
            ADMIN PROCEDURE
          </div>
          {procedure.map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{
                width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                background: "rgba(167,139,250,0.12)", border: "1px solid #4c1d95",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 800, color: "#a78bfa",
              }}>
                {i + 1}
              </div>
              <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.55 }}>{step}</div>
            </div>
          ))}
        </div>

        {/* Response + notes */}
        <div style={{ padding: "18px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", letterSpacing: "0.08em", marginBottom: 12, fontFamily: "monospace" }}>
            OBSERVED RESPONSE
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 14 }}>
            {RESPONSE_OPTIONS.map(r => {
              const active = response === r.id;
              return (
                <div
                  key={r.id}
                  onClick={() => onResponse(active ? null : r.id)}
                  style={{
                    border:       active ? `2px solid ${r.border}` : "1.5px solid #e5e7eb",
                    borderRadius: 9,
                    background:   active ? r.bg : "#fafafa",
                    padding:      "9px 10px",
                    cursor:       "pointer",
                    textAlign:    "center",
                    transition:   "all 0.12s",
                  }}
                >
                  <div style={{ fontSize: 16, marginBottom: 3 }}>{r.emoji}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: active ? r.color : "#374151" }}>{r.label}</div>
                  <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.4, marginTop: 2 }}>{r.desc}</div>
                </div>
              );
            })}
          </div>
          <textarea
            value={notes}
            onChange={e => onNotes(e.target.value)}
            placeholder="Admin observation notes — describe specific reactions, vocalisations, body language…"
            rows={3}
            style={{
              width:        "100%",
              boxSizing:    "border-box",
              border:       "1.5px solid #ddd6fe",
              borderRadius: 8,
              padding:      "9px 11px",
              fontSize:     12,
              color:        "#374151",
              background:   "#fafaff",
              outline:      "none",
              resize:       "vertical",
              lineHeight:   1.5,
              fontFamily:   "inherit",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function CreativeTrackContent() {
  const { user } = useAuthContext();

  // Student search
  const [students,        setStudents]        = useState<StudentOption[]>([]);
  const [studentSearch,   setStudentSearch]   = useState("");
  const [selectedStudent, setSelectedStudent] = useState<StudentOption | null>(null);
  const [studentName,     setStudentName]     = useState("");

  // Section 01 — Adaptive Need Logistics
  const [emotionalAnchors,    setEmotionalAnchors]    = useState("");
  const [sensorySensitivities, setSensorySensitivities] = useState("");
  const [physicalSupport,     setPhysicalSupport]     = useState("");

  // Section 02 — Engagement Profile
  const [notation,      setNotation]      = useState<NotationOption | "">("");
  const [tactile,       setTactile]       = useState<TactileOption | "">("");
  const [visualStyle,   setVisualStyle]   = useState<VisualStyleOption | "">("");
  const [focusTrigger,  setFocusTrigger]  = useState<FocusTriggerOption | "">("");

  // Section 03 — Sensory Benchmarks
  const [soundResponse,   setSoundResponse]   = useState<SensoryResponse>(null);
  const [soundNotes,      setSoundNotes]      = useState("");
  const [beatResponse,    setBeatResponse]    = useState<SensoryResponse>(null);
  const [beatNotes,       setBeatNotes]       = useState("");
  const [touchResponse,   setTouchResponse]   = useState<SensoryResponse>(null);
  const [touchNotes,      setTouchNotes]      = useState("");

  // Section 04 — Teacher Overrides
  const [overrides, setOverrides] = useState<TeacherOverrides>(DEFAULT_OVERRIDES);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [saveErr,setSaveErr] = useState("");

  // Assessment ID
  const [assessmentId] = useState(() => {
    const d  = new Date();
    const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const sx = Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, "0");
    return `CT-${ds}-${sx}`;
  });

  useEffect(() => {
    if (!db) return;
    getDocs(query(collection(db, "users"), where("role", "==", "student"))).then(snap => {
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

  function updateOverride<K extends keyof TeacherOverrides>(key: K, val: TeacherOverrides[K]) {
    setOverrides(prev => ({ ...prev, [key]: val }));
  }

  const config = useMemo(() => buildConfig(overrides), [overrides]);

  // Average sensory score (only from observed responses)
  const avgScore = useMemo(() => {
    const scored = [soundResponse, beatResponse, touchResponse]
      .map(r => RESPONSE_OPTIONS.find(o => o.id === r)?.score ?? null)
      .filter((s): s is number => s !== null);
    if (scored.length === 0) return 3;
    return scored.reduce((a, b) => a + b, 0) / scored.length;
  }, [soundResponse, beatResponse, touchResponse]);

  const benchmarksComplete =
    soundResponse !== null && beatResponse !== null && touchResponse !== null;

  const canSave =
    !!studentName.trim() &&
    !!emotionalAnchors.trim() &&
    !!notation &&
    benchmarksComplete;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveErr("");
    try {
      const sensoryScore = Math.round(avgScore * 10) / 10;
      const notesBundle = [
        soundNotes  ? `Sound: ${soundNotes}`  : null,
        beatNotes   ? `Beat: ${beatNotes}`    : null,
        touchNotes  ? `Touch: ${touchNotes}`  : null,
      ].filter(Boolean).join(" | ");

      await saveScreening({
        screeningType: "creative-track",
        childName:     studentName.trim(),
        rhythmScore:   RESPONSE_OPTIONS.find(r => r.id === beatResponse)?.score  ?? 3,
        pitchScore:    RESPONSE_OPTIONS.find(r => r.id === soundResponse)?.score ?? 3,
        motorScore:    RESPONSE_OPTIONS.find(r => r.id === touchResponse)?.score ?? 3,
        averageScore:  sensoryScore,
        config,
        screenedBy:    user?.uid ?? "",
        screenedAt:    new Date().toISOString(),
        studentId:     selectedStudent?.uid ?? null,
        // Sensory & adaptive fields
        sensoryProfile: [
          emotionalAnchors    ? `Emotional anchors: ${emotionalAnchors}`      : null,
          sensorySensitivities ? `Sensitivities: ${sensorySensitivities}`      : null,
        ].filter(Boolean).join(" | "),
        physicalNeeds:  physicalSupport || undefined,
        learningStyle: [
          notation     ? `Notation: ${notation}`      : null,
          tactile      ? `Tactile: ${tactile}`        : null,
          visualStyle  ? `Visual: ${visualStyle}`     : null,
          focusTrigger ? `Trigger: ${focusTrigger}`   : null,
        ].filter(Boolean).join(" | "),
        // Benchmark observation notes via existing fields
        stageReadiness:     notesBundle || undefined,
        academicGoals:      `Sound: ${soundResponse ?? "—"} | Beat: ${beatResponse ?? "—"} | Touch: ${touchResponse ?? "—"}`,
        practiceCommitment: overrides.metronomeEnabled
          ? `Teacher override — Metronome: ${overrides.metronomeBpm} BPM, ${overrides.handIntegration}`
          : `Default Delta Slab — No metronome, ${overrides.handIntegration}`,
      });
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ─── Success screen ──────────────────────────────────────────────────────────

  if (saved) {
    return (
      <div style={{ maxWidth: 540, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 52, marginBottom: 16 }}>🎨</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#4c1d95", marginBottom: 6 }}>
          Adaptive profile saved
        </div>
        <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 32 }}>
          Creative Track screening logged for <strong style={{ color: "#374151" }}>{studentName}</strong>
        </div>
        <div style={{
          border:       "1.5px solid #fecaca",
          borderRadius: 16,
          background:   "#fef2f2",
          padding:      "26px 22px",
          boxShadow:    "0 0 32px rgba(220,38,38,0.10)",
          marginBottom: 28,
          textAlign:    "left",
        }}>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6 }}>Enrollment Slab</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: "#991b1b", marginBottom: 10 }}>
            Delta Slab
          </div>
          <div style={{
            display:       "inline-block",
            background:    "#dc2626",
            color:         "#fff",
            borderRadius:  8,
            padding:       "6px 14px",
            fontSize:      12,
            fontWeight:    700,
            marginBottom:  18,
          }}>
            {config.syllabusStrategy}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { label: "Metronome",       value: config.metronome ? `Yes — ${config.metronomeBpm} BPM` : "No metronome" },
              { label: "Hands",           value: config.handIntegration },
              { label: "Chords",          value: "None" },
              { label: "Song Difficulty", value: config.songsheetDifficulty },
            ].map(f => (
              <div key={f.label} style={{ background: "rgba(255,255,255,0.7)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{f.label}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
              </div>
            ))}
          </div>
        </div>
        <Link
          href="/dashboard/screening"
          style={{ display: "inline-block", background: "#7c3aed", color: "#fff", borderRadius: 10, padding: "12px 28px", fontSize: 14, fontWeight: 700, textDecoration: "none" }}
        >
          ← Back to Screening Hub
        </Link>
      </div>
    );
  }

  // ─── Main form ───────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: "0 16px 60px" }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <Link
          href="/dashboard/screening"
          style={{ fontSize: 12, color: "#9ca3af", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 20, marginTop: 24 }}
        >
          ← Screening Hub
        </Link>
        <div style={{
          background:   "linear-gradient(135deg, #f5f3ff 0%, #ede9fe 50%, #faf5ff 100%)",
          border:       "1.5px solid #ddd6fe",
          borderRadius: 16,
          padding:      "28px 28px 24px",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 28 }}>🎨</span>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#4c1d95", letterSpacing: "-0.01em" }}>
                  The Creative Track
                </div>
              </div>
              <div style={{ fontSize: 14, color: "#6d28d9", opacity: 0.8, marginBottom: 12 }}>
                Inclusive Support Screening — Sensory & Adaptive Assessment
              </div>
              <div style={{
                display:       "inline-block",
                background:    "rgba(124,58,237,0.07)",
                border:        "1px solid #ddd6fe",
                borderRadius:  8,
                padding:       "5px 14px",
                fontSize:      11,
                fontWeight:    700,
                color:         "#6d28d9",
                letterSpacing: "0.04em",
                fontFamily:    "monospace",
              }}>
                {assessmentId}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>
                {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {["Adaptive", "Inclusive", "Personalised"].map(tag => (
                  <span key={tag} style={{
                    fontSize: 10, fontWeight: 700, color: "#7c3aed",
                    background: "rgba(124,58,237,0.07)", border: "1px solid #ddd6fe",
                    borderRadius: 99, padding: "3px 10px",
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Student name ──────────────────────────────────────────────────────── */}
      <SectionCard>
        <AdaptiveSectionBar icon="👤" code="S-00" title="Student Identification" />
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
                border: "1.5px solid #ddd6fe", borderRadius: 10,
                padding: "11px 14px", fontSize: 14, color: "#111",
                background: "#fafaff", outline: "none",
              }}
            />
            {filteredStudents.length > 0 && (
              <div style={{
                position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
                background: "#fff", border: "1.5px solid #ddd6fe",
                borderRadius: "0 0 10px 10px", boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
              }}>
                {filteredStudents.map(s => (
                  <div
                    key={s.uid}
                    onClick={() => { setSelectedStudent(s); setStudentName(s.name); setStudentSearch(s.name); }}
                    style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #ede9fe", fontSize: 14 }}
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

      {/* ── Section 01 — Adaptive Need Logistics ────────────────────────────── */}
      <SectionCard>
        <AdaptiveSectionBar
          icon="📋"
          code="S-01"
          title="Adaptive Need Logistics"
          sub="Record emotional anchors, sensory sensitivities, and physical support requirements"
        />
        <div style={{ padding: "22px" }}>
          <div style={{
            background:   "#fafaff",
            border:       "1px solid #ede9fe",
            borderRadius: 10,
            padding:      "12px 16px",
            marginBottom: 22,
            fontSize:     12,
            color:        "#6d28d9",
            lineHeight:   1.6,
          }}>
            This section documents the student&apos;s individual needs before the session begins.
            These notes are shared with the assigned teacher and kept private from the student&apos;s
            public profile.
          </div>

          <AdaptiveTextArea
            label="Emotional Anchors"
            hint="What helps this student feel calm, safe, and ready to learn? Include routines, objects, phrases, or environments that work."
            value={emotionalAnchors}
            onChange={setEmotionalAnchors}
            placeholder="e.g. Arrives with a favourite toy; responds well to a consistent greeting phrase; needs 5 minutes of quiet settling before any instruction begins…"
            rows={3}
          />

          <AdaptiveTextArea
            label="Sensory Sensitivities"
            hint="Log any stimuli that may cause distress or disengagement — sounds, lighting, textures, crowded spaces, or specific tones."
            value={sensorySensitivities}
            onChange={setSensorySensitivities}
            placeholder="e.g. Distressed by loud metronome clicks; prefers dim lighting; cannot tolerate sustained high-pitched sounds; dislikes the feel of plastic keys…"
            rows={3}
          />

          <AdaptiveTextArea
            label="Physical Support Configuration"
            hint="Record any adaptive equipment, seating requirements, or physical arrangements needed at the instrument."
            value={physicalSupport}
            onChange={setPhysicalSupport}
            placeholder="e.g. Requires a padded chair with armrests; needs keyboard raised 5 cm; uses a single-hand adaptive controller; benefits from a weighted lap pad during sessions…"
            rows={3}
          />
        </div>
      </SectionCard>

      {/* ── Section 02 — Engagement Profile ─────────────────────────────────── */}
      <SectionCard>
        <AdaptiveSectionBar
          icon="🎯"
          code="S-02"
          title="Engagement Profile"
          sub="Select triggers that maximise focus and learning comfort for this student"
        />
        <div style={{ padding: "22px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <AdaptiveSelect
                label="Notation Colour Preference"
                hint="How should sheet music and note cards be presented?"
                value={notation}
                options={NOTATION_OPTIONS}
                onChange={setNotation}
              />
              <AdaptiveSelect
                label="Visual Engagement Style"
                hint="Which display format best supports attention and memory?"
                value={visualStyle}
                options={VISUAL_STYLE_OPTIONS}
                onChange={setVisualStyle}
              />
            </div>
            <div>
              <AdaptiveSelect
                label="Tactile Feedback Preference"
                hint="What physical cues help the student locate and differentiate keys?"
                value={tactile}
                options={TACTILE_OPTIONS}
                onChange={setTactile}
              />
              <AdaptiveSelect
                label="Focus Trigger / Motivator"
                hint="Which reward or reinforcement strategy keeps the student most engaged?"
                value={focusTrigger}
                options={FOCUS_TRIGGER_OPTIONS}
                onChange={setFocusTrigger}
              />
            </div>
          </div>

          {/* Profile summary chips */}
          {(notation || tactile || visualStyle || focusTrigger) && (
            <div style={{
              marginTop:    4,
              padding:      "14px 16px",
              background:   "#f5f3ff",
              border:       "1px solid #ddd6fe",
              borderRadius: 10,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", letterSpacing: "0.06em", marginBottom: 10 }}>
                ENGAGEMENT SUMMARY
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {[notation, tactile, visualStyle, focusTrigger].filter(Boolean).map(val => (
                  <span key={val} style={{
                    fontSize: 11, fontWeight: 600, color: "#4c1d95",
                    background: "rgba(124,58,237,0.08)",
                    border: "1px solid #ddd6fe",
                    borderRadius: 99, padding: "4px 12px",
                  }}>
                    {val}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Section 03 — Sensory Response Benchmark ─────────────────────────── */}
      <SectionCard>
        <AdaptiveSectionBar
          icon="🔬"
          code="S-03"
          title="Sensory Response Benchmark"
          sub="Admin-administered observation — log reactions to three controlled stimuli"
        />
        <div style={{ padding: "22px" }}>
          <div style={{
            background:   "#0f0a2e",
            border:       "1px solid #1e1b4b",
            borderRadius: 10,
            padding:      "12px 16px",
            marginBottom: 20,
            fontSize:     12,
            color:        "#94a3b8",
            lineHeight:   1.6,
          }}>
            <span style={{ color: "#a78bfa", fontWeight: 700 }}>Protocol note — </span>
            Administer each stimulus in a calm, unhurried environment. Allow the student to self-regulate between
            stimuli. Record the dominant observed response — if the student moves between states, log the most
            pronounced reaction and note the transition in the observation field.
          </div>

          <BenchmarkPanel
            code="B-01"
            icon="🎹"
            title="Initial Keyboard Sound Range"
            procedure={[
              "Sit at the keyboard with the student beside you — do not prompt them to touch it.",
              "Play a single soft middle C (mp dynamic). Pause 5 seconds.",
              "Play a slow ascending C–E–G with a 2-second gap between each note.",
              "Observe body language, eye contact, vocalisations, and physical proximity.",
            ]}
            response={soundResponse}
            notes={soundNotes}
            onResponse={setSoundResponse}
            onNotes={setSoundNotes}
          />

          <BenchmarkPanel
            code="B-02"
            icon="🥁"
            title="Soft Percussive Beat Response"
            procedure={[
              "Use a padded drum pad, a tabletop surface, or your own hand — not a metronome click.",
              "Tap a slow, steady beat at roughly 50–60 BPM using a soft mallet or fingertip.",
              "Maintain for 8–10 beats. Do not speak during the beat — let the sound be the only stimulus.",
              "Observe whether the student leans in, mirrors the motion, withdraws, or shows distress.",
            ]}
            response={beatResponse}
            notes={beatNotes}
            onResponse={setBeatResponse}
            onNotes={setBeatNotes}
          />

          <BenchmarkPanel
            code="B-03"
            icon="☝️"
            title="Single-Finger Key Contact Mechanics"
            procedure={[
              "Invite — do not instruct — the student to rest one finger on any key of their choosing.",
              "If accepted, gently ask them to press it down slowly. No sound targets, no correction.",
              "Note which finger they choose, how they hold their hand, and their comfort with sustained key contact.",
              "If the student declines, mark as Withdrawal and log any verbal or non-verbal cues given.",
            ]}
            response={touchResponse}
            notes={touchNotes}
            onResponse={setTouchResponse}
            onNotes={setTouchNotes}
          />

          {/* Benchmark status */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            {[
              { label: "B-01 Sound",  done: soundResponse !== null },
              { label: "B-02 Beat",   done: beatResponse  !== null },
              { label: "B-03 Touch",  done: touchResponse !== null },
            ].map(b => (
              <div key={b.label} style={{
                fontSize: 11, fontWeight: 600, padding: "5px 14px",
                borderRadius: 99,
                background: b.done ? "#ede9fe" : "#f3f4f6",
                color:      b.done ? "#6d28d9" : "#9ca3af",
                border:     `1px solid ${b.done ? "#ddd6fe" : "#e5e7eb"}`,
              }}>
                {b.done ? "✓" : "○"} {b.label}
              </div>
            ))}
            {benchmarksComplete && (
              <div style={{
                fontSize: 11, fontWeight: 700, padding: "5px 14px", borderRadius: 99,
                background: "#f0fdf4", color: "#15803d", border: "1px solid #86efac",
              }}>
                All benchmarks recorded
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      {/* ── Section 04 — Pacing Mapping ──────────────────────────────────────── */}
      <SectionCard>
        <AdaptiveSectionBar
          icon="🗂️"
          code="S-04"
          title="Pacing Mapping"
          sub="Enrollment locked to Delta Slab — teacher override parameters configurable below"
        />
        <div style={{ padding: "22px" }}>

          {/* Locked slab notice */}
          <div style={{
            display:      "flex",
            alignItems:   "center",
            gap:          14,
            background:   "#fef2f2",
            border:       "1.5px solid #fecaca",
            borderRadius: 12,
            padding:      "16px 18px",
            marginBottom: 22,
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10,
              background: "#dc2626", display: "flex",
              alignItems: "center", justifyContent: "center",
              fontSize: 18, flexShrink: 0,
            }}>
              🔒
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#991b1b", marginBottom: 3 }}>
                Enrollment locked to Delta Slab
              </div>
              <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
                All Creative Track students begin at Delta Slab — the most supportive, stress-free
                entry point. Teacher overrides below are available but require deliberate configuration.
              </div>
            </div>
            <div style={{
              fontSize: 10, fontWeight: 800, color: "#dc2626",
              background: "rgba(220,38,38,0.08)", border: "1px solid #fecaca",
              borderRadius: 6, padding: "4px 10px", flexShrink: 0, fontFamily: "monospace",
              whiteSpace: "nowrap",
            }}>
              DELTA SLAB
            </div>
          </div>

          {/* Override panel */}
          <div style={{
            border:       "1.5px solid #ddd6fe",
            borderRadius: 12,
            overflow:     "hidden",
            marginBottom: 22,
          }}>
            <div style={{
              background:    "#1e1b4b",
              padding:       "12px 18px",
              display:       "flex",
              alignItems:    "center",
              gap:           10,
            }}>
              <div style={{
                fontSize: 10, fontWeight: 800, color: "#a78bfa", fontFamily: "monospace",
                background: "rgba(167,139,250,0.12)", borderRadius: 5, padding: "3px 9px",
              }}>
                TEACHER OVERRIDE
              </div>
              <div style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 600 }}>
                Personalised parameters — requires teacher authorisation
              </div>
            </div>
            <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 20 }}>

              {/* Metronome toggle */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>Metronome</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                      Default: OFF — enable only if the student demonstrates readiness for external beat cues
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateOverride("metronomeEnabled", !overrides.metronomeEnabled)}
                    style={{
                      width: 48, height: 26, borderRadius: 99,
                      border: "none", cursor: "pointer",
                      background: overrides.metronomeEnabled ? "#7c3aed" : "#e5e7eb",
                      position: "relative", flexShrink: 0, transition: "background 0.2s",
                    }}
                  >
                    <div style={{
                      position: "absolute", top: 3,
                      left: overrides.metronomeEnabled ? 24 : 4,
                      width: 20, height: 20, borderRadius: "50%",
                      background: "#fff",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
                      transition: "left 0.2s",
                    }} />
                  </button>
                </div>

                {overrides.metronomeEnabled && (
                  <div style={{
                    background:   "#f5f3ff",
                    border:       "1px solid #ddd6fe",
                    borderRadius: 10,
                    padding:      "14px 16px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#4c1d95" }}>BPM Override</div>
                      <div style={{
                        fontSize: 14, fontWeight: 900, color: "#7c3aed",
                        background: "rgba(124,58,237,0.08)",
                        border: "1px solid #ddd6fe", borderRadius: 8,
                        padding: "4px 14px",
                      }}>
                        {overrides.metronomeBpm} BPM
                      </div>
                    </div>
                    <input
                      type="range"
                      min={30}
                      max={60}
                      step={5}
                      value={overrides.metronomeBpm}
                      onChange={e => updateOverride("metronomeBpm", Number(e.target.value))}
                      style={{ width: "100%", accentColor: "#7c3aed" }}
                    />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#9ca3af", marginTop: 4 }}>
                      <span>30 BPM — very slow</span>
                      <span>60 BPM — moderate</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Hand integration override */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Hand Integration</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>
                  Default: RH Only — upgrade to Hands Separated if the student shows bilateral readiness
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  {(["RH Only", "Hands Separated"] as const).map(opt => {
                    const active = overrides.handIntegration === opt;
                    return (
                      <div
                        key={opt}
                        onClick={() => updateOverride("handIntegration", opt)}
                        style={{
                          flex:         1,
                          border:       active ? "2px solid #7c3aed" : "1.5px solid #e5e7eb",
                          borderRadius: 10,
                          background:   active ? "#f5f3ff" : "#fafafa",
                          padding:      "12px 14px",
                          cursor:       "pointer",
                          textAlign:    "center",
                          transition:   "all 0.12s",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#4c1d95" : "#374151" }}>{opt}</div>
                        <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>
                          {opt === "RH Only" ? "Default — single-hand melody focus" : "Both hands, separated practice"}
                        </div>
                        {active && opt !== "RH Only" && (
                          <div style={{
                            marginTop: 6, fontSize: 9, fontWeight: 800,
                            color: "#7c3aed", background: "rgba(124,58,237,0.08)",
                            border: "1px solid #ddd6fe", borderRadius: 99, padding: "2px 8px",
                            display: "inline-block",
                          }}>
                            TEACHER OVERRIDE ACTIVE
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Song difficulty override */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Song Difficulty</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>
                  Default: Simplified/Rote — upgrade to Standard/Easier if notation readiness is confirmed
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  {(["Simplified/Rote", "Standard/Easier"] as const).map(opt => {
                    const active = overrides.songDifficulty === opt;
                    return (
                      <div
                        key={opt}
                        onClick={() => updateOverride("songDifficulty", opt)}
                        style={{
                          flex:         1,
                          border:       active ? "2px solid #7c3aed" : "1.5px solid #e5e7eb",
                          borderRadius: 10,
                          background:   active ? "#f5f3ff" : "#fafafa",
                          padding:      "12px 14px",
                          cursor:       "pointer",
                          textAlign:    "center",
                          transition:   "all 0.12s",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#4c1d95" : "#374151" }}>{opt}</div>
                        <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>
                          {opt === "Simplified/Rote" ? "Default — ear/memory based learning" : "Gentle notation introduction"}
                        </div>
                        {active && opt !== "Simplified/Rote" && (
                          <div style={{
                            marginTop: 6, fontSize: 9, fontWeight: 800,
                            color: "#7c3aed", background: "rgba(124,58,237,0.08)",
                            border: "1px solid #ddd6fe", borderRadius: 99, padding: "2px 8px",
                            display: "inline-block",
                          }}>
                            TEACHER OVERRIDE ACTIVE
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Live config preview */}
          <div style={{
            background:   "#fef2f2",
            border:       "1.5px solid #fecaca",
            borderRadius: 12,
            padding:      "18px 20px",
            marginBottom: 22,
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              flexWrap: "wrap", gap: 10, marginBottom: 14,
            }}>
              <div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3 }}>Active Configuration — Delta Slab</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#991b1b" }}>Delta Slab</div>
              </div>
              <div style={{
                background: "#dc2626", color: "#fff",
                borderRadius: 8, padding: "7px 14px",
                fontSize: 11, fontWeight: 700,
              }}>
                {overrides.metronomeEnabled ? "Teacher Override Active" : "Default Parameters"}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
              {[
                { label: "Metronome",       value: config.metronome ? `Yes — ${config.metronomeBpm} BPM` : "No metronome" },
                { label: "Hands",           value: config.handIntegration },
                { label: "Chords",          value: "None (locked)" },
                { label: "Song Difficulty", value: config.songsheetDifficulty },
              ].map(f => (
                <div key={f.label} style={{ background: "rgba(255,255,255,0.7)", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{f.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{f.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Student summary strip */}
          <div style={{
            background:    "#f9fafb",
            border:        "1px solid #e5e7eb",
            borderRadius:  10,
            padding:       "14px 16px",
            marginBottom:  20,
            display:       "flex",
            alignItems:    "center",
            gap:           16,
            flexWrap:      "wrap",
          }}>
            <div>
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>Student</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{studentName || "—"}</div>
            </div>
            {notation && (
              <div>
                <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>Notation</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{notation}</div>
              </div>
            )}
            {benchmarksComplete && (
              <div>
                <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>Sensory Score</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
                  {avgScore.toFixed(1)} / 4.0
                </div>
              </div>
            )}
          </div>

          {/* Validation hints */}
          {!canSave && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>Required before saving:</div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {[
                  { label: "Student name",         done: !!studentName.trim() },
                  { label: "Emotional anchors",    done: !!emotionalAnchors.trim() },
                  { label: "Notation preference",  done: !!notation },
                  { label: "All 3 benchmarks",     done: benchmarksComplete },
                ].map(v => (
                  <div key={v.label} style={{
                    fontSize: 11, fontWeight: 600, padding: "4px 12px",
                    borderRadius: 99,
                    background: v.done ? "#ede9fe" : "#f3f4f6",
                    color:      v.done ? "#6d28d9" : "#9ca3af",
                    border:     `1px solid ${v.done ? "#ddd6fe" : "#e5e7eb"}`,
                  }}>
                    {v.done ? "✓" : "○"} {v.label}
                  </div>
                ))}
              </div>
            </div>
          )}

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
              background:   canSave ? "#7c3aed" : "#e5e7eb",
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
            {saving ? "Saving adaptive profile…" : "Save Creative Track Screening"}
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Page export ──────────────────────────────────────────────────────────────

export default function CreativeTrackPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <CreativeTrackContent />
      </Suspense>
    </ProtectedRoute>
  );
}
