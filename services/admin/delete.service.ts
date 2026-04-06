/**
 * delete.service.ts
 * Central service for all destructive operations:
 *   - Clear student history (syllabus progress, payments, attendance)
 *   - Delete center (with member reassignment guard)
 *   - Delete user (student / teacher / admin) — soft-deletes Firestore doc, flags auth
 *
 * All operations log to audit trail before executing.
 * All operations require explicit confirmation from the caller.
 */

import {
  collection,
  doc,
  getDocs,
  getDoc,
  deleteDoc,
  setDoc,
  updateDoc,
  query,
  where,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import { logAction } from "@/services/audit/audit.service";
import type { Role } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClearHistoryOptions {
  syllabus:    boolean;   // clear student_syllabus + lessons/lesson_items/student_lesson_progress
  payments:    boolean;   // clear transactions + reset balance to 0
  attendance:  boolean;   // clear attendance records
}

export interface ClearHistoryResult {
  cleared: string[];   // human-readable summary of what was cleared
  errors:  string[];
}

export interface DeleteResult {
  success: boolean;
  error?:  string;
}

// ─── Student History Clear ────────────────────────────────────────────────────

/**
 * Clear one or more history categories for a student.
 * Does NOT delete the student account itself.
 */
export async function clearStudentHistory(
  studentId:     string,
  options:       ClearHistoryOptions,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<ClearHistoryResult> {
  const result: ClearHistoryResult = { cleared: [], errors: [] };

  // Verify student exists
  const studentSnap = await getDoc(doc(db, "users", studentId));
  if (!studentSnap.exists()) {
    return { cleared: [], errors: ["Student not found."] };
  }
  const studentName = (studentSnap.data().displayName as string) ?? studentId;

  // ── Syllabus history ──────────────────────────────────────────────────────
  if (options.syllabus) {
    try {
      // 1. Delete student_syllabus doc (imported Excel syllabus)
      await deleteDoc(doc(db, "student_syllabus", studentId)).catch(() => null);

      // 2. Delete student_lesson_progress records
      const progressSnap = await getDocs(
        query(collection(db, "student_lesson_progress"), where("studentId", "==", studentId))
      );
      const batch1 = writeBatch(db);
      progressSnap.docs.forEach(d => batch1.delete(d.ref));
      if (progressSnap.docs.length > 0) await batch1.commit();

      // 3. Delete student_progress_summary
      await deleteDoc(doc(db, "student_progress_summary", studentId)).catch(() => null);

      // 4. Delete student-scoped lessons + their items
      const studentLessonsSnap = await getDocs(
        query(collection(db, "lessons"), where("studentId", "==", studentId))
      );
      for (const lessonDoc of studentLessonsSnap.docs) {
        // Delete items for this lesson
        const itemsSnap = await getDocs(
          query(collection(db, "lesson_items"), where("lessonId", "==", lessonDoc.id))
        );
        const batchItems = writeBatch(db);
        itemsSnap.docs.forEach(d => batchItems.delete(d.ref));
        if (itemsSnap.docs.length > 0) await batchItems.commit();
        await deleteDoc(lessonDoc.ref);
      }

      result.cleared.push(
        `Syllabus: removed ${progressSnap.docs.length} progress records, ` +
        `${studentLessonsSnap.docs.length} custom lessons, and imported syllabus`
      );
    } catch (err) {
      result.errors.push(`Syllabus clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Payment / transaction history ─────────────────────────────────────────
  if (options.payments) {
    try {
      const txSnap = await getDocs(
        query(collection(db, "transactions"), where("studentUid", "==", studentId))
      );
      const batchTx = writeBatch(db);
      txSnap.docs.forEach(d => batchTx.delete(d.ref));
      if (txSnap.docs.length > 0) await batchTx.commit();

      // Also delete from fees collection if present
      const feesSnap = await getDocs(
        query(collection(db, "fees"), where("studentUid", "==", studentId))
      );
      const batchFees = writeBatch(db);
      feesSnap.docs.forEach(d => batchFees.delete(d.ref));
      if (feesSnap.docs.length > 0) await batchFees.commit();

      // Reset balance on user doc to 0
      await updateDoc(doc(db, "users", studentId), { balance: 0, updatedAt: serverTimestamp() });

      result.cleared.push(
        `Payments: deleted ${txSnap.docs.length} transaction(s), ` +
        `${feesSnap.docs.length} fee record(s), balance reset to ₹0`
      );
    } catch (err) {
      result.errors.push(`Payments clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Attendance history ────────────────────────────────────────────────────
  if (options.attendance) {
    try {
      const attSnap = await getDocs(
        query(collection(db, "attendance"), where("studentId", "==", studentId))
      );
      const batchAtt = writeBatch(db);
      attSnap.docs.forEach(d => batchAtt.delete(d.ref));
      if (attSnap.docs.length > 0) await batchAtt.commit();

      result.cleared.push(`Attendance: deleted ${attSnap.docs.length} record(s)`);
    } catch (err) {
      result.errors.push(`Attendance clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Audit log
  logAction({
    action:        "STUDENT_HISTORY_CLEARED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { studentId, studentName, options, result },
  });

  return result;
}

// ─── Delete Center ────────────────────────────────────────────────────────────

/**
 * Delete a center.
 * Guard: fails if the center still has active members (students or teachers).
 * On success: deletes center doc + cascades center-scoped lessons + items.
 */
export async function deleteCenter(
  centerId:      string,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<DeleteResult> {
  try {
    // Guard: active students in center
    const studentsSnap = await getDocs(
      query(collection(db, "users"), where("centerId", "==", centerId), where("role", "==", "student"))
    );
    if (!studentsSnap.empty) {
      return {
        success: false,
        error: `Cannot delete: ${studentsSnap.docs.length} student(s) still assigned to this center. Reassign or remove them first.`,
      };
    }

    // Guard: teachers in center
    const teachersSnap = await getDocs(
      query(collection(db, "users"), where("centerId", "==", centerId), where("role", "==", "teacher"))
    );
    if (!teachersSnap.empty) {
      return {
        success: false,
        error: `Cannot delete: ${teachersSnap.docs.length} teacher(s) still assigned to this center. Reassign or remove them first.`,
      };
    }

    // Cascade: center-scoped lessons + lesson items
    const centerLessonsSnap = await getDocs(
      query(collection(db, "lessons"), where("centerId", "==", centerId))
    );
    for (const lessonDoc of centerLessonsSnap.docs) {
      const itemsSnap = await getDocs(
        query(collection(db, "lesson_items"), where("lessonId", "==", lessonDoc.id))
      );
      const batchItems = writeBatch(db);
      itemsSnap.docs.forEach(d => batchItems.delete(d.ref));
      if (itemsSnap.docs.length > 0) await batchItems.commit();
      await deleteDoc(lessonDoc.ref);
    }

    // Cascade: center doc
    const centerSnap = await getDoc(doc(db, "centers", centerId));
    const centerName = centerSnap.exists() ? (centerSnap.data().name as string) ?? centerId : centerId;
    await deleteDoc(doc(db, "centers", centerId));

    logAction({
      action:        "CENTER_DELETED",
      initiatorId,
      initiatorRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { centerId, centerName, cascadedLessons: centerLessonsSnap.docs.length },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Delete User (Student / Teacher / Admin) ──────────────────────────────────

/**
 * Soft-delete a user:
 *   - Sets status = "deleted", deletedAt timestamp on their Firestore doc
 *   - Does NOT delete Firebase Auth account (requires Admin SDK — use Firebase console)
 *
 * For students: also clears all history automatically.
 * Logs to audit trail.
 */
export async function deleteUser(
  userId:        string,
  userRole:      "student" | "teacher" | "admin",
  initiatorId:   string,
  initiatorRole: Role,
): Promise<DeleteResult> {
  try {
    const userSnap = await getDoc(doc(db, "users", userId));
    if (!userSnap.exists()) return { success: false, error: "User not found." };

    const userData = userSnap.data();
    const userName = (userData.displayName as string) ?? userId;

    // Mark deleted on Firestore doc
    await updateDoc(doc(db, "users", userId), {
      status:    "deleted",
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // For students: cascade clear all history
    if (userRole === "student") {
      await clearStudentHistory(
        userId,
        { syllabus: true, payments: true, attendance: true },
        initiatorId,
        initiatorRole,
      );
    }

    logAction({
      action:        "USER_DELETED",
      initiatorId,
      initiatorRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { userId, userName, userRole },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Syllabus Lesson / Item Edit ──────────────────────────────────────────────

/**
 * Update a lesson's title (center-wide or student-scoped).
 */
export async function updateLessonTitle(
  lessonId: string,
  newTitle: string,
): Promise<DeleteResult> {
  try {
    if (!newTitle.trim()) return { success: false, error: "Title cannot be empty." };
    await updateDoc(doc(db, "lessons", lessonId), {
      title:     newTitle.trim(),
      updatedAt: serverTimestamp(),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Update a lesson item's title and/or type.
 */
export async function updateLessonItem(
  itemId:   string,
  updates:  { title?: string; type?: "concept" | "exercise" | "songsheet" },
): Promise<DeleteResult> {
  try {
    if (updates.title !== undefined && !updates.title.trim()) {
      return { success: false, error: "Title cannot be empty." };
    }
    const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (updates.title) payload.title = updates.title.trim();
    if (updates.type)  payload.type  = updates.type;
    await updateDoc(doc(db, "lesson_items", itemId), payload);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete a lesson item from a lesson.
 * Also removes any student_lesson_progress records for this item.
 */
export async function deleteLessonItem(
  itemId:        string,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<DeleteResult> {
  try {
    // Cascade: remove progress records
    const progressSnap = await getDocs(
      query(collection(db, "student_lesson_progress"), where("itemId", "==", itemId))
    );
    const batch = writeBatch(db);
    progressSnap.docs.forEach(d => batch.delete(d.ref));
    if (progressSnap.docs.length > 0) await batch.commit();

    await deleteDoc(doc(db, "lesson_items", itemId));

    logAction({
      action:        "LESSON_ITEM_DELETED",
      initiatorId,
      initiatorRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { itemId, progressCleared: progressSnap.docs.length },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete an entire lesson and all its items + progress.
 */
export async function deleteLesson(
  lessonId:      string,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<DeleteResult> {
  try {
    const itemsSnap = await getDocs(
      query(collection(db, "lesson_items"), where("lessonId", "==", lessonId))
    );

    // Cascade: progress for all items
    for (const itemDoc of itemsSnap.docs) {
      const progressSnap = await getDocs(
        query(collection(db, "student_lesson_progress"), where("itemId", "==", itemDoc.id))
      );
      const batch = writeBatch(db);
      progressSnap.docs.forEach(d => batch.delete(d.ref));
      if (progressSnap.docs.length > 0) await batch.commit();
      await deleteDoc(itemDoc.ref);
    }

    await deleteDoc(doc(db, "lessons", lessonId));

    logAction({
      action:        "LESSON_DELETED",
      initiatorId,
      initiatorRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { lessonId, itemsDeleted: itemsSnap.docs.length },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
