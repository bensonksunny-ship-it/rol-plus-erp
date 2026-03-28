import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDocs,
  getDocFromServer,
  orderBy,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  increment,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type { User } from "@/types";
import type {
  SyllabusUnit,
  CreateSyllabusUnitInput,
  StudentProgress,
  StudentSyllabus,
  ProgressStatus,
} from "@/types/syllabus";

const STUDENT_PROGRESS  = "student_progress";
const SYLLABUS_MASTER   = "syllabus_master";
const STUDENT_SYLLABUS  = "student_syllabus";

/**
 * Create a syllabus unit.
 * Validates: prerequisiteId references an existing unit (if provided).
 */
export async function createUnit(data: CreateSyllabusUnitInput): Promise<SyllabusUnit> {
  // Validate prerequisite exists if provided
  if (data.prerequisiteId) {
    const prereqSnap = await getDocFromServer(doc(db, SYLLABUS_MASTER, data.prerequisiteId));
    if (!prereqSnap.exists()) {
      throw new Error(`PREREQUISITE_NOT_FOUND: unit ${data.prerequisiteId} does not exist`);
    }
  }

  const ref = await addDoc(collection(db, SYLLABUS_MASTER), {
    title:          data.title,
    level:          data.level,
    order:          data.order,
    prerequisiteId: data.prerequisiteId ?? null,
    concepts:       data.concepts       ?? [],
    exercises:      data.exercises      ?? [],
    createdAt:      serverTimestamp(),
    updatedAt:      serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) throw new Error("UNIT_CREATE_FAILED: document not found after write");

  return { id: snap.id, ...snap.data() } as SyllabusUnit;
}

/**
 * Get all syllabus units ordered by `order` ascending.
 */
export async function getUnits(): Promise<SyllabusUnit[]> {
  const q    = query(collection(db, SYLLABUS_MASTER), orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({
    id:        d.id,
    concepts:  [],
    exercises: [],
    ...d.data(),
  }) as unknown as SyllabusUnit);
}

// ─── Student Progress ─────────────────────────────────────────────────────────

/**
 * Update student progress for a syllabus unit.
 * Validates:
 *   - unit exists
 *   - student exists and has role "student"
 *   - order enforced: prerequisite unit must be completed first (unless admin override)
 * Admin override: pass overrideBy (admin UID) to skip order check.
 *
 * DO NOT MODIFY THIS FUNCTION — existing logic is preserved exactly.
 */
export async function updateProgress(
  studentUid: string,
  unitId:     string,
  options: {
    status:         ProgressStatus;
    teacherSignOff: string | null;
    feedback:       string | null;
    overrideBy:     string | null;   // admin UID — skips order check if provided
  }
): Promise<StudentProgress> {
  // Validate student
  const studentSnap = await getDocFromServer(doc(db, "users", studentUid));
  if (!studentSnap.exists()) throw new Error(`USER_NOT_FOUND: ${studentUid}`);
  const student = studentSnap.data() as User;
  if (student.role !== "student") throw new Error(`ROLE_MISMATCH: ${studentUid} is not a student`);

  // Validate unit exists
  const unitSnap = await getDocFromServer(doc(db, SYLLABUS_MASTER, unitId));
  if (!unitSnap.exists()) throw new Error(`UNIT_NOT_FOUND: ${unitId}`);
  const unit = unitSnap.data() as SyllabusUnit;

  // Enforce prerequisite order unless admin override
  if (!options.overrideBy && unit.prerequisiteId) {
    const prereqProgressSnap = await getDocs(
      query(
        collection(db, STUDENT_PROGRESS),
        where("studentUid", "==", studentUid),
        where("unitId",     "==", unit.prerequisiteId),
        where("status",     "==", "completed")
      )
    );
    if (prereqProgressSnap.empty) {
      throw new Error(
        `ORDER_VIOLATION: student ${studentUid} has not completed prerequisite unit ${unit.prerequisiteId}`
      );
    }
  }

  // Upsert progress record (studentUid + unitId is the unique key)
  const progressId  = `${studentUid}_${unitId}`;
  const progressRef = doc(db, STUDENT_PROGRESS, progressId);

  // Gamification: award +100 points when a unit is completed (only on first completion)
  const existingSnap = await getDocFromServer(progressRef).catch(() => null);
  const wasCompleted = existingSnap?.exists()
    ? existingSnap.data().status === "completed"
    : false;
  const awardUnitPoints = options.status === "completed" && !wasCompleted;

  const now = new Date().toISOString();
  await setDoc(progressRef, {
    studentUid:     studentUid,
    unitId:         unitId,
    status:         options.status,
    completionDate: options.status === "completed" ? now : null,
    teacherSignOff: options.teacherSignOff,
    feedback:       options.feedback,
    overrideBy:     options.overrideBy,
    ...(awardUnitPoints ? { points: increment(100) } : {}),
    updatedAt:      serverTimestamp(),
    createdAt:      serverTimestamp(),
  }, { merge: true });

  const snap = await getDocFromServer(progressRef);
  if (!snap.exists()) throw new Error("PROGRESS_WRITE_FAILED: document not found after write");

  logAction({
    action:        options.overrideBy ? "SYLLABUS_PROGRESS_OVERRIDE" : "SYLLABUS_PROGRESS_UPDATED",
    initiatorId:   options.teacherSignOff ?? studentUid,
    initiatorRole: options.teacherSignOff ? "teacher" : "student",
    approverId:    options.overrideBy ?? null,
    approverRole:  options.overrideBy ? "admin" : null,
    reason:        options.overrideBy ? "admin_override" : null,
    metadata:      {
      studentUid,
      unitId,
      status:       options.status,
      feedback:     options.feedback,
    },
  });

  return { id: snap.id, ...snap.data() } as StudentProgress;
}

// ─── Student Syllabus Assignment ──────────────────────────────────────────────

/**
 * Assign (or replace) a list of unit IDs to a student.
 * Doc ID === studentUid (1:1 relationship).
 */
export async function assignSyllabus(
  studentUid:    string,
  unitIds:       string[],
  initiatorId?:  string,
  initiatorRole?: import("@/types").Role,
): Promise<void> {
  await setDoc(
    doc(db, STUDENT_SYLLABUS, studentUid),
    {
      studentUid,
      unitIds,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );

  logAction({
    action:        "SYLLABUS_ASSIGNED",
    initiatorId:   initiatorId ?? "system",
    initiatorRole: initiatorRole ?? "admin",
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { studentUid, unitIds },
  });
}

/**
 * Get the syllabus assignment for a student.
 * Returns null if no assignment exists.
 */
export async function getStudentSyllabus(studentUid: string): Promise<StudentSyllabus | null> {
  const snap = await getDocFromServer(doc(db, STUDENT_SYLLABUS, studentUid));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as StudentSyllabus;
}

/**
 * Get progress records for a student (all units).
 */
export async function getStudentProgress(studentUid: string): Promise<StudentProgress[]> {
  const q    = query(collection(db, STUDENT_PROGRESS), where("studentUid", "==", studentUid));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({
    id:                 d.id,
    completedConcepts:  [],
    completedExercises: [],
    ...d.data(),
  }) as unknown as StudentProgress);
}

/**
 * Mark a concept as completed or uncompleted for a student's unit progress.
 * Non-destructive: uses arrayUnion / arrayRemove.
 */
export async function toggleConcept(
  studentUid: string,
  unitId:     string,
  concept:    string,
  completed:  boolean
): Promise<void> {
  const progressId  = `${studentUid}_${unitId}`;
  const progressRef = doc(db, STUDENT_PROGRESS, progressId);

  // Gamification: +10 points when checking a concept (only on first check)
  const existingSnap = await getDocFromServer(progressRef).catch(() => null);
  const alreadyDone  = existingSnap?.exists()
    ? (existingSnap.data().completedConcepts ?? []).includes(concept)
    : false;
  const awardPoints = completed && !alreadyDone;

  await setDoc(progressRef, {
    studentUid,
    unitId,
    completedConcepts: completed ? arrayUnion(concept) : arrayRemove(concept),
    ...(awardPoints    ? { points: increment(10)  } : {}),
    ...(!awardPoints && !completed ? { points: increment(-10) } : {}),
    updatedAt:         serverTimestamp(),
    createdAt:         serverTimestamp(),
  }, { merge: true });
}

/**
 * Mark an exercise as completed or uncompleted for a student's unit progress.
 * Non-destructive: uses arrayUnion / arrayRemove.
 */
export async function toggleExercise(
  studentUid: string,
  unitId:     string,
  exercise:   string,
  completed:  boolean
): Promise<void> {
  const progressId  = `${studentUid}_${unitId}`;
  const progressRef = doc(db, STUDENT_PROGRESS, progressId);

  // Gamification: +20 points when checking an exercise (only on first check)
  const existingSnap = await getDocFromServer(progressRef).catch(() => null);
  const alreadyDone  = existingSnap?.exists()
    ? (existingSnap.data().completedExercises ?? []).includes(exercise)
    : false;
  const awardPoints = completed && !alreadyDone;

  await setDoc(progressRef, {
    studentUid,
    unitId,
    completedExercises: completed ? arrayUnion(exercise) : arrayRemove(exercise),
    ...(awardPoints     ? { points: increment(20)  } : {}),
    ...(!awardPoints && !completed ? { points: increment(-20) } : {}),
    updatedAt:          serverTimestamp(),
    createdAt:          serverTimestamp(),
  }, { merge: true });
}
