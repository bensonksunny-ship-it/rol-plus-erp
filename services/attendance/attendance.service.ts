import {
  collection,
  doc,
  addDoc,
  updateDoc,
  increment,
  getDocFromServer,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { User, StudentUser } from "@/types";
import type {
  Class,
  CreateClassInput,
  AttendanceRecord,
  MarkAttendanceInput,
} from "@/types/attendance";
import { getFeeStructureByCenter } from "@/services/finance/finance.service";

const CLASSES    = "classes";
const ATTENDANCE = "attendance";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchUser(uid: string): Promise<User> {
  const snap = await getDocFromServer(doc(db, "users", uid));
  if (!snap.exists()) throw new Error(`USER_NOT_FOUND: ${uid}`);
  return snap.data() as User;
}

async function fetchCenter(centerId: string): Promise<void> {
  const snap = await getDocFromServer(doc(db, "centers", centerId));
  if (!snap.exists()) throw new Error(`CENTER_NOT_FOUND: ${centerId}`);
}

// ─── Class Functions ──────────────────────────────────────────────────────────

/**
 * Create a new scheduled class.
 * Validates: center exists, teacher exists and has correct role.
 */
export async function createClass(data: CreateClassInput): Promise<Class> {
  await fetchCenter(data.centerId);

  const teacher = await fetchUser(data.teacherUid);
  if (teacher.role !== "teacher") {
    throw new Error(`ROLE_MISMATCH: user ${data.teacherUid} is not a teacher`);
  }

  const ref = await addDoc(collection(db, CLASSES), {
    centerId:       data.centerId,
    date:           data.date,
    startTime:      data.startTime,
    endTime:        data.endTime,
    teacherUid:     data.teacherUid,
    teacherClockIn: null,
    status:         "scheduled",
    createdAt:      serverTimestamp(),
    updatedAt:      serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) throw new Error("CLASS_CREATE_FAILED: document not found after write");

  return { id: snap.id, ...snap.data() } as Class;
}

/**
 * Record teacher clock-in for a class.
 * Validates: class exists, user is the assigned teacher.
 */
export async function teacherClockIn(classId: string, teacherUid: string): Promise<void> {
  const classSnap = await getDocFromServer(doc(db, CLASSES, classId));
  if (!classSnap.exists()) throw new Error(`CLASS_NOT_FOUND: ${classId}`);

  const classData = classSnap.data() as Class;
  if (classData.status !== "scheduled") {
    throw new Error(`CLASS_NOT_SCHEDULED: cannot clock in for class with status "${classData.status}"`);
  }
  if (classData.teacherUid !== teacherUid) {
    throw new Error(`UNAUTHORIZED: teacher ${teacherUid} is not assigned to class ${classId}`);
  }
  if (classData.teacherClockIn !== null) {
    throw new Error(`ALREADY_CLOCKED_IN: teacher already clocked in for class ${classId}`);
  }

  await updateDoc(doc(db, CLASSES, classId), {
    teacherClockIn: new Date().toISOString(),
    updatedAt:      serverTimestamp(),
  });
}

/**
 * Get a single class by ID.
 */
export async function getClassById(classId: string): Promise<Class> {
  const snap = await getDocFromServer(doc(db, CLASSES, classId));
  if (!snap.exists()) throw new Error(`CLASS_NOT_FOUND: ${classId}`);
  return { id: snap.id, ...snap.data() } as Class;
}

// ─── Attendance Functions ─────────────────────────────────────────────────────

/**
 * Mark attendance for a student in a class.
 * Validates:
 *   - class exists
 *   - student exists and has correct role
 *   - student belongs to the class's center
 *   - no duplicate attendance record for same classId + studentUid
 */
export async function markAttendance(data: MarkAttendanceInput): Promise<AttendanceRecord> {
  // Validate class
  const classSnap = await getDocFromServer(doc(db, CLASSES, data.classId));
  if (!classSnap.exists()) throw new Error(`CLASS_NOT_FOUND: ${data.classId}`);
  const classData = classSnap.data() as Class;
  if (classData.status !== "scheduled") {
    throw new Error(`CLASS_NOT_SCHEDULED: cannot mark attendance for class with status "${classData.status}"`);
  }

  // Validate student role
  const student = await fetchUser(data.studentUid);
  if (student.role !== "student") {
    throw new Error(`ROLE_MISMATCH: user ${data.studentUid} is not a student`);
  }

  // Validate student belongs to the class's center
  const studentData = student as StudentUser;
  if (studentData.centerId !== classData.centerId) {
    throw new Error(
      `CENTER_MISMATCH: student ${data.studentUid} does not belong to center ${classData.centerId}`
    );
  }

  // Prevent duplicate attendance
  const duplicateQuery = query(
    collection(db, ATTENDANCE),
    where("classId",    "==", data.classId),
    where("studentUid", "==", data.studentUid)
  );
  const duplicateSnap = await getDocs(duplicateQuery);
  if (!duplicateSnap.empty) {
    throw new Error(
      `DUPLICATE_ATTENDANCE: attendance already marked for student ${data.studentUid} in class ${data.classId}`
    );
  }

  const ref = await addDoc(collection(db, ATTENDANCE), {
    classId:    data.classId,
    studentUid: data.studentUid,
    centerId:   data.centerId,
    markedAt:   data.markedAt,
    method:     data.method,
    status:     data.status,
    createdAt:  serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) throw new Error("ATTENDANCE_CREATE_FAILED: document not found after write");

  // Per-class billing: charge student only on first (present) attendance mark
  if (data.status === "present") {
    const feeStructure = await getFeeStructureByCenter(classData.centerId);
    if (feeStructure && feeStructure.billingCycle === "per_class") {
      await updateDoc(doc(db, "users", data.studentUid), {
        currentBalance: increment(feeStructure.amount),
        updatedAt:      new Date().toISOString(),
      });
    }
  }

  return { id: snap.id, ...snap.data() } as AttendanceRecord;
}

/**
 * Get all attendance records for a class.
 */
export async function getAttendanceByClass(classId: string): Promise<AttendanceRecord[]> {
  const q    = query(collection(db, ATTENDANCE), where("classId", "==", classId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as AttendanceRecord);
}

/**
 * Get all classes for a center.
 */
export async function getClassesByCenter(centerId: string): Promise<Class[]> {
  const q    = query(collection(db, CLASSES), where("centerId", "==", centerId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Class);
}

/**
 * Get all classes assigned to a teacher.
 */
export async function getClassesByTeacher(teacherUid: string): Promise<Class[]> {
  const q    = query(collection(db, CLASSES), where("teacherUid", "==", teacherUid));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Class);
}

/**
 * Get all attendance records for a student.
 */
export async function getAttendanceByStudent(studentUid: string): Promise<AttendanceRecord[]> {
  const q    = query(collection(db, ATTENDANCE), where("studentUid", "==", studentUid));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as AttendanceRecord);
}

// ─── Ghost Class Logic ────────────────────────────────────────────────────────

const GHOST_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if a class should be marked as ghost.
 * Conditions:
 *   - class.status === "scheduled"
 *   - teacherClockIn is set
 *   - no attendance records exist
 *   - more than 30 minutes have passed since teacherClockIn
 * If all conditions met → set class.status = "ghost".
 * Returns true if marked ghost, false otherwise.
 */
export async function checkGhostClass(classId: string): Promise<boolean> {
  const classSnap = await getDocFromServer(doc(db, CLASSES, classId));
  if (!classSnap.exists()) throw new Error(`CLASS_NOT_FOUND: ${classId}`);

  const classData = classSnap.data() as Class;

  // Only evaluate scheduled classes
  if (classData.status !== "scheduled") {
    return false;
  }

  // Teacher must have clocked in
  if (!classData.teacherClockIn) {
    return false;
  }

  // Check time elapsed since clock-in
  const clockInTime = new Date(classData.teacherClockIn).getTime();
  const now         = Date.now();
  if (now - clockInTime < GHOST_THRESHOLD_MS) {
    return false;
  }

  // Check for any attendance records
  const attendanceSnap = await getDocs(
    query(collection(db, ATTENDANCE), where("classId", "==", classId))
  );
  if (!attendanceSnap.empty) {
    return false;
  }

  // All conditions met — mark as ghost
  await updateDoc(doc(db, CLASSES, classId), {
    status:    "ghost",
    updatedAt: serverTimestamp(),
  });

  return true;
}
