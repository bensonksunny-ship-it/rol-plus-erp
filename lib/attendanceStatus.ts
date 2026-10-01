// =============================================================================
// Has a class's attendance been taken? One rule for every "Marked / Partly
// marked / Pending" badge.
//
//   expected = the centre's currently active students (lib/activeStudents —
//              "active" or the Registry's "confirm", with an admission no.)
//   marked   = those active students with ANY saved status for the date
//              (present, absent, break, cancelled, not assigned all count)
// Records for students who aren't on the active roster (inactive, merged
// copies, another centre) are ignored, and a student is counted once.
// =============================================================================

export type ClassMarkState = "none" | "partial" | "complete";

export function classMarkState(
  records: { studentUid: string; status?: string | null }[],
  activeUids: Set<string>,
): { state: ClassMarkState; marked: number; expected: number } {
  const marked = new Set<string>();
  let anyRecord = false;
  for (const r of records) {
    if (!r.status) continue;
    anyRecord = true;
    if (activeUids.has(r.studentUid)) marked.add(r.studentUid);
  }
  const expected = activeUids.size;
  if (!anyRecord) return { state: "none", marked: 0, expected };
  // Attendance was taken but nobody is on the active roster (e.g. roster not
  // set up yet) — nothing left to mark, so don't show it as half done.
  if (expected === 0) return { state: "complete", marked: 0, expected };
  if (marked.size === 0) return { state: "none", marked: 0, expected };
  return { state: marked.size >= expected ? "complete" : "partial", marked: marked.size, expected };
}
