"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { collection, getDocs, query, where, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { saveScreening, getAllScreenings, saveAdmission, getAllAdmissions, getAdmissionsByTeacher, updateAdmission, deleteAdmission } from "@/services/screening/screening.service";
import { generateAdmissionCardPDF } from "@/lib/generateAdmissionCard";
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

// ─── Page shell ───────────────────────────────────────────────────────────────

// ─── Edit admission overlay ───────────────────────────────────────────────────

function EditAdmissionOverlay({
  record,
  centresList,
  onSave,
  onCancel,
}: {
  record:      Record<string, unknown>;
  centresList: { id: string; name: string }[];
  onSave:      (updated: Record<string, unknown>) => Promise<void>;
  onCancel:    () => void;
}) {
  function rs(v: unknown): string    { return typeof v === "string" ? v : ""; }
  function ra(v: unknown): string[]  { return Array.isArray(v) ? v.map(String) : []; }
  function rn(v: unknown): number | null { return typeof v === "number" ? v : null; }

  const dobParts = rs(record.dob).split("/");

  const [admissionNumber,    setAdmissionNumber]    = useState(rs(record.admissionNumber));
  const [fullName,           setFullName]           = useState(rs(record.fullName));
  const [age,                setAge]                = useState(rs(record.age));
  const [dobDD,              setDobDD]              = useState(dobParts[0] ?? "");
  const [dobMM,              setDobMM]              = useState(dobParts[1] ?? "");
  const [dobYYYY,            setDobYYYY]            = useState(dobParts[2] ?? "");
  const [parentName,         setParentName]         = useState(rs(record.parentName));
  const [workingStatus,      setWorkingStatus]      = useState(rs(record.workingStatus));
  const [schoolCompany,      setSchoolCompany]      = useState(rs(record.schoolCompany));
  const [phone,              setPhone]              = useState(rs(record.phone));
  const [email,              setEmail]              = useState(rs(record.email));
  const [address1,           setAddress1]           = useState(rs(record.address1));
  const [address2,           setAddress2]           = useState(rs(record.address2));
  const [centre,             setCentre]             = useState(() => { const raw = rs(record.centre); const found = centresList.find(c => c.id === raw); return found ? found.name : raw; });
  const [purposeOfLearning,  setPurposeOfLearning]  = useState(rs(record.purposeOfLearning));
  const [instrumentsToLearn, setInstrumentsToLearn] = useState<string[]>(ra(record.instrumentsToLearn));
  const [previousExperience, setPreviousExperience] = useState(rs(record.previousExperience));
  const [instrumentsPlayed,  setInstrumentsPlayed]  = useState<string[]>(ra(record.instrumentsPlayed));
  const [musicalSkill,       setMusicalSkill]       = useState(rs(record.musicalSkill));
  const [howHeardAboutUs,    setHowHeardAboutUs]    = useState(rs(record.howHeardAboutUs));
  const [initialExperience,  setInitialExperience]  = useState<number | null>(rn(record.initialExperience));
  const [parentPartnerProgram, setParentPartnerProgram] = useState(rs(record.parentPartnerProgram));
  const [photoDataUrl,       setPhotoDataUrl]       = useState<string | null>(rs(record.photo) || null);

  const fileInputRef   = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [saving,   setSaving]   = useState(false);
  const [saveErr,  setSaveErr]  = useState("");

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
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load failed")); };
      img.src = url;
    });
  }

  function handlePhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    compressImage(file).then(setPhotoDataUrl).catch(() => {});
    e.target.value = "";
  }

  async function handleSave() {
    if (!fullName.trim() || !phone.trim() || saving) return;
    setSaving(true); setSaveErr("");
    try {
      await onSave({
        admissionNumber: admissionNumber.trim(),
        fullName: fullName.trim(), age: age.trim(),
        dob: `${dobDD}/${dobMM}/${dobYYYY}`,
        parentName: parentName.trim(), workingStatus, schoolCompany: schoolCompany.trim(),
        phone: phone.trim(), email: email.trim(),
        address1: address1.trim(), address2: address2.trim(), centre,
        purposeOfLearning, instrumentsToLearn, previousExperience,
        instrumentsPlayed, musicalSkill, howHeardAboutUs: howHeardAboutUs.trim(),
        initialExperience, parentPartnerProgram, photo: photoDataUrl ?? null,
      });
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save.");
      setSaving(false);
    }
  }

  const canSave = fullName.trim().length > 0 && phone.trim().length > 0;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 12px" }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 640, boxShadow: "0 24px 64px rgba(0,0,0,0.2)" }}>
        {/* Header */}
        <div style={{ padding: "18px 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>✏️ Edit Application</div>
          <button onClick={onCancel} style={{ border: "none", background: "#f3f4f6", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13, color: "#374151" }}>✕ Cancel</button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", maxHeight: "72vh", overflowY: "auto", display: "flex", flexDirection: "column" as const, gap: 20 }}>
          {/* Admission Number */}
          <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4338ca", marginBottom: 8 }}>Admission Number <span style={{ fontSize: 11, fontWeight: 400, color: "#6366f1" }}>(11 digits)</span></div>
            <input
              value={admissionNumber}
              onChange={e => setAdmissionNumber(e.target.value.replace(/\D/g, "").slice(0, 11))}
              placeholder="00000000000"
              maxLength={11}
              style={{ ...s.input, fontFamily: "monospace", fontSize: 15, fontWeight: 700, letterSpacing: "0.12em", color: "#4338ca", background: "#fff", maxWidth: 200 }}
            />
          </div>

          {/* Personal */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Personal Information</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 3 }}>
                <label style={s.label}>Full Name *</label>
                <input value={fullName} onChange={e => setFullName(e.target.value)} style={s.input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Age</label>
                <input value={age} onChange={e => setAge(e.target.value)} type="number" min={0} style={s.input} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Date of Birth</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={dobDD} onChange={e => setDobDD(e.target.value)} placeholder="DD" maxLength={2} style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} />
                  <span style={{ color: "#9ca3af" }}>/</span>
                  <input value={dobMM} onChange={e => setDobMM(e.target.value)} placeholder="MM" maxLength={2} style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} />
                  <span style={{ color: "#9ca3af" }}>/</span>
                  <input value={dobYYYY} onChange={e => setDobYYYY(e.target.value)} placeholder="YYYY" maxLength={4} style={{ ...s.input, width: 68, textAlign: "center" as const, boxSizing: "border-box" as const }} />
                </div>
              </div>
              <div style={{ flex: 1.5 }}>
                <label style={s.label}>Parent / Guardian</label>
                <input value={parentName} onChange={e => setParentName(e.target.value)} style={s.input} />
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={s.label}>Working Status</label>
              <OptionGroup options={["Student","Working","Part Time","Not Working"]} value={workingStatus} onChange={setWorkingStatus} />
            </div>
            <div>
              <label style={s.label}>School / Company</label>
              <input value={schoolCompany} onChange={e => setSchoolCompany(e.target.value)} style={s.input} />
            </div>
          </div>

          {/* Contact */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Contact Information</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Phone *</label>
                <input value={phone} onChange={e => setPhone(e.target.value)} type="tel" style={s.input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Email</label>
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" style={s.input} />
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={s.label}>Address Line 1</label>
              <input value={address1} onChange={e => setAddress1(e.target.value)} style={s.input} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 2 }}>
                <label style={s.label}>Address Line 2</label>
                <input value={address2} onChange={e => setAddress2(e.target.value)} style={s.input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Centre</label>
                {centresList.length > 0 ? (
                  <select value={centre} onChange={e => setCentre(e.target.value)} style={{ ...s.input, cursor: "pointer" }}>
                    <option value="">— Select —</option>
                    {centresList.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                ) : (
                  <input value={centre} onChange={e => setCentre(e.target.value)} style={s.input} />
                )}
              </div>
            </div>
          </div>

          {/* Musical */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Musical Skills</div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Purpose of Learning</label>
              <OptionGroup options={["Formal Music Learning","Skill Development","Entertainment"]} value={purposeOfLearning} onChange={setPurposeOfLearning} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Instruments to Learn</label>
              <MultiOptionGroup options={["Piano","Keyboard","Guitar","Drums","Violin","Vocal"]} values={instrumentsToLearn} onChange={setInstrumentsToLearn} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Previous Experience</label>
              <OptionGroup options={["Well-Trained","Average","No Previous Experience"]} value={previousExperience} onChange={setPreviousExperience} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Instruments Already Playing</label>
              <MultiOptionGroup options={["Guitar","Drums","Keyboard","None of the Above"]} values={instrumentsPlayed} onChange={setInstrumentsPlayed} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Musical Skill</label>
              <OptionGroup options={["Excellent","Average","Poor"]} value={musicalSkill} onChange={setMusicalSkill} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>How Heard About Us</label>
              <input value={howHeardAboutUs} onChange={e => setHowHeardAboutUs(e.target.value)} style={s.input} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Initial Experience (/ 10)</label>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <button key={n} type="button"
                    onClick={() => setInitialExperience(initialExperience === n ? null : n)}
                    style={{ width: 38, height: 38, borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13,
                      background: initialExperience === n ? "#4f46e5" : "#f3f4f6",
                      color:      initialExperience === n ? "#fff" : "#374151",
                      fontWeight: initialExperience === n ? 800 : 500,
                    }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={s.label}>Parent Partner Program</label>
              <OptionGroup options={["Yes","No","Want to Know More"]} value={parentPartnerProgram} onChange={setParentPartnerProgram} />
            </div>
          </div>

          {/* Photo */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Candidate Photo</div>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handlePhotoFile} />
            <input ref={fileInputRef}   type="file" accept="image/*"                       style={{ display: "none" }} onChange={handlePhotoFile} />
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
              <div style={{ width: 90, height: 112, flexShrink: 0, border: "2px dashed #d1d5db", borderRadius: 8, background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                {photoDataUrl
                  ? <img src={photoDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontSize: 26, color: "#d1d5db" }}>📷</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                <button type="button" onClick={() => cameraInputRef.current?.click()} style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #4f46e5", background: "#ede9fe", color: "#4f46e5", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>📸 Take Photo</button>
                <button type="button" onClick={() => fileInputRef.current?.click()} style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>🖼️ Upload</button>
                {photoDataUrl && <button type="button" onClick={() => setPhotoDataUrl(null)} style={{ padding: "6px 14px", borderRadius: 7, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: 12, cursor: "pointer" }}>Remove</button>}
              </div>
            </div>
          </div>

          {saveErr && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 7, padding: "9px 13px", fontSize: 13, color: "#dc2626" }}>{saveErr}</div>}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onCancel} style={s.secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave || saving}
            style={{ ...s.primaryBtn, opacity: canSave && !saving ? 1 : 0.4, cursor: canSave && !saving ? "pointer" : "not-allowed" }}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Admission applications list ─────────────────────────────────────────────

function AdmissionsList({ onStartScreening }: { onStartScreening: (name: string) => void }) {
  const { user }       = useAuthContext();
  const [admissions,   setAdmissions]   = useState<Record<string, unknown>[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [selected,     setSelected]     = useState<Record<string, unknown> | null>(null);
  const [editing,      setEditing]      = useState<Record<string, unknown> | null>(null);
  const [deleteId,     setDeleteId]     = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [centresList,  setCentresList]  = useState<{ id: string; name: string }[]>([]);
  const [showForm,     setShowForm]     = useState(false);
  const [pdfLoading,   setPdfLoading]   = useState<string | null>(null);

  // Screening lookup map: keyed by studentId and by lowercased studentName
  const [screeningMap, setScreeningMap] = useState<Map<string, Record<string, unknown>>>(new Map());

  // Complete-admission modal state
  const [completing,       setCompleting]       = useState<{ admission: Record<string, unknown>; screening: Record<string, unknown> } | null>(null);
  const [completingAdmNo,  setCompletingAdmNo]  = useState("");
  const [completingSaving, setCompletingSaving] = useState("");
  const [completingPhase,  setCompletingPhase]  = useState<"number" | "success" | "enroll">("number");
  const [enrollCentre,     setEnrollCentre]     = useState("");
  const [enrolling,        setEnrolling]        = useState(false);

  function closeCompleting() {
    setCompleting(null); setCompletingAdmNo(""); setCompletingPhase("number"); setEnrollCentre("");
  }

  function str(v: unknown): string   { return typeof v === "string" ? v : ""; }
  function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }
  function num(v: unknown): number | null { return typeof v === "number" ? v : null; }

  function reload() {
    setLoading(true);
    (user?.role === ROLES.TEACHER && user.uid
      ? getAdmissionsByTeacher(user.uid)
      : getAllAdmissions()
    )
      .then(setAdmissions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    getDocs(collection(db, "centers"))
      .then(snap => setCentresList(snap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id }))))
      .catch(() => {});
    // Build screening lookup map from all 3 instrument collections
    Promise.all(
      ["guitar-screenings", "keyboard-screenings", "drum-screenings"].map(col => getDocs(collection(db, col)))
    ).then(snaps => {
      const map = new Map<string, Record<string, unknown>>();
      for (const snap of snaps) {
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          const sid  = typeof data.studentId   === "string" ? data.studentId   : "";
          const snam = typeof data.studentName === "string" ? data.studentName.toLowerCase() : "";
          if (sid)  map.set(sid,  data);
          if (snam) map.set(snam, data);
        }
      }
      setScreeningMap(map);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveEdit(id: string, updated: Record<string, unknown>) {
    await updateAdmission(id, updated);
    setAdmissions(prev => prev.map(a => str(a.id) === id ? { ...a, ...updated } : a));
    setSelected(prev => prev && str(prev.id) === id ? { ...prev, ...updated } : prev);
    setEditing(null);
  }

  async function handleDelete(id: string) {
    setDeleteSubmitting(true);
    try {
      await deleteAdmission(id);
      setAdmissions(prev => prev.filter(a => str(a.id) !== id));
      if (selected && str(selected.id) === id) setSelected(null);
      setDeleteId(null);
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  function getScreening(rec: Record<string, unknown>): Record<string, unknown> | null {
    return screeningMap.get(str(rec.id))
        || screeningMap.get(str(rec.fullName).toLowerCase())
        || null;
  }

  async function handleRedownload(admission: Record<string, unknown>) {
    const id = str(admission.id);
    setPdfLoading(id);
    try {
      await generateAdmissionCardPDF(admission, getScreening(admission));
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setPdfLoading(null);
    }
  }

  async function handleCompleteAdmission() {
    if (!completing || completingAdmNo.length !== 11 || completingSaving) return;
    setCompletingSaving("saving");
    try {
      const id      = str(completing.admission.id);
      const updated = { ...completing.admission, admissionNumber: completingAdmNo };
      await updateAdmission(id, { admissionNumber: completingAdmNo });
      setAdmissions(prev => prev.map(a => str(a.id) === id ? updated : a));
      setCompletingSaving("downloading");
      await generateAdmissionCardPDF(updated, completing.screening);
      // Advance to success phase — keep modal open for enroll option
      setCompleting({ ...completing, admission: updated });
      setCompletingPhase("success");
    } catch (err) {
      console.error("Complete admission failed:", err);
    } finally {
      setCompletingSaving("");
    }
  }

  async function handleEnrollStudent() {
    if (!completing || !enrollCentre || enrolling) return;
    setEnrolling(true);
    try {
      const adm = completing.admission;
      await addDoc(collection(db, "users"), {
        name:            str(adm.fullName),
        role:            "student",
        phone:           str(adm.phone),
        email:           str(adm.email),
        age:             str(adm.age),
        dob:             str(adm.dob),
        parentName:      str(adm.parentName),
        workingStatus:   str(adm.workingStatus),
        schoolCompany:   str(adm.schoolCompany),
        address1:        str(adm.address1),
        address2:        str(adm.address2),
        centre:          enrollCentre,
        admissionNumber: str(adm.admissionNumber),
        studentID:       str(adm.admissionNumber),
        instruments:     arr(adm.instrumentsToLearn),
        musicalSkill:    str(adm.musicalSkill),
        photo:           str(adm.photo) || null,
        createdAt:       serverTimestamp(),
      });
      await deleteAdmission(str(adm.id));
      setAdmissions(prev => prev.filter(a => str(a.id) !== str(adm.id)));
      closeCompleting();
    } catch (err) {
      console.error("Enrollment failed:", err);
    } finally {
      setEnrolling(false);
    }
  }

  if (loading) {
    return <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>;
  }

  const formModal = showForm ? (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.55)", overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "16px" }}>
      <div style={{ width: "100%", maxWidth: 640, borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", background: "#fff", margin: "20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>📋 New Admission Application</div>
          <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1, padding: 4 }}>✕</button>
        </div>
        <AdmissionFormContent onDone={() => { setShowForm(false); reload(); }} />
      </div>
    </div>
  ) : null;

  if (admissions.length === 0) {
    return (
      <>
        {formModal}
        <div style={{ textAlign: "center", padding: "60px 24px", color: "#9ca3af" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#374151", marginBottom: 6 }}>No applications yet</div>
          <div style={{ fontSize: 13, marginBottom: 24 }}>Submitted forms will appear here.</div>
          <button onClick={() => setShowForm(true)} style={s.primaryBtn}>
            + New Admission
          </button>
        </div>
      </>
    );
  }

  return (
    <div>
      {formModal}
      {/* Edit overlay */}
      {editing && (
        <EditAdmissionOverlay
          record={editing}
          centresList={centresList}
          onSave={async (updated) => { await handleSaveEdit(str(editing.id), updated); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* Delete confirmation overlay */}
      {deleteId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 28px", maxWidth: 380, width: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.2)", textAlign: "center" as const }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🗑️</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111", marginBottom: 6 }}>Delete Application?</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 22 }}>
              This will permanently remove the application. This action cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={() => setDeleteId(null)}
                disabled={deleteSubmitting}
                style={{ ...s.secondaryBtn, minWidth: 90 }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                disabled={deleteSubmitting}
                style={{ ...s.primaryBtn, background: "#dc2626", minWidth: 90, opacity: deleteSubmitting ? 0.6 : 1, cursor: deleteSubmitting ? "not-allowed" : "pointer" }}
              >
                {deleteSubmitting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Complete Admission modal (3 phases) ── */}
      {completing && (
        <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 460, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>

            {/* ─ PHASE 1: Enter admission number ─ */}
            {completingPhase === "number" && (<>
              <div style={{ background: "#16a34a", borderRadius: "16px 16px 0 0", padding: "18px 24px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>✅ Complete Admission</div>
                <div style={{ fontSize: 12, color: "#bbf7d0", marginTop: 3 }}>{str(completing.admission.fullName)}</div>
              </div>
              <div style={{ padding: "14px 24px", background: "#f0fdf4", borderBottom: "1px solid #d1fae5" }}>
                {(() => {
                  const sc = completing.screening;
                  const cfg = sc.config as Record<string, unknown> | undefined;
                  return (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                      <span style={{ background: "#dcfce7", color: "#15803d", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99 }}>
                        {str(sc.instrument).charAt(0).toUpperCase() + str(sc.instrument).slice(1)}
                      </span>
                      <span style={{ background: "#f3f4f6", color: "#374151", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 99 }}>
                        {str(sc.stream).replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                      {cfg && str(cfg.track) && (
                        <span style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99 }}>
                          {str(cfg.track)}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div style={{ padding: "24px 24px 20px" }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: "#374151", display: "block", marginBottom: 8 }}>
                  Admission Number <span style={{ fontWeight: 400, color: "#9ca3af" }}>(11 digits)</span>
                </label>
                <input
                  value={completingAdmNo}
                  onChange={e => setCompletingAdmNo(e.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="00000000000"
                  maxLength={11}
                  autoFocus
                  style={{
                    width: "100%", boxSizing: "border-box" as const,
                    padding: "12px 16px", borderRadius: 10,
                    border: completingAdmNo.length === 11 ? "2px solid #16a34a" : completingAdmNo.length > 0 ? "2px solid #d97706" : "1px solid #d1d5db",
                    fontSize: 22, fontFamily: "monospace", fontWeight: 800,
                    letterSpacing: "0.18em", color: "#111", outline: "none",
                    background: completingAdmNo.length === 11 ? "#f0fdf4" : "#fff",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: completingAdmNo.length === 11 ? "#16a34a" : "#9ca3af" }}>
                    {completingAdmNo.length}/11 digits{completingAdmNo.length === 11 ? " ✓" : ""}
                  </span>
                  {completingAdmNo.length > 0 && completingAdmNo.length < 11 && (
                    <span style={{ fontSize: 11, color: "#d97706" }}>{11 - completingAdmNo.length} more needed</span>
                  )}
                </div>
              </div>
              <div style={{ padding: "0 24px 20px", display: "flex", gap: 10 }}>
                <button onClick={closeCompleting} disabled={!!completingSaving} style={{ ...s.secondaryBtn, flex: 1 }}>Cancel</button>
                <button
                  onClick={handleCompleteAdmission}
                  disabled={completingAdmNo.length !== 11 || !!completingSaving}
                  style={{ ...s.primaryBtn, flex: 2, background: "#16a34a", opacity: completingAdmNo.length === 11 && !completingSaving ? 1 : 0.45, cursor: completingAdmNo.length === 11 && !completingSaving ? "pointer" : "not-allowed" }}
                >
                  {completingSaving === "saving" ? "Saving…" : completingSaving === "downloading" ? "Generating PDF…" : "Save & Download PDF"}
                </button>
              </div>
            </>)}

            {/* ─ PHASE 2: Success — offer enroll ─ */}
            {completingPhase === "success" && (<>
              <div style={{ background: "#16a34a", borderRadius: "16px 16px 0 0", padding: "18px 24px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>🎉 Admission Complete</div>
                <div style={{ fontSize: 12, color: "#bbf7d0", marginTop: 3 }}>{str(completing.admission.fullName)}</div>
              </div>
              <div style={{ padding: "28px 24px" }}>
                <div style={{ background: "#f0fdf4", border: "1px solid #d1fae5", borderRadius: 12, padding: "16px 20px", marginBottom: 20, textAlign: "center" as const }}>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Admission Number</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: 800, color: "#15803d", letterSpacing: "0.14em" }}>
                    {str(completing.admission.admissionNumber)}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#374151", marginBottom: 6 }}>
                  The Admission Card PDF has been downloaded. Would you like to enroll this student now?
                </div>
                <div style={{ fontSize: 12, color: "#9ca3af" }}>
                  Enrolling will add the student to the Students list and remove them from Applications.
                </div>
              </div>
              <div style={{ padding: "0 24px 24px", display: "flex", gap: 10 }}>
                <button onClick={closeCompleting} style={{ ...s.secondaryBtn, flex: 1 }}>Close</button>
                <button
                  onClick={() => setCompletingPhase("enroll")}
                  style={{ ...s.primaryBtn, flex: 2, background: "#4f46e5" }}
                >
                  Enroll Student →
                </button>
              </div>
            </>)}

            {/* ─ PHASE 3: Select centre & enroll ─ */}
            {completingPhase === "enroll" && (<>
              <div style={{ background: "#4f46e5", borderRadius: "16px 16px 0 0", padding: "18px 24px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>🏫 Enroll Student</div>
                <div style={{ fontSize: 12, color: "#c7d2fe", marginTop: 3 }}>{str(completing.admission.fullName)}</div>
              </div>
              <div style={{ padding: "28px 24px" }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: "#374151", display: "block", marginBottom: 10 }}>
                  Select Centre
                </label>
                {centresList.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                    {centresList.map(c => {
                      const sel = enrollCentre === c.id;
                      return (
                        <button key={c.id} onClick={() => setEnrollCentre(c.id)}
                          style={{ textAlign: "left", padding: "12px 16px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                            border: sel ? "2px solid #4f46e5" : "1px solid #e5e7eb",
                            background: sel ? "#ede9fe" : "#f9fafb",
                            display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                            background: sel ? "#4f46e5" : "#d1d5db", transition: "background 0.15s" }} />
                          <span style={{ fontSize: 13, fontWeight: sel ? 700 : 500, color: sel ? "#4f46e5" : "#374151" }}>
                            {c.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: "16px", background: "#f9fafb", borderRadius: 10, fontSize: 13, color: "#9ca3af", textAlign: "center" as const }}>
                    No centres found in database.
                  </div>
                )}
              </div>
              <div style={{ padding: "0 24px 24px", display: "flex", gap: 10 }}>
                <button onClick={() => setCompletingPhase("success")} disabled={enrolling} style={{ ...s.secondaryBtn, flex: 1 }}>← Back</button>
                <button
                  onClick={handleEnrollStudent}
                  disabled={!enrollCentre || enrolling}
                  style={{ ...s.primaryBtn, flex: 2, background: "#4f46e5", opacity: enrollCentre && !enrolling ? 1 : 0.45, cursor: enrollCentre && !enrolling ? "pointer" : "not-allowed" }}
                >
                  {enrolling ? "Enrolling…" : "Confirm Enrollment"}
                </button>
              </div>
            </>)}

          </div>
        </div>
      )}

      {/* ── Detail panel ── */}
      {selected && (
        <div style={{
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
          padding: "24px", marginBottom: 20, position: "relative" as const,
          boxShadow: "0 4px 24px rgba(0,0,0,0.07)",
        }}>
          {/* Action row */}
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" as const }}>
            <button
              onClick={() => { onStartScreening(str(selected.fullName)); }}
              style={{
                padding: "9px 16px", borderRadius: 8, border: "none",
                background: "#4f46e5", color: "#fff",
                fontSize: 13, fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              🎹 Start Screening
            </button>
            <button
              onClick={() => setEditing(selected)}
              style={{
                padding: "9px 16px", borderRadius: 8,
                border: "1px solid #d1d5db", background: "#f9fafb",
                color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              ✏️ Edit
            </button>
            <button
              onClick={() => setDeleteId(str(selected.id))}
              style={{
                padding: "9px 16px", borderRadius: 8,
                border: "1px solid #fecaca", background: "#fef2f2",
                color: "#dc2626", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              🗑️ Delete
            </button>
            <button
              onClick={() => setSelected(null)}
              style={{
                marginLeft: "auto", padding: "9px 14px", borderRadius: 8,
                border: "none", background: "#f3f4f6",
                color: "#374151", fontSize: 13, cursor: "pointer",
              }}
            >
              ✕ Close
            </button>
          </div>

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
                  ["Age",        str(selected.age)],
                  ["DOB",        str(selected.dob)],
                  ["Parent",     str(selected.parentName)],
                  ["Phone",      str(selected.phone)],
                  ["Email",      str(selected.email)],
                  ["Status",     str(selected.workingStatus)],
                  ["School/Co.", str(selected.schoolCompany)],
                  ["Centre",     centresList.find(c => c.id === str(selected.centre))?.name ?? str(selected.centre)],
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
              ["Purpose of Learning",    str(selected.purposeOfLearning)],
              ["Previous Experience",    str(selected.previousExperience)],
              ["Musical Skill",          str(selected.musicalSkill)],
              ["How Heard About Us",     str(selected.howHeardAboutUs)],
              ["Parent Partner Program", str(selected.parentPartnerProgram)],
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
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>
            Applications
            <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>({admissions.length})</span>
          </div>
          <button onClick={() => setShowForm(true)}
            style={{ ...s.primaryBtn, padding: "8px 16px", fontSize: 12 }}>
            + New Admission
          </button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                {["", "Name", "Adm. No.", "Age", "Phone", "Instruments", "Centre", "Date", ""].map((h, i) => (
                  <th key={i} style={{
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
                const isSelected  = selected?.id === rec.id;
                const instruments = arr(rec.instrumentsToLearn);
                return (
                  <tr
                    key={str(rec.id) || i}
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      background: isSelected ? "#ede9fe" : i % 2 === 0 ? "#fff" : "#fafafa",
                    }}
                  >
                    <td style={{ padding: "10px 10px 10px 14px", width: 40 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 6, overflow: "hidden", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {str(rec.photo)
                          ? <img src={str(rec.photo)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : <span style={{ fontSize: 18 }}>👤</span>}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: "#111", whiteSpace: "nowrap" as const }}>
                      {str(rec.fullName)}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 11, color: "#4f46e5", fontFamily: "monospace", whiteSpace: "nowrap" as const, fontWeight: 700, letterSpacing: "0.04em" }}>
                      {str(rec.admissionNumber) || <span style={{ color: "#d1d5db", fontStyle: "italic", fontFamily: "inherit" }}>—</span>}
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
                          ? instruments.map(inst => <span key={inst} style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>{inst}</span>)
                          : <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" as const }}>
                      {str(rec.centre) || "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" as const }}>
                      {str(rec.submittedAt) ? new Date(str(rec.submittedAt)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                    </td>
                    {/* Actions */}
                    <td style={{ padding: "10px 14px", whiteSpace: "nowrap" as const }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => setSelected(isSelected ? null : rec)}
                          title={isSelected ? "Close" : "View details"}
                          style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #e5e7eb", background: isSelected ? "#ede9fe" : "#f9fafb", cursor: "pointer", fontSize: 12, color: isSelected ? "#4f46e5" : "#374151", fontWeight: 600 }}
                        >
                          {isSelected ? "▲" : "▼"}
                        </button>
                        <button
                          onClick={() => { onStartScreening(str(rec.fullName)); }}
                          title="Start Screening"
                          style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "#4f46e5", cursor: "pointer", fontSize: 12, color: "#fff", fontWeight: 700 }}
                        >
                          🎹
                        </button>
                        <button
                          onClick={() => { setSelected(rec); setEditing(rec); }}
                          title="Edit"
                          style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", cursor: "pointer", fontSize: 12, color: "#374151" }}
                        >
                          ✏️
                        </button>
                        {str(rec.admissionNumber) ? (
                          // Already has admission number → re-download + enroll
                          <>
                            <button
                              onClick={() => handleRedownload(rec)}
                              title="Download Admission Card PDF"
                              disabled={pdfLoading === str(rec.id)}
                              style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #c7d2fe", background: "#eef2ff", cursor: pdfLoading === str(rec.id) ? "wait" : "pointer", fontSize: 12, color: "#4338ca", fontWeight: 700, opacity: pdfLoading === str(rec.id) ? 0.6 : 1, whiteSpace: "nowrap" as const }}
                            >
                              {pdfLoading === str(rec.id) ? "…" : "📄 Card"}
                            </button>
                            <button
                              onClick={() => { setCompleting({ admission: rec, screening: getScreening(rec) ?? {} }); setCompletingPhase("success"); }}
                              title="Enroll Student"
                              style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #a5b4fc", background: "#ede9fe", cursor: "pointer", fontSize: 12, color: "#4338ca", fontWeight: 700, whiteSpace: "nowrap" as const }}
                            >
                              🎓 Enroll
                            </button>
                          </>
                        ) : getScreening(rec) ? (
                          // Screened but no admission number → request form download + complete admission
                          <>
                            <button
                              onClick={() => handleRedownload(rec)}
                              title="Download Admission Request Form"
                              disabled={pdfLoading === str(rec.id)}
                              style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #c7d2fe", background: "#eef2ff", cursor: pdfLoading === str(rec.id) ? "wait" : "pointer", fontSize: 12, color: "#4338ca", fontWeight: 700, whiteSpace: "nowrap" as const, opacity: pdfLoading === str(rec.id) ? 0.6 : 1 }}
                            >
                              {pdfLoading === str(rec.id) ? "…" : "📄 Request"}
                            </button>
                            <button
                              onClick={() => { setCompleting({ admission: rec, screening: getScreening(rec)! }); setCompletingAdmNo(""); }}
                              title="Complete Admission"
                              style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #86efac", background: "#dcfce7", cursor: "pointer", fontSize: 12, color: "#15803d", fontWeight: 700, whiteSpace: "nowrap" as const }}
                            >
                              ✅ Admit
                            </button>
                          </>
                        ) : null}
                        <button
                          onClick={() => setDeleteId(str(rec.id))}
                          title="Delete"
                          style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", cursor: "pointer", fontSize: 12, color: "#dc2626" }}
                        >
                          🗑️
                        </button>
                      </div>
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
  const [view,          setView]          = useState<"screening" | "applications">("screening");
  const [selectedTrack, setSelectedTrack] = useState<"guitar" | "keyboard" | "drums">("guitar");
  const [formKey,       setFormKey]       = useState(0);

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

function AdmissionFormContent({ onDone }: { onDone?: () => void } = {}) {
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
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={reset} style={s.primaryBtn}>+ New Application</button>
            {onDone && (
              <button onClick={onDone} style={s.secondaryBtn}>← Back to Applications</button>
            )}
          </div>
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
                {centres.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
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
