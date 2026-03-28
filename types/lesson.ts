import type { Timestamp } from "firebase/firestore";

// ─── Collections ──────────────────────────────────────────────────────────────
// lessons              — master lesson definitions (per center or per student)
// lesson_items         — individual concept / exercise / songsheet within a lesson
// student_lesson_progress — per-student attempt + completion tracking per item

// ─── Lesson ───────────────────────────────────────────────────────────────────

export interface Lesson {
  id:           string;
  title:        string;
  lessonNumber: number;          // human-readable identifier
  order:        number;          // strict sequence (no skipping)
  centerId:     string | null;   // null if student-specific
  studentId:    string | null;   // null if center-wide
  createdAt:    Timestamp | string;
  updatedAt:    Timestamp | string;
}

export type CreateLessonInput = Omit<Lesson, "id" | "createdAt" | "updatedAt">;

// ─── Lesson Item ──────────────────────────────────────────────────────────────

export type LessonItemType = "concept" | "exercise" | "songsheet";

export interface LessonItem {
  id:          string;
  lessonId:    string;
  type:        LessonItemType;
  title:       string;
  maxAttempts: 5;                // fixed at 5 — never configurable
  order:       number;
  createdAt:   Timestamp | string;
  updatedAt:   Timestamp | string;
}

export type CreateLessonItemInput = Omit<LessonItem, "id" | "createdAt" | "updatedAt">;

// ─── Attempt ──────────────────────────────────────────────────────────────────

export type AttemptStatus = "attempted" | "completed";

export interface Attempt {
  attemptNo: number;             // 1–5
  date:      string;             // ISO date string
  status:    AttemptStatus;
  notes:     string | null;
  teacherId: string;             // UID of teacher who logged this attempt
}

// ─── Student Lesson Progress ──────────────────────────────────────────────────

export interface StudentLessonProgress {
  id:              string;       // deterministic: `${studentId}_${itemId}`
  studentId:       string;
  lessonId:        string;
  itemId:          string;
  attempts:        Attempt[];
  completed:       boolean;
  completionDate:  string | null;  // ISO date string
  teacherId:       string | null;  // last teacher who acted on this
  firstAttemptDate:string | null;  // ISO date string — for timeline
  totalAttempts:   number;         // denormalised count = attempts.length
  createdAt:       Timestamp | string;
  updatedAt:       Timestamp | string;
}

export type CreateProgressInput = Pick<
  StudentLessonProgress,
  "studentId" | "lessonId" | "itemId"
>;

// ─── Excel import row (raw, pre-validation) ───────────────────────────────────
// Required columns: lessonNumber, lessonName, itemType, itemTitle, order
// itemType must be one of: concept | exercise | songsheet

export interface ExcelImportRow {
  lessonNumber: number;
  lessonName:   string;
  itemType:     string;          // raw string before validation
  itemTitle:    string;
  order:        number;          // item order within lesson
}

// ─── Lesson progress summary ──────────────────────────────────────────────────

export interface LessonProgressSummary {
  totalLessons:       number;
  completedLessons:   number;
  inProgressLessons:  number;
  avgAttemptsPerItem: number;    // average across all items that have ≥1 attempt
}
