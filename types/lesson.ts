import type { Timestamp } from "firebase/firestore";

// ─── Collections ──────────────────────────────────────────────────────────────
// lessons                  — master lesson definitions (center-wide OR student-specific)
// lesson_items             — ordered activities within a lesson: concept / exercise / songsheet
// student_lesson_progress  — per-student attempt + completion tracking per item

// ─── Lesson ───────────────────────────────────────────────────────────────────

export interface Lesson {
  id:           string;
  title:        string;
  lessonNumber: number;          // human-readable identifier
  order:        number;          // strict sequence (no skipping)
  centerId:     string | null;   // set for center-wide lessons
  studentId:    string | null;   // set for student-specific lessons
  createdAt:    Timestamp | string;
  updatedAt:    Timestamp | string;
}

export type CreateLessonInput = Omit<Lesson, "id" | "createdAt" | "updatedAt">;

// ─── Lesson Item ──────────────────────────────────────────────────────────────

export type LessonItemType = "concept" | "exercise" | "songsheet";

// Per-type attempt limits:  concept → 5, exercise → 5, songsheet → 10
export const MAX_ATTEMPTS_BY_TYPE: Record<LessonItemType, number> = {
  concept:   5,
  exercise:  5,
  songsheet: 10,
};

export interface LessonItem {
  id:          string;
  lessonId:    string;
  type:        LessonItemType;
  title:       string;
  maxAttempts: number;   // set from MAX_ATTEMPTS_BY_TYPE at creation time
  order:       number;   // strict within-lesson sequence
  createdAt:   Timestamp | string;
  updatedAt:   Timestamp | string;
}

export type CreateLessonItemInput = Omit<LessonItem, "id" | "createdAt" | "updatedAt">;

// ─── Attempt ──────────────────────────────────────────────────────────────────

export type AttemptStatus = "attempted" | "completed";

export interface Attempt {
  attemptNo: number;             // 1-based
  date:      string;             // ISO date string
  status:    AttemptStatus;
  notes:     string | null;
  teacherId: string;             // UID of teacher who logged this attempt
}

// ─── Student Lesson Progress ──────────────────────────────────────────────────

export interface StudentLessonProgress {
  id:               string;       // deterministic: `${studentId}_${itemId}`
  studentId:        string;
  lessonId:         string;
  itemId:           string;
  attempts:         Attempt[];
  completed:        boolean;
  completionDate:   string | null;  // ISO date string
  teacherId:        string | null;  // last teacher who acted on this
  firstAttemptDate: string | null;  // ISO date string
  totalAttempts:    number;         // denormalised = attempts.length
  createdAt:        Timestamp | string;
  updatedAt:        Timestamp | string;
}

export type CreateProgressInput = Pick<
  StudentLessonProgress,
  "studentId" | "lessonId" | "itemId"
>;

// ─── Stored progress summary (written on every teacher action) ────────────────

export interface StudentProgressSummary {
  id:             string;   // doc ID = studentId
  studentId:      string;
  overallPercent: number;   // 0–100, recalculated on every write
  lessonPercents: Record<string, number>;  // lessonId → 0–100
  updatedAt:      Timestamp | string;
}

// ─── Excel import row (raw, pre-validation) ───────────────────────────────────
// Required columns: lessonNumber, lessonName, itemType, itemTitle
// itemType must be one of: concept | exercise | songsheet
// lessonNumber determines lesson sequence order
// Item order is auto-assigned by row sequence within each lesson group

export interface ExcelImportRow {
  lessonNumber: number;
  lessonName:   string;
  itemType:     string;   // raw string before validation
  itemTitle:    string;
}

// ─── Lesson progress summary (live calculation result) ───────────────────────

export interface LessonProgressSummary {
  totalLessons:      number;
  completedLessons:  number;
  inProgressLessons: number;
  overallPercent:    number;   // 0–100
}
