// =============================================================================
// Monthly attendance matrix — one row per student, one column per class date.
// Shared by the History grid (page.tsx) and the CSV / PDF export (export.ts).
//
// A student's class days come from their batch, else their personal class days
// (ROL+ individual), else the centre's schedule. Extra-class dates count for
// everyone. Dates that aren't one of the student's class days show "–" and
// don't count.
// =============================================================================

import type { AttendanceStatus } from "@/services/attendance/attendance.service";
import type { CenterBatch } from "@/types";

export interface MatrixCentre {
  id:         string;
  name:       string;
  daysOfWeek: string[];
  batches:    CenterBatch[];
}

export interface MatrixStudent {
  uid:         string;
  name:        string;
  admissionNo: string;
  classType:   "group" | "personal";
  classDays:   string[];
  batchId:     string | null;
}

export interface MatrixRec { studentUid: string; date: string; status: AttendanceStatus }

/** "all" | "general" (no / unknown batch) | a batch id. */
export type BatchFilter = string;

export interface MatrixRow {
  student:   MatrixStudent;
  batchName: string;
  /** Per date column: a status, null = class day not marked, "off" = not this student's class day. */
  cells:     (AttendanceStatus | null | "off")[];
  total:     number;   // class days up to today, excluding Break / Cancelled / Not Assigned
  present:   number;
  absent:    number;
  pct:       number | null;
}

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dowOf = (iso: string) => DAY_ABBR[new Date(iso + "T00:00:00").getDay()];

export function datesInMonth(month: string): string[] {
  const [yr, mo] = month.split("-").map(Number);
  const days = new Date(yr, mo, 0).getDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function studentBatch(centre: MatrixCentre, st: MatrixStudent): CenterBatch | undefined {
  return st.batchId ? centre.batches.find(b => b.id === st.batchId) : undefined;
}

export function studentDays(centre: MatrixCentre, st: MatrixStudent): string[] {
  const b = studentBatch(centre, st);
  if (b && b.daysOfWeek.length) return b.daysOfWeek;
  if (st.classType === "personal" && st.classDays.length) return st.classDays;
  if (centre.daysOfWeek.length) return centre.daysOfWeek;
  return centre.batches[0]?.daysOfWeek ?? [];
}

export function matchesBatch(centre: MatrixCentre, st: MatrixStudent, filter: BatchFilter): boolean {
  if (filter === "all") return true;
  if (filter === "general") return !studentBatch(centre, st);
  return st.batchId === filter;
}

const NOT_COUNTED = new Set<AttendanceStatus>(["break", "cancelled_teacher", "cancelled_student"]);

export function buildMatrix(
  centre: MatrixCentre, students: MatrixStudent[], recs: MatrixRec[], extraDates: Set<string>,
  month: string, today: string, filter: BatchFilter,
): { dates: string[]; rows: MatrixRow[] } {
  const visible = students.filter(s => matchesBatch(centre, s, filter));
  const status = new Map<string, AttendanceStatus>();
  recs.forEach(r => status.set(`${r.studentUid}|${r.date}`, r.status));

  const all = datesInMonth(month);
  const daySets = new Map(visible.map(s => [s.uid, new Set(studentDays(centre, s))]));
  // Columns: every date that's a class day for someone shown, plus extra classes
  // and any date that already has a mark.
  const dates = all.filter(d =>
    extraDates.has(d)
    || visible.some(s => daySets.get(s.uid)!.has(dowOf(d)) || status.has(`${s.uid}|${d}`)));

  const rows = visible.map(st => {
    const days = daySets.get(st.uid)!;
    let total = 0, present = 0, absent = 0;
    const cells = dates.map(d => {
      const s = status.get(`${st.uid}|${d}`) ?? null;
      const isClassDay = extraDates.has(d) || days.has(dowOf(d));
      if (!s && !isClassDay) return "off" as const;
      if (s === "present") present++;
      else if (s === "absent") absent++;
      if (d <= today && !(s && NOT_COUNTED.has(s))) total++;
      return s;
    });
    return {
      student: st, batchName: studentBatch(centre, st)?.name ?? "General Batch",
      cells, total, present, absent,
      pct: present + absent > 0 ? Math.round(present / (present + absent) * 100) : null,
    };
  });
  return { dates, rows };
}
