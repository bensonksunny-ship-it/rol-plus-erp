import type { Timestamp } from "firebase/firestore";

export interface SyllabusUnit {
  id:             string;
  title:          string;
  level:          string;          // e.g. "Beginner", "Intermediate", "Advanced"
  order:          number;          // strict sequence — no skipping
  prerequisiteId: string | null;   // id of required prior unit, null if first
  createdAt:      Timestamp | string;
  updatedAt:      Timestamp | string;
}

export type CreateSyllabusUnitInput = Omit<SyllabusUnit, "id" | "createdAt" | "updatedAt">;

// ─── Student Progress ─────────────────────────────────────────────────────────

export type ProgressStatus = "not_started" | "in_progress" | "completed";

export interface StudentProgress {
  id:             string;
  studentUid:     string;
  unitId:         string;
  status:         ProgressStatus;
  completionDate: string | null;   // ISO date string
  teacherSignOff: string | null;   // UID of teacher who signed off
  feedback:       string | null;
  overrideBy:     string | null;   // UID of admin who applied override (null if normal flow)
  createdAt:      Timestamp | string;
  updatedAt:      Timestamp | string;
}
