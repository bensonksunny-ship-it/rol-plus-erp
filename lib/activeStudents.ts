// One definition of "currently active student", shared by every headcount KPI
// (Center Suite, Admin dashboard, Faculty Suite) and the centre rosters/cards.

import { normAdmNo } from "@/lib/dedup";

/** Active whether `status` carries the Students page vocabulary ("active") or the
 *  Registry's ("confirm" / "confirmed"). Pending inactivation / break requests
 *  still attend until approved. A missing status is NOT active (strict opt-in). */
export function isActiveStudentStatus(status: unknown): boolean {
  return /^(active|confirm|confirmed|deactivation_requested|break_requested)$/i.test(String(status ?? "").trim());
}

/** Admission number is a prerequisite for being counted as active. */
export function hasAdmissionNo(no: unknown): boolean {
  return typeof no === "string" && no.trim() !== "" && no.trim() !== "—" && no.trim() !== "-";
}

type StudentLike = Record<string, unknown>;

/** Raw user doc → is this student on an active roster right now? */
export function isCurrentlyActiveStudent(st: StudentLike, activeCenterIds?: Set<string>): boolean {
  if (st.status === "merged" || st.status === "deleted") return false;
  if (!isActiveStudentStatus(st.status ?? st.studentStatus)) return false;
  if (!hasAdmissionNo(st.admissionNo ?? st.admissionNumber)) return false;
  const cid = typeof st.centerId === "string" ? st.centerId : "";
  if (!cid) return false;
  return activeCenterIds ? activeCenterIds.has(cid) : true;
}

/** Ids of every currently active student record (duplicates included — use for lookups). */
export function activeStudentUids(students: (StudentLike & { uid?: string; id?: string })[], activeCenterIds?: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const st of students) {
    const id = typeof st.uid === "string" ? st.uid : typeof st.id === "string" ? st.id : "";
    if (id && isCurrentlyActiveStudent(st, activeCenterIds)) out.add(id);
  }
  return out;
}

/**
 * Headcount of currently active students: active status + admission number +
 * assigned to one of `activeCenterIds`. Duplicate records of one person (same
 * centre + admission no.) count once — same rule as the centre card badges.
 */
export function countActiveStudents(students: StudentLike[], activeCenterIds?: Set<string>): number {
  const seen = new Set<string>();
  for (const st of students) {
    if (!isCurrentlyActiveStudent(st, activeCenterIds)) continue;
    seen.add(`${st.centerId}|${normAdmNo(st.admissionNo ?? st.admissionNumber)}`);
  }
  return seen.size;
}
