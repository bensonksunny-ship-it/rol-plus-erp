// =============================================================================
// The 9 offered courses (COURSES): Introduction to / Intermediate / Advanced ×
// Keyboard / Guitar / Drums. Older records are spelled "Intermediate to
// Keyboard" — normalizeCourse() reads them under today's names.
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

/**
 * Course title from level + instrument. Only Introduction takes "to":
 * "Introduction to Keyboard", "Intermediate Keyboard", "Advanced Keyboard".
 * Either part alone is returned as-is.
 */
export function formatCourse(level: string | null | undefined, instrument: string | null | undefined): string {
  const l = (level ?? "").trim(), i = (instrument ?? "").trim();
  if (!l || !i) return i || l;
  return l.toLowerCase() === "introduction" ? `${l} to ${i}` : `${l} ${i}`;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// ── The 9 offered courses (both wings) ───────────────────────────────────────
/** Instruments a course can be in — matches the syllabus instruments. */
export const COURSE_INSTRUMENTS = ["Keyboard", "Guitar", "Drums"] as const;
export type CourseInstrument = (typeof COURSE_INSTRUMENTS)[number];

export interface CourseOption { label: string; level: CourseLevel; instrument: CourseInstrument }

/** Introduction to Keyboard, Intermediate Keyboard, Advanced Keyboard, then Guitar, then Drums. */
export const COURSES: CourseOption[] = COURSE_INSTRUMENTS.flatMap(instrument =>
  COURSE_LEVELS.map(level => ({ label: formatCourse(level, instrument), level, instrument })));

const COURSE_RE = /^(introduction|intermediate|advanced)\s+(?:to\s+)?(.+)$/i;

/** Old or new spelling ("Intermediate to Drums" / "intermediate drums") → the listed course; null if not one of the 9. */
export function findCourse(course: unknown): CourseOption | null {
  const m = str(course).match(COURSE_RE);
  if (!m) return null;
  return COURSES.find(c => c.level.toLowerCase() === m[1].toLowerCase()
    && c.instrument.toLowerCase() === m[2].trim().toLowerCase()) ?? null;
}

/** A stored course title in today's spelling — "Intermediate to Keyboard" → "Intermediate Keyboard"; anything else as-is. */
export function normalizeCourse(course: unknown): string {
  return findCourse(course)?.label ?? str(course);
}

/** Course Level from a stored `courseLevel`, else parsed from a course title; "" when none. */
export function levelOfCourse(courseLevel: unknown, course: unknown): CourseLevel | "" {
  if (isCourseLevel(courseLevel)) return courseLevel;
  const m = str(course).match(COURSE_RE);
  return m ? COURSE_LEVELS.find(l => l.toLowerCase() === m[1].toLowerCase()) ?? "" : "";
}

/** The instrument part of a course title — "Intermediate Drums" / "Intermediate to Drums" → "Drums"; other text as-is. */
export function instrumentOfCourse(course: unknown): string {
  const c = str(course);
  const m = c.match(COURSE_RE);
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

/**
 * One finished course in a student's `completedCourses`. `completedOn` ("" = date unavailable) is the
 * staff-entered date (YYYY-MM-DD); `at` is when it was recorded.
 */
export interface CourseCompletion {
  course: string; level: string; completedOn: string; next: string | null;
  at: string; by: string; byName: string;
}

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
  if (str(d.course)) return normalizeCourse(d.course);
  const instruments = [
    ...(Array.isArray(d.instruments) ? d.instruments : []),
    ...(Array.isArray(d.instrumentsToLearn) ? d.instrumentsToLearn : []),
  ].map(str).filter(Boolean);
  const unique = [...new Set(instruments)];
  const single = unique.length === 1 ? unique[0] : str(d.instrument);
  if (str(d.courseLevel) && single) return formatCourse(str(d.courseLevel), single);
  return unique.join(", ") || str(d.instrument);
}

// ── Course progress (previous courses + the current one) ─────────────────────
// Picking Intermediate/Advanced asks whether the lower courses of that
// instrument were finished. Yes → they go into `completedCourses`; No → their
// labels are kept in `unfinishedCourses` until someone confirms them.

/** Lower courses of the same instrument — Advanced Drums → [Introduction to Drums, Intermediate Drums]. */
export function lowerCourses(c: CourseOption): CourseOption[] {
  const rank = COURSE_LEVELS.indexOf(c.level);
  return COURSES.filter(x => x.instrument === c.instrument && COURSE_LEVELS.indexOf(x.level) < rank);
}

/** Course labels (today's spelling) found in a `completedCourses` array. */
export function completedLabels(completed: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(completed)) for (const e of completed) {
    const label = normalizeCourse((e as { course?: unknown } | null)?.course);
    if (label) out.add(label);
  }
  return out;
}

/** Lower courses of `c` not yet recorded as completed — the ones to ask about. */
export function missingPrevCourses(c: CourseOption, completed: unknown): CourseOption[] {
  const done = completedLabels(completed);
  return lowerCourses(c).filter(x => !done.has(x.label));
}

export type CourseStepState = "completed" | "not_finished" | "unconfirmed" | "in_progress" | "graduated";
export interface CourseStep { label: string; state: CourseStepState }

/**
 * Status of each course on the student's path: lower courses (Completed / Not
 * finished / Not confirmed) then the current one (In progress, or Graduated
 * after the final course). [] when the course isn't one of the 9.
 */
export function courseProgress(course: unknown, completed: unknown, unfinished: unknown, graduated: boolean): CourseStep[] {
  const c = findCourse(course);
  if (!c) return [];
  const done = completedLabels(completed);
  const notDone = new Set(Array.isArray(unfinished) ? unfinished.map(normalizeCourse) : []);
  const steps: CourseStep[] = lowerCourses(c).map(x => ({
    label: x.label,
    state: done.has(x.label) ? "completed" : notDone.has(x.label) ? "not_finished" : "unconfirmed",
  }));
  steps.push({ label: c.label, state: graduated || done.has(c.label) ? "graduated" : "in_progress" });
  return steps;
}
