import {
  collection,
  doc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { ScreeningResult } from "@/types";
import { initStudentSyllabus } from "@/services/syllabus/lm-syllabus.service";

export async function saveScreening(
  data: Omit<ScreeningResult, "id">,
): Promise<string> {
  const ref  = doc(collection(db, "screenings"));
  const full: ScreeningResult = { ...data, id: ref.id };
  await setDoc(ref, full);
  if (data.studentId) {
    await updateDoc(doc(db, "users", data.studentId), {
      screening: full,
      updatedAt: new Date().toISOString(),
    });
    if (data.screeningType === "little-mozarts") {
      await initStudentSyllabus(data.studentId, data.averageScore);
    }
  }
  return ref.id;
}

export async function getScreeningByStudent(
  studentId: string,
): Promise<ScreeningResult | null> {
  const snap = await getDocs(
    query(collection(db, "screenings"), where("studentId", "==", studentId)),
  );
  if (snap.empty) return null;
  const list = snap.docs.map(d => d.data() as ScreeningResult);
  list.sort((a, b) => b.screenedAt.localeCompare(a.screenedAt));
  return list[0];
}

export async function getAllScreenings(): Promise<ScreeningResult[]> {
  const snap = await getDocs(collection(db, "screenings"));
  return snap.docs
    .map(d => d.data() as ScreeningResult)
    .sort((a, b) => b.screenedAt.localeCompare(a.screenedAt));
}
