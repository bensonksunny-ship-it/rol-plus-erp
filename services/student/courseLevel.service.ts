// Course Level progression (Introduction → Intermediate → Advanced).
// `courseLevel` is its own field; `course` stays the composite title
// ("Intermediate to Keyboard") that the Registry, centre rosters and student
// profile all read. Every change is appended to `levelHistory` and audited.

import { arrayRemove, arrayUnion, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { findCourse, formatCourse, missingPrevCourses, nextCourseLevel, type CourseCompletion, type CourseLevel, type CourseOption, type LevelHistoryEntry } from "@/lib/course";

/** Staff answer to "Has the student finished the previous course(s)?" */
export interface PrevCoursesAnswer { finished: boolean; completedOn: string }

/** `completedCourses` entries for previous courses confirmed as finished. */
function prevCompletionEntries(labels: string[], completedOn: string, by: LevelChangeBy): CourseCompletion[] {
  const at = new Date().toISOString();
  return labels.map(label => {
    const c = findCourse(label);
    const next = c ? nextCourseLevel(c.level) : null;
    return {
      course: label, level: c?.level ?? "", completedOn,
      next: c && next ? formatCourse(next, c.instrument) : null,
      at, by: by.uid, byName: by.name,
    };
  });
}

/**
 * Fields for the previous courses of `course`: none missing → clear
 * `unfinishedCourses`; Yes → record them in `completedCourses`; No → list
 * them in `unfinishedCourses` ("Not finished" until someone confirms).
 * Merge into the student write. Both wings.
 */
export function prevCoursesPatch(course: CourseOption, completed: unknown, answer: PrevCoursesAnswer | null, by: LevelChangeBy): Record<string, unknown> {
  const missing = missingPrevCourses(course, completed).map(c => c.label);
  if (!missing.length || !answer) return { unfinishedCourses: [] };
  if (!answer.finished) return { unfinishedCourses: missing };
  return {
    completedCourses: arrayUnion(...prevCompletionEntries(missing, answer.completedOn, by)),
    unfinishedCourses: [],
  };
}

/** A "Not finished" previous course is later confirmed as finished. */
export async function confirmPreviousCourses(uid: string, labels: string[], completedOn: string, by: LevelChangeBy): Promise<void> {
  if (!labels.length) return;
  await updateDoc(doc(db, "users", uid), {
    completedCourses: arrayUnion(...prevCompletionEntries(labels, completedOn, by)),
    // Only these courses — any other "Not finished" course stays as it is.
    unfinishedCourses: arrayRemove(...labels),
    updatedAt: serverTimestamp(),
  });
  logAction({
    action: "PREVIOUS_COURSES_CONFIRMED",
    initiatorId: by.uid, initiatorRole: by.role as Parameters<typeof logAction>[0]["initiatorRole"],
    approverId: null, approverRole: null, reason: null,
    metadata: { uid, courses: labels, completedOn },
  });
}

export interface LevelChangeBy { uid: string; name: string; role: string }

/** Fields to write for a level change — merge into a larger user-doc patch, or use alone. */
export function levelChangePatch(from: string, to: CourseLevel, instrument: string, by: LevelChangeBy): Record<string, unknown> {
  const entry: LevelHistoryEntry = { from, to, at: new Date().toISOString(), by: by.uid, byName: by.name };
  return {
    courseLevel:  to,
    course:       formatCourse(to, instrument),
    levelHistory: arrayUnion(entry),
    // Moving to a level (promotion or correction) means the student is studying again.
    graduated:    false,
  };
}

/** Sets a student's Course Level (promotion or correction) and audits it. */
export async function setStudentCourseLevel(uid: string, from: string, to: CourseLevel, instrument: string, by: LevelChangeBy): Promise<void> {
  await updateDoc(doc(db, "users", uid), { ...levelChangePatch(from, to, instrument, by), updatedAt: serverTimestamp() });
  logLevelChange(uid, from, to, by);
}

/**
 * Picks one of the 9 listed courses for a student (course dropdowns on the
 * Registry, Students page and profile). Writes `course` + `courseLevel` +
 * `instrument`; a level change also goes into `levelHistory`. When the student
 * has a Wing 2 syllabus slot, the slot follows the course. Both wings.
 */
export async function setStudentCourse(args: {
  uid: string; course: CourseOption; prevLevel: string; prevCourse: string;
  hasSyllabusSlot: boolean; by: LevelChangeBy;
  /** Raw `completedCourses` + the answer about previous courses (null when none were missing). */
  completed: unknown; prevAnswer: PrevCoursesAnswer | null;
}): Promise<void> {
  const { uid, course, prevLevel, prevCourse, hasSyllabusSlot, by, completed, prevAnswer } = args;
  const levelChanged = prevLevel !== course.level;
  const patch: Record<string, unknown> = {
    ...(levelChanged ? levelChangePatch(prevLevel, course.level, course.instrument, by) : {}),
    course:      course.label,
    courseLevel: course.level,
    instrument:  course.instrument,
    ...prevCoursesPatch(course, completed, prevAnswer, by),
    updatedAt:   serverTimestamp(),
  };
  if (hasSyllabusSlot) {
    patch.syllabusLevel      = course.level.toLowerCase();
    patch.syllabusInstrument = course.instrument.toLowerCase();
  }
  await updateDoc(doc(db, "users", uid), patch);
  logAction({
    action: "COURSE_CHANGE",
    initiatorId: by.uid, initiatorRole: by.role as Parameters<typeof logAction>[0]["initiatorRole"],
    approverId: null, approverRole: null, reason: null,
    metadata: { uid, from: prevCourse || null, to: course.label },
  });
  if (levelChanged) logLevelChange(uid, prevLevel, course.level, by);
}

/**
 * "Mark Course Complete": records the finished course (with the staff-entered
 * completion date) in `completedCourses`, then advances to the next level of
 * the same instrument — `courseLevel`, `course`, `levelHistory`, and the Wing 2
 * syllabus slot (`syllabusLevel`) when the student has one. At the final level
 * (Advanced) there's nothing to advance to: the student is marked `graduated`
 * and stays Active. Both wings.
 */
export async function completeStudentCourse(args: {
  uid: string; level: CourseLevel; course: string; instrument: string;
  completedOn: string; hasSyllabusSlot: boolean; by: LevelChangeBy;
}): Promise<{ next: CourseLevel | null }> {
  const { uid, level, course, instrument, completedOn, hasSyllabusSlot, by } = args;
  const next = nextCourseLevel(level);
  const entry: CourseCompletion = {
    course: course || formatCourse(level, instrument), level, completedOn,
    next: next ? formatCourse(next, instrument) : null,
    at: new Date().toISOString(), by: by.uid, byName: by.name,
  };
  const patch: Record<string, unknown> = {
    completedCourses: arrayUnion(entry),
    lastCourseCompletedOn: completedOn,
    updatedAt: serverTimestamp(),
  };
  if (next) {
    Object.assign(patch, levelChangePatch(level, next, instrument, by));
    if (hasSyllabusSlot) patch.syllabusLevel = next.toLowerCase();
  } else {
    Object.assign(patch, { graduated: true, graduatedOn: completedOn });
  }
  await updateDoc(doc(db, "users", uid), patch);
  logAction({
    action: "COURSE_COMPLETED",
    initiatorId: by.uid, initiatorRole: by.role as Parameters<typeof logAction>[0]["initiatorRole"],
    approverId: null, approverRole: null, reason: null,
    metadata: { uid, course: entry.course, completedOn, next: entry.next },
  });
  if (next) logLevelChange(uid, level, next, by);
  return { next };
}

export function logLevelChange(uid: string, from: string, to: string, by: LevelChangeBy): void {
  logAction({
    action: "COURSE_LEVEL_CHANGE",
    initiatorId: by.uid, initiatorRole: by.role as Parameters<typeof logAction>[0]["initiatorRole"],
    approverId: null, approverRole: null, reason: null,
    metadata: { uid, from: from || null, to },
  });
}
