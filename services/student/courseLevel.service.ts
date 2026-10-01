// Course Level progression (Introduction → Intermediate → Advanced).
// `courseLevel` is its own field; `course` stays the composite title
// ("Intermediate to Keyboard") that the Registry, centre rosters and student
// profile all read. Every change is appended to `levelHistory` and audited.

import { arrayUnion, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { formatCourse, type CourseLevel, type LevelHistoryEntry } from "@/lib/course";

export interface LevelChangeBy { uid: string; name: string; role: string }

/** Fields to write for a level change — merge into a larger user-doc patch, or use alone. */
export function levelChangePatch(from: string, to: CourseLevel, instrument: string, by: LevelChangeBy): Record<string, unknown> {
  const entry: LevelHistoryEntry = { from, to, at: new Date().toISOString(), by: by.uid, byName: by.name };
  return {
    courseLevel:  to,
    course:       formatCourse(to, instrument),
    levelHistory: arrayUnion(entry),
  };
}

/** Sets a student's Course Level (promotion or correction) and audits it. */
export async function setStudentCourseLevel(uid: string, from: string, to: CourseLevel, instrument: string, by: LevelChangeBy): Promise<void> {
  await updateDoc(doc(db, "users", uid), { ...levelChangePatch(from, to, instrument, by), updatedAt: serverTimestamp() });
  logLevelChange(uid, from, to, by);
}

export function logLevelChange(uid: string, from: string, to: string, by: LevelChangeBy): void {
  logAction({
    action: "COURSE_LEVEL_CHANGE",
    initiatorId: by.uid, initiatorRole: by.role as Parameters<typeof logAction>[0]["initiatorRole"],
    approverId: null, approverRole: null, reason: null,
    metadata: { uid, from: from || null, to },
  });
}
