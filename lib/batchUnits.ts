// =============================================================================
// Centre + Batch "units" — the operational unit for class cards (Attendance,
// My Classes, Enrollments centre list).
//
// A centre with 2+ batches is split into one unit per batch (its own name, days,
// time and teacher — batch teacher, else the centre teacher). Students belong to
// the unit of their batchId; any without a valid batch go to a "No batch" unit
// (only when there are such students), so nobody disappears. A centre with one
// batch or none stays a single unit covering all its students.
// =============================================================================

import type { CenterBatch } from "@/types";

export interface UnitCentre {
  id:          string;
  name:        string;
  teacherUid?: string | null;
  daysOfWeek?: string[];
  batches?:    CenterBatch[];
  timeSlot?:   string | null;
}

export interface BatchUnit<S> {
  /** `${centreId}` for an unsplit centre, `${centreId}|${batchId|"none"}` for a batch unit. */
  key:        string;
  centreId:   string;
  centreName: string;
  /** null = the whole centre (unsplit) or the "No batch" leftovers. */
  batchId:    string | null;
  /** "" for an unsplit centre with no batches. */
  batchName:  string;
  split:      boolean;
  teacherUid: string;
  days:       string[];
  time:       string;
  students:   S[];
}

export const NO_BATCH = "none";

const dayKey = (d: string) => String(d).trim().slice(0, 3).toLowerCase();

/** Does `days` include the weekday of `isoDate` ("Mon", "monday", "MON" all fine)? */
export function meetsOn(days: string[], isoDate: string): boolean {
  const k = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(isoDate + "T00:00:00").getDay()];
  return days.some(d => dayKey(d) === k);
}

export function isSplitCentre(c: UnitCentre): boolean {
  return (c.batches?.length ?? 0) >= 2;
}

export function centreUnits<S extends { batchId?: string | null }>(c: UnitCentre, students: S[]): BatchUnit<S>[] {
  const batches = c.batches ?? [];
  const centreTeacher = c.teacherUid ?? "";
  if (batches.length < 2) {
    const b = batches[0];
    return [{
      key: c.id, centreId: c.id, centreName: c.name, batchId: b?.id ?? null, batchName: b?.name ?? "", split: false,
      teacherUid: b?.teacherUid || centreTeacher,
      days: b?.daysOfWeek?.length ? b.daysOfWeek : (c.daysOfWeek ?? []),
      time: b?.startTime && b?.endTime ? `${b.startTime}–${b.endTime}` : (c.timeSlot ?? ""),
      students,
    }];
  }
  const ids = new Set(batches.map(b => b.id));
  const units: BatchUnit<S>[] = batches.map(b => ({
    key: `${c.id}|${b.id}`, centreId: c.id, centreName: c.name, batchId: b.id, batchName: b.name, split: true,
    teacherUid: b.teacherUid || centreTeacher,
    days: b.daysOfWeek ?? [],
    time: b.startTime && b.endTime ? `${b.startTime}–${b.endTime}` : "",
    students: students.filter(s => s.batchId === b.id),
  }));
  const leftovers = students.filter(s => !s.batchId || !ids.has(s.batchId));
  if (leftovers.length > 0) {
    units.push({
      key: `${c.id}|${NO_BATCH}`, centreId: c.id, centreName: c.name, batchId: null, batchName: "No batch", split: true,
      teacherUid: centreTeacher, days: c.daysOfWeek ?? [], time: c.timeSlot ?? "", students: leftovers,
    });
  }
  return units;
}

/** "Centre" or "Centre — Batch" for headers. */
export const unitTitle = (u: { centreName: string; batchName: string; split: boolean }) =>
  u.split ? `${u.centreName} — ${u.batchName}` : u.centreName;

/** The unit key a student belongs to (matches centreUnits keys). */
export function studentUnitKey(c: UnitCentre, batchId: string | null | undefined): string {
  if (!isSplitCentre(c)) return c.id;
  return (c.batches ?? []).some(b => b.id === batchId) ? `${c.id}|${batchId}` : `${c.id}|${NO_BATCH}`;
}

/** "Centre" or "Centre — Batch" for a student's unit. */
export function studentUnitLabel(c: UnitCentre, batchId: string | null | undefined): string {
  if (!isSplitCentre(c)) return c.name;
  const b = (c.batches ?? []).find(x => x.id === batchId);
  return `${c.name} — ${b ? b.name : "No batch"}`;
}

/** Every unit of a list of centres, without students (for tabs, filters, counts). */
export function allUnits(centres: UnitCentre[]): BatchUnit<never>[] {
  return centres.flatMap(c => centreUnits(c, [] as never[]));
}
