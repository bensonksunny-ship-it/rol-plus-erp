import {
  doc,
  getDocFromServer,
  updateDoc,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { User, StudentUser, TeacherUser } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchUser(uid: string): Promise<User> {
  const snap = await getDocFromServer(doc(db, "users", uid));
  if (!snap.exists()) throw new Error(`USER_NOT_FOUND: ${uid}`);
  return snap.data() as User;
}

async function assertCenterExists(centerId: string): Promise<void> {
  const snap = await getDocFromServer(doc(db, "centers", centerId));
  if (!snap.exists()) throw new Error(`CENTER_NOT_FOUND: ${centerId}`);
}

// ─── Student Assignment ───────────────────────────────────────────────────────

/**
 * Assign a student to a center.
 * A student can belong to ONLY ONE center.
 * Updates: users.centerId + centers.studentUids[]
 */
export async function assignStudentToCenter(
  studentId: string,
  centerId: string
): Promise<void> {
  const user = await fetchUser(studentId);
  await assertCenterExists(centerId);

  if (user.role !== "student") {
    throw new Error(`ROLE_MISMATCH: user ${studentId} is not a student`);
  }

  const student = user as StudentUser;
  if (student.centerId === centerId) {
    throw new Error(`ALREADY_ASSIGNED: student ${studentId} is already in center ${centerId}`);
  }
  if (student.centerId) {
    throw new Error(
      `STUDENT_HAS_CENTER: student ${studentId} already belongs to center ${student.centerId}. Remove first.`
    );
  }

  const userRef   = doc(db, "users",   studentId);
  const centerRef = doc(db, "centers", centerId);

  await updateDoc(userRef,   { centerId, updatedAt: new Date().toISOString() });
  await updateDoc(centerRef, { studentUids: arrayUnion(studentId), updatedAt: new Date().toISOString() });
}

/**
 * Remove a student from a center.
 * Updates: users.centerId → "" + centers.studentUids[] -= studentId
 */
export async function removeStudentFromCenter(
  studentId: string,
  centerId: string
): Promise<void> {
  const user = await fetchUser(studentId);
  await assertCenterExists(centerId);

  if (user.role !== "student") {
    throw new Error(`ROLE_MISMATCH: user ${studentId} is not a student`);
  }

  const student = user as StudentUser;
  if (student.centerId !== centerId) {
    throw new Error(`NOT_ASSIGNED: student ${studentId} is not assigned to center ${centerId}`);
  }

  const userRef   = doc(db, "users",   studentId);
  const centerRef = doc(db, "centers", centerId);

  await updateDoc(userRef,   { centerId: "", updatedAt: new Date().toISOString() });
  await updateDoc(centerRef, { studentUids: arrayRemove(studentId), updatedAt: new Date().toISOString() });
}

// ─── Teacher Assignment ───────────────────────────────────────────────────────

/**
 * Assign a teacher to a center.
 * A teacher can belong to multiple centers.
 * Updates: users.centerIds[] += centerId + centers.teacherUid (single teacher per center per schema)
 */
export async function assignTeacherToCenter(
  teacherId: string,
  centerId: string
): Promise<void> {
  const user = await fetchUser(teacherId);
  await assertCenterExists(centerId);

  if (user.role !== "teacher") {
    throw new Error(`ROLE_MISMATCH: user ${teacherId} is not a teacher`);
  }

  const teacher = user as TeacherUser;
  if (teacher.centerIds?.includes(centerId)) {
    throw new Error(`ALREADY_ASSIGNED: teacher ${teacherId} is already assigned to center ${centerId}`);
  }

  const userRef   = doc(db, "users",   teacherId);
  const centerRef = doc(db, "centers", centerId);

  await updateDoc(userRef,   { centerIds: arrayUnion(centerId), updatedAt: new Date().toISOString() });
  await updateDoc(centerRef, { teacherUid: teacherId,           updatedAt: new Date().toISOString() });
}

/**
 * Remove a teacher from a center.
 * Updates: users.centerIds[] -= centerId + centers.teacherUid → ""
 */
export async function removeTeacherFromCenter(
  teacherId: string,
  centerId: string
): Promise<void> {
  const user = await fetchUser(teacherId);
  await assertCenterExists(centerId);

  if (user.role !== "teacher") {
    throw new Error(`ROLE_MISMATCH: user ${teacherId} is not a teacher`);
  }

  const teacher = user as TeacherUser;
  if (!teacher.centerIds?.includes(centerId)) {
    throw new Error(`NOT_ASSIGNED: teacher ${teacherId} is not assigned to center ${centerId}`);
  }

  const userRef   = doc(db, "users",   teacherId);
  const centerRef = doc(db, "centers", centerId);

  await updateDoc(userRef,   { centerIds: arrayRemove(centerId), updatedAt: new Date().toISOString() });
  await updateDoc(centerRef, { teacherUid: "",                   updatedAt: new Date().toISOString() });
}
