// =============================================================================
// Course title = Course Level + Instrument, e.g. "Introduction to Keyboard".
// Picked on the admission form (both wings); a Course Level allows exactly one
// instrument. Saved on the application and the student as `courseLevel` +
// `course`, so the Registry, centre rosters and My Classes all read `course`.
// =============================================================================

export const COURSE_LEVELS = ["Introduction", "Intermediate", "Advanced"] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];

export function isCourseLevel(v: unknown): v is CourseLevel {
  return typeof v === "string" && (COURSE_LEVELS as readonly string[]).includes(v);
}

/** "Introduction" + "Keyboard" → "Introduction to Keyboard"; either alone is returned as-is. */
export function formatCourse(level: string | null | undefined, instrument: string | null | undefined): string {
  const l = (level ?? "").trim(), i = (instrument ?? "").trim();
  return l && i ? `${l} to ${i}` : i || l;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Course Level from a stored `courseLevel`, else parsed from a course title; "" when none. */
export function levelOfCourse(courseLevel: unknown, course: unknown): CourseLevel | "" {
  if (isCourseLevel(courseLevel)) return courseLevel;
  const c = str(course).toLowerCase();
  return COURSE_LEVELS.find(l => c.startsWith(`${l.toLowerCase()} to `)) ?? "";
}

/** The instrument part of a course title — "Intermediate to Drums" → "Drums"; other text as-is. */
export function instrumentOfCourse(course: unknown): string {
  const c = str(course);
  const m = c.match(/^(introduction|intermediate|advanced)\s+to\s+(.+)$/i);
  return m ? m[2].trim() : c;
}

/** The level after `level` — Introduction → Intermediate → Advanced; null at the top. */
export function nextCourseLevel(level: string): CourseLevel | null {
  const i = (COURSE_LEVELS as readonly string[]).indexOf(level);
  if (i < 0) return COURSE_LEVELS[0];
  return i + 1 < COURSE_LEVELS.length ? COURSE_LEVELS[i + 1] : null;
}

/** One entry in a student's `levelHistory`. */
export interface LevelHistoryEntry { from: string; to: string; at: string; by: string; byName: string }

/** "Promoted to Intermediate on 30 Sep 2026" / "Level set to Introduction on …". */
export function levelHistoryText(h: LevelHistoryEntry): string {
  const rank = (l: string) => (COURSE_LEVELS as readonly string[]).indexOf(l);
  const verb = !h.from ? "Level set to" : rank(h.to) > rank(h.from) ? "Promoted to" : "Moved back to";
  const d = new Date(h.at);
  const when = isNaN(d.getTime()) ? "" : ` on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  return `${verb} ${h.to}${when}${h.byName ? ` · by ${h.byName}` : ""}`;
}

/**
 * The course label for a student / application doc: the stored `course`, else
 * built from `courseLevel` + the single instrument, else the instrument list.
 * Returns "" when nothing is known.
 */
export function courseLabel(d: Record<string, unknown> | null | undefined): string {
  if (!d) return "";
  if (str(d.course)) return str(d.course);
  const instruments = [
    ...(Array.isArray(d.instruments) ? d.instruments : []),
    ...(Array.isArray(d.instrumentsToLearn) ? d.instrumentsToLearn : []),
  ].map(str).filter(Boolean);
  const unique = [...new Set(instruments)];
  const single = unique.length === 1 ? unique[0] : str(d.instrument);
  if (str(d.courseLevel) && single) return formatCourse(str(d.courseLevel), single);
  return unique.join(", ") || str(d.instrument);
}
