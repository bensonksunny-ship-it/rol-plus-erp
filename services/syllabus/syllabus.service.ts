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
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { User } from "@/types";
import type {
  SyllabusUnit,
  CreateSyllabusUnitInput,
  StudentProgress,
  ProgressStatus,
} from "@/types/syllabus";

const STUDENT_PROGRESS = "student_progress";

const SYLLABUS_MASTER = "syllabus_master";

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
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as SyllabusUnit);
}

// ─── Student Progress ─────────────────────────────────────────────────────────

/**
 * Update student progress for a syllabus unit.
 * Validates:
 *   - unit exists
 *   - student exists and has role "student"
 *   - order enforced: prerequisite unit must be completed first (unless admin override)
 * Admin override: pass overrideBy (admin UID) to skip order check.
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

  const now = new Date().toISOString();
  await setDoc(progressRef, {
    studentUid:     studentUid,
    unitId:         unitId,
    status:         options.status,
    completionDate: options.status === "completed" ? now : null,
    teacherSignOff: options.teacherSignOff,
    feedback:       options.feedback,
    overrideBy:     options.overrideBy,
    updatedAt:      serverTimestamp(),
    createdAt:      serverTimestamp(),
  }, { merge: true });

  const snap = await getDocFromServer(progressRef);
  if (!snap.exists()) throw new Error("PROGRESS_WRITE_FAILED: document not found after write");

  return { id: snap.id, ...snap.data() } as StudentProgress;
}
