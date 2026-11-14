// Course Level progression (Introduction → Intermediate → Advanced).
// `courseLevel` is its own field; `course` stays the composite title
// ("Intermediate to Keyboard") that the Registry, centre rosters and student
// profile all read. Every change is appended to `levelHistory` and audited.

import { arrayUnion, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { formatCourse, nextCourseLevel, type CourseCompletion, type CourseLevel, type LevelHistoryEntry } from "@/lib/course";

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
