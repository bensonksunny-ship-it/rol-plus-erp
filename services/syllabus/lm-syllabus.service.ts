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
} from "@/types/syllabus";
import { MASTER_TRACK_DATA, TRACK_UI_CONFIG } from "./lm-master.data";

const MASTER_COL = "master_syllabuses";
const STUDENT_COL = "student_syllabus";

export function scoreToTrack(averageScore: number): LittleMozartsTrack {
  if (averageScore <= 2.5) return "delta_track";
  if (averageScore <= 4.0) return "epsilon_track";
  return "zeta_track";
}

export async function seedMasterSyllabus(
  track: LittleMozartsTrack,
  items?: MasterSyllabusItem[],
): Promise<void> {
  await setDoc(doc(db, MASTER_COL, track), {
    track,
    items: items ?? MASTER_TRACK_DATA[track],
  });
}

export async function getMasterSyllabus(track: LittleMozartsTrack): Promise<MasterSyllabusItem[]> {
  const snap = await getDoc(doc(db, MASTER_COL, track));
  if (!snap.exists()) return MASTER_TRACK_DATA[track];
  return (snap.data() as { items: MasterSyllabusItem[] }).items;
}

export async function initStudentSyllabus(
  studentId: string,
  averageScore: number,
): Promise<void> {
  const track = scoreToTrack(averageScore);
  const masterItems = await getMasterSyllabus(track);

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
      updatedAt: new Date().toISOString(),
      lastMarkedBy: teacherId,
    });
  });
}
