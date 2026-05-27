import {
  doc,
  setDoc,
  getDoc,
  runTransaction,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type {
  LittleMozartsTrack,
  MasterSyllabusItem,
  StudentSyllabusItem,
  LMStudentSyllabus,
  LMSyllabusTarget,
} from "@/types/syllabus";
import { MASTER_TRACK_DATA, TRACK_UI_CONFIG } from "./lm-master.data";

const MASTER_COL = "master_syllabuses";
const STUDENT_COL = "student_syllabus";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function scoreToTrack(averageScore: number): LittleMozartsTrack {
  if (averageScore <= 2.5) return "delta_track";
  if (averageScore <= 4.0) return "epsilon_track";
  return "zeta_track";
}

// Path: master_syllabuses/{program}/tracks/{track}/courses/{course}
function masterRef(target: LMSyllabusTarget) {
  return doc(db, MASTER_COL, target.program, "tracks", target.track, "courses", target.course);
}

// ─── Master syllabus ──────────────────────────────────────────────────────────

export async function seedMasterSyllabus(
  target: LMSyllabusTarget,
  items?: MasterSyllabusItem[],
): Promise<void> {
  await setDoc(masterRef(target), {
    ...target,
    items: items ?? MASTER_TRACK_DATA[target.track],
  });
}

export async function getMasterSyllabus(
  target: LMSyllabusTarget,
): Promise<MasterSyllabusItem[]> {
  const snap = await getDoc(masterRef(target));
  if (!snap.exists()) return MASTER_TRACK_DATA[target.track];
  return (snap.data() as { items: MasterSyllabusItem[] }).items;
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
    syllabusType: "little_mozarts",
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
