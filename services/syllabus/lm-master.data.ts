import type {
  MasterSyllabusItem,
  LittleMozartsTrack,
  LMSyllabusUIConfig,
  LMSyllabusTarget,
  HandAllocation,
  LMProgram,
  LMCourse,
  LMTrackOrBridge,
} from "@/types/syllabus";

const RH: HandAllocation = "RH Only";
const HS: HandAllocation = "Hands Separated";
const HT: HandAllocation = "Hands Together";

function concept(n: number, ln: string, title: string): MasterSyllabusItem {
  return { lessonNumber: n, lessonName: ln, itemType: "concept", itemTitle: title, metronomeBpm: null, handAllocation: null };
}
function exercise(n: number, ln: string, title: string, bpm: number | null, hand: HandAllocation): MasterSyllabusItem {
  return { lessonNumber: n, lessonName: ln, itemType: "exercise", itemTitle: title, metronomeBpm: bpm, handAllocation: hand };
}
function songsheet(n: number, ln: string, title: string, bpm: number | null, hand: HandAllocation): MasterSyllabusItem {
  return { lessonNumber: n, lessonName: ln, itemType: "songsheet", itemTitle: title, metronomeBpm: bpm, handAllocation: hand };
}

// ─── Delta Track ──────────────────────────────────────────────────────────────
// Metronome OFF · RH Only · No chords · Simplified/Rote songsheets

export const DELTA_TRACK_ITEMS: MasterSyllabusItem[] = [
  // Lesson 1
  concept(1, "Welcome to the Piano", "The Keyboard Layout"),
  concept(1, "Welcome to the Piano", "Finger Numbers 1–5"),
  exercise(1, "Welcome to the Piano", "Finger Number Drill", null, RH),
  // Lesson 2
  concept(2, "Black Keys", "Groups of 2 Black Keys"),
  concept(2, "Black Keys", "Groups of 3 Black Keys"),
  exercise(2, "Black Keys", "Black Key Tapping – RH", null, RH),
  // Lesson 3
  concept(3, "White Keys & Notes", "Musical Alphabet C D E F G A B"),
  concept(3, "White Keys & Notes", "Finding C on the Keyboard"),
  exercise(3, "White Keys & Notes", "Name the White Keys", null, RH),
  // Lesson 4 — C Major scale dual entry
  concept(4, "Five-Finger C Position", "C Position & Posture"),
  concept(4, "Five-Finger C Position", "C Major Scale – Introduction"),
  exercise(4, "Five-Finger C Position", "C Major Scale – RH", null, RH),
  exercise(4, "Five-Finger C Position", "Five-Finger Warm-Up in C", null, RH),
  // Lesson 5
  concept(5, "Reading Music & First Songs", "Quarter Note & Rest"),
  concept(5, "Reading Music & First Songs", "Half Note & Rest"),
  songsheet(5, "Reading Music & First Songs", "Mary Had a Little Lamb", null, RH),
  // Lesson 6
  concept(6, "Rhythm", "Steady Beat & Counting (1–2–3–4)"),
  exercise(6, "Rhythm", "Rhythm Clapping – 4/4 Time", null, RH),
  songsheet(6, "Rhythm", "Hot Cross Buns", null, RH),
  // Lesson 7 — G Major scale dual entry
  concept(7, "G Position", "G Position Placement"),
  concept(7, "G Position", "G Major Scale – Introduction"),
  exercise(7, "G Position", "G Major Scale – RH", null, RH),
  exercise(7, "G Position", "G Position Melody", null, RH),
  // Lesson 8
  concept(8, "Dynamics", "Piano (p) & Forte (f)"),
  exercise(8, "Dynamics", "Soft & Loud Exercise", null, RH),
  songsheet(8, "Dynamics", "Twinkle Twinkle Little Star", null, RH),
  // Lesson 9
  concept(9, "Legato & Staccato", "Legato – Smooth Playing"),
  concept(9, "Legato & Staccato", "Staccato – Short & Detached"),
  exercise(9, "Legato & Staccato", "Legato Study in C", null, RH),
  exercise(9, "Legato & Staccato", "Staccato Study in C", null, RH),
  // Lesson 10 — pure exercises & songsheets, no concepts
  exercise(10, "Course 2 Wrap-Up", "C Major Scale Review", null, RH),
  exercise(10, "Course 2 Wrap-Up", "G Major Scale Review", null, RH),
  exercise(10, "Course 2 Wrap-Up", "Five-Finger Exercises C & G", null, RH),
  songsheet(10, "Course 2 Wrap-Up", "Mary Had a Little Lamb – Performance", null, RH),
  songsheet(10, "Course 2 Wrap-Up", "Twinkle Twinkle – Performance", null, RH),
];

// ─── Epsilon Track ────────────────────────────────────────────────────────────
// Metronome ON 50 BPM · Hands Separated · Basic Block chords · Standard/Easier

export const EPSILON_TRACK_ITEMS: MasterSyllabusItem[] = [
  // Lesson 1
  concept(1, "Hands Separate Review", "Review: C Position Both Hands"),
  concept(1, "Hands Separate Review", "Bass Clef – Lines GBDFA"),
  exercise(1, "Hands Separate Review", "C Major Scale – RH", 50, HS),
  // Lesson 2
  concept(2, "Left Hand Introduction", "C Position – Left Hand"),
  exercise(2, "Left Hand Introduction", "C Major Scale – LH", 50, HS),
  exercise(2, "Left Hand Introduction", "Alternate-Hand Drill", 50, HS),
  // Lesson 3 — D Major scale dual entry
  concept(3, "D Major", "D Major Scale – Introduction"),
  exercise(3, "D Major", "D Major Scale – RH", 50, HS),
  exercise(3, "D Major", "D Major Scale – LH", 50, HS),
  exercise(3, "D Major", "D Position Warm-Up", 50, HS),
  // Lesson 4
  concept(4, "Reading Both Clefs", "Grand Staff & Middle C"),
  concept(4, "Reading Both Clefs", "Notes C–G in Bass Clef"),
  exercise(4, "Reading Both Clefs", "Two-Clef Reading Drill", 50, HS),
  songsheet(4, "Reading Both Clefs", "Ode to Joy – Simplified", 50, HS),
  // Lesson 5
  concept(5, "8th Notes & Dotted Rhythms", "Eighth Note & Rest"),
  concept(5, "8th Notes & Dotted Rhythms", "Dotted Quarter Note"),
  exercise(5, "8th Notes & Dotted Rhythms", "Eighth Note Rhythm Drill", 50, HS),
  songsheet(5, "8th Notes & Dotted Rhythms", "Jingle Bells – RH Melody", 50, HS),
  // Lesson 6 — C Major chord dual entry
  concept(6, "C Major Chord", "What is a Chord?"),
  concept(6, "C Major Chord", "C Major Chord – Introduction"),
  exercise(6, "C Major Chord", "C Major Chord Exercise", 50, HS),
  exercise(6, "C Major Chord", "Chord Transitions C–G", 50, HS),
  // Lesson 7 — G Major (review) & F Major dual entries
  concept(7, "G & F Major", "G Major Scale – Review"),
  exercise(7, "G & F Major", "G Major Scale – Hands Sep.", 50, HS),
  concept(7, "G & F Major", "F Major Scale – Introduction"),
  exercise(7, "G & F Major", "F Major Scale – RH", 50, HS),
  // Lesson 8 — G Major chord dual entry
  concept(8, "Songs with Chords", "G Major Chord – Basic Block"),
  exercise(8, "Songs with Chords", "G Major Chord Practice", 50, HS),
  exercise(8, "Songs with Chords", "C–G Chord Alternation", 50, HS),
  songsheet(8, "Songs with Chords", "Au Clair de la Lune – Simplified", 50, HS),
  // Lesson 9
  concept(9, "Phrasing & Expression", "Slurs & Phrase Marks"),
  concept(9, "Phrasing & Expression", "Crescendo & Decrescendo"),
  exercise(9, "Phrasing & Expression", "Phrase Expression Study", 50, HS),
  exercise(9, "Phrasing & Expression", "Dynamic Shaping Drill", 50, HS),
  // Lesson 10 — pure exercises & songsheets, no concepts
  exercise(10, "Course 2 Assessment", "C Major Scale – Hands Sep.", 50, HS),
  exercise(10, "Course 2 Assessment", "D Major Scale – Hands Sep.", 50, HS),
  exercise(10, "Course 2 Assessment", "F Major Scale – RH", 50, HS),
  exercise(10, "Course 2 Assessment", "C–G–F Chord Progression", 50, HS),
  songsheet(10, "Course 2 Assessment", "Ode to Joy – Full Simplified Version", 50, HS),
  songsheet(10, "Course 2 Assessment", "Performance Piece (Teacher's Choice)", 50, HS),
];

// ─── Zeta Track ───────────────────────────────────────────────────────────────
// Metronome ON 65 BPM · Hands Together · Full Triads · Standard songsheets

export const ZETA_TRACK_ITEMS: MasterSyllabusItem[] = [
  // Lesson 1 — C Major scale dual entry
  concept(1, "Hands Together Coordination", "HT Coordination Principles"),
  concept(1, "Hands Together Coordination", "C Major Scale – HT Introduction"),
  exercise(1, "Hands Together Coordination", "C Major Scale – Hands Together", 65, HT),
  exercise(1, "Hands Together Coordination", "Contrary Motion Exercise", 65, HT),
  // Lesson 2 — D Major & E Major dual entries
  concept(2, "D & E Major HT", "D Major Scale – HT"),
  exercise(2, "D & E Major HT", "D Major Scale – HT", 65, HT),
  concept(2, "D & E Major HT", "E Major Scale – Introduction"),
  exercise(2, "D & E Major HT", "E Major Scale – HT", 65, HT),
  // Lesson 3
  concept(3, "Major Triads", "Root Position Triads"),
  concept(3, "Major Triads", "First Inversion – Introduction"),
  exercise(3, "Major Triads", "C Major Triad – Root & 1st Inv.", 65, HT),
  exercise(3, "Major Triads", "G Major Triad – Root & 1st Inv.", 65, HT),
  // Lesson 4 — F Major & A Major dual entries
  concept(4, "F & A Major HT", "F Major Scale – HT"),
  exercise(4, "F & A Major HT", "F Major Scale – HT", 65, HT),
  concept(4, "F & A Major HT", "A Major Scale – Introduction"),
  exercise(4, "F & A Major HT", "A Major Scale – HT", 65, HT),
  // Lesson 5 — C Major arpeggio dual entry
  concept(5, "Arpeggios & Songs", "C Major Arpeggio – Introduction"),
  exercise(5, "Arpeggios & Songs", "C Major Arpeggio – RH", 65, HT),
  exercise(5, "Arpeggios & Songs", "C Major Arpeggio – LH", 65, HT),
  songsheet(5, "Arpeggios & Songs", "Für Elise – Opening Theme", 65, HT),
  // Lesson 6 — B♭ Major dual entry
  concept(6, "B♭ Major & Chord Progressions", "B♭ Major Scale – Introduction"),
  exercise(6, "B♭ Major & Chord Progressions", "B♭ Major Scale – HT", 65, HT),
  concept(6, "B♭ Major & Chord Progressions", "I–IV–V Progression"),
  exercise(6, "B♭ Major & Chord Progressions", "I–IV–V–I in C Major", 65, HT),
  // Lesson 7 — G7 chord dual entry
  concept(7, "Dominant 7th Chords", "Dominant 7th Chord – Introduction"),
  exercise(7, "Dominant 7th Chords", "G7 Chord Exercise", 65, HT),
  exercise(7, "Dominant 7th Chords", "G7 to C Resolution", 65, HT),
  songsheet(7, "Dominant 7th Chords", "Minuet in G – Bach (Simplified)", 65, HT),
  // Lesson 8
  concept(8, "Advanced Rhythms", "Triplets"),
  concept(8, "Advanced Rhythms", "Syncopation – Introduction"),
  exercise(8, "Advanced Rhythms", "Triplet Drill in C", 65, HT),
  exercise(8, "Advanced Rhythms", "Syncopation Study", 65, HT),
  songsheet(8, "Advanced Rhythms", "Für Elise – Extended", 65, HT),
  // Lesson 9
  concept(9, "Pedal & Sight-Reading", "Sustain Pedal – Introduction"),
  concept(9, "Pedal & Sight-Reading", "Sight-Reading Strategies"),
  exercise(9, "Pedal & Sight-Reading", "Pedal Practice in C Major", 65, HT),
  exercise(9, "Pedal & Sight-Reading", "Sight-Reading Exercise Set A", 65, HT),
  // Lesson 10 — pure exercises & songsheets, no concepts
  exercise(10, "Final Assessment & Performance", "C Major Scale – HT Target 80 BPM", 65, HT),
  exercise(10, "Final Assessment & Performance", "Arpeggio Study – C Major", 65, HT),
  exercise(10, "Final Assessment & Performance", "Triad Progression C–F–G–C", 65, HT),
  exercise(10, "Final Assessment & Performance", "I–IV–V–I Full Progression", 65, HT),
  songsheet(10, "Final Assessment & Performance", "Minuet in G – Full Performance", 65, HT),
  songsheet(10, "Final Assessment & Performance", "Performance Piece (Teacher's Choice)", 65, HT),
];

// ─── Track index ──────────────────────────────────────────────────────────────

export const MASTER_TRACK_DATA: Record<LittleMozartsTrack, MasterSyllabusItem[]> = {
  delta_track:   DELTA_TRACK_ITEMS,
  epsilon_track: EPSILON_TRACK_ITEMS,
  zeta_track:    ZETA_TRACK_ITEMS,
};

// Course 1.1 = lessons 1–5 · Course 1.2 = lessons 6–10
// Bridge entries are always [] — they must be imported via Excel
export const MASTER_COURSE_DATA: Record<LittleMozartsTrack, Partial<Record<LMCourse, MasterSyllabusItem[]>>> = {
  delta_track: {
    course_1_1: DELTA_TRACK_ITEMS.filter(i => i.lessonNumber <= 5),
    course_1_2: DELTA_TRACK_ITEMS.filter(i => i.lessonNumber > 5),
  },
  epsilon_track: {
    course_1_1: EPSILON_TRACK_ITEMS.filter(i => i.lessonNumber <= 5),
    course_1_2: EPSILON_TRACK_ITEMS.filter(i => i.lessonNumber > 5),
  },
  zeta_track: {
    course_1_1: ZETA_TRACK_ITEMS.filter(i => i.lessonNumber <= 5),
    course_1_2: ZETA_TRACK_ITEMS.filter(i => i.lessonNumber > 5),
  },
};

// ─── Pathway progression rules ────────────────────────────────────────────────
// Each array is the ordered sequence of LMSyllabusTargets a student must complete.

export const TRACK_PROGRESSION: Record<LittleMozartsTrack, LMSyllabusTarget[]> = {
  delta_track: [
    { program: "intro_keyboard", track: "delta_track",   course: "course_1_1"   },
    { program: "intro_keyboard", track: "delta_track",   course: "course_1_2"   },
    { program: "intro_keyboard", track: "bridge",        course: "delta_bridge" },
    { program: "intro_keyboard", track: "bridge",        course: "epsilon_bridge"},
  ],
  epsilon_track: [
    { program: "intro_keyboard", track: "epsilon_track", course: "course_1_1"   },
    { program: "intro_keyboard", track: "epsilon_track", course: "course_1_2"   },
    { program: "intro_keyboard", track: "bridge",        course: "epsilon_bridge"},
  ],
  zeta_track: [
    { program: "intro_keyboard", track: "zeta_track",    course: "course_1_1"   },
    { program: "intro_keyboard", track: "zeta_track",    course: "course_1_2"   },
  ],
};

export function getNextCourseTarget(
  track:   LittleMozartsTrack,
  current: LMCourse,
): LMSyllabusTarget | null {
  const path = TRACK_PROGRESSION[track];
  const idx  = path.findIndex(t => t.course === current);
  return idx >= 0 && idx < path.length - 1 ? path[idx + 1]! : null;
}

export const TRACK_UI_CONFIG: Record<LittleMozartsTrack, LMSyllabusUIConfig> = {
  delta_track: {
    metronome:       false,
    metronomeBpm:    null,
    handIntegration: "RH Only",
    chords:          false,
  },
  epsilon_track: {
    metronome:       true,
    metronomeBpm:    50,
    handIntegration: "Hands Separated",
    chords:          "Basic Blocks",
  },
  zeta_track: {
    metronome:       true,
    metronomeBpm:    65,
    handIntegration: "Hands Together",
    chords:          "Full Triads",
  },
};

export const PROGRAM_LABELS: Record<LMProgram, string> = {
  intro_keyboard:        "Introduction to Keyboard",
  intro_guitar:          "Introduction to Guitar",
  intermediate_keyboard: "Intermediate Keyboard",
  intermediate_guitar:   "Intermediate Guitar",
  advanced_keyboard:     "Advanced Keyboard",
  advanced_guitar:       "Advanced Guitar",
};

export const COURSE_LABELS: Record<LMCourse, string> = {
  course_1_1:    "Course 1.1",
  course_1_2:    "Course 1.2",
  delta_bridge:  "Delta Bridge",
  epsilon_bridge:"Epsilon Bridge",
  term_1:        "Term 1",
  term_2:        "Term 2",
  term_3:        "Term 3",
};

export const TRACK_LABELS: Record<LMTrackOrBridge, string> = {
  delta_track:   "Delta Track",
  epsilon_track: "Epsilon Track",
  zeta_track:    "Zeta Track",
  bridge:        "Bridge",
  standard:      "Standard",
};

export const TRACK_SHORT: Record<LMTrackOrBridge, string> = {
  delta_track:   "Delta",
  epsilon_track: "Epsilon",
  zeta_track:    "Zeta",
  bridge:        "Bridge",
  standard:      "Standard",
};

// ─── Program slot definitions ─────────────────────────────────────────────────

export interface ProgramSlot { track: LMTrackOrBridge; course: LMCourse }

const INTRO_SLOTS: ProgramSlot[] = [
  { track: "delta_track",   course: "course_1_1"    },
  { track: "delta_track",   course: "course_1_2"    },
  { track: "epsilon_track", course: "course_1_1"    },
  { track: "epsilon_track", course: "course_1_2"    },
  { track: "zeta_track",    course: "course_1_1"    },
  { track: "zeta_track",    course: "course_1_2"    },
  { track: "bridge",        course: "delta_bridge"  },
  { track: "bridge",        course: "epsilon_bridge"},
];

const FLAT_SLOTS: ProgramSlot[] = [
  { track: "standard", course: "term_1" },
  { track: "standard", course: "term_2" },
  { track: "standard", course: "term_3" },
];

export const PROGRAM_SLOTS: Record<LMProgram, ProgramSlot[]> = {
  intro_keyboard:        INTRO_SLOTS,
  intro_guitar:          INTRO_SLOTS,
  intermediate_keyboard: FLAT_SLOTS,
  intermediate_guitar:   FLAT_SLOTS,
  advanced_keyboard:     FLAT_SLOTS,
  advanced_guitar:       FLAT_SLOTS,
};

export function isTrackBasedProgram(program: LMProgram): boolean {
  return program === "intro_keyboard" || program === "intro_guitar";
}

// Returns per-row pathway data for Card 1 visualization.
// Track-based programs → one row per LM track. Flat programs → single standard row.
export function getProgramPathway(program: LMProgram): { track: LMTrackOrBridge; steps: LMSyllabusTarget[] }[] {
  if (isTrackBasedProgram(program)) {
    return (Object.entries(TRACK_PROGRESSION) as [LittleMozartsTrack, LMSyllabusTarget[]][]).map(([track, steps]) => ({
      track: track as LMTrackOrBridge,
      steps: steps.map(s => ({ ...s, program })),
    }));
  }
  return [{
    track: "standard" as const,
    steps: PROGRAM_SLOTS[program].map(s => ({ program, ...s })),
  }];
}
