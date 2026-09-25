// =============================================================================
// Fast Track screening questions — the five sections a teacher runs and grades.
//
// Pure (no Firebase SDK) so the client screen, the Admissions "Screening
// Questions" tab and the /api/admin/screening-questions route share one shape
// and one validator. Stored per wing at `config/screening_questions_{wing}`;
// a wing with no saved doc uses DEFAULT_FAST_TRACK_TESTS.
//
// Scored out of 15: five sections × 3 marks (High 3 · Medium 2 · Low 1).
// The sections are fixed (S-1 Rhythm Sync, S-2 Pitch Consciousness, S-3 Sheet
// Tapping, S-4 Attention Span, S-5 Musical Awareness) because the saved
// screeningScores map to them by position — leaders can reword them, not add
// or remove them. The slab (syllabus level suggestion) still comes from the
// three practical music sections, S-1 to S-3.
//
// Older screenings (before 5 sections) were three sections × 5 marks; they
// carry no `sectionMax` and are read with readScreeningMarks() below.
// =============================================================================

export type ScreeningGrade = "High" | "Medium" | "Low";
export const SCREENING_GRADES: ScreeningGrade[] = ["High", "Medium", "Low"];

export interface ScreeningStep { tag: string; text: string }
export interface ScreeningRubric { grade: ScreeningGrade; desc: string }

/** Marks per section, and the band each mark falls in. */
export const MAX_SECTION_MARKS = 3;
export const SECTION_COUNT = 5;
export const MAX_TOTAL_MARKS = MAX_SECTION_MARKS * SECTION_COUNT; // 15
/** The previous format: three sections marked out of 5 (still 15 in total). */
export const LEGACY_SECTION_MARKS = 5;

export const GRADE_MARK_RANGE: Record<ScreeningGrade, { min: number; max: number; label: string }> = {
  High:   { min: 3, max: 3, label: "3 marks" },
  Medium: { min: 2, max: 2, label: "2 marks" },
  Low:    { min: 1, max: 1, label: "1 mark" },
};
/** Band for a mark. `outOf` = 5 reads an older (3 × 5) screening's marks. */
export function gradeForMarks(marks: number, outOf: number = MAX_SECTION_MARKS): ScreeningGrade {
  if (outOf === LEGACY_SECTION_MARKS) return marks >= 4 ? "High" : marks >= 2 ? "Medium" : "Low";
  return marks >= 3 ? "High" : marks >= 2 ? "Medium" : "Low";
}
/** Mark on the current 1–3 scale for a band (used to carry old marks into an edit). */
export const GRADE_TO_MARK: Record<ScreeningGrade, number> = { High: 3, Medium: 2, Low: 1 };

/** Keys of the stored per-section marks — `screeningScores` on a screening. */
export type ScreeningScoreKey = "rhythmSync" | "pitchConsciousness" | "sheetTapping" | "attentionSpan" | "musicalAwareness";
export const SCREENING_SCORE_KEYS: ScreeningScoreKey[] = ["rhythmSync", "pitchConsciousness", "sheetTapping", "attentionSpan", "musicalAwareness"];
export type ScreeningScores = Record<ScreeningScoreKey, number> & { total: number; sectionMax: number };

/**
 * Per-section marks of any saved fast-track screening, in either format:
 *   current — five sections out of 3 (`screeningScores.sectionMax` = 3)
 *   legacy  — three sections out of 5 (`screeningScores` without sectionMax,
 *             or only the old rhythmScore / pitchScore / motorScore fields)
 */
export function readScreeningMarks(sc: Record<string, unknown> | null | undefined): {
  marks: (number | null)[]; outOf: number; total: number | null; legacy: boolean; labels: string[];
} {
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
  const ss = (sc?.screeningScores ?? null) as Record<string, unknown> | null;
  if (ss && num(ss.sectionMax) === MAX_SECTION_MARKS) {
    const marks = SCREENING_SCORE_KEYS.map(k => num(ss[k]));
    return {
      marks, outOf: MAX_SECTION_MARKS, legacy: false, labels: [...FAST_TRACK_TEST_MEASURES],
      total: num(ss.total) ?? (marks.every(m => m !== null) ? (marks as number[]).reduce((a, b) => a + b, 0) : null),
    };
  }
  const marks = ss
    ? [num(ss.rhythmSync), num(ss.pitchConsciousness), num(ss.sheetTapping)]
    : [num(sc?.rhythmScore), num(sc?.pitchScore), num(sc?.motorScore)];
  return {
    marks, outOf: LEGACY_SECTION_MARKS, legacy: true, labels: FAST_TRACK_TEST_MEASURES.slice(0, 3),
    total: num(ss?.total) ?? (marks.every(m => m !== null) ? (marks as number[]).reduce((a, b) => a + b, 0) : null),
  };
}

/** "Rhythm Sync: 3/3" lines for a saved screening (admission card, summaries). */
export function screeningSectionLines(sc: Record<string, unknown> | null | undefined): string[] {
  const r = readScreeningMarks(sc);
  return r.labels.map((l, i) => `${l}: ${r.marks[i] ?? "–"}/${r.outOf}`);
}

export interface FastTrackTest {
  code: string;
  title: string;
  sub: string;
  steps: ScreeningStep[];
  tip: string;
  rubric: ScreeningRubric[];
}

export const FAST_TRACK_TEST_CODES = ["S-1", "S-2", "S-3", "S-4", "S-5"] as const;
/** What each section measures — fixed, since scoring depends on it. */
export const FAST_TRACK_TEST_MEASURES = ["Rhythm Sync", "Pitch Consciousness", "Sheet Tapping", "Attention Span", "Musical Awareness"] as const;

/**
 * Bumped when the sections themselves change. A saved wing doc from an older
 * version described different tests (v1: Rhythm / Dexterity / Pitch Echo), so
 * it is ignored and the wing falls back to the current defaults.
 * (Adding S-4 / S-5 did not bump it: S-1–S-3 are unchanged, so a leader's
 * saved wording is kept and the new sections start from the defaults.)
 */
export const SCREENING_QUESTIONS_VERSION = 2;

export const MAX_STEPS = 8;

export const DEFAULT_FAST_TRACK_TESTS: FastTrackTest[] = [
  {
    code: "S-1", title: "Metronome Rhythm Sync",
    sub: "60 BPM · Quarter notes → eighth notes, switched without warning",
    steps: [
      { tag: "Setup",    text: "Set the metronome to 60 BPM. Student taps in time with the click." },
      { tag: "Bars 1–4", text: "Quarter notes — one tap per beat, four beats per bar." },
      { tag: "→ Shift",  text: "Switch to eighth notes immediately — no warning given to the student." },
      { tag: "Bars 5–8", text: "Eighth notes — two taps per beat, double subdivision." },
    ],
    tip: "Run 2 trials and score the better attempt. Key focus: whether the shift to double-time is instant or delayed.",
    rubric: [
      { grade: "High",   desc: "Immediate shift to double-time with zero hesitation." },
      { grade: "Medium", desc: "Mostly on-beat; hesitates 1–2 beats on the shift." },
      { grade: "Low",    desc: "Struggles at 60 BPM or loses beat accuracy." },
    ],
  },
  {
    code: "S-2", title: "Song Sing-Along & Pitch Consciousness",
    sub: "Familiar song on instrument / audio · Student sings along with the melody",
    steps: [
      { tag: "Setup",  text: "Pick a simple, familiar song the student knows." },
      { tag: "Play",   text: "Play the song on the instrument or from audio." },
      { tag: "Sing",   text: "Student sings along with the melody." },
      { tag: "Listen", text: "Listen for vocal pitch accuracy and musical ear consciousness across the whole song." },
    ],
    tip: "Score pitch matching and awareness — not voice quality. Note any drift in the higher or lower register.",
    rubric: [
      { grade: "High",   desc: "Matches vocal pitch accurately throughout, with clear pitch awareness and tonal confidence." },
      { grade: "Medium", desc: "Sings along reasonably well; occasional slight pitch drift or uncertainty in the higher/lower register." },
      { grade: "Low",    desc: "Monotone, off-pitch, or unable to align vocal pitch with the played song." },
    ],
  },
  {
    code: "S-3", title: "Metronome Sheet Tapping & Count Sync",
    sub: "Screening sheet (beat counts 1-2-3-4 / slash marks) · Tap + count aloud",
    steps: [
      { tag: "Setup", text: "Hand the student the physical/digital screening sheet showing numbered beat counts 1-2-3-4 / slash marks over the staff lines." },
      { tag: "Click", text: "Start the metronome." },
      { tag: "Tap",   text: "Student taps out the rhythm on the sheet while counting \"1, 2, 3, 4\" aloud in sync with the click." },
    ],
    tip: "Watch voice–tap coordination: are the spoken counts and the taps landing together on the click?",
    rubric: [
      { grade: "High",   desc: "Taps and counts beat numbers simultaneously with precise metronome sync and steady meter." },
      { grade: "Medium", desc: "Taps accurately but hesitates or loses voice–tap coordination during the count-aloud." },
      { grade: "Low",    desc: "Unable to coordinate verbal beat counting with physical tapping or the metronome pulse." },
    ],
  },
  {
    code: "S-4", title: "Attention Span & Instruction Comprehension Speed",
    sub: "Observed while giving the student a new task or instruction",
    steps: [
      { tag: "Instruct", text: "Give the student a new task or instruction they have not heard before." },
      { tag: "Observe",  text: "Watch focus and retention while they carry it out." },
      { tag: "Speed",    text: "Note how quickly they understand — first explanation, a repeat, or step-by-step help." },
    ],
    tip: "Score what you observe across the whole session, not a single moment of distraction.",
    rubric: [
      { grade: "High",   desc: "Grasps instructions immediately on first explanation; maintains sharp focus." },
      { grade: "Medium", desc: "Requires a brief repeat or secondary explanation; good focus with minor distraction." },
      { grade: "Low",    desc: "Slow comprehension or easily distracted; requires step-by-step guidance." },
    ],
  },
  {
    code: "S-5", title: "Musical Awareness & Aptitude Questions",
    sub: "Three direct questions · evaluated together into one score",
    steps: [
      { tag: "Q1", text: "\"What types or genres of music are you aware of or like listening to?\"" },
      { tag: "Q2", text: "\"How creative do you feel you are when trying new things or making music?\"" },
      { tag: "Q3", text: "\"What are your daily/weekly music listening habits?\"" },
    ],
    tip: "Ask all three, then give one combined score for the overall answers.",
    rubric: [
      { grade: "High",   desc: "Strong awareness of genres, highly engaged creative mindset, regular active music listening habits." },
      { grade: "Medium", desc: "Moderate genre awareness, occasional creative interest, casual listening habits." },
      { grade: "Low",    desc: "Minimal genre awareness, low interest/confidence in creativity, rarely listens to music." },
    ],
  },
];

export const screeningQuestionsDocId = (wing: string) => `screening_questions_${wing}`;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Coerce stored/submitted data into exactly five well-formed tests. Any
 * missing or blank field falls back to the default text, so a bad save can
 * never leave a teacher with an empty test. Codes and grades are always the
 * fixed ones.
 */
export function sanitizeFastTrackTests(raw: unknown): FastTrackTest[] {
  const list = Array.isArray(raw) ? raw : [];
  return DEFAULT_FAST_TRACK_TESTS.map((def, i) => {
    const t = (list[i] && typeof list[i] === "object" ? list[i] : {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(t.steps) ? t.steps : [];
    const steps = rawSteps
      .slice(0, MAX_STEPS)
      .map(s => {
        const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
        return { tag: str(o.tag, 30), text: str(o.text, 300) };
      })
      .filter(s => s.text);
    const rubricIn = Array.isArray(t.rubric) ? t.rubric as Record<string, unknown>[] : [];
    return {
      code:  def.code,
      title: str(t.title, 80) || def.title,
      sub:   str(t.sub, 160),
      steps: steps.length ? steps : def.steps,
      tip:   str(t.tip, 400),
      rubric: SCREENING_GRADES.map(grade => ({
        grade,
        desc: str(rubricIn.find(r => r?.grade === grade)?.desc, 300)
          || def.rubric.find(r => r.grade === grade)!.desc,
      })),
    };
  });
}
