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

type Grade = "High" | "Medium" | "Low";

interface StudentOption { uid: string; name: string; studentID: string; }

// ─── Scoring constants ────────────────────────────────────────────────────────

const GRADE_SCORE: Record<Grade, number> = { High: 5, Medium: 3, Low: 1 };

const GRADE_STYLE: Record<Grade, { border: string; bg: string; dot: string; badgeBg: string; badgeColor: string; label: string }> = {
  High:   { border: "#16a34a", bg: "#f0fdf4", dot: "#16a34a", badgeBg: "#dcfce7", badgeColor: "#15803d", label: "HIGH"   },
  Medium: { border: "#d97706", bg: "#fffbeb", dot: "#d97706", badgeBg: "#fef3c7", badgeColor: "#92400e", label: "MEDIUM" },
  Low:    { border: "#dc2626", bg: "#fef2f2", dot: "#dc2626", badgeBg: "#fee2e2", badgeColor: "#991b1b", label: "LOW"    },
};

const SLAB_STYLE: Record<string, { border: string; bg: string; color: string; glow: string }> = {
  "Zeta Slab":    { border: "#16a34a", bg: "#f0fdf4", color: "#15803d", glow: "rgba(22,163,74,0.18)"  },
  "Epsilon Slab": { border: "#d97706", bg: "#fffbeb", color: "#92400e", glow: "rgba(217,119,6,0.18)"  },
  "Delta Slab":   { border: "#dc2626", bg: "#fef2f2", color: "#991b1b", glow: "rgba(220,38,38,0.18)"  },
};

// ─── Survey options ───────────────────────────────────────────────────────────

const INSTRUMENTS = ["Piano", "Keyboard", "Guitar", "Violin", "Drums", "Vocal", "None"] as const;

const PERF_GOALS = [
  { id: "exams",       label: "Formal Exams",          desc: "ABRSM, Trinity, or equivalent grade exams" },
  { id: "stage",       label: "Stage Performances",    desc: "Recitals, concerts, and public showcases"  },
  { id: "both",        label: "Both",                  desc: "Exam certification and stage readiness"    },
  { id: "personal",    label: "Personal Development",  desc: "Skill-building without exam pressure"      },
] as const;

const SIGHT_OPTIONS = [
  { id: "none",    label: "None",    desc: "No prior sight-reading experience"         },
  { id: "some",    label: "Some",    desc: "Occasional exposure, not yet systematic"   },
  { id: "regular", label: "Regular", desc: "Reads from sheet music regularly"          },
] as const;

// ─── Slab compute ─────────────────────────────────────────────────────────────

function computeSlabConfig(r: Grade, d: Grade, p: Grade): ScreeningConfig {
  const all = [r, d, p];
  if (all.every(g => g === "High")) {
    return {
      track:               "Zeta Slab",
      syllabusStrategy:    "Advanced Performance Track — Exam & Stage Ready",
      metronome:           true,
      metronomeBpm:        80,
      handIntegration:     "Hands Together",
      chords:              "Full Harmonies & Inversions",
      songsheetDifficulty: "Advanced/16-Bar",
    };
  }
  if (all.some(g => g === "Low")) {
    return {
      track:               "Delta Slab",
      syllabusStrategy:    "Structured Foundations — Technical Groundwork First",
      metronome:           true,
      metronomeBpm:        55,
      handIntegration:     "Hands Separated",
      chords:              false,
      songsheetDifficulty: "Standard/Easier",
    };
  }
  return {
    track:               "Epsilon Slab",
    syllabusStrategy:    "Accelerated Integration — Bridging Foundations to Performance",
    metronome:           true,
    metronomeBpm:        70,
    handIntegration:     "Hands Together",
    chords:              "Basic Blocks",
    songsheetDifficulty: "Mid-Tier",
  };
}

function slabReason(r: Grade, d: Grade, p: Grade): string {
  const all = [r, d, p];
  if (all.every(g => g === "High")) return "All three tests HIGH → peak performance placement";
  if (all.some(g => g === "Low"))   return "One or more tests LOW → foundational track required";
  const highs = all.filter(g => g === "High").length;
  return `${highs} HIGH / ${3 - highs} MEDIUM → accelerated intermediate placement`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionBar({ code, title, sub }: { code: string; title: string; sub?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 14,
      background: "#0f172a", borderRadius: "10px 10px 0 0", padding: "16px 24px",
    }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: "#4ade80", letterSpacing: "0.1em",
        fontFamily: "monospace", background: "rgba(74,222,128,0.12)",
        borderRadius: 6, padding: "4px 10px", flexShrink: 0, marginTop: 2,
      }}>
        {code}
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc", letterSpacing: "0.02em" }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  );
}

function GradeCard({
  grade, desc, selected, onSelect,
}: {
  grade: Grade; desc: string; selected: boolean; onSelect: () => void;
}) {
  const st = GRADE_STYLE[grade];
  return (
    <div onClick={onSelect} style={{
      border:       selected ? `2px solid ${st.border}` : "1.5px solid #e5e7eb",
      borderRadius: 10,
      background:   selected ? st.bg : "#fafafa",
      padding:      "13px 16px",
      cursor:       "pointer",
      marginBottom: 8,
      display:      "flex",
      alignItems:   "flex-start",
      gap:          12,
      transition:   "border-color 0.12s, background 0.12s",
    }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0, marginTop: 3,
        border:      `2px solid ${selected ? st.border : "#d1d5db"}`,
        background:  selected ? st.dot : "transparent",
        transition:  "all 0.12s",
      }} />
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 12, fontWeight: 800, color: selected ? st.border : "#374151",
          letterSpacing: "0.08em", fontFamily: "monospace", marginBottom: 4,
        }}>
          {st.label}
        </div>
        <div style={{ fontSize: 12, color: selected ? "#374151" : "#9ca3af", lineHeight: 1.55 }}>
          {desc}
        </div>
      </div>
      {selected && (
        <div style={{
          fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 99,
          background: st.badgeBg, color: st.badgeColor,
          letterSpacing: "0.08em", flexShrink: 0, marginTop: 2, fontFamily: "monospace",
        }}>
          LOCKED
        </div>
      )}
    </div>
  );
}

function TestBlock({
  code, title, sub, briefLeft, rubric, value, onChange,
}: {
  code:      string;
  title:     string;
  sub:       string;
  briefLeft: React.ReactNode;
  rubric:    Array<{ grade: Grade; desc: string }>;
  value:     Grade | null;
  onChange:  (g: Grade) => void;
}) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 18 }}>
      <SectionBar code={code} title={title} sub={sub} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", background: "#fff" }}>
        {/* Left — brief */}
        <div style={{ padding: "20px 22px", borderRight: "1px solid #f0f0f0", background: "#fcfcfc" }}>
          {briefLeft}
        </div>
        {/* Right — scoring */}
        <div style={{ padding: "20px 22px" }}>
          <div style={{
            fontSize: 9, fontWeight: 800, color: "#9ca3af", letterSpacing: "0.12em",
            fontFamily: "monospace", marginBottom: 14,
          }}>
            SCORE ENTRY — SELECT ONE
          </div>
          {rubric.map(r => (
            <GradeCard
              key={r.grade} grade={r.grade} desc={r.desc}
              selected={value === r.grade} onSelect={() => onChange(r.grade)}
            />
          ))}
          {value && (
            <div style={{ marginTop: 10, textAlign: "center", fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>
              POINTS ASSIGNED: {GRADE_SCORE[value]} / 5
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function FastTrackContent() {
  const { user } = useAuthContext();

  // Survey
  const [studentName,          setStudentName]          = useState("");
  const [studentQuery,         setStudentQuery]         = useState("");
  const [allStudents,          setAllStudents]          = useState<StudentOption[]>([]);
  const [linkedStudent,        setLinkedStudent]        = useState<StudentOption | null>(null);
  const [studsLoading,         setStudsLoading]         = useState(false);
  const [showDropdown,         setShowDropdown]         = useState(false);
  const [priorInstruments,     setPriorInstruments]     = useState<string[]>([]);
  const [performanceGoal,      setPerformanceGoal]      = useState("");
  const [sightReading,         setSightReading]         = useState("");

  // Test grades
  const [rhythmGrade, setRhythmGrade] = useState<Grade | null>(null);
  const [dexGrade,    setDexGrade]    = useState<Grade | null>(null);
  const [pitchGrade,  setPitchGrade]  = useState<Grade | null>(null);

  // Save
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [assessmentId] = useState(() => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `FT-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  });

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
    return allStudents
      .filter(s => s.name.toLowerCase().includes(q) || s.studentID.toLowerCase().includes(q))
      .slice(0, 8);
  }, [studentQuery, allStudents, linkedStudent]);

  function toggleInstrument(inst: string) {
    if (inst === "None") {
      setPriorInstruments(prev => prev.includes("None") ? [] : ["None"]);
    } else {
      setPriorInstruments(prev => {
        const sans = prev.filter(i => i !== "None");
        return sans.includes(inst) ? sans.filter(i => i !== inst) : [...sans, inst];
      });
    }
  }

  const allGraded   = rhythmGrade !== null && dexGrade !== null && pitchGrade !== null;
  const canSave     = allGraded && studentName.trim().length > 0;
  const slabConfig  = allGraded ? computeSlabConfig(rhythmGrade!, dexGrade!, pitchGrade!) : null;
  const avgScore    = allGraded
    ? parseFloat(((GRADE_SCORE[rhythmGrade!] + GRADE_SCORE[dexGrade!] + GRADE_SCORE[pitchGrade!]) / 3).toFixed(2))
    : null;

  async function handleSave() {
    if (!canSave || !slabConfig || avgScore === null || saving) return;
    setSaving(true); setSaveErr("");
    try {
      await saveScreening({
        screeningType:       "fast-track",
        childName:           studentName.trim(),
        stageReadiness:      performanceGoal || undefined,
        academicGoals:       priorInstruments.length ? priorInstruments.join(", ") : undefined,
        practiceCommitment:  sightReading || undefined,
        rhythmSyncGrade:     rhythmGrade!,
        dexterityGrade:      dexGrade!,
        pitchEchoGrade:      pitchGrade!,
        rhythmScore:         GRADE_SCORE[rhythmGrade!],
        pitchScore:          GRADE_SCORE[pitchGrade!],
        motorScore:          GRADE_SCORE[dexGrade!],
        averageScore:        avgScore,
        config:              slabConfig,
        screenedBy:          user?.uid ?? "",
        screenedAt:          new Date().toISOString(),
        studentId:           linkedStudent?.uid ?? null,
      });
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setStudentName(""); setStudentQuery(""); setLinkedStudent(null); setShowDropdown(false);
    setPriorInstruments([]); setPerformanceGoal(""); setSightReading("");
    setRhythmGrade(null); setDexGrade(null); setPitchGrade(null);
    setSaved(false); setSaveErr("");
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (saved && slabConfig) {
    const ss = SLAB_STYLE[slabConfig.track] ?? SLAB_STYLE["Epsilon Slab"];
    return (
      <div style={{ maxWidth: 600, margin: "40px auto", padding: "0 16px" }}>
        <div style={{
          background: ss.bg, border: `2px solid ${ss.border}`, borderRadius: 16,
          padding: "44px 36px", textAlign: "center",
          boxShadow: `0 0 40px ${ss.glow}`,
        }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>✅</div>
          <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 6 }}>
            {assessmentId}
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: ss.color, marginBottom: 4 }}>
            Assessment Saved
          </div>
          <div style={{ fontSize: 32, fontWeight: 900, color: ss.color, marginBottom: 8 }}>
            {slabConfig.track}
          </div>
          <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 4 }}>{studentName}</div>
          <div style={{ fontSize: 13, color: "#374151", marginBottom: 28 }}>{slabConfig.syllabusStrategy}</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" as const }}>
            <button onClick={reset} style={s.darkBtn}>+ New Assessment</button>
            <Link href="/dashboard/screening" style={{ ...s.outlineBtn, textDecoration: "none" }}>← Back to Hub</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 940, margin: "0 auto" }}>

      {/* ── Protocol header ──────────────────────────────────────────────────── */}
      <div style={{
        background: "#0f172a", borderRadius: 12, padding: "20px 28px",
        marginBottom: 22, display: "flex", alignItems: "center",
        justifyContent: "space-between", flexWrap: "wrap" as const, gap: 16,
      }}>
        <div>
          <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", letterSpacing: "0.14em", marginBottom: 6 }}>
            ROL MUSIC ACADEMY · CLINICAL ASSESSMENT PROTOCOL
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#f8fafc", letterSpacing: "0.02em" }}>
            FAST TRACK ASSESSMENT
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            Ages 7–30 · Grades · Formal Exams · Stage Performance
          </div>
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ fontSize: 9, color: "#334155", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 4 }}>
            ASSESSMENT ID
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#38bdf8", fontFamily: "monospace" }}>
            {assessmentId}
          </div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
            {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
          </div>
        </div>
      </div>

      {/* ── Section 01: Background Survey ────────────────────────────────────── */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 18 }}>
        <SectionBar
          code="01"
          title="BACKGROUND SURVEY"
          sub="Profile data collected before practical testing begins"
        />
        <div style={{ background: "#fff", padding: "24px 24px" }}>

          {/* Name + student link */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
            <div>
              <label style={s.techLabel}>STUDENT NAME *</label>
              <input
                value={studentName}
                onChange={e => setStudentName(e.target.value)}
                placeholder="Full name"
                style={s.input}
              />
            </div>
            <div>
              <label style={s.techLabel}>
                LINK TO ENROLLED STUDENT
                <span style={{ color: "#9ca3af", fontWeight: 400, letterSpacing: 0 }}> (optional)</span>
              </label>
              <div style={{ position: "relative" }}>
                {linkedStudent ? (
                  <div style={{ ...s.input, display: "flex", alignItems: "center", justifyContent: "space-between", boxSizing: "border-box" as const }}>
                    <span style={{ fontSize: 13, color: "#111" }}>
                      {linkedStudent.name}
                      <span style={{ color: "#9ca3af", fontFamily: "monospace", fontSize: 11, marginLeft: 6 }}>
                        ({linkedStudent.studentID})
                      </span>
                    </span>
                    <button type="button"
                      onClick={() => { setLinkedStudent(null); setStudentQuery(""); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 15, padding: 0, lineHeight: 1 }}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <input
                    value={studentQuery}
                    onChange={e => { setStudentQuery(e.target.value); setShowDropdown(true); }}
                    onFocus={() => setShowDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                    placeholder="Search by name or ID…"
                    style={s.input}
                  />
                )}
                {showDropdown && filteredStudents.length > 0 && !linkedStudent && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 6px 18px rgba(0,0,0,0.10)", background: "#fff", marginTop: 2, overflow: "hidden" }}>
                    {filteredStudents.map(st => (
                      <div key={st.uid}
                        onMouseDown={() => { setLinkedStudent(st); if (!studentName.trim()) setStudentName(st.name); setStudentQuery(""); setShowDropdown(false); }}
                        style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
                      >
                        <span style={{ fontWeight: 600, color: "#111" }}>{st.name}</span>
                        <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>{st.studentID}</span>
                      </div>
                    ))}
                    {studsLoading && (
                      <div style={{ padding: "10px 14px", fontSize: 12, color: "#9ca3af" }}>Loading…</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Prior instruments */}
          <div style={{ marginBottom: 22 }}>
            <label style={s.techLabel}>PRIOR INSTRUMENT TRAINING</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
              {INSTRUMENTS.map(inst => {
                const sel = priorInstruments.includes(inst);
                return (
                  <button key={inst} type="button" onClick={() => toggleInstrument(inst)} style={{
                    padding: "7px 16px", borderRadius: 8, cursor: "pointer",
                    fontSize: 12, fontWeight: sel ? 700 : 500, fontFamily: "inherit",
                    border:      sel ? "2px solid #0f172a" : "1.5px solid #e5e7eb",
                    background:  sel ? "#0f172a" : "#f9fafb",
                    color:       sel ? "#f8fafc" : "#374151",
                    letterSpacing: "0.02em",
                  }}>
                    {sel ? "✓ " : ""}{inst}
                  </button>
                );
              })}
            </div>
            {priorInstruments.length > 0 && (
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 8, fontFamily: "monospace", letterSpacing: "0.04em" }}>
                RECORDED: {priorInstruments.join(" · ")}
              </div>
            )}
          </div>

          {/* Performance goals */}
          <div style={{ marginBottom: 22 }}>
            <label style={s.techLabel}>PRIMARY PERFORMANCE GOALS</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {PERF_GOALS.map(g => {
                const sel = performanceGoal === g.id;
                return (
                  <div key={g.id} onClick={() => setPerformanceGoal(sel ? "" : g.id)} style={{
                    border:      sel ? "2px solid #0f172a" : "1.5px solid #e5e7eb",
                    borderRadius: 9, padding: "12px 14px", cursor: "pointer",
                    background:  sel ? "#f8fafc" : "#fafafa",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: sel ? "#0f172a" : "#374151", marginBottom: 3 }}>
                      {sel ? "✓ " : ""}{g.label}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{g.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sight-reading toggle */}
          <div>
            <label style={s.techLabel}>SIGHT-READING EXPOSURE</label>
            <div style={{ display: "flex", gap: 10 }}>
              {SIGHT_OPTIONS.map(opt => {
                const sel = sightReading === opt.id;
                return (
                  <div key={opt.id} onClick={() => setSightReading(sel ? "" : opt.id)} style={{
                    flex: 1, border: sel ? "2px solid #0f172a" : "1.5px solid #e5e7eb",
                    borderRadius: 9, padding: "12px 14px", cursor: "pointer",
                    background: sel ? "#f8fafc" : "#fafafa",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <div style={{
                        width: 15, height: 15, borderRadius: "50%", flexShrink: 0,
                        border: `2px solid ${sel ? "#0f172a" : "#d1d5db"}`,
                        background: sel ? "#0f172a" : "transparent",
                      }} />
                      <div style={{ fontSize: 11, fontWeight: 800, color: sel ? "#0f172a" : "#374151", letterSpacing: "0.06em", fontFamily: "monospace" }}>
                        {opt.label.toUpperCase()}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", paddingLeft: 23 }}>{opt.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Test T-01: Metronome Rhythm Sync ─────────────────────────────────── */}
      <TestBlock
        code="T-01"
        title="METRONOME RHYTHM SYNC TEST"
        sub="80 BPM · Quarter note (♩) → Double-time eighth note (♪) shift across 4 bars"
        briefLeft={
          <div>
            <div style={s.briefHeader}>TEST BRIEF</div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 14 }}>
              Set the metronome to <strong>80 BPM</strong>. The student claps in time with the click.
            </div>
            <div style={s.darkPanel}>
              <div style={s.panelLabel}>PROCEDURE</div>
              {[
                { tag: "BARS 1–4", note: "♩ Quarter notes — one clap per beat, four beats per bar",     color: "#38bdf8" },
                { tag: "→ SHIFT", note: "Switch immediately, no warning given to the student",            color: "#fbbf24" },
                { tag: "BARS 5–8", note: "♪♪ Eighth notes — two claps per beat, double subdivision",    color: "#4ade80" },
              ].map(row => (
                <div key={row.tag} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 7 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: row.color, fontFamily: "monospace", minWidth: 58, flexShrink: 0, marginTop: 1 }}>
                    {row.tag}
                  </div>
                  <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>{row.note}</div>
                </div>
              ))}
            </div>
            <div style={s.tipText}>
              Run 2 trials. Score the better attempt. Key focus: whether the subdivision shift is instantaneous or delayed.
            </div>
          </div>
        }
        rubric={[
          {
            grade: "High",
            desc:  "Locks in from bar 1 at 80 BPM with no drift. Switch to double-time eighth notes is immediate — zero hesitation, clean subdivision throughout bar 5.",
          },
          {
            grade: "Medium",
            desc:  "Quarter notes are mostly on-beat. Hesitates 1–2 beats when the subdivision shifts, but self-corrects and recovers within the bar.",
          },
          {
            grade: "Low",
            desc:  "Struggles to maintain 80 BPM in quarter notes, or loses beat entirely at the subdivision switch and cannot recover within the bar.",
          },
        ]}
        value={rhythmGrade}
        onChange={setRhythmGrade}
      />

      {/* ── Test T-02: 5-Finger Dexterity Run ───────────────────────────────── */}
      <TestBlock
        code="T-02"
        title="5-FINGER DEXTERITY RUN"
        sub="Independent finger isolation · Ascending 1→5 and descending 5→1 on a flat surface"
        briefLeft={
          <div>
            <div style={s.briefHeader}>TEST BRIEF</div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 14 }}>
              Student places one hand flat on a table. Each finger taps individually and rapidly in sequence.
            </div>
            <div style={s.darkPanel}>
              <div style={s.panelLabel}>SEQUENCE</div>
              {/* Ascending */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", marginBottom: 6 }}>ASCENDING</div>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  {[1, 2, 3, 4, 5].map((f, i) => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: "50%",
                        background: i === 0 ? "#3b82f6" : i === 4 ? "#4ade80" : "#1e293b",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, fontWeight: 800, color: "#fff",
                      }}>{f}</div>
                      {i < 4 && <div style={{ width: 10, height: 2, background: "#334155" }} />}
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "#64748b", marginLeft: 6 }}>→</div>
                </div>
              </div>
              {/* Descending */}
              <div>
                <div style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", marginBottom: 6 }}>DESCENDING</div>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  {[5, 4, 3, 2, 1].map((f, i) => (
                    <div key={`d${f}`} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: "50%",
                        background: i === 0 ? "#4ade80" : i === 4 ? "#3b82f6" : "#1e293b",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, fontWeight: 800, color: "#fff",
                      }}>{f}</div>
                      {i < 4 && <div style={{ width: 10, height: 2, background: "#334155" }} />}
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "#64748b", marginLeft: 6 }}>→</div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 10 }}>
                Repeat 3× each direction · Both hands
              </div>
            </div>
            <div style={s.tipText}>
              Watch for mirroring in the idle hand, grouping of fingers 4–5, stiffness at the 3→4 transition, or wrist involvement.
            </div>
          </div>
        }
        rubric={[
          {
            grade: "High",
            desc:  "Clean, rapid, fully independent isolation in all 5 fingers. Fingers 4 and 5 are as precise as fingers 1–3. No mirroring, no stiffness, no idle-hand movement.",
          },
          {
            grade: "Medium",
            desc:  "Mostly clean but minor hesitation at finger 4 or 5. Slight idle-hand mirroring that self-corrects when prompted. Finger grouping present but recoverable.",
          },
          {
            grade: "Low",
            desc:  "Visible stiffness across the hand, idle-hand mirroring throughout, or fingers 4–5 moving as a pair rather than independently despite multiple attempts.",
          },
        ]}
        value={dexGrade}
        onChange={setDexGrade}
      />

      {/* ── Test T-03: Pitch & Interval Echo ─────────────────────────────────── */}
      <TestBlock
        code="T-03"
        title="PITCH & INTERVAL ECHO"
        sub="3-note melodic phrase · Immediate hum-back from memory · No replays"
        briefLeft={
          <div>
            <div style={s.briefHeader}>TEST BRIEF</div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 14 }}>
              Play a 3-note phrase on the keyboard. The student immediately hums or sings it back from memory. No second play.
            </div>
            <div style={s.darkPanel}>
              <div style={s.panelLabel}>ROUNDS</div>
              {[
                { tag: "ROUND 1", note: "C–E–G ascending (major triad). Simple, bright interval.",     color: "#38bdf8" },
                { tag: "ROUND 2", note: "C–E–C (step up, return). Tests interval memory & direction.", color: "#a78bfa" },
                { tag: "ROUND 3", note: "Evaluator's choice — any 3-note phrase of moderate range.",   color: "#4ade80" },
              ].map(row => (
                <div key={row.tag} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 7 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: row.color, fontFamily: "monospace", minWidth: 60, flexShrink: 0, marginTop: 1 }}>
                    {row.tag}
                  </div>
                  <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>{row.note}</div>
                </div>
              ))}
            </div>
            <div style={s.tipText}>
              Accept humming or singing. Score on pitch accuracy and contour — not voice quality. No replays between rounds.
            </div>
          </div>
        }
        rubric={[
          {
            grade: "High",
            desc:  "Reproduces all 3 rounds accurately within 2 seconds. Correct pitch, contour, and interval direction in each phrase without prompting.",
          },
          {
            grade: "Medium",
            desc:  "Accurate on Rounds 1–2 but drifts in Round 3 (evaluator's phrase). Contour is correct but one or two pitches land slightly sharp or flat.",
          },
          {
            grade: "Low",
            desc:  "Cannot accurately reproduce even the first phrase. Hums in the approximate range but cannot lock in correct pitches or interval direction.",
          },
        ]}
        value={pitchGrade}
        onChange={setPitchGrade}
      />

      {/* ── Auto-Slab Mapper ─────────────────────────────────────────────────── */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 20 }}>
        <SectionBar
          code="RESULT"
          title="AUTO-SLAB MAPPER"
          sub="Computes slab assignment from all three test grades — all tests must be scored"
        />
        <div style={{ background: "#fff", padding: "24px 24px" }}>

          {/* Score summary row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
            {([
              { code: "T-01", name: "RHYTHM SYNC",  grade: rhythmGrade },
              { code: "T-02", name: "5-FIN DEXTR.", grade: dexGrade    },
              { code: "T-03", name: "PITCH ECHO",   grade: pitchGrade  },
            ] as const).map(t => {
              const gs = t.grade ? GRADE_STYLE[t.grade] : null;
              return (
                <div key={t.code} style={{
                  border:     `1.5px solid ${gs ? gs.border : "#e5e7eb"}`,
                  borderRadius: 10,
                  background: gs ? gs.bg : "#f9fafb",
                  padding:    "16px 14px",
                  textAlign:  "center" as const,
                  transition: "all 0.2s",
                }}>
                  <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 8 }}>
                    {t.code} · {t.name}
                  </div>
                  {t.grade ? (
                    <>
                      <div style={{ fontSize: 22, fontWeight: 900, color: gs!.border, fontFamily: "monospace", letterSpacing: "0.05em" }}>
                        {t.grade.toUpperCase()}
                      </div>
                      <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace", marginTop: 4 }}>
                        {GRADE_SCORE[t.grade]} / 5 pts
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 13, color: "#d1d5db", fontFamily: "monospace" }}>——</div>
                  )}
                </div>
              );
            })}
          </div>

          {allGraded && slabConfig && avgScore !== null ? (
            <>
              {/* Logic line */}
              <div style={{
                background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8,
                padding: "10px 16px", marginBottom: 20,
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: "#64748b", fontFamily: "monospace", letterSpacing: "0.1em", flexShrink: 0 }}>
                  LOGIC
                </div>
                <div style={{ height: 1, flex: 1, background: "#e2e8f0" }} />
                <div style={{ fontSize: 11, color: "#374151", fontFamily: "monospace" }}>
                  {slabReason(rhythmGrade!, dexGrade!, pitchGrade!)}
                </div>
              </div>

              {/* Slab result card */}
              {(() => {
                const ss = SLAB_STYLE[slabConfig.track] ?? SLAB_STYLE["Epsilon Slab"];
                return (
                  <div style={{
                    border:       `2px solid ${ss.border}`,
                    borderRadius: 12,
                    background:   ss.bg,
                    padding:      "22px 24px",
                    marginBottom: 20,
                    boxShadow:    `0 0 28px ${ss.glow}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 16, marginBottom: 20 }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 6 }}>
                          ASSIGNED SLAB
                        </div>
                        <div style={{ fontSize: 36, fontWeight: 900, color: ss.color, lineHeight: 1, letterSpacing: "0.02em" }}>
                          {slabConfig.track}
                        </div>
                        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                          {slabConfig.syllabusStrategy}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" as const }}>
                        <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 6 }}>
                          COMPOSITE SCORE
                        </div>
                        <div style={{ fontSize: 42, fontWeight: 900, color: ss.color, lineHeight: 1 }}>
                          {avgScore.toFixed(2)}
                          <span style={{ fontSize: 16, fontWeight: 400, color: "#9ca3af", marginLeft: 4 }}>/ 5</span>
                        </div>
                      </div>
                    </div>

                    {/* Config grid */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                      {([
                        { label: "Metronome",       value: slabConfig.metronome ? `Yes — ${slabConfig.metronomeBpm} BPM` : "No" },
                        { label: "Hand Integration", value: slabConfig.handIntegration },
                        { label: "Chords",          value: slabConfig.chords === false ? "None" : slabConfig.chords as string },
                        { label: "Song Difficulty", value: slabConfig.songsheetDifficulty },
                      ] as { label: string; value: string }[]).map(f => (
                        <div key={f.label} style={{ background: "rgba(255,255,255,0.65)", borderRadius: 8, padding: "10px 12px" }}>
                          <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 3, fontFamily: "monospace" }}>
                            {f.label}
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{f.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Assessment summary strip */}
              {studentName && (
                <div style={{
                  background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8,
                  padding: "12px 16px", marginBottom: 20,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  flexWrap: "wrap" as const, gap: 10,
                }}>
                  <div>
                    <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 3 }}>STUDENT</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>{studentName}</div>
                    {linkedStudent && (
                      <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>{linkedStudent.studentID}</div>
                    )}
                  </div>
                  <div style={{ textAlign: "right" as const }}>
                    <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 3 }}>ASSESSMENT ID</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", fontFamily: "monospace" }}>{assessmentId}</div>
                  </div>
                </div>
              )}

              {saveErr && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 16 }}>
                  {saveErr}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <Link href="/dashboard/screening" style={{ ...s.outlineBtn, textDecoration: "none" }}>
                  ← Back to Hub
                </Link>
                <button
                  onClick={handleSave}
                  disabled={!canSave || saving}
                  style={{
                    padding: "13px 32px", borderRadius: 9, border: "none",
                    background:  canSave && !saving ? "#0f172a" : "#e5e7eb",
                    color:       canSave && !saving ? "#f8fafc" : "#9ca3af",
                    fontSize:    13, fontWeight: 800, cursor: canSave && !saving ? "pointer" : "not-allowed",
                    letterSpacing: "0.06em", fontFamily: "monospace",
                  }}>
                  {saving ? "SAVING…" : !studentName.trim() ? "ENTER STUDENT NAME ↑" : "💾 SAVE ASSESSMENT"}
                </button>
              </div>
            </>
          ) : (
            <div style={{
              textAlign: "center", padding: "36px 0",
              border: "2px dashed #e5e7eb", borderRadius: 10,
            }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>⏳</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
                Complete all three tests to generate the slab assignment
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", letterSpacing: "0.05em" }}>
                {[
                  !rhythmGrade ? "T-01 RHYTHM SYNC" : null,
                  !dexGrade    ? "T-02 DEXTERITY"   : null,
                  !pitchGrade  ? "T-03 PITCH ECHO"  : null,
                ].filter(Boolean).join("  ·  ")}
                {!allGraded ? "  —  NOT YET SCORED" : ""}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ─── Page export ──────────────────────────────────────────────────────────────

export default function FastTrackScreeningPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <FastTrackContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  techLabel: {
    fontSize: 9, fontWeight: 800, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.12em",
    fontFamily: "monospace", display: "block", marginBottom: 8,
  },
  input: {
    width: "100%", boxSizing: "border-box",
    border: "1.5px solid #d1d5db", borderRadius: 7,
    padding: "9px 12px", fontSize: 13, outline: "none",
    fontFamily: "inherit", color: "#111", background: "#fff",
  },
  briefHeader: {
    fontSize: 9, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.12em",
    fontFamily: "monospace", marginBottom: 12,
  },
  darkPanel: {
    background: "#1e293b", borderRadius: 8, padding: "14px 16px", marginBottom: 14,
  },
  panelLabel: {
    fontSize: 9, color: "#64748b", fontFamily: "monospace",
    letterSpacing: "0.1em", marginBottom: 10,
  },
  tipText: {
    fontSize: 11, color: "#9ca3af", lineHeight: 1.6,
  },
  darkBtn: {
    padding: "11px 26px", borderRadius: 8, border: "none",
    background: "#0f172a", color: "#f8fafc",
    fontSize: 13, fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit",
  },
  outlineBtn: {
    padding: "11px 20px", borderRadius: 8,
    border: "1.5px solid #e5e7eb", background: "#f9fafb",
    color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer",
    fontFamily: "inherit", display: "inline-flex", alignItems: "center",
  },
};
