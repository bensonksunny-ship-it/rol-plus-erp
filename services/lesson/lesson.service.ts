import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDocs,
  getDocFromServer,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type {
  Lesson,
  LessonItem,
  LessonItemType,
  StudentLessonProgress,
  Attempt,
  CreateLessonInput,
  CreateLessonItemInput,
  ExcelImportRow,
  LessonProgressSummary,
} from "@/types/lesson";
import type { Role } from "@/types";

// ─── Collection names ─────────────────────────────────────────────────────────

const LESSONS          = "lessons";
const LESSON_ITEMS     = "lesson_items";
const STUDENT_PROGRESS = "student_lesson_progress";

const MAX_ATTEMPTS = 5;
const VALID_ITEM_TYPES: LessonItemType[] = ["concept", "exercise", "songsheet"];

// ─── Error helpers ────────────────────────────────────────────────────────────

function friendlyError(raw: unknown): string {
  if (raw instanceof Error) {
    const m = raw.message;
    if (m.startsWith("USER_NOT_FOUND"))        return "Student not found. Verify the student ID.";
    if (m.startsWith("ROLE_MISMATCH"))         return "The specified user is not a student.";
    if (m.startsWith("ITEM_NOT_FOUND"))        return "Lesson item not found.";
    if (m.startsWith("LESSON_NOT_FOUND"))      return "Lesson not found.";
    if (m.startsWith("CENTER_NOT_FOUND"))      return "Center not found.";
    if (m.startsWith("ORDER_VIOLATION"))       return "Complete the previous lesson before attempting this one.";
    if (m.startsWith("ITEM_LOCKED"))           return "This item is already completed and cannot accept new attempts.";
    if (m.startsWith("MAX_ATTEMPTS_REACHED"))  return `Maximum ${MAX_ATTEMPTS} attempts reached for this item.`;
    if (m.startsWith("NO_ATTEMPTS"))           return "At least 1 attempt must be logged before marking as completed.";
    if (m.startsWith("ALREADY_COMPLETED"))     return "This item has already been marked as completed.";
    if (m.startsWith("DUPLICATE_ORDER"))       return "A lesson with this order number already exists.";
    if (m.startsWith("NO_ITEMS"))              return "This lesson has no items. Add items before accessing.";
    if (m.startsWith("INVALID_ITEM_TYPE"))     return "Item type must be one of: concept, exercise, songsheet.";
    return m;
  }
  return String(raw);
}

// ─── Lessons ──────────────────────────────────────────────────────────────────

export async function createLesson(
  data:          CreateLessonInput,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<Lesson> {
  try {
    const scopeField = data.centerId ? "centerId" : "studentId";
    const scopeValue = data.centerId ?? data.studentId;

    if (scopeValue) {
      const dupSnap = await getDocs(
        query(
          collection(db, LESSONS),
          where(scopeField, "==", scopeValue),
          where("order", "==", data.order),
        )
      );
      if (!dupSnap.empty) {
        throw new Error(`DUPLICATE_ORDER: lesson order ${data.order} already exists in this scope`);
      }
    }

    const ref = await addDoc(collection(db, LESSONS), {
      title:        data.title,
      lessonNumber: data.lessonNumber,
      order:        data.order,
      centerId:     data.centerId  ?? null,
      studentId:    data.studentId ?? null,
      createdAt:    serverTimestamp(),
      updatedAt:    serverTimestamp(),
    });

    logAction({
      action:        "LESSON_CREATED",
      initiatorId,
      initiatorRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { lessonId: ref.id, title: data.title, order: data.order },
    });

    const snap = await getDocFromServer(ref);
    return { id: snap.id, ...snap.data() } as Lesson;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

export async function getLessonsByCenter(centerId: string): Promise<Lesson[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, LESSONS),
        where("centerId", "==", centerId),
        orderBy("order", "asc"),
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Lesson);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

export async function getLessonsByStudent(studentId: string): Promise<Lesson[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, LESSONS),
        where("studentId", "==", studentId),
        orderBy("order", "asc"),
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Lesson);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Lesson Items ─────────────────────────────────────────────────────────────

export async function createLessonItem(
  data:          CreateLessonItemInput,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<LessonItem> {
  try {
    if (!VALID_ITEM_TYPES.includes(data.type)) {
      throw new Error(`INVALID_ITEM_TYPE: "${data.type}" is not allowed`);
    }

    const lessonSnap = await getDocFromServer(doc(db, LESSONS, data.lessonId));
    if (!lessonSnap.exists()) throw new Error(`LESSON_NOT_FOUND: ${data.lessonId}`);

    const ref = await addDoc(collection(db, LESSON_ITEMS), {
      lessonId:    data.lessonId,
      type:        data.type,
      title:       data.title,
      maxAttempts: MAX_ATTEMPTS,
      order:       data.order,
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    });

    logAction({
      action:        "LESSON_ITEM_CREATED",
      initiatorId,
      initiatorRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { itemId: ref.id, lessonId: data.lessonId, type: data.type, title: data.title },
    });

    const snap = await getDocFromServer(ref);
    return { id: snap.id, ...snap.data() } as LessonItem;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

export async function getItemsByLesson(lessonId: string): Promise<LessonItem[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, LESSON_ITEMS),
        where("lessonId", "==", lessonId),
        orderBy("order", "asc"),
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }) as LessonItem);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Student Lesson Progress ──────────────────────────────────────────────────

export async function getProgressByStudent(studentId: string): Promise<StudentLessonProgress[]> {
  try {
    const snap = await getDocs(
      query(collection(db, STUDENT_PROGRESS), where("studentId", "==", studentId))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }) as StudentLessonProgress);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

export async function getProgressRecord(
  studentId: string,
  itemId:    string,
): Promise<StudentLessonProgress | null> {
  try {
    const progressId = `${studentId}_${itemId}`;
    const snap = await getDocFromServer(doc(db, STUDENT_PROGRESS, progressId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as StudentLessonProgress;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Order enforcement helper ─────────────────────────────────────────────────

/**
 * Validates that the student has completed at least 1 item in the previous
 * lesson within the same scope (center or student).
 * Throws ORDER_VIOLATION if the check fails.
 */
async function enforceOrderCheck(
  studentId: string,
  lesson:    Lesson,
): Promise<void> {
  if (lesson.order <= 1) return; // first lesson — always allowed

  const scopeField = lesson.centerId ? "centerId" : "studentId";
  const scopeValue = lesson.centerId ?? lesson.studentId;
  if (!scopeValue) return;

  const prevSnap = await getDocs(
    query(
      collection(db, LESSONS),
      where(scopeField, "==", scopeValue),
      where("order", "==", lesson.order - 1),
    )
  );
  if (prevSnap.empty) return; // no previous lesson found — allow

  const prevLessonId = prevSnap.docs[0].id;
  const prevItemsSnap = await getDocs(
    query(collection(db, LESSON_ITEMS), where("lessonId", "==", prevLessonId))
  );

  if (prevItemsSnap.empty) return; // previous lesson has no items — allow

  for (const prevItemDoc of prevItemsSnap.docs) {
    const prog = await getProgressRecord(studentId, prevItemDoc.id);
    if (prog?.completed) return; // at least one item completed — pass
  }

  throw new Error(
    `ORDER_VIOLATION: student ${studentId} has not completed any item in lesson ${prevLessonId}`
  );
}

// ─── Add Attempt ──────────────────────────────────────────────────────────────

export async function addAttempt(
  studentId:    string,
  lessonId:     string,
  itemId:       string,
  teacherId:    string,
  teacherRole:  Role,
  notes:        string | null,
  overrideBy:   string | null,
): Promise<StudentLessonProgress> {
  try {
    // Validate student exists and has correct role
    const studentSnap = await getDocFromServer(doc(db, "users", studentId));
    if (!studentSnap.exists()) throw new Error(`USER_NOT_FOUND: ${studentId}`);
    if (studentSnap.data().role !== "student") throw new Error(`ROLE_MISMATCH: ${studentId}`);

    // Validate item exists
    const itemSnap = await getDocFromServer(doc(db, LESSON_ITEMS, itemId));
    if (!itemSnap.exists()) throw new Error(`ITEM_NOT_FOUND: ${itemId}`);

    // Validate lesson exists
    const lessonSnap = await getDocFromServer(doc(db, LESSONS, lessonId));
    if (!lessonSnap.exists()) throw new Error(`LESSON_NOT_FOUND: ${lessonId}`);

    // Block access if lesson has no items (edge case guard)
    const itemsSnap = await getDocs(
      query(collection(db, LESSON_ITEMS), where("lessonId", "==", lessonId))
    );
    if (itemsSnap.empty) throw new Error(`NO_ITEMS: lesson ${lessonId} has no items`);

    // Order enforcement — skip only if admin override provided
    if (!overrideBy) {
      await enforceOrderCheck(studentId, lessonSnap.data() as Lesson);
    }

    // Load existing progress record
    const progressId  = `${studentId}_${itemId}`;
    const progressRef = doc(db, STUDENT_PROGRESS, progressId);
    const existing    = await getDocFromServer(progressRef).catch(() => null);
    const current     = existing?.exists()
      ? (existing.data() as Omit<StudentLessonProgress, "id">)
      : null;

    // Hard locks
    if (current?.completed) throw new Error(`ITEM_LOCKED: ${itemId} is already completed`);

    const currentAttempts: Attempt[] = current?.attempts ?? [];
    if (currentAttempts.length >= MAX_ATTEMPTS) {
      throw new Error(`MAX_ATTEMPTS_REACHED: ${itemId} has reached the limit of ${MAX_ATTEMPTS} attempts`);
    }

    const attemptNo   = currentAttempts.length + 1;
    const today       = new Date().toISOString().slice(0, 10);
    const newAttempt: Attempt = {
      attemptNo,
      date:      today,
      status:    "attempted",
      notes:     notes ?? null,
      teacherId,
    };

    const updatedAttempts = [...currentAttempts, newAttempt];

    await setDoc(progressRef, {
      studentId,
      lessonId,
      itemId,
      attempts:         updatedAttempts,
      completed:        false,
      completionDate:   null,
      teacherId,
      firstAttemptDate: current?.firstAttemptDate ?? today,
      totalAttempts:    updatedAttempts.length,
      updatedAt:        serverTimestamp(),
      createdAt:        serverTimestamp(),
    }, { merge: true });

    logAction({
      action:        overrideBy ? "ATTEMPT_LOGGED_OVERRIDE" : "ATTEMPT_LOGGED",
      initiatorId:   teacherId,
      initiatorRole: teacherRole,
      approverId:    overrideBy ?? null,
      approverRole:  overrideBy ? "admin" : null,
      reason:        overrideBy ? "admin_override" : null,
      metadata:      { studentId, lessonId, itemId, attemptNo, notes },
    });

    const snap = await getDocFromServer(progressRef);
    return { id: snap.id, ...snap.data() } as StudentLessonProgress;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Mark Item Completed ──────────────────────────────────────────────────────

export async function markItemCompleted(
  studentId:   string,
  lessonId:    string,
  itemId:      string,
  teacherId:   string,
  teacherRole: Role,
  overrideBy:  string | null,
): Promise<StudentLessonProgress> {
  try {
    const progressId  = `${studentId}_${itemId}`;
    const progressRef = doc(db, STUDENT_PROGRESS, progressId);
    const existing    = await getDocFromServer(progressRef).catch(() => null);
    const current     = existing?.exists()
      ? (existing.data() as Omit<StudentLessonProgress, "id">)
      : null;

    if (!current || current.attempts.length === 0) {
      throw new Error(`NO_ATTEMPTS: cannot complete item ${itemId} without at least 1 attempt`);
    }
    if (current.completed) throw new Error(`ALREADY_COMPLETED: ${itemId}`);

    const today = new Date().toISOString();

    const updatedAttempts: Attempt[] = current.attempts.map((a, idx) =>
      idx === current.attempts.length - 1 ? { ...a, status: "completed" as const } : a
    );

    await setDoc(progressRef, {
      attempts:       updatedAttempts,
      completed:      true,
      completionDate: today,
      teacherId,
      totalAttempts:  updatedAttempts.length,
      updatedAt:      serverTimestamp(),
    }, { merge: true });

    logAction({
      action:        overrideBy ? "ITEM_COMPLETED_OVERRIDE" : "ITEM_COMPLETED",
      initiatorId:   teacherId,
      initiatorRole: teacherRole,
      approverId:    overrideBy ?? null,
      approverRole:  overrideBy ? "admin" : null,
      reason:        overrideBy ? "admin_override" : null,
      metadata:      {
        studentId, lessonId, itemId,
        totalAttempts:  updatedAttempts.length,
        completionDate: today,
      },
    });

    const snap = await getDocFromServer(progressRef);
    return { id: snap.id, ...snap.data() } as StudentLessonProgress;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Lesson Progress Summary ──────────────────────────────────────────────────

/**
 * Aggregate lesson-level progress for a student.
 * Fetches all lessons the student has scope over (center + student-specific),
 * then computes totals from progress records.
 */
export async function getLessonProgressSummary(
  studentId: string,
): Promise<LessonProgressSummary> {
  try {
    // Resolve student's centerId
    const studentSnap = await getDocFromServer(doc(db, "users", studentId));
    if (!studentSnap.exists()) throw new Error(`USER_NOT_FOUND: ${studentId}`);
    const centerId: string | undefined = studentSnap.data().centerId;

    // Fetch all lessons in scope
    const lessonPromises: Promise<Lesson[]>[] = [getLessonsByStudent(studentId)];
    if (centerId) lessonPromises.push(getLessonsByCenter(centerId));

    const lessonArrays = await Promise.all(lessonPromises);
    const allLessons = lessonArrays.flat();

    if (allLessons.length === 0) {
      return { totalLessons: 0, completedLessons: 0, inProgressLessons: 0, avgAttemptsPerItem: 0 };
    }

    // Fetch all items for all lessons
    const lessonIds = allLessons.map(l => l.id);
    const itemPromises = lessonIds.map(id =>
      getDocs(query(collection(db, LESSON_ITEMS), where("lessonId", "==", id)))
    );
    const itemSnaps = await Promise.all(itemPromises);

    // Map: lessonId → itemIds
    const lessonItemMap: Record<string, string[]> = {};
    for (let i = 0; i < lessonIds.length; i++) {
      lessonItemMap[lessonIds[i]] = itemSnaps[i].docs.map(d => d.id);
    }

    // Fetch all progress records for student
    const allProgress = await getProgressByStudent(studentId);
    const progressMap: Record<string, StudentLessonProgress> = {};
    allProgress.forEach(p => { progressMap[p.itemId] = p; });

    let completedLessons  = 0;
    let inProgressLessons = 0;
    let totalAttemptSum   = 0;
    let itemsWithAttempts = 0;

    for (const lesson of allLessons) {
      const items = lessonItemMap[lesson.id] ?? [];
      if (items.length === 0) continue;

      let anyStarted    = false;
      let allCompleted  = true;

      for (const itemId of items) {
        const prog = progressMap[itemId];
        if (!prog || prog.attempts.length === 0) {
          allCompleted = false;
          continue;
        }
        anyStarted = true;
        if (!prog.completed) allCompleted = false;
        totalAttemptSum += prog.totalAttempts;
        itemsWithAttempts++;
      }

      if (allCompleted && anyStarted) completedLessons++;
      else if (anyStarted)            inProgressLessons++;
    }

    const avgAttemptsPerItem = itemsWithAttempts > 0
      ? Math.round((totalAttemptSum / itemsWithAttempts) * 10) / 10
      : 0;

    return {
      totalLessons:      allLessons.length,
      completedLessons,
      inProgressLessons,
      avgAttemptsPerItem,
    };
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Excel Bulk Import ────────────────────────────────────────────────────────

export interface ImportResult {
  created:  number;
  skipped:  number;
  errors:   string[];
}

/**
 * Bulk import lessons from validated Excel rows.
 * Schema: lessonNumber, lessonName, itemType, itemTitle, order
 *
 * Atomic per-lesson: if item creation fails, the lesson doc is deleted (rollback).
 * Scope: centerId OR studentId (exactly one must be non-null).
 */
export async function bulkImportLessons(
  rows:          ExcelImportRow[],
  scope:         { centerId: string; studentId: null } | { centerId: null; studentId: string },
  initiatorId:   string,
  initiatorRole: Role,
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  // Group rows by lessonNumber
  const grouped = new Map<number, ExcelImportRow[]>();
  for (const row of rows) {
    if (!grouped.has(row.lessonNumber)) grouped.set(row.lessonNumber, []);
    grouped.get(row.lessonNumber)!.push(row);
  }

  // Track lesson orders used in this import (prevent intra-batch duplicates)
  const usedOrders = new Set<number>();

  for (const [lessonNumber, lessonRows] of grouped) {
    const firstRow = lessonRows[0];
    const rowLabel = `Lesson ${lessonNumber}`;

    // Validate lesson-level fields
    if (!firstRow.lessonName?.trim()) {
      result.errors.push(`${rowLabel}: lessonName is required`);
      result.skipped++;
      continue;
    }
    if (isNaN(firstRow.order) || firstRow.order < 1) {
      result.errors.push(`${rowLabel}: order must be a positive number (got "${firstRow.order}")`);
      result.skipped++;
      continue;
    }
    if (usedOrders.has(firstRow.order)) {
      result.errors.push(`${rowLabel}: duplicate order ${firstRow.order} in this import batch`);
      result.skipped++;
      continue;
    }
    usedOrders.add(firstRow.order);

    // Validate all item rows for this lesson
    const itemErrors: string[] = [];
    for (const row of lessonRows) {
      if (!row.itemTitle?.trim()) {
        itemErrors.push(`${rowLabel} row: itemTitle is required`);
      }
      if (!VALID_ITEM_TYPES.includes(row.itemType?.trim() as LessonItemType)) {
        itemErrors.push(
          `${rowLabel} row: invalid itemType "${row.itemType}". Must be one of: concept, exercise, songsheet`
        );
      }
    }
    if (itemErrors.length > 0) {
      result.errors.push(...itemErrors);
      result.skipped++;
      continue;
    }

    try {
      // Check for existing lesson with same order in Firestore
      const scopeField = scope.centerId ? "centerId" : "studentId";
      const scopeValue = scope.centerId ?? scope.studentId;
      const dupSnap = await getDocs(
        query(
          collection(db, LESSONS),
          where(scopeField, "==", scopeValue),
          where("order", "==", firstRow.order),
        )
      );
      if (!dupSnap.empty) {
        result.errors.push(`Lesson order ${firstRow.order} already exists in Firestore — skipped`);
        result.skipped++;
        continue;
      }

      // Create lesson document
      const lessonRef = await addDoc(collection(db, LESSONS), {
        title:        firstRow.lessonName.trim(),
        lessonNumber,
        order:        firstRow.order,
        centerId:     scope.centerId  ?? null,
        studentId:    scope.studentId ?? null,
        createdAt:    serverTimestamp(),
        updatedAt:    serverTimestamp(),
      });

      const lessonId = lessonRef.id;
      let itemOrder  = 1;
      const createdItemRefs: string[] = [];

      try {
        // Create all items — atomic: any failure rolls back the lesson
        for (const row of lessonRows) {
          const itemRef = await addDoc(collection(db, LESSON_ITEMS), {
            lessonId,
            type:        row.itemType.trim() as LessonItemType,
            title:       row.itemTitle.trim(),
            maxAttempts: MAX_ATTEMPTS,
            order:       itemOrder++,
            createdAt:   serverTimestamp(),
            updatedAt:   serverTimestamp(),
          });
          createdItemRefs.push(itemRef.id);
        }

        result.created++;
      } catch (itemErr) {
        // Rollback: delete created items + lesson document
        for (const itemId of createdItemRefs) {
          await deleteDoc(doc(db, LESSON_ITEMS, itemId)).catch(() => null);
        }
        await deleteDoc(lessonRef).catch(() => null);

        const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
        result.errors.push(`${rowLabel}: item creation failed and was rolled back — ${msg}`);
        result.skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${rowLabel}: ${friendlyError(err) !== msg ? friendlyError(err) : msg}`);
      result.skipped++;
    }
  }

  logAction({
    action:        "SYLLABUS_BULK_IMPORTED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      {
      created:   result.created,
      skipped:   result.skipped,
      scope:     scope.centerId ? `center:${scope.centerId}` : `student:${scope.studentId}`,
    },
  });

  return result;
}
