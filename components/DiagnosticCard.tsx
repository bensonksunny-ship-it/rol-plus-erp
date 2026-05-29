"use client";

import type { ScreeningConfig, ScreeningTrack } from "@/types";

export const TRACK_STYLE: Record<ScreeningTrack, { bg: string; color: string; border: string; pill: string }> = {
  "Level 1 (Delta Track)":   { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe", pill: "#1d4ed8" },
  "Level 2 (Epsilon Track)": { bg: "#fefce8", color: "#92400e", border: "#fde68a", pill: "#d97706" },
  "Level 3 (Zeta Track)":    { bg: "#f0fdf4", color: "#15803d", border: "#86efac", pill: "#16a34a" },
  "Explorer Track":          { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa", pill: "#ea580c" },
  "Achiever Track":          { bg: "#f0fdfa", color: "#0f766e", border: "#99f6e4", pill: "#0d9488" },
  "Prodigy Track":           { bg: "#faf5ff", color: "#7e22ce", border: "#e9d5ff", pill: "#9333ea" },
  "Comfort Level":           { bg: "#fdf2f8", color: "#9d174d", border: "#fbcfe8", pill: "#db2777" },
  "Harmony Level":           { bg: "#fff7ed", color: "#9a3412", border: "#fed7aa", pill: "#f97316" },
  "Flow Level":              { bg: "#ecfdf5", color: "#065f46", border: "#6ee7b7", pill: "#059669" },
  "Sensory-Friendly Level":  { bg: "#f0f9ff", color: "#0369a1", border: "#bae6fd", pill: "#0284c7" },
  "Adaptive Level":          { bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe", pill: "#7c3aed" },
  "Expression Level":        { bg: "#fff1f2", color: "#be123c", border: "#fecdd3", pill: "#e11d48" },
  "Zeta Slab":               { bg: "#f0fdf4", color: "#15803d", border: "#86efac", pill: "#16a34a" },
  "Epsilon Slab":            { bg: "#fefce8", color: "#92400e", border: "#fde68a", pill: "#d97706" },
  "Delta Slab":              { bg: "#fef2f2", color: "#991b1b", border: "#fecaca", pill: "#dc2626" },
};

function scoreColor(n: number): string {
  if (n <= 2) return "#dc2626";
  if (n === 3) return "#d97706";
  return "#16a34a";
}

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
    languageSkills?:     string;
    coreStrengths?:      string;
    motorBaseline?:      string;
    stageReadiness?:     string;
    academicGoals?:      string;
    practiceCommitment?: string;
    learningMotivation?: string;
    pacingPreference?:   string;
    musicalBackground?:  string;
    sensoryProfile?:     string;
    physicalNeeds?:      string;
    learningStyle?:      string;
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

      {!compact && (() => {
        const lmFields = [
          { label: "Language & Listening Style", val: result.languageSkills ?? "" },
          { label: "Focus & Attention",          val: result.coreStrengths  ?? "" },
          { label: "Hand Control & Movement",    val: result.motorBaseline  ?? "" },
        ];
        const ftFields = [
          { label: "Performance Comfort",        val: result.stageReadiness     ?? "" },
          { label: "Exam & Certification Drive", val: result.academicGoals      ?? "" },
          { label: "Practice Discipline",        val: result.practiceCommitment ?? "" },
        ];
        const joyfulFields = [
          { label: "Learning Motivation", val: result.learningMotivation ?? "" },
          { label: "Pacing Preference",   val: result.pacingPreference   ?? "" },
          { label: "Musical Background",  val: result.musicalBackground  ?? "" },
        ];
        const creativeFields = [
          { label: "Sensory Profile", val: result.sensoryProfile ?? "" },
          { label: "Physical Needs",  val: result.physicalNeeds  ?? "" },
          { label: "Learning Style",  val: result.learningStyle  ?? "" },
        ];
        const fields = creativeFields.some(f => f.val) ? creativeFields
          : joyfulFields.some(f => f.val) ? joyfulFields
          : ftFields.some(f => f.val) ? ftFields
          : lmFields;
        const hasAny  = fields.some(f => f.val);
        if (!hasAny) return null;
        return (
          <div style={{ marginTop: 14, borderTop: `1px solid ${ts.border}`, paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>Interview</div>
            {fields.filter(n => n.val).map(n => {
              const match  = n.val.match(/^Option ([A-C]):\s*([\s\S]+)$/);
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
