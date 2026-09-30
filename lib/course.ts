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
