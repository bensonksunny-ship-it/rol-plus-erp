import type { Timestamp } from "firebase/firestore";

// ─── Class ────────────────────────────────────────────────────────────────────

export type ClassStatus = "scheduled" | "completed" | "ghost";

export interface Class {
  id:              string;
  centerId:        string;
  date:            string;          // ISO date string e.g. "2026-03-27"
  startTime:       string;          // e.g. "17:00"
  endTime:         string;          // e.g. "18:30"
  teacherUid:      string;
  teacherClockIn:  string | null;   // ISO timestamp — null until teacher clocks in
  status:          ClassStatus;
  createdAt:       Timestamp | string;
  updatedAt:       Timestamp | string;
}

export type CreateClassInput = Omit<Class, "id" | "teacherClockIn" | "status" | "createdAt" | "updatedAt">;

// ─── Attendance Record ────────────────────────────────────────────────────────

export type AttendanceMethod = "qr" | "manual";
export type AttendanceStatus = "present" | "absent";

export interface AttendanceRecord {
  id:         string;
  classId:    string;
  studentUid: string;
  centerId:   string;
  markedAt:   string;               // ISO timestamp
  method:     AttendanceMethod;
  status:     AttendanceStatus;
  createdAt:  Timestamp | string;
}

export type MarkAttendanceInput = Omit<AttendanceRecord, "id" | "createdAt">;
