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
