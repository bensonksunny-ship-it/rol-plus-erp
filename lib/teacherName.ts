/**
 * Teacher naming. `displayName` on a user doc has always held the official
 * full name (admin records, logins, the Users page). A teacher can also carry
 * an optional `preferredName` alias ("Adithya M") — that is what every
 * teacher-facing label across the app shows, falling back to the official name.
 */

// Any teacher-ish object: a TeacherUser or a raw Firestore doc's data().
type TeacherNameSource = {
  preferredName?: unknown;
  displayName?: unknown;
  fullName?: unknown;
  name?: unknown;
} | Record<string, unknown> | null | undefined;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Official full name — for administrative records only. */
export function getTeacherOfficialName(t: TeacherNameSource): string {
  return str(t?.displayName) || str(t?.fullName) || str(t?.name);
}

/** Name to show across the app: preferred alias, else the official name. */
export function getTeacherDisplayName(t: TeacherNameSource): string {
  return str(t?.preferredName) || getTeacherOfficialName(t);
}

/** The official name when it differs from what's displayed — for subtle metadata subtext. */
export function getTeacherOfficialSubtext(t: TeacherNameSource): string {
  const official = getTeacherOfficialName(t);
  return official && official !== getTeacherDisplayName(t) ? official : "";
}
