"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening, getAllScreenings, saveAdmission, getAllAdmissions } from "@/services/screening/screening.service";
import Link from "next/link";
import type { ScreeningConfig, ScreeningTrack, ScreeningResult } from "@/types";

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

const SCREEN_TRACK_SHORT: Record<ScreeningTrack, string> = {
  "Level 1 (Delta Track)":   "Delta",
  "Level 2 (Epsilon Track)": "Epsilon",
  "Level 3 (Zeta Track)":    "Zeta",
  "Explorer Track":          "Explorer",
  "Achiever Track":          "Achiever",
  "Prodigy Track":           "Prodigy",
};

function scoreColor(n: number): string {
  if (n <= 2) return "#dc2626";
  if (n === 3) return "#d97706";
  return "#16a34a";
}

// ─── Page shell ───────────────────────────────────────────────────────────────

// ─── Admission applications list ─────────────────────────────────────────────

function AdmissionsList() {
  const [admissions, setAdmissions] = useState<Record<string, unknown>[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [selected,   setSelected]   = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    getAllAdmissions()
      .then(setAdmissions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function str(v: unknown): string  { return typeof v === "string" ? v : ""; }
  function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }
  function num(v: unknown): number | null { return typeof v === "number" ? v : null; }

  if (loading) {
    return <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>;
  }

  if (admissions.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0", color: "#9ca3af" }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>No applications yet</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Submitted forms will appear here.</div>
      </div>
    );
  }

  return (
    <div>
      {/* ── Detail panel ── */}
      {selected && (
        <div style={{
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
          padding: "24px", marginBottom: 20, position: "relative" as const,
          boxShadow: "0 4px 24px rgba(0,0,0,0.07)",
        }}>
          <button
            onClick={() => setSelected(null)}
            style={{
              position: "absolute" as const, top: 16, right: 16,
              border: "none", background: "#f3f4f6", borderRadius: 6,
              padding: "4px 10px", cursor: "pointer", fontSize: 13, color: "#374151",
            }}
          >
            ✕ Close
          </button>

          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" as const }}>
            {/* Photo */}
            <div style={{
              width: 90, height: 112, flexShrink: 0,
              border: "2px solid #e5e7eb", borderRadius: 8, overflow: "hidden",
              background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {str(selected.photo) ? (
                <img src={str(selected.photo)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontSize: 28, color: "#d1d5db" }}>👤</span>
              )}
            </div>

            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#111", marginBottom: 2 }}>{str(selected.fullName)}</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
                {str(selected.submittedAt) ? new Date(str(selected.submittedAt)).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : ""}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 20px" }}>
                {([
                  ["Age",           str(selected.age)],
                  ["DOB",           str(selected.dob)],
                  ["Parent",        str(selected.parentName)],
                  ["Phone",         str(selected.phone)],
                  ["Email",         str(selected.email)],
                  ["Status",        str(selected.workingStatus)],
                  ["School/Co.",    str(selected.schoolCompany)],
                  ["Centre",        str(selected.centre)],
                ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{k}</div>
                    <div style={{ fontSize: 13, color: "#111", fontWeight: 500 }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Address */}
          {(str(selected.address1) || str(selected.address2)) && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f3f4f6" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>Address</div>
              <div style={{ fontSize: 13, color: "#374151" }}>
                {[str(selected.address1), str(selected.address2)].filter(Boolean).join(", ")}
              </div>
            </div>
          )}

          {/* Musical info */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f3f4f6", display: "flex", flexDirection: "column" as const, gap: 10 }}>
            {([
              ["Purpose of Learning",   str(selected.purposeOfLearning)],
              ["Previous Experience",   str(selected.previousExperience)],
              ["Musical Skill",         str(selected.musicalSkill)],
              ["How Heard About Us",    str(selected.howHeardAboutUs)],
              ["Parent Partner Program",str(selected.parentPartnerProgram)],
            ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>{k}</div>
                <div style={{ fontSize: 13, color: "#374151" }}>{v}</div>
              </div>
            ))}
            {arr(selected.instrumentsToLearn).length > 0 && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>Instruments to Learn</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                  {arr(selected.instrumentsToLearn).map(i => (
                    <span key={i} style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99 }}>{i}</span>
                  ))}
                </div>
              </div>
            )}
            {arr(selected.instrumentsPlayed).length > 0 && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>Instruments Played</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                  {arr(selected.instrumentsPlayed).map(i => (
                    <span key={i} style={{ background: "#dcfce7", color: "#15803d", fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99 }}>{i}</span>
                  ))}
                </div>
              </div>
            )}
            {num(selected.initialExperience) !== null && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>Initial Experience</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#4f46e5" }}>{num(selected.initialExperience)} <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>/ 10</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Applications table ── */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>
            Applications
            <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>({admissions.length})</span>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                {["", "Name", "Age", "Phone", "Instruments", "Centre", "Date"].map(h => (
                  <th key={h} style={{
                    padding: "10px 14px", textAlign: "left" as const,
                    fontSize: 11, fontWeight: 600, color: "#6b7280",
                    textTransform: "uppercase" as const, letterSpacing: "0.05em",
                    whiteSpace: "nowrap" as const,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {admissions.map((rec, i) => {
                const isSelected = selected === rec;
                const instruments = arr(rec.instrumentsToLearn);
                return (
                  <tr
                    key={str(rec.id) || i}
                    onClick={() => setSelected(isSelected ? null : rec)}
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      background: isSelected ? "#ede9fe" : i % 2 === 0 ? "#fff" : "#fafafa",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Photo thumb */}
                    <td style={{ padding: "10px 10px 10px 14px", width: 40 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 6, overflow: "hidden",
                        background: "#f3f4f6", flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {str(rec.photo) ? (
                          <img src={str(rec.photo)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <span style={{ fontSize: 18, lineHeight: 1 }}>👤</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: "#111", whiteSpace: "nowrap" as const }}>
                      {str(rec.fullName)}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 13, color: "#374151" }}>
                      {str(rec.age) || "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 13, color: "#374151", whiteSpace: "nowrap" as const }}>
                      {str(rec.phone) || "—"}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                        {instruments.length > 0
                          ? instruments.map(inst => (
                            <span key={inst} style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>{inst}</span>
                          ))
                          : <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>
                        }
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" as const }}>
                      {str(rec.centre) || "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" as const }}>
                      {str(rec.submittedAt) ? new Date(str(rec.submittedAt)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ScreeningHub() {
  const [view, setView] = useState<"screening" | "admission" | "applications">("screening");
  return (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        {([
          { key: "screening"    as const, label: "🎹 Screening",      desc: "Evaluate & assign track" },
          { key: "admission"    as const, label: "📋 Admission Form",  desc: "Student application"    },
          { key: "applications" as const, label: "📁 Applications",    desc: "View submitted forms"   },
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
      {view === "screening"    && <ScreeningContent />}
      {view === "admission"    && <AdmissionFormContent />}
      {view === "applications" && <AdmissionsList />}
    </>
  );
}

export default function ScreeningPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
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

// ─── Admission form helpers ───────────────────────────────────────────────────

function OptionGroup({ options, value, onChange }: {
  options: string[];
  value:   string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
      {options.map(opt => {
        const sel = value === opt;
        return (
          <button key={opt} type="button" onClick={() => onChange(sel ? "" : opt)} style={{
            padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13,
            border:     sel ? "2px solid #4f46e5" : "1px solid #e5e7eb",
            background: sel ? "#ede9fe" : "#f9fafb",
            color:      sel ? "#4f46e5" : "#374151",
            fontWeight: sel ? 700 : 400,
          }}>
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function MultiOptionGroup({ options, values, onChange }: {
  options:  string[];
  values:   string[];
  onChange: (vals: string[]) => void;
}) {
  function toggle(opt: string) {
    onChange(values.includes(opt) ? values.filter(v => v !== opt) : [...values, opt]);
  }
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
      {options.map(opt => {
        const sel = values.includes(opt);
        return (
          <button key={opt} type="button" onClick={() => toggle(opt)} style={{
            padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13,
            border:     sel ? "2px solid #4f46e5" : "1px solid #e5e7eb",
            background: sel ? "#ede9fe" : "#f9fafb",
            color:      sel ? "#4f46e5" : "#374151",
            fontWeight: sel ? 700 : 400,
          }}>
            {sel ? "✓ " : ""}{opt}
          </button>
        );
      })}
    </div>
  );
}

// ─── Admission form content ───────────────────────────────────────────────────

function AdmissionFormContent() {
  const { user } = useAuthContext();

  // Personal information
  const [fullName,      setFullName]      = useState("");
  const [age,           setAge]           = useState("");
  const [dobDD,         setDobDD]         = useState("");
  const [dobMM,         setDobMM]         = useState("");
  const [dobYYYY,       setDobYYYY]       = useState("");
  const [parentName,    setParentName]    = useState("");
  const [workingStatus, setWorkingStatus] = useState("");
  const [schoolCompany, setSchoolCompany] = useState("");

  // Contact information
  const [phone,    setPhone]    = useState("");
  const [email,    setEmail]    = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [centre,   setCentre]   = useState("");
  const [centres,  setCentres]  = useState<{ id: string; name: string }[]>([]);

  // Musical skills
  const [purposeOfLearning,   setPurposeOfLearning]   = useState("");
  const [instrumentsToLearn,  setInstrumentsToLearn]  = useState<string[]>([]);
  const [previousExperience,  setPreviousExperience]  = useState("");
  const [instrumentsPlayed,   setInstrumentsPlayed]   = useState<string[]>([]);
  const [musicalSkill,        setMusicalSkill]        = useState("");
  const [howHeardAboutUs,     setHowHeardAboutUs]     = useState("");
  const [initialExperience,   setInitialExperience]   = useState<number | null>(null);
  const [parentPartnerProgram,setParentPartnerProgram]= useState("");

  // Photo
  const [photoDataUrl,  setPhotoDataUrl]  = useState<string | null>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Submit state
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  useEffect(() => {
    getDocs(collection(db, "centers"))
      .then(snap => setCentres(snap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id }))))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const canSubmit = fullName.trim().length > 0 && phone.trim().length > 0;

  function compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX_W = 320, MAX_H = 420;
        const ratio = Math.min(MAX_W / img.width, MAX_H / img.height, 1);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
      img.src = url;
    });
  }

  function handlePhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    compressImage(file).then(setPhotoDataUrl).catch(() => {});
    e.target.value = "";
  }

  async function handleSubmit() {
    if (!canSubmit || saving) return;
    setSaving(true); setSaveErr("");
    try {
      await saveAdmission({
        fullName:            fullName.trim(),
        age:                 age.trim(),
        dob:                 `${dobDD}/${dobMM}/${dobYYYY}`,
        parentName:          parentName.trim(),
        workingStatus,
        schoolCompany:       schoolCompany.trim(),
        phone:               phone.trim(),
        email:               email.trim(),
        address1:            address1.trim(),
        address2:            address2.trim(),
        centre,
        purposeOfLearning,
        instrumentsToLearn,
        previousExperience,
        instrumentsPlayed,
        musicalSkill,
        howHeardAboutUs:     howHeardAboutUs.trim(),
        initialExperience,
        parentPartnerProgram,
        photo:               photoDataUrl ?? null,
        submittedBy:         user?.uid ?? "",
      });
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setFullName(""); setAge(""); setDobDD(""); setDobMM(""); setDobYYYY("");
    setParentName(""); setWorkingStatus(""); setSchoolCompany("");
    setPhone(""); setEmail(""); setAddress1(""); setAddress2(""); setCentre("");
    setPurposeOfLearning(""); setInstrumentsToLearn([]); setPreviousExperience("");
    setInstrumentsPlayed([]); setMusicalSkill(""); setHowHeardAboutUs("");
    setInitialExperience(null); setParentPartnerProgram("");
    setPhotoDataUrl(null);
    setSaved(false); setSaveErr("");
  }

  if (saved) {
    return (
      <div style={{ maxWidth: 520, margin: "40px auto", textAlign: "center" }}>
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 14, padding: "36px 28px" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#15803d", marginBottom: 8 }}>Application Submitted</div>
          <div style={{ fontSize: 14, color: "#166534", marginBottom: 24 }}>
            <strong>{fullName}</strong>&apos;s admission form has been saved successfully.
          </div>
          <button onClick={reset} style={s.primaryBtn}>+ New Application</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#111", marginBottom: 4 }}>📋 Admission Form</div>
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
        ROL&apos;s School Of Music — Student Admission Application
      </div>

      {/* ── Personal Information ─────────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={s.sectionTitle}>Personal Information</div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 3 }}>
            <label style={s.label}>Full Name *</label>
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Enter full name" style={s.input} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Age</label>
            <input value={age} onChange={e => setAge(e.target.value)} placeholder="—" style={s.input} type="number" min={0} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Date of Birth</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={dobDD} onChange={e => setDobDD(e.target.value)} placeholder="DD"
                style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} maxLength={2} />
              <span style={{ color: "#9ca3af", fontWeight: 700 }}>/</span>
              <input value={dobMM} onChange={e => setDobMM(e.target.value)} placeholder="MM"
                style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} maxLength={2} />
              <span style={{ color: "#9ca3af", fontWeight: 700 }}>/</span>
              <input value={dobYYYY} onChange={e => setDobYYYY(e.target.value)} placeholder="YYYY"
                style={{ ...s.input, width: 68, textAlign: "center" as const, boxSizing: "border-box" as const }} maxLength={4} />
            </div>
          </div>
          <div style={{ flex: 1.5 }}>
            <label style={s.label}>Name of Parent / Guardian</label>
            <input value={parentName} onChange={e => setParentName(e.target.value)} placeholder="Parent or guardian name" style={s.input} />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Working Status</label>
          <OptionGroup
            options={["Student", "Working", "Part Time", "Not Working"]}
            value={workingStatus}
            onChange={setWorkingStatus}
          />
        </div>

        <div>
          <label style={s.label}>Name of School / Company</label>
          <input value={schoolCompany} onChange={e => setSchoolCompany(e.target.value)} placeholder="School or company name" style={s.input} />
        </div>
      </div>

      {/* ── Contact Information ──────────────────────────────────────────────── */}
      <div style={{ ...s.card, marginTop: 16 }}>
        <div style={s.sectionTitle}>Contact Information</div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Phone Number *</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 00000 00000" style={s.input} type="tel" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Email ID</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" style={s.input} type="email" />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Address Line 1</label>
          <input value={address1} onChange={e => setAddress1(e.target.value)} placeholder="House / Flat no., Street name" style={s.input} />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 2 }}>
            <label style={s.label}>Address Line 2</label>
            <input value={address2} onChange={e => setAddress2(e.target.value)} placeholder="Area, Landmark" style={s.input} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Centre</label>
            {centres.length > 0 ? (
              <select value={centre} onChange={e => setCentre(e.target.value)} style={{ ...s.input, cursor: "pointer" }}>
                <option value="">— Select —</option>
                {centres.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <input value={centre} onChange={e => setCentre(e.target.value)} placeholder="Centre" style={s.input} />
            )}
          </div>
        </div>
      </div>

      {/* ── Musical Skills ───────────────────────────────────────────────────── */}
      <div style={{ ...s.card, marginTop: 16 }}>
        <div style={s.sectionTitle}>Information on Musical Skills</div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>Purpose of Learning</label>
          <OptionGroup
            options={["Formal Music Learning", "Skill Development", "Entertainment"]}
            value={purposeOfLearning}
            onChange={setPurposeOfLearning}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>
            Musical Instrument to Learn{" "}
            <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}>(select all that apply)</span>
          </label>
          <MultiOptionGroup
            options={["Piano", "Keyboard", "Guitar", "Drums", "Violin", "Vocal"]}
            values={instrumentsToLearn}
            onChange={setInstrumentsToLearn}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>Previous Experience in Music</label>
          <OptionGroup
            options={["Well-Trained", "Average", "No Previous Experience"]}
            value={previousExperience}
            onChange={setPreviousExperience}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>
            Instruments You Already Play{" "}
            <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}>(select all that apply)</span>
          </label>
          <MultiOptionGroup
            options={["Guitar", "Drums", "Keyboard", "None of the Above"]}
            values={instrumentsPlayed}
            onChange={setInstrumentsPlayed}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>Explain Your Musical Skill</label>
          <OptionGroup
            options={["Excellent", "Average", "Poor"]}
            value={musicalSkill}
            onChange={setMusicalSkill}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>How Do You Know About ROL&apos;s School Of Music?</label>
          <input value={howHeardAboutUs} onChange={e => setHowHeardAboutUs(e.target.value)}
            placeholder="e.g. Social media, friend referral, walk-in…" style={s.input} />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>
            How Do You Describe Your Initial Experience With Us?{" "}
            <span style={{ color: "#9ca3af", fontWeight: 400 }}>( / 10)</span>
          </label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
            {[1,2,3,4,5,6,7,8,9,10].map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setInitialExperience(initialExperience === n ? null : n)}
                style={{
                  width: 42, height: 42, borderRadius: 8, cursor: "pointer", fontSize: 14,
                  border:     "none",
                  background: initialExperience === n ? "#4f46e5" : "#f3f4f6",
                  color:      initialExperience === n ? "#fff" : "#374151",
                  fontWeight: initialExperience === n ? 800 : 500,
                }}
              >
                {n}
              </button>
            ))}
          </div>
          {initialExperience !== null && (
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>Selected: {initialExperience} / 10</div>
          )}
        </div>

        <div>
          <label style={s.label}>Would You Like to Participate in Our Parent Partner Program?</label>
          <OptionGroup
            options={["Yes", "No", "Want to Know More"]}
            value={parentPartnerProgram}
            onChange={setParentPartnerProgram}
          />
        </div>
      </div>

      {/* ── Candidate Photo ──────────────────────────────────────────────────── */}
      <div style={{ ...s.card, marginTop: 16 }}>
        <div style={s.sectionTitle}>Candidate Photo</div>

        {/* Hidden inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={handlePhotoFile}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handlePhotoFile}
        />

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" as const }}>
          {/* Preview box */}
          <div style={{
            width: 120, height: 150, flexShrink: 0,
            border: "2px dashed #d1d5db", borderRadius: 10,
            background: "#f9fafb",
            display: "flex", alignItems: "center", justifyContent: "center",
            overflow: "hidden",
          }}>
            {photoDataUrl ? (
              <img src={photoDataUrl} alt="Candidate" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ textAlign: "center" as const, color: "#9ca3af" }}>
                <div style={{ fontSize: 32, marginBottom: 4 }}>📷</div>
                <div style={{ fontSize: 11 }}>No photo</div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10, justifyContent: "center", flex: 1 }}>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              style={{
                padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                border: "1px solid #4f46e5", background: "#ede9fe",
                color: "#4f46e5", fontSize: 13, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ fontSize: 18 }}>📸</span> Take Photo
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                border: "1px solid #d1d5db", background: "#f9fafb",
                color: "#374151", fontSize: 13, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ fontSize: 18 }}>🖼️</span> Upload Photo
            </button>
            {photoDataUrl && (
              <button
                type="button"
                onClick={() => setPhotoDataUrl(null)}
                style={{
                  padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid #fecaca", background: "#fef2f2",
                  color: "#dc2626", fontSize: 12, fontWeight: 600,
                }}
              >
                Remove Photo
              </button>
            )}
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
              Photo is optional. Compressed automatically.
            </div>
          </div>
        </div>
      </div>

      {saveErr && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginTop: 16 }}>
          {saveErr}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
        <button type="button" onClick={reset} style={s.secondaryBtn}>Reset</button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || saving}
          style={{ ...s.primaryBtn, opacity: canSubmit && !saving ? 1 : 0.4, cursor: canSubmit && !saving ? "pointer" : "not-allowed" }}
        >
          {saving ? "Submitting…" : "Submit Application"}
        </button>
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
                        <span style={{
                          fontSize: 10, fontWeight: 700,
                          padding: "2px 8px", borderRadius: 99,
                          background: rec.screeningType === "little-mozarts" ? "#ede9fe" : "#fef3c7",
                          color:      rec.screeningType === "little-mozarts" ? "#4f46e5" : "#92400e",
                        }}>
                          {rec.screeningType === "little-mozarts" ? "LM" : "FT"}
                        </span>
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
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [saveErr,    setSaveErr]    = useState("");
  const [historyKey, setHistoryKey] = useState(0);

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
      setHistoryKey(k => k + 1);
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

  // ── Step indicator ─────────────────────────────────────────────────────────
  const steps = [
    { n: 1 as const, label: "Student Info" },
    { n: 2 as const, label: "Parent Interview" },
    { n: 3 as const, label: "Practical Scores" },
  ];

  return (
    <>
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
    <ScreeningHistory key={historyKey} />
    </>
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
