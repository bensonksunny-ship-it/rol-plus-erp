"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useWing } from "@/hooks/useWing";
import { saveScreening, getAllScreenings } from "@/services/screening/screening.service";
import { AdmissionsList } from "./admissions-list";
import type { ScreeningConfig, ScreeningTrack, ScreeningResult, ScreeningType } from "@/types";
import { DiagnosticCard, TRACK_STYLE } from "@/components/DiagnosticCard";
import { GuitarScreeningContent } from "./guitar/GuitarScreeningContent";
import { KeyboardScreeningContent } from "./keyboard/KeyboardScreeningContent";
import { DrumScreeningContent } from "./drums/DrumScreeningContent";

// ─── Track definitions ────────────────────────────────────────────────────────

interface TrackInterviewQuestion {
  key:      string;
  title:    string;
  subtitle: string;
  options:  Array<{ letter: "A" | "B" | "C"; text: string }>;
}

interface TrackGame { icon: string; name: string; hint: string; }

interface TrackDef {
  id:         ScreeningType;
  icon:       string;
  label:      string;
  ageDesc:    string;
  accent:     string;
  accentBg:   string;
  href?:      string;   // if set, tile navigates to this dedicated page instead of inline form
  questions:  [TrackInterviewQuestion, TrackInterviewQuestion, TrackInterviewQuestion];
  iKeys:      [string, string, string];
  games:      [TrackGame, TrackGame, TrackGame];
  computeCfg: (avg: number) => ScreeningConfig;
}

const LM_TRACK: TrackDef = {
  id: "little-mozarts", icon: "🎹", label: "Little Mozarts", ageDesc: "Ages 3–6",
  accent: "#4f46e5", accentBg: "#ede9fe",
  questions: [
    {
      key: "languageSkills", title: "Language & Listening Style",
      subtitle: "How does your child best take in and remember information?",
      options: [
        { letter: "A", text: "Learns mostly from pictures. Struggles with long spoken instructions." },
        { letter: "B", text: "Easily remembers rhymes and songs. Can follow two simple instructions in a row." },
        { letter: "C", text: "Understands long instructions quickly and talks very clearly." },
      ],
    },
    {
      key: "coreStrengths", title: "Focus & Attention",
      subtitle: "How does your child stay interested during an activity?",
      options: [
        { letter: "A", text: "Changes activities quickly. Needs new and exciting things to stay interested." },
        { letter: "B", text: "Can sit and play with one toy (like blocks or puzzles) for 15 minutes or more." },
        { letter: "C", text: "Loves finding patterns and figuring out how things work." },
      ],
    },
    {
      key: "motorBaseline", title: "Hand Control & Movement",
      subtitle: "How well does your child handle small, precise movements?",
      options: [
        { letter: "A", text: "Prefers running and jumping. Small finger control is still developing." },
        { letter: "B", text: "Good hand control. Easily handles coloring, drawing, or playing with small blocks." },
        { letter: "C", text: "Excellent finger control. Easily picks up and handles very tiny objects." },
      ],
    },
  ],
  iKeys: ["languageSkills", "coreStrengths", "motorBaseline"],
  games: [
    { icon: "🥁", name: "The Heartbeat Sync Game",    hint: "Rhythm Score" },
    { icon: "🎵", name: "The Bird vs. Bear Game",      hint: "Pitch Score"  },
    { icon: "🐾", name: "The Animal Footsteps Game",   hint: "Motor Score"  },
  ],
  computeCfg: (avg) => {
    if (avg <= 2.5) return { track: "Level 1 (Delta Track)", syllabusStrategy: "Tactile/Pre-Staff Preparation", metronome: false, metronomeBpm: null, handIntegration: "RH Only", chords: false, songsheetDifficulty: "Simplified/Rote" };
    if (avg <= 4.0) return { track: "Level 2 (Epsilon Track)", syllabusStrategy: "Standard Method Integration", metronome: true, metronomeBpm: 55, handIntegration: "Hands Separated", chords: "Basic Blocks", songsheetDifficulty: "Standard" };
    return { track: "Level 3 (Zeta Track)", syllabusStrategy: "Accelerated Performance & Early Composition", metronome: true, metronomeBpm: 70, handIntegration: "Hands Together", chords: "Full Harmonies", songsheetDifficulty: "Advanced/16-Bar" };
  },
};

const FT_TRACK: TrackDef = {
  id: "fast-track", icon: "🎸", label: "Fast Track", ageDesc: "Ages 7–30",
  accent: "#d97706", accentBg: "#fefce8",
  questions: [
    {
      key: "stageReadiness", title: "Performance Comfort",
      subtitle: "How does the student feel about performing in front of others?",
      options: [
        { letter: "A", text: "Prefers playing in one-on-one settings or small classrooms." },
        { letter: "B", text: "Excited to perform on stage in front of large audiences." },
        { letter: "C", text: "Wants to master both stage performances and competitive evaluations." },
      ],
    },
    {
      key: "academicGoals", title: "Exam & Certification Drive",
      subtitle: "What are the student's goals with formal music education?",
      options: [
        { letter: "A", text: "Wants to learn structured technique without matching strict exam deadlines." },
        { letter: "B", text: "Highly focused on clearing formal grade examinations and earning certificates." },
        { letter: "C", text: "Aims to fast-track through grades to reach advanced certification quickly." },
      ],
    },
    {
      key: "practiceCommitment", title: "Practice Discipline",
      subtitle: "How much daily practice can the student commit to?",
      options: [
        { letter: "A", text: "Can commit to 20–30 minutes of focused technical practice daily." },
        { letter: "B", text: "Ready for 45 minutes of strict daily practice covering scales and exercises." },
        { letter: "C", text: "Fully dedicated to rigorous, long-duration practice for top-tier results." },
      ],
    },
  ],
  iKeys: ["stageReadiness", "academicGoals", "practiceCommitment"],
  games: [
    { icon: "🥁", name: "Rhythm Clap & Count Test",   hint: "Rhythm Score" },
    { icon: "🎵", name: "Ear Pitch Match Test",        hint: "Pitch Score"  },
    { icon: "🎹", name: "Technical Play Test",         hint: "Motor Score"  },
  ],
  computeCfg: (avg) => {
    if (avg <= 2.5) return { track: "Explorer Track", syllabusStrategy: "Beginner Foundations", metronome: true, metronomeBpm: 55, handIntegration: "Hands Separated", chords: false, songsheetDifficulty: "Standard/Easier" };
    if (avg <= 4.0) return { track: "Achiever Track", syllabusStrategy: "Intermediate Integration", metronome: true, metronomeBpm: 70, handIntegration: "Hands Together", chords: "Basic Blocks", songsheetDifficulty: "Mid-Tier" };
    return { track: "Prodigy Track", syllabusStrategy: "Advanced Performance & 16-Bar Composition", metronome: true, metronomeBpm: 80, handIntegration: "Hands Together", chords: "Full Harmonies & Inversions", songsheetDifficulty: "Advanced/16-Bar" };
  },
};

const JOYFUL_TRACK: TrackDef = {
  id: "joyful-track", icon: "🌻", label: "Joyful Track", ageDesc: "Ages 31+",
  accent: "#db2777", accentBg: "#fdf2f8",
  questions: [
    {
      key: "learningMotivation", title: "Learning Motivation",
      subtitle: "What brings you to music at this stage of life?",
      options: [
        { letter: "A", text: "Looking for a relaxing hobby to unwind and de-stress after work." },
        { letter: "B", text: "Want to learn songs I love and enjoy playing for myself or family." },
        { letter: "C", text: "Interested in understanding music theory and developing real skill over time." },
      ],
    },
    {
      key: "pacingPreference", title: "Pacing Preference",
      subtitle: "How would you prefer to structure your learning journey?",
      options: [
        { letter: "A", text: "Go at my own pace with no strict timeline or syllabus pressure." },
        { letter: "B", text: "Gentle structure — a loose plan but flexibility to adjust as I go." },
        { letter: "C", text: "Clear milestones — I like knowing what I'm working toward and when." },
      ],
    },
    {
      key: "musicalBackground", title: "Musical Background",
      subtitle: "What is your prior experience with music?",
      options: [
        { letter: "A", text: "Completely new to playing any instrument. Starting from scratch." },
        { letter: "B", text: "Some exposure years ago — school music, casual singing, or basic lessons." },
        { letter: "C", text: "Had formal training in the past and returning to pick it up again." },
      ],
    },
  ],
  iKeys: ["learningMotivation", "pacingPreference", "musicalBackground"],
  games: [
    { icon: "🥁", name: "Steady Beat Test",      hint: "Rhythm Score" },
    { icon: "🎵", name: "Melody Recognition",    hint: "Pitch Score"  },
    { icon: "🎹", name: "Finger Ease & Posture", hint: "Motor Score"  },
  ],
  computeCfg: (avg) => {
    if (avg <= 2.5) return { track: "Comfort Level", syllabusStrategy: "Relaxed Repertoire & Stress-Free Foundations", metronome: false, metronomeBpm: null, handIntegration: "RH Only", chords: false, songsheetDifficulty: "Simplified/Rote" };
    if (avg <= 4.0) return { track: "Harmony Level", syllabusStrategy: "Balanced Melody & Harmony Integration", metronome: true, metronomeBpm: 55, handIntegration: "Hands Separated", chords: "Basic Blocks", songsheetDifficulty: "Standard/Easier" };
    return { track: "Flow Level", syllabusStrategy: "Enriched Repertoire with Theory Concepts", metronome: true, metronomeBpm: 65, handIntegration: "Hands Together", chords: "Full Harmonies", songsheetDifficulty: "Standard" };
  },
};

const CREATIVE_TRACK: TrackDef = {
  id: "creative-track", icon: "🎨", label: "The Creative Track", ageDesc: "All Ages",
  accent: "#7c3aed", accentBg: "#f5f3ff",
  questions: [
    {
      key: "sensoryProfile", title: "Sensory & Focus Profile",
      subtitle: "How does the student best engage with their environment during learning?",
      options: [
        { letter: "A", text: "Benefits from reduced sensory input — prefers quieter spaces and fewer visual distractions." },
        { letter: "B", text: "Can manage standard classroom settings with occasional breaks or movement." },
        { letter: "C", text: "Engages well with tactile or visual learning aids and multi-sensory input." },
      ],
    },
    {
      key: "physicalNeeds", title: "Physical & Motor Considerations",
      subtitle: "What physical adaptations, if any, are needed to support learning?",
      options: [
        { letter: "A", text: "Requires significant adaptation — limited hand or arm mobility, or significant fine motor challenges." },
        { letter: "B", text: "Some adaptations helpful — keyboard height, finger resistance, or hand positioning guidance." },
        { letter: "C", text: "Minimal adaptations — can engage with standard instrument setup with minor modifications." },
      ],
    },
    {
      key: "learningStyle", title: "Preferred Learning Style",
      subtitle: "How does the student best absorb and retain new musical concepts?",
      options: [
        { letter: "A", text: "Responds best to repetition, routine, and consistent structure session to session." },
        { letter: "B", text: "Learns through imitation and demonstration — watching and copying works well." },
        { letter: "C", text: "Engages through creativity — improvisation, colour coding, or storytelling works well." },
      ],
    },
  ],
  iKeys: ["sensoryProfile", "physicalNeeds", "learningStyle"],
  games: [
    { icon: "🥁", name: "Adapted Rhythm Activity", hint: "Rhythm Score" },
    { icon: "🎵", name: "Sound Matching Game",      hint: "Pitch Score"  },
    { icon: "🎹", name: "Key Press & Response",     hint: "Motor Score"  },
  ],
  computeCfg: (avg) => {
    if (avg <= 2.5) return { track: "Sensory-Friendly Level", syllabusStrategy: "Fully Adapted Sensory-Friendly Foundations", metronome: false, metronomeBpm: null, handIntegration: "RH Only", chords: false, songsheetDifficulty: "Simplified/Rote" };
    if (avg <= 4.0) return { track: "Adaptive Level", syllabusStrategy: "Adaptive Standard Integration", metronome: true, metronomeBpm: 50, handIntegration: "Hands Separated", chords: false, songsheetDifficulty: "Standard/Easier" };
    return { track: "Expression Level", syllabusStrategy: "Creative Expression & Adaptive Performance", metronome: true, metronomeBpm: 60, handIntegration: "Hands Separated", chords: "Basic Blocks", songsheetDifficulty: "Standard" };
  },
};

const TRACK_LIST: TrackDef[] = [LM_TRACK, FT_TRACK, JOYFUL_TRACK, CREATIVE_TRACK];

const TRACK_DEFS: Record<ScreeningType, TrackDef> = {
  "little-mozarts": LM_TRACK,
  "fast-track":     FT_TRACK,
  "joyful-track":   JOYFUL_TRACK,
  "creative-track": CREATIVE_TRACK,
};

const SCREEN_TRACK_SHORT: Record<ScreeningTrack, string> = {
  "Level 1 (Delta Track)":   "Delta",
  "Level 2 (Epsilon Track)": "Epsilon",
  "Level 3 (Zeta Track)":    "Zeta",
  "Explorer Track":          "Explorer",
  "Achiever Track":          "Achiever",
  "Prodigy Track":           "Prodigy",
  "Comfort Level":           "Comfort",
  "Harmony Level":           "Harmony",
  "Flow Level":              "Flow",
  "Sensory-Friendly Level":  "Sensory",
  "Adaptive Level":          "Adaptive",
  "Expression Level":        "Expression",
  "Zeta Slab":               "Zeta",
  "Epsilon Slab":            "Epsilon",
  "Delta Slab":              "Delta",
};

function scoreColor(n: number): string {
  if (n <= 2) return "#dc2626";
  if (n === 3) return "#d97706";
  return "#16a34a";
}

function ScreeningHub() {
  const { wing } = useWing();
  const [view,          setView]          = useState<"screening" | "applications">("screening");
  const [selectedTrack, setSelectedTrack] = useState<"guitar" | "keyboard" | "drums">("guitar");
  const [formKey,       setFormKey]       = useState(0);

  // Rol's School of Music does its intake (applications + Fast-Track wizard)
  // entirely on /dashboard/admissions — this hub is ROL+ only.
  if (wing === "school_of_music") {
    return (
      <div style={{ maxWidth: 480, margin: "60px auto", textAlign: "center", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "32px 28px" }}>
        <div style={{ fontSize: 34, marginBottom: 10 }}>📝</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-text-primary)", marginBottom: 6 }}>Admissions for School of Music</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20, lineHeight: 1.5 }}>
          The applications list and the Fast-Track intake wizard both live on the Admissions page.
        </div>
        <Link href="/dashboard/admissions" style={{ display: "inline-block", padding: "10px 20px", borderRadius: 8, background: "#4f46e5", color: "#fff", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
          Go to Admissions →
        </Link>
      </div>
    );
  }

  function handleStartScreening(_name: string) {
    setFormKey(k => k + 1);
    setView("screening");
  }

  function selectTrack(id: "guitar" | "keyboard" | "drums") {
    setSelectedTrack(id);
    setFormKey(k => k + 1);
  }

  return (
    <>
      <style>{`
        @media(max-width:640px){
          .scr-inst-grid{grid-template-columns:1fr !important}
          .scr-outer{padding:0 10px !important}
          .scr-hero{padding:16px !important}
          .scr-grid{display:flex !important;flex-direction:column !important;gap:12px !important}
          .scr-sensory-grid{grid-template-columns:1fr !important;gap:12px !important}
        }
      `}</style>
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        {([
          { key: "screening"    as const, label: "🎹 Screening",    desc: "Evaluate & assign track"        },
          { key: "applications" as const, label: "📁 Applications", desc: "View & manage admission forms"  },
        ]).map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setView(tab.key)}
            style={{
              flex: 1,
              border:       view === tab.key ? "2px solid #4f46e5" : "1px solid #e5e7eb",
              borderRadius: 10,
              padding:      "12px 16px",
              background:   view === tab.key ? "#ede9fe" : "#fafafa",
              cursor:       "pointer",
              textAlign:    "left",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 800, color: view === tab.key ? "#4f46e5" : "#374151" }}>
              {tab.label}
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
              {tab.desc}
            </div>
          </button>
        ))}
      </div>

      {view === "screening" && (
        <>
          {/* Instrument selector */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }} className="scr-inst-grid">
            {([
              { key: "guitar"   as const, icon: "🎸", label: "Guitar Screening",   accent: "#d97706", accentBg: "#fffbeb" },
              { key: "keyboard" as const, icon: "🎹", label: "Keyboard Screening", accent: "#0d9488", accentBg: "#f0fdfa" },
              { key: "drums"    as const, icon: "🥁", label: "Drum Screening",     accent: "#dc2626", accentBg: "#fef2f2" },
            ]).map(t => (
              <button key={t.key} type="button" onClick={() => selectTrack(t.key)}
                style={{ border: selectedTrack === t.key ? `2px solid ${t.accent}` : "1px solid #e5e7eb",
                  borderRadius: 10, padding: "12px 16px",
                  background: selectedTrack === t.key ? t.accentBg : "#fafafa",
                  cursor: "pointer", textAlign: "left", display: "block" }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: selectedTrack === t.key ? t.accent : "#374151" }}>
                  {t.icon} {t.label}
                </div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                  All age groups · 4 dynamic streams
                </div>
              </button>
            ))}
          </div>
          {selectedTrack === "guitar" && (
            <GuitarScreeningContent key={formKey} onBack={() => selectTrack("keyboard")} />
          )}
          {selectedTrack === "keyboard" && (
            <KeyboardScreeningContent key={formKey} onBack={() => selectTrack("guitar")} />
          )}
          {selectedTrack === "drums" && (
            <DrumScreeningContent key={formKey} onBack={() => selectTrack("guitar")} />
          )}
        </>
      )}
      {view === "applications" && <AdmissionsList onStartScreening={handleStartScreening} />}
    </>
  );
}

export default function ScreeningPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <ScreeningHub />
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


// ─── Screening history list ───────────────────────────────────────────────────

function ScreeningHistory() {
  const [screenings, setScreenings] = useState<ScreeningResult[]>([]);
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    getAllScreenings()
      .then(data => setScreenings(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#111" }}>
          Screening History
          {!loading && screenings.length > 0 && (
            <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>
              ({screenings.length})
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "28px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>
      ) : screenings.length === 0 ? (
        <div style={{ textAlign: "center", padding: "28px 0", color: "#9ca3af", fontSize: 13 }}>No screenings recorded yet.</div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                  {["Name", "Type", "Rhythm", "Pitch", "Motor", "Average", "Track", "Date"].map(h => (
                    <th key={h} style={{
                      padding: "10px 14px",
                      textAlign: "left" as const,
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#6b7280",
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.05em",
                      whiteSpace: "nowrap" as const,
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {screenings.map((rec, i) => {
                  const ts    = TRACK_STYLE[rec.config.track];
                  const short = SCREEN_TRACK_SHORT[rec.config.track];
                  return (
                    <tr key={rec.id} style={{ borderBottom: "1px solid #f3f4f6", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                      <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 600, color: "#111", whiteSpace: "nowrap" as const }}>
                        {rec.childName}
                      </td>
                      <td style={{ padding: "11px 14px" }}>
                        {(() => {
                          const badge: Record<string, { label: string; bg: string; color: string }> = {
                            "little-mozarts": { label: "LM", bg: "#ede9fe", color: "#4f46e5" },
                            "fast-track":     { label: "FT", bg: "#fef3c7", color: "#92400e" },
                            "joyful-track":   { label: "JT", bg: "#fce7f3", color: "#9d174d" },
                            "creative-track": { label: "CT", bg: "#f5f3ff", color: "#6d28d9" },
                          };
                          const b = badge[rec.screeningType] ?? { label: rec.screeningType.slice(0, 2).toUpperCase(), bg: "#f3f4f6", color: "#374151" };
                          return (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: b.bg, color: b.color }}>
                              {b.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: "11px 14px", textAlign: "center" as const, fontSize: 15, fontWeight: 800, color: scoreColor(rec.rhythmScore) }}>
                        {rec.rhythmScore}
                      </td>
                      <td style={{ padding: "11px 14px", textAlign: "center" as const, fontSize: 15, fontWeight: 800, color: scoreColor(rec.pitchScore) }}>
                        {rec.pitchScore}
                      </td>
                      <td style={{ padding: "11px 14px", textAlign: "center" as const, fontSize: 15, fontWeight: 800, color: scoreColor(rec.motorScore) }}>
                        {rec.motorScore}
                      </td>
                      <td style={{ padding: "11px 14px", fontSize: 16, fontWeight: 900, color: ts.color, whiteSpace: "nowrap" as const }}>
                        {rec.averageScore.toFixed(2)}
                        <span style={{ fontSize: 11, fontWeight: 400, color: "#9ca3af", marginLeft: 3 }}>/ 5</span>
                      </td>
                      <td style={{ padding: "11px 14px" }}>
                        <span style={{
                          background: ts.pill, color: "#fff",
                          fontSize: 11, fontWeight: 700,
                          padding: "4px 10px", borderRadius: 99,
                          whiteSpace: "nowrap" as const,
                        }}>
                          {short}
                        </span>
                      </td>
                      <td style={{ padding: "11px 14px", fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" as const }}>
                        {new Date(rec.screenedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Generic screening form (all tracks) ─────────────────────────────────────

function TrackScreeningForm({
  track,
  initialChildName = "",
}: {
  track:             TrackDef;
  initialChildName?: string;
}) {
  const { user } = useAuthContext();
  const { wing } = useWing();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [childName,     setChildName]     = useState(initialChildName);
  const [studentQuery,  setStudentQuery]  = useState("");
  const [allStudents,   setAllStudents]   = useState<StudentOption[]>([]);
  const [linkedStudent, setLinkedStudent] = useState<StudentOption | null>(null);
  const [studsLoading,  setStudsLoading]  = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);

  // Step 2 — generic interview answers keyed by question.key
  const [interviewAnswers, setInterviewAnswers] = useState<Record<string, string>>({});

  // Step 3
  const [rhythmScore, setRhythmScore] = useState<number | null>(null);
  const [pitchScore,  setPitchScore]  = useState<number | null>(null);
  const [motorScore,  setMotorScore]  = useState<number | null>(null);

  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [saveErr,    setSaveErr]    = useState("");
  const [historyKey, setHistoryKey] = useState(0);

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
  const config          = averageScore !== null ? track.computeCfg(averageScore) : null;

  async function handleSave() {
    if (!allScoresFilled || !config || averageScore === null || !childName.trim()) return;
    setSaving(true); setSaveErr("");
    try {
      await saveScreening({
        wing,
        screeningType:  track.id,
        childName:      childName.trim(),
        languageSkills:     interviewAnswers["languageSkills"]     || undefined,
        coreStrengths:      interviewAnswers["coreStrengths"]      || undefined,
        motorBaseline:      interviewAnswers["motorBaseline"]      || undefined,
        stageReadiness:     interviewAnswers["stageReadiness"]     || undefined,
        academicGoals:      interviewAnswers["academicGoals"]      || undefined,
        practiceCommitment: interviewAnswers["practiceCommitment"] || undefined,
        learningMotivation: interviewAnswers["learningMotivation"] || undefined,
        pacingPreference:   interviewAnswers["pacingPreference"]   || undefined,
        musicalBackground:  interviewAnswers["musicalBackground"]  || undefined,
        sensoryProfile:     interviewAnswers["sensoryProfile"]     || undefined,
        physicalNeeds:      interviewAnswers["physicalNeeds"]      || undefined,
        learningStyle:      interviewAnswers["learningStyle"]      || undefined,
        rhythmScore:  rhythmScore!,
        pitchScore:   pitchScore!,
        motorScore:   motorScore!,
        averageScore,
        config,
        screenedBy:   user?.uid ?? "",
        screenedAt:   new Date().toISOString(),
        studentId:    linkedStudent?.uid ?? null,
      });
      setSaved(true);
      setHistoryKey(k => k + 1);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setStep(1);
    setChildName(""); setStudentQuery(""); setLinkedStudent(null); setShowDropdown(false);
    setInterviewAnswers({});
    setRhythmScore(null); setPitchScore(null); setMotorScore(null);
    setSaved(false); setSaveErr("");
  }

  if (saved && config && averageScore !== null) {
    return (
      <>
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
        <ScreeningHistory key={historyKey} />
      </>
    );
  }

  const LM_ACCENT = "#4f46e5";

  const lmCard: React.CSSProperties = {
    background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
    padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
  };
  const lmBtn = (active = true): React.CSSProperties => ({
    padding: "11px 22px", borderRadius: 12, border: "none",
    fontSize: 13, fontWeight: 700, cursor: active ? "pointer" : "not-allowed", fontFamily: "inherit",
    display: "inline-flex", alignItems: "center",
    background: active ? LM_ACCENT : "#e5e7eb",
    color: active ? "#fff" : "#9ca3af",
  });
  const lmSecBtn: React.CSSProperties = {
    padding: "11px 22px", borderRadius: 12, border: "none",
    fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
    display: "inline-flex", alignItems: "center",
    background: "#f3f4f6", color: "#6b7280",
  };
  const lmInput: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
    padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
  };
  const lmLabel: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.09em", display: "block", marginBottom: 10,
  };

  const stepLabels = ["Student Info", "Interview", "Practical Scores"];

  return (
    <>
      <div style={{ maxWidth: 780, margin: "0 auto" }}>

        {/* Header */}
        <div style={{
          background: "linear-gradient(135deg, #eef2ff, #e0e7ff)",
          border: "1px solid #c7d2fe", borderRadius: 20, padding: "22px 28px",
          marginBottom: 22, display: "flex", alignItems: "center",
          justifyContent: "space-between", flexWrap: "wrap" as const, gap: 14,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, background: LM_ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
              {track.icon}
            </div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 900, color: "#3730a3" }}>{track.label}</div>
              <div style={{ fontSize: 12, color: "#6366f1", opacity: 0.8, marginTop: 2 }}>Pre-Admission Screening · Musical Capacity Evaluation</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
            {["Step by step", "Auto-assigns track"].map(t => (
              <span key={t} style={{ fontSize: 10, fontWeight: 700, color: LM_ACCENT, background: "rgba(79,70,229,0.07)", border: "1px solid #c7d2fe", borderRadius: 99, padding: "3px 10px" }}>{t}</span>
            ))}
          </div>
        </div>

        {/* Stepper */}
        <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 26 }}>
          {stepLabels.map((label, i) => {
            const n = i + 1; const done = step > n; const active = step === n;
            return (
              <div key={n} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: done || active ? LM_ACCENT : "#f3f4f6", color: done || active ? "#fff" : "#9ca3af", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0, boxShadow: active ? `0 0 0 5px rgba(79,70,229,0.1)` : "none", transition: "all 0.2s" }}>
                    {done ? "✓" : n}
                  </div>
                  <div style={{ fontSize: 11, marginTop: 6, fontWeight: active ? 700 : 400, color: active ? LM_ACCENT : done ? "#6b7280" : "#9ca3af", whiteSpace: "nowrap" }}>{label}</div>
                </div>
                {i < stepLabels.length - 1 && <div style={{ height: 2, width: 48, flexShrink: 0, alignSelf: "flex-start", marginTop: 16, background: done ? LM_ACCENT : "#f0f0f0", transition: "background 0.3s" }} />}
              </div>
            );
          })}
        </div>

        {/* Step 1: Student Info */}
        {step === 1 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>
            <div style={{ ...lmCard, gridColumn: "span 12" }}>
              <div style={lmLabel}>Student Information</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <label style={lmLabel}>{track.id === "little-mozarts" ? "Child's Name *" : "Student's Name *"}</label>
                  <input value={childName} onChange={e => setChildName(e.target.value)} placeholder="Full name" style={lmInput} />
                </div>
                <div>
                  <label style={lmLabel}>Link to Enrolled Student <span style={{ textTransform: "none", fontWeight: 400, color: "#9ca3af", letterSpacing: 0 }}>(optional)</span></label>
                  <div style={{ position: "relative" }}>
                    {linkedStudent ? (
                      <div style={{ ...lmInput, display: "flex", alignItems: "center", justifyContent: "space-between", boxSizing: "border-box" as const }}>
                        <span>{linkedStudent.name} <span style={{ color: "#9ca3af", fontSize: 11 }}>({linkedStudent.studentID})</span></span>
                        <button type="button" onClick={() => { setLinkedStudent(null); setStudentQuery(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16, padding: 0 }}>✕</button>
                      </div>
                    ) : (
                      <input value={studentQuery} onChange={e => { setStudentQuery(e.target.value); setShowDropdown(true); }} onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 150)} placeholder="Search by name or student ID…" style={lmInput} />
                    )}
                    {showDropdown && filteredStudents.length > 0 && !linkedStudent && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, border: "1px solid #f0f0f0", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", background: "#fff", marginTop: 4, overflow: "hidden" }}>
                        {filteredStudents.map(st => (
                          <div key={st.uid} onMouseDown={() => { setLinkedStudent(st); if (!childName.trim()) setChildName(st.name); setStudentQuery(""); setShowDropdown(false); }}
                            style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f9fafb", display: "flex", justifyContent: "space-between" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "#fafafa")}
                            onMouseLeave={e => (e.currentTarget.style.background = "#fff")}>
                            <span style={{ fontWeight: 600, color: "#111" }}>{st.name}</span>
                            <span style={{ fontSize: 11, color: "#9ca3af" }}>{st.studentID}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
                    {studsLoading ? "Loading students…" : "Links this diagnostic to the student's profile."}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "flex-end" }}>
              <button type="button" disabled={!childName.trim()} onClick={() => setStep(2)} style={lmBtn(!!childName.trim())}>
                Next: Interview →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Interview */}
        {step === 2 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>
            <div style={{ ...lmCard, gridColumn: "span 12" }}>
              <div style={lmLabel}>Screening Interview</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 22 }}>Select the option that best describes the student.</div>
              {track.questions.map((q, qi) => {
                const currentVal = interviewAnswers[q.key] ?? "";
                return (
                  <div key={q.key} style={{ marginBottom: qi < track.questions.length - 1 ? 28 : 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 2 }}>{qi + 1}. {q.title}</div>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>{q.subtitle}</div>
                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                      {q.options.map(opt => {
                        const optValue = `Option ${opt.letter}: ${opt.text}`;
                        const selected = currentVal === optValue;
                        return (
                          <div key={opt.letter}
                            onClick={() => setInterviewAnswers(prev => ({ ...prev, [q.key]: selected ? "" : optValue }))}
                            style={{ display: "flex", alignItems: "flex-start", gap: 12, border: selected ? `2px solid ${LM_ACCENT}` : "1.5px solid #f0f0f0", borderRadius: 12, padding: "12px 14px", background: selected ? "#eef2ff" : "#fafafa", cursor: "pointer", transition: "all 0.12s" }}>
                            <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, background: selected ? LM_ACCENT : "#e5e7eb", color: selected ? "#fff" : "#6b7280", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, marginTop: 1 }}>
                              {selected ? "✓" : opt.letter}
                            </div>
                            <div style={{ fontSize: 13, color: selected ? "#3730a3" : "#374151", lineHeight: 1.5, fontWeight: selected ? 600 : 400 }}>{opt.text}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
              <button type="button" onClick={() => setStep(1)} style={lmSecBtn}>← Back</button>
              <button type="button" onClick={() => setStep(3)} style={lmBtn()}>Next: Practical Scores →</button>
            </div>
          </div>
        )}

        {/* Step 3: Practical Scores */}
        {step === 3 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>
            <div style={{ ...lmCard, gridColumn: "span 12" }}>
              <div style={lmLabel}>Practical Assessment</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 22 }}>Score each activity 1–5. Results compute automatically once all three are filled.</div>
              {([
                { ...track.games[0], value: rhythmScore, set: setRhythmScore },
                { ...track.games[1], value: pitchScore,  set: setPitchScore  },
                { ...track.games[2], value: motorScore,  set: setMotorScore  },
              ]).map((g, i) => (
                <div key={g.hint} style={{ marginBottom: i < 2 ? 28 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{g.icon}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>{g.name}</div>
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>{g.hint}</div>
                    </div>
                    {g.value !== null && (
                      <div style={{ fontSize: 22, fontWeight: 900, color: scoreColor(g.value), minWidth: 36, textAlign: "right" as const, background: "#f3f4f6", borderRadius: 10, padding: "6px 12px" }}>
                        {g.value}
                      </div>
                    )}
                  </div>
                  <ScoreSelector value={g.value} onChange={g.set} />
                </div>
              ))}
            </div>

            {allScoresFilled && config && averageScore !== null ? (
              <div style={{ gridColumn: "span 12" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: 12 }}>Diagnostic Result</div>
                <DiagnosticCard
                  result={{
                    childName, rhythmScore: rhythmScore!, pitchScore: pitchScore!, motorScore: motorScore!, averageScore, config,
                    screenedAt: new Date().toISOString(),
                    languageSkills: interviewAnswers["languageSkills"], coreStrengths: interviewAnswers["coreStrengths"],
                    motorBaseline: interviewAnswers["motorBaseline"], stageReadiness: interviewAnswers["stageReadiness"],
                    academicGoals: interviewAnswers["academicGoals"], practiceCommitment: interviewAnswers["practiceCommitment"],
                    learningMotivation: interviewAnswers["learningMotivation"], pacingPreference: interviewAnswers["pacingPreference"],
                    musicalBackground: interviewAnswers["musicalBackground"], sensoryProfile: interviewAnswers["sensoryProfile"],
                    physicalNeeds: interviewAnswers["physicalNeeds"], learningStyle: interviewAnswers["learningStyle"],
                  }}
                />
              </div>
            ) : (
              <div style={{ gridColumn: "span 12", ...lmCard, background: "#f8f9fb", textAlign: "center" as const, padding: "28px" }}>
                <div style={{ fontSize: 13, color: "#9ca3af" }}>Fill all three scores above to see the diagnostic result.</div>
              </div>
            )}

            {saveErr && (
              <div style={{ gridColumn: "span 12", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#dc2626" }}>{saveErr}</div>
            )}

            <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between" }}>
              <button type="button" onClick={() => setStep(2)} style={lmSecBtn}>← Back</button>
              <button type="button" disabled={!allScoresFilled || saving} onClick={handleSave} style={lmBtn(!!allScoresFilled && !saving)}>
                {saving ? "Saving…" : "💾 Save Screening"}
              </button>
            </div>
          </div>
        )}
      </div>
      <ScreeningHistory key={historyKey} />
    </>
  );
}

// ─── Styles (legacy — used by other components above TrackScreeningForm) ──────

const s: Record<string, React.CSSProperties> = {
  card: {
    background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
    padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
  },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 18 },
  field: { marginBottom: 18 },
  label: { fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 },
  input: {
    width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
    padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
  },
  primaryBtn: {
    padding: "11px 22px", borderRadius: 12, border: "none", background: "#4f46e5",
    color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
  },
  secondaryBtn: {
    padding: "11px 22px", borderRadius: 12, border: "none", background: "#f3f4f6",
    color: "#6b7280", fontSize: 13, fontWeight: 700, cursor: "pointer",
  },
};
