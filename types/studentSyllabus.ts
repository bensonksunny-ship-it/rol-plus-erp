import type { Timestamp } from "firebase/firestore";

// ─── Collection: student_syllabus ─────────────────────────────────────────────
// One document per student (doc ID = studentUid)
// Entirely self-contained — no references to the master lesson/syllabus collections

export type SyllabusItemType = "concept" | "exercise" | "songsheet";

// 5-slot attempt array — 0 = not attempted, 1 = attempted
export type AttemptSlots = [number, number, number, number, number];

export interface SyllabusItem {
  id:            string;           // uuid generated on import
  type:          SyllabusItemType;
  title:         string;
  attempts:      AttemptSlots;     // always length 5
  completed:     boolean;
  startDate:     string | null;    // ISO date — set on first attempt
  completedDate: string | null;    // ISO date — set on "Mark Done"
}

export interface SyllabusLesson {
  id:     string;       // uuid generated on import
  title:  string;       // lessonTitle from Excel
  order:  number;       // 1-based import order
  items:  SyllabusItem[];
}

export interface StudentSyllabusDoc {
  id:         string;              // doc ID = studentUid
  studentUid: string;
  lessons:    SyllabusLesson[];
  importedAt: Timestamp | string;
  updatedAt:  Timestamp | string;
}

// ─── Excel import row ─────────────────────────────────────────────────────────
// Expected columns (case-insensitive, spaces/underscores ignored):
//   Lesson | Type | Title

export interface SyllabusImportRow {
  lesson: string;
  type:   string;
  title:  string;
}

// ─── Analytics snapshot (computed, not stored) ────────────────────────────────

export interface ItemAnalytics {
  attemptsUsed: number;             // count of 1s in attempts[]
  daysTaken:    number | null;      // completedDate - startDate in days
}
