// =============================================================================
// Fast Track screening questions — the three tests a teacher runs and grades.
//
// Pure (no Firebase SDK) so the client screen, the Admissions "Screening
// Questions" tab and the /api/admin/screening-questions route share one shape
// and one validator. Stored per wing at `config/screening_questions_{wing}`;
// a wing with no saved doc uses DEFAULT_FAST_TRACK_TESTS.
//
// The three tests are fixed (T-01 Rhythm, T-02 Dexterity, T-03 Pitch) because
// the slab logic and the saved rhythm/motor/pitch scores map to them by
// position — leaders can reword them, not add or remove them.
// =============================================================================

export type ScreeningGrade = "High" | "Medium" | "Low";
export const SCREENING_GRADES: ScreeningGrade[] = ["High", "Medium", "Low"];

export interface ScreeningStep { tag: string; text: string }
export interface ScreeningRubric { grade: ScreeningGrade; desc: string }

export interface FastTrackTest {
  code: string;
  title: string;
  sub: string;
  steps: ScreeningStep[];
  tip: string;
  rubric: ScreeningRubric[];
}

export const FAST_TRACK_TEST_CODES = ["T-01", "T-02", "T-03"] as const;
/** What each test measures — fixed, since scoring depends on it. */
export const FAST_TRACK_TEST_MEASURES = ["Rhythm", "Dexterity", "Pitch"] as const;

export const MAX_STEPS = 8;

export const DEFAULT_FAST_TRACK_TESTS: FastTrackTest[] = [
  {
    code: "T-01", title: "Metronome Rhythm Sync",
    sub: "80 BPM · Quarter note → eighth-note shift across 4 bars",
    steps: [
      { tag: "Setup",    text: "Set metronome to 80 BPM. Student claps in time with the click." },
      { tag: "Bars 1–4", text: "Quarter notes — one clap per beat, four beats per bar" },
      { tag: "→ Shift",  text: "Switch immediately — no warning given to the student" },
      { tag: "Bars 5–8", text: "Eighth notes — two claps per beat, double subdivision" },
    ],
    tip: "Run 2 trials. Score the better attempt. Key focus: whether the subdivision shift is instantaneous or delayed.",
    rubric: [
      { grade: "High",   desc: "Locks in from bar 1 at 80 BPM. Switch to double-time is immediate — zero hesitation." },
      { grade: "Medium", desc: "Mostly on-beat. Hesitates 1–2 beats at the shift but self-corrects within the bar." },
      { grade: "Low",    desc: "Struggles at 80 BPM, or loses beat entirely at the subdivision shift." },
    ],
  },
  {
    code: "T-02", title: "5-Finger Dexterity Run",
    sub: "Independent isolation · Ascending 1→5 and descending 5→1",
    steps: [
      { tag: "Setup",      text: "Student places one hand flat on a table." },
      { tag: "Ascending",  text: "Fingers 1 → 2 → 3 → 4 → 5 — each taps individually and rapidly." },
      { tag: "Descending", text: "Fingers 5 → 4 → 3 → 2 → 1 — same individual tap sequence." },
      { tag: "Repeat",     text: "3× each direction · Both hands. Watch for mirroring in the idle hand." },
    ],
    tip: "Watch for mirroring in the idle hand, grouping of fingers 4–5, stiffness at the 3→4 transition, or wrist involvement.",
    rubric: [
      { grade: "High",   desc: "Clean, rapid, fully independent isolation in all 5 fingers. No mirroring or stiffness." },
      { grade: "Medium", desc: "Minor hesitation at finger 4 or 5. Slight idle-hand mirroring that self-corrects." },
      { grade: "Low",    desc: "Visible stiffness, persistent mirroring, or fingers 4–5 moving as a pair." },
    ],
  },
  {
    code: "T-03", title: "Pitch & Interval Echo",
    sub: "3-note melodic phrase · Hum-back from memory · No replays",
    steps: [
      { tag: "Round 1", text: "Play C–E–G ascending (major triad). Simple, bright interval." },
      { tag: "Round 2", text: "Play C–E–C (step up, return). Tests interval memory & direction." },
      { tag: "Round 3", text: "Evaluator's choice — any 3-note phrase of moderate range." },
    ],
    tip: "Accept humming or singing. Score on pitch accuracy and contour — not voice quality. No replays between rounds.",
    rubric: [
      { grade: "High",   desc: "Reproduces all 3 rounds accurately within 2 seconds. Correct pitch, contour, and interval direction." },
      { grade: "Medium", desc: "Accurate on Rounds 1–2 but drifts in Round 3. Contour correct but one or two pitches off." },
      { grade: "Low",    desc: "Cannot accurately reproduce even the first phrase. Hums in approximate range only." },
    ],
  },
];

export const screeningQuestionsDocId = (wing: string) => `screening_questions_${wing}`;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Coerce stored/submitted data into exactly three well-formed tests. Any
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
