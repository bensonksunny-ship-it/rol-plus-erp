import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  runTransaction,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type {
  LittleMozartsTrack,
  MasterSyllabusItem,
  StudentSyllabusItem,
  LMStudentSyllabus,
  LMSyllabusTarget,
  LMCourse,
} from "@/types/syllabus";
import { MASTER_COURSE_DATA, TRACK_UI_CONFIG, TRACK_PROGRESSION, getNextCourseTarget } from "./lm-master.data";

const MASTER_COL = "master_syllabuses";
const STUDENT_COL = "student_syllabus";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function scoreToTrack(averageScore: number): LittleMozartsTrack {
  if (averageScore <= 2.5) return "delta_track";
  if (averageScore <= 4.0) return "epsilon_track";
  return "zeta_track";
}

// Path: master_syllabuses/{program}/tracks/{track}/courses/{course}
// Bridge courses use track="bridge" → shared namespace, not tied to a single student track
function masterRef(target: LMSyllabusTarget) {
  return doc(db, MASTER_COL, target.program, "tracks", target.track, "courses", target.course);
}

function getMasterFallback(target: LMSyllabusTarget): MasterSyllabusItem[] {
  if (target.track === "bridge" || target.track === "standard") return [];
  return MASTER_COURSE_DATA[target.track as LittleMozartsTrack]?.[target.course] ?? [];
}

// ─── Master syllabus ──────────────────────────────────────────────────────────

export async function seedMasterSyllabus(
  target: LMSyllabusTarget,
  items?: MasterSyllabusItem[],
): Promise<void> {
  await setDoc(masterRef(target), {
    ...target,
    items: items ?? getMasterFallback(target),
  });
}

export async function getMasterSyllabus(
  target: LMSyllabusTarget,
): Promise<MasterSyllabusItem[]> {
  const snap = await getDoc(masterRef(target));
  if (!snap.exists()) return getMasterFallback(target);
  return (snap.data() as { items: MasterSyllabusItem[] }).items;
}

export async function getMasterSyllabusWithMeta(
  target: LMSyllabusTarget,
): Promise<{ exists: boolean; items: MasterSyllabusItem[] }> {
  const snap = await getDoc(masterRef(target));
  if (!snap.exists()) return { exists: false, items: getMasterFallback(target) };
  return { exists: true, items: (snap.data() as { items: MasterSyllabusItem[] }).items };
}

export async function deleteMasterSyllabus(target: LMSyllabusTarget): Promise<void> {
  await deleteDoc(masterRef(target));
}

// ─── Student syllabus ─────────────────────────────────────────────────────────

export async function initStudentSyllabus(
  studentId: string,
  averageScore: number,
): Promise<void> {
  const track = scoreToTrack(averageScore);

  // Default to course_1_1 on initial enrolment
  const target: LMSyllabusTarget = {
    program: "intro_keyboard",
    track,
    course:  "course_1_1",
  };

  const masterItems = await getMasterSyllabus(target);

  const items: StudentSyllabusItem[] = masterItems.map(item => ({
    ...item,
    completed:   false,
    completedAt: null,
  }));

  const now = new Date().toISOString();
  const syllabus: LMStudentSyllabus = {
    studentId,
    track,
    syllabusType:  "little_mozarts",
    currentCourse: "course_1_1",
    items,
    uiConfig:  TRACK_UI_CONFIG[track],
    createdAt: now,
    updatedAt: now,
  };

  await setDoc(doc(db, STUDENT_COL, studentId), syllabus);
}

export async function getStudentSyllabus(studentId: string): Promise<LMStudentSyllabus | null> {
  const snap = await getDoc(doc(db, STUDENT_COL, studentId));
  if (!snap.exists()) return null;
  const data = snap.data() as LMStudentSyllabus;
  if (data.syllabusType !== "little_mozarts") return null;
  return data;
}

export async function updateStudentSyllabusItems(
  studentId: string,
  items: StudentSyllabusItem[],
  updatedBy: string,
): Promise<void> {
  const ref = doc(db, STUDENT_COL, studentId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error(`LM_SYLLABUS_NOT_FOUND: ${studentId}`);
    tx.update(ref, { items, updatedAt: new Date().toISOString(), lastMarkedBy: updatedBy });
  });
}

// Advance a student to the next course in their track's pathway.
// Loads the next course's master items, replaces the student's items array,
// and updates currentCourse — all in a single transaction.
export async function advanceStudentCourse(
  studentId: string,
  updatedBy:  string,
): Promise<{ advanced: true; nextCourse: LMCourse } | { advanced: false; reason: string }> {
  const ref = doc(db, STUDENT_COL, studentId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { advanced: false, reason: "Student syllabus not found." };

    const data         = snap.data() as LMStudentSyllabus;
    const nextTarget   = getNextCourseTarget(data.track, data.currentCourse);
    if (!nextTarget)   return { advanced: false, reason: "Already at final course." };

    // Load master items for next course outside the transaction isn't possible,
    // so we use getDoc directly — acceptable since master docs change rarely.
    const masterSnap = await getDoc(
      doc(db, "master_syllabuses", nextTarget.program, "tracks", nextTarget.track, "courses", nextTarget.course)
    );
    const masterItems: MasterSyllabusItem[] = masterSnap.exists()
      ? (masterSnap.data() as { items: MasterSyllabusItem[] }).items
      : getMasterFallback(nextTarget);

    const newItems: StudentSyllabusItem[] = masterItems.map(item => ({
      ...item,
      completed:   false,
      completedAt: null,
    }));

    tx.update(ref, {
      currentCourse: nextTarget.course,
      items:         newItems,
      updatedAt:     new Date().toISOString(),
      lastMarkedBy:  updatedBy,
    });

    return { advanced: true, nextCourse: nextTarget.course };
  });
}

export async function toggleItemProgress(
  studentId: string,
  itemIndex: number,
  completed: boolean,
  teacherId: string,
): Promise<void> {
  const ref = doc(db, STUDENT_COL, studentId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error(`LM_SYLLABUS_NOT_FOUND: ${studentId}`);
    const data = snap.data() as LMStudentSyllabus;
    if (itemIndex < 0 || itemIndex >= data.items.length) {
      throw new Error(`ITEM_INDEX_OUT_OF_RANGE: ${itemIndex}`);
    }
    const items = data.items.map((item, i) =>
      i === itemIndex
        ? { ...item, completed, completedAt: completed ? new Date().toISOString() : null }
        : item
    );
    tx.update(ref, {
      items,
      updatedAt:    new Date().toISOString(),
      lastMarkedBy: teacherId,
    });
  });
}
