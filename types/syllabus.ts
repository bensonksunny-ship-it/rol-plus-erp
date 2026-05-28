import type { Timestamp } from "firebase/firestore";

export interface SyllabusUnit {
  id:             string;
  title:          string;
  level:          string;          // e.g. "Beginner", "Intermediate", "Advanced"
  order:          number;          // strict sequence — no skipping
  prerequisiteId: string | null;   // id of required prior unit, null if first
  concepts:       string[];        // list of concept labels for this unit
  exercises:      string[];        // list of exercise labels for this unit
  createdAt:      Timestamp | string;
  updatedAt:      Timestamp | string;
}

export type CreateSyllabusUnitInput = Omit<SyllabusUnit, "id" | "createdAt" | "updatedAt">;

// ─── Student Progress ─────────────────────────────────────────────────────────

export type ProgressStatus = "not_started" | "in_progress" | "completed";

export interface StudentProgress {
  id:                  string;
  studentUid:          string;
  unitId:              string;
  status:              ProgressStatus;
  completionDate:      string | null;   // ISO date string
  teacherSignOff:      string | null;   // UID of teacher who signed off
  feedback:            string | null;
  overrideBy:          string | null;   // UID of admin who applied override (null if normal flow)
  completedConcepts:   string[];        // subset of SyllabusUnit.concepts
  completedExercises:  string[];        // subset of SyllabusUnit.exercises
  points:              number;          // gamification: accumulated points for this unit
  createdAt:           Timestamp | string;
  updatedAt:           Timestamp | string;
}

// ─── Student Syllabus Assignment ──────────────────────────────────────────────

export interface StudentSyllabus {
  id:         string;   // same as studentUid (1:1)
  studentUid: string;
  unitIds:    string[]; // ordered list of assigned unit IDs
  createdAt:  Timestamp | string;
  updatedAt:  Timestamp | string;
}

// ─── Little Mozarts Flat-Array Syllabus ───────────────────────────────────────

export type LittleMozartsTrack = "delta_track" | "epsilon_track" | "zeta_track";

export type LMItemType = "concept" | "exercise" | "songsheet";

export type HandAllocation = "RH Only" | "Hands Separated" | "Hands Together";

export interface MasterSyllabusItem {
  lessonNumber:   number;
  lessonName:     string;
  itemType:       LMItemType;
  itemTitle:      string;
  metronomeBpm:   number | null;        // always null for concepts
  handAllocation: HandAllocation | null; // always null for concepts
}

export interface StudentSyllabusItem extends MasterSyllabusItem {
  completed:   boolean;
  completedAt: string | null;
}

export interface LMSyllabusUIConfig {
  metronome:       boolean;
  metronomeBpm:    number | null;
  handIntegration: HandAllocation;
  chords:          false | "Basic Blocks" | "Full Triads";
}

export interface LMStudentSyllabus {
  studentId:     string;
  track:         LittleMozartsTrack;
  syllabusType:  "little_mozarts";
  currentCourse: LMCourse;        // which course the student is currently working on
  items:         StudentSyllabusItem[];
  uiConfig:      LMSyllabusUIConfig;
  createdAt:     string;
  updatedAt:     string;
}

export type LMProgram =
  | "intro_keyboard"
  | "intro_guitar"
  | "intermediate_keyboard"
  | "intermediate_guitar"
  | "advanced_keyboard"
  | "advanced_guitar";

export type LMCourse =
  | "course_1_1"
  | "course_1_2"
  | "delta_bridge"
  | "epsilon_bridge"
  | "term_1"
  | "term_2"
  | "term_3";

export type LMTrackOrBridge = LittleMozartsTrack | "bridge" | "standard";

export interface LMSyllabusTarget {
  program: LMProgram;
  track:   LMTrackOrBridge;
  course:  LMCourse;
}
