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
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type {
  Lesson,
  LessonItem,
  LessonItemType,
  StudentLessonProgress,
  StudentProgressSummary,
  Attempt,
  CreateLessonInput,
  CreateLessonItemInput,
  ExcelImportRow,
  LessonProgressSummary,
} from "@/types/lesson";
import { MAX_ATTEMPTS_BY_TYPE } from "@/types/lesson";
import type { Role } from "@/types";

// ─── Collection names ─────────────────────────────────────────────────────────

const LESSONS          = "lessons";
const LESSON_ITEMS     = "lesson_items";
const STUDENT_PROGRESS = "student_lesson_progress";
const PROGRESS_SUMMARY = "student_progress_summary";

const VALID_ITEM_TYPES: LessonItemType[] = ["concept", "exercise", "songsheet"];

// ─── Error helpers ────────────────────────────────────────────────────────────

function friendlyError(raw: unknown): string {
  if (raw instanceof Error) {
    const m = raw.message;
    if (m.startsWith("USER_NOT_FOUND"))       return "Student not found. Verify the student ID.";
    if (m.startsWith("ROLE_MISMATCH"))        return "The specified user is not a student.";
    if (m.startsWith("ITEM_NOT_FOUND"))       return "Lesson item not found.";
    if (m.startsWith("LESSON_NOT_FOUND"))     return "Lesson not found.";
    if (m.startsWith("CENTER_NOT_FOUND"))     return "Center not found.";
    if (m.startsWith("ITEM_LOCKED"))          return "This item is locked. Complete the previous activity first.";
    if (m.startsWith("MAX_ATTEMPTS_REACHED")) return "Maximum attempts reached for this item.";
    if (m.startsWith("NO_ATTEMPTS"))          return "At least 1 attempt must be logged before marking as completed.";
    if (m.startsWith("ALREADY_COMPLETED"))    return "This item has already been marked as completed.";
    if (m.startsWith("DUPLICATE_ORDER"))      return "A lesson with this order number already exists.";
    if (m.startsWith("NO_ITEMS"))             return "This lesson has no items.";
    if (m.startsWith("INVALID_ITEM_TYPE"))    return "Item type must be one of: concept, exercise, songsheet.";
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
      query(collection(db, LESSONS), where("centerId", "==", centerId))
    );
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }) as Lesson)
      .sort((a, b) => a.order - b.order);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

export async function getLessonsByStudent(studentId: string): Promise<Lesson[]> {
  try {
    const snap = await getDocs(
      query(collection(db, LESSONS), where("studentId", "==", studentId))
    );
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }) as Lesson)
      .sort((a, b) => a.order - b.order);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

/**
 * Get ALL lessons for a student:
 *   - center-wide lessons (lesson.centerId == student.centerId)
 *   - student-specific lessons (lesson.studentId == studentId)
 * Both types merged into a single list sorted by order ascending.
 * No assignment system — lessons are available directly.
 */
export async function getLessonsForStudent(
  studentId: string,
): Promise<{ lessons: (Lesson & { items: LessonItem[] })[]; centerId: string | null }> {
  try {
    const studentSnap = await getDocFromServer(doc(db, "users", studentId));
    if (!studentSnap.exists()) throw new Error(`USER_NOT_FOUND: ${studentId}`);
    const centerId: string | null = (studentSnap.data().centerId as string) ?? null;

    // Fetch center-wide + student-specific lessons in parallel
    const [centerLessons, studentLessons] = await Promise.all([
      centerId ? getLessonsByCenter(centerId) : Promise.resolve([]),
      getLessonsByStudent(studentId),
    ]);

    // Merge and sort by order — dedup by id in case of overlap
    const seen = new Set<string>();
    const allLessons: Lesson[] = [];
    for (const l of [...centerLessons, ...studentLessons]) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        allLessons.push(l);
      }
    }
    allLessons.sort((a, b) => a.order - b.order);

    if (allLessons.length === 0) return { lessons: [], centerId };

    // Fetch items for all lessons in parallel
    const itemArrays = await Promise.all(allLessons.map(l => getItemsByLesson(l.id)));
    const lessons = allLessons.map((lesson, idx) => ({
      ...lesson,
      items: itemArrays[idx] ?? [],
    }));

    return { lessons, centerId };
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

    const maxAttempts = MAX_ATTEMPTS_BY_TYPE[data.type];

    const ref = await addDoc(collection(db, LESSON_ITEMS), {
      lessonId:    data.lessonId,
      type:        data.type,
      title:       data.title,
      maxAttempts,
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
      query(collection(db, LESSON_ITEMS), where("lessonId", "==", lessonId))
    );
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }) as LessonItem)
      .sort((a, b) => a.order - b.order);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Student Lesson Progress ──────────────────────────────────────────────────

export async function getProgressByStudent(
  studentId: string,
): Promise<StudentLessonProgress[]> {
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

// ─── Sequential unlock helpers ────────────────────────────────────────────────

/**
 * Returns true if the item at `itemOrder` in `lessonId` is unlocked for `studentId`.
 *
 * Rules:
 *  - First item (order === 1) of first lesson (lesson.order === 1) → always unlocked.
 *  - First item (order === 1) of any other lesson → unlocked only when ALL items
 *    of the previous lesson are completed.
 *  - Any other item → unlocked when the immediately preceding item (order - 1)
 *    in the same lesson is completed.
 */
export async function isItemUnlocked(
  studentId: string,
  lesson:    Lesson,
  item:      LessonItem,
  allLessonsForStudent: Lesson[],    // pre-fetched, sorted by order
  allItemsForLesson:    LessonItem[], // pre-fetched for this lesson, sorted by order
): Promise<boolean> {
  // First item of the lesson
  if (item.order === 1) {
    // First lesson — always unlocked
    if (lesson.order === 1) return true;

    // Otherwise need all items of the previous lesson to be completed
    const prevLesson = allLessonsForStudent.find(l => l.order === lesson.order - 1);
    if (!prevLesson) return true; // no previous lesson found — allow

    const prevItems = await getItemsByLesson(prevLesson.id);
    if (prevItems.length === 0) return true; // previous lesson has no items — allow

    for (const prevItem of prevItems) {
      const prog = await getProgressRecord(studentId, prevItem.id);
      if (!prog?.completed) return false;
    }
    return true;
  }

  // Non-first item — previous item in same lesson must be completed
  const prevItem = allItemsForLesson.find(i => i.order === item.order - 1);
  if (!prevItem) return true; // no previous item — allow

  const prog = await getProgressRecord(studentId, prevItem.id);
  return prog?.completed === true;
}

// ─── Progress percent helpers (pure — no DB) ─────────────────────────────────

export function calcLessonPercent(
  items:       LessonItem[],
  progressMap: Record<string, StudentLessonProgress>,
): number {
  if (items.length === 0) return 0;
  const completed = items.filter(i => progressMap[i.id]?.completed).length;
  return Math.round((completed / items.length) * 100);
}

export function calcOverallPercent(
  allItems:    LessonItem[],
  progressMap: Record<string, StudentLessonProgress>,
): number {
  if (allItems.length === 0) return 0;
  const completed = allItems.filter(i => progressMap[i.id]?.completed).length;
  return Math.round((completed / allItems.length) * 100);
}

/**
 * Recalculate and store lessonPercents + overallPercent for a student.
 * Called after every teacher write (addAttempt / markItemCompleted).
 * Single doc write to `student_progress_summary/{studentId}`.
 */
async function refreshProgressSummary(studentId: string): Promise<void> {
  try {
    const { lessons } = await getLessonsForStudent(studentId);
    const allProgress  = await getProgressByStudent(studentId);

    const progressMap: Record<string, StudentLessonProgress> = {};
    allProgress.forEach(p => { progressMap[p.itemId] = p; });

    const lessonPercents: Record<string, number> = {};
    const allItems: LessonItem[] = [];

    for (const lesson of lessons) {
      lessonPercents[lesson.id] = calcLessonPercent(lesson.items, progressMap);
      allItems.push(...lesson.items);
    }

    const overallPercent = calcOverallPercent(allItems, progressMap);

    await setDoc(
      doc(db, PROGRESS_SUMMARY, studentId),
      {
        studentId,
        overallPercent,
        lessonPercents,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    // Non-blocking: log but don't fail the primary action
    console.error("refreshProgressSummary failed:", err);
  }
}

export async function getProgressSummary(
  studentId: string,
): Promise<StudentProgressSummary | null> {
  try {
    const snap = await getDocFromServer(doc(db, PROGRESS_SUMMARY, studentId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as StudentProgressSummary;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Add Attempt ──────────────────────────────────────────────────────────────

export async function addAttempt(
  studentId:   string,
  lessonId:    string,
  itemId:      string,
  teacherId:   string,
  teacherRole: Role,
  notes:       string | null,
): Promise<StudentLessonProgress> {
  try {
    // Validate student
    const studentSnap = await getDocFromServer(doc(db, "users", studentId));
    if (!studentSnap.exists()) throw new Error(`USER_NOT_FOUND: ${studentId}`);
    if (studentSnap.data().role !== "student") throw new Error(`ROLE_MISMATCH: ${studentId}`);

    // Validate item + lesson
    const itemSnap = await getDocFromServer(doc(db, LESSON_ITEMS, itemId));
    if (!itemSnap.exists()) throw new Error(`ITEM_NOT_FOUND: ${itemId}`);
    const item = { id: itemSnap.id, ...itemSnap.data() } as LessonItem;

    const lessonSnap = await getDocFromServer(doc(db, LESSONS, lessonId));
    if (!lessonSnap.exists()) throw new Error(`LESSON_NOT_FOUND: ${lessonId}`);
    const lesson = { id: lessonSnap.id, ...lessonSnap.data() } as Lesson;

    // Sequential unlock check
    const { lessons: allLessons } = await getLessonsForStudent(studentId);
    const allItemsForLesson = await getItemsByLesson(lessonId);
    const unlocked = await isItemUnlocked(studentId, lesson, item, allLessons, allItemsForLesson);
    if (!unlocked) {
      throw new Error(`ITEM_LOCKED: complete the previous activity before attempting this one`);
    }

    // Load existing progress
    const progressId  = `${studentId}_${itemId}`;
    const progressRef = doc(db, STUDENT_PROGRESS, progressId);
    const existing    = await getDocFromServer(progressRef).catch(() => null);
    const current     = existing?.exists()
      ? (existing.data() as Omit<StudentLessonProgress, "id">)
      : null;

    if (current?.completed) throw new Error(`ITEM_LOCKED: ${itemId} is already completed`);

    const currentAttempts: Attempt[] = current?.attempts ?? [];
    const maxAttempts = MAX_ATTEMPTS_BY_TYPE[item.type] ?? 5;
    if (currentAttempts.length >= maxAttempts) {
      throw new Error(
        `MAX_ATTEMPTS_REACHED: ${item.type} has a limit of ${maxAttempts} attempts`
      );
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
      action:        "ATTEMPT_LOGGED",
      initiatorId:   teacherId,
      initiatorRole: teacherRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { studentId, lessonId, itemId, attemptNo, notes },
    });

    // Refresh stored progress percents (non-blocking)
    void refreshProgressSummary(studentId);

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
      action:        "ITEM_COMPLETED",
      initiatorId:   teacherId,
      initiatorRole: teacherRole,
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      {
        studentId, lessonId, itemId,
        totalAttempts:  updatedAttempts.length,
        completionDate: today,
      },
    });

    // Refresh stored progress percents (non-blocking)
    void refreshProgressSummary(studentId);

    const snap = await getDocFromServer(progressRef);
    return { id: snap.id, ...snap.data() } as StudentLessonProgress;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Live progress summary ────────────────────────────────────────────────────

export async function getLessonProgressSummary(
  studentId: string,
): Promise<LessonProgressSummary> {
  try {
    const { lessons } = await getLessonsForStudent(studentId);

    if (lessons.length === 0) {
      return { totalLessons: 0, completedLessons: 0, inProgressLessons: 0, overallPercent: 0 };
    }

    const allProgress  = await getProgressByStudent(studentId);
    const progressMap: Record<string, StudentLessonProgress> = {};
    allProgress.forEach(p => { progressMap[p.itemId] = p; });

    let completedLessons  = 0;
    let inProgressLessons = 0;
    const allItems: LessonItem[] = [];

    for (const lesson of lessons) {
      allItems.push(...lesson.items);
      if (lesson.items.length === 0) continue;

      const completed  = lesson.items.filter(i => progressMap[i.id]?.completed).length;
      const anyStarted = lesson.items.some(i =>
        (progressMap[i.id]?.attempts.length ?? 0) > 0
      );

      if (completed === lesson.items.length) completedLessons++;
      else if (anyStarted)                   inProgressLessons++;
    }

    const overallPercent = calcOverallPercent(allItems, progressMap);

    return {
      totalLessons:      lessons.length,
      completedLessons,
      inProgressLessons,
      overallPercent,
    };
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

// ─── Excel Bulk Import ────────────────────────────────────────────────────────

export interface ImportResult {
  created: number;
  skipped: number;
  errors:  string[];
}

export async function bulkImportLessons(
  rows:          ExcelImportRow[],
  scope:         { centerId: string; studentId: null } | { centerId: null; studentId: string },
  initiatorId:   string,
  initiatorRole: Role,
  overwrite:     boolean = false,
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  // Group rows by lessonNumber (preserving insertion order)
  const grouped = new Map<number, ExcelImportRow[]>();
  for (const row of rows) {
    if (!grouped.has(row.lessonNumber)) grouped.set(row.lessonNumber, []);
    grouped.get(row.lessonNumber)!.push(row);
  }

  const sortedLessonNumbers = Array.from(grouped.keys()).sort((a, b) => a - b);
  const lessonOrderMap = new Map<number, number>();
  sortedLessonNumbers.forEach((num, idx) => lessonOrderMap.set(num, idx + 1));

  const scopeField = scope.centerId ? "centerId" : "studentId";
  const scopeValue = scope.centerId ?? scope.studentId;

  for (const [lessonNumber, lessonRows] of grouped) {
    const firstRow    = lessonRows[0];
    const rowLabel    = `Lesson ${lessonNumber}`;
    const lessonOrder = lessonOrderMap.get(lessonNumber)!;

    if (!firstRow.lessonName?.trim()) {
      result.errors.push(`${rowLabel}: lessonName is required`);
      result.skipped++;
      continue;
    }

    const itemErrors: string[] = [];
    for (const row of lessonRows) {
      if (!row.itemTitle?.trim()) {
        itemErrors.push(`${rowLabel}: itemTitle is required (found empty row)`);
      }
      if (!VALID_ITEM_TYPES.includes(row.itemType?.trim().toLowerCase() as LessonItemType)) {
        itemErrors.push(
          `${rowLabel}: invalid itemType "${row.itemType}" — must be concept, exercise, or songsheet`
        );
      }
    }
    if (itemErrors.length > 0) {
      result.errors.push(...itemErrors);
      result.skipped++;
      continue;
    }

    try {
      const dupSnap = await getDocs(
        query(
          collection(db, LESSONS),
          where(scopeField, "==", scopeValue),
          where("lessonNumber", "==", lessonNumber),
        )
      );

      if (!dupSnap.empty) {
        if (!overwrite) {
          result.errors.push(`Lesson ${lessonNumber} ("${firstRow.lessonName.trim()}") already exists — skipped`);
          result.skipped++;
          continue;
        }
        // Overwrite: delete existing lesson + items
        for (const existingDoc of dupSnap.docs) {
          const existingItemsSnap = await getDocs(
            query(collection(db, LESSON_ITEMS), where("lessonId", "==", existingDoc.id))
          );
          for (const itemDoc of existingItemsSnap.docs) {
            await deleteDoc(doc(db, LESSON_ITEMS, itemDoc.id)).catch(() => null);
          }
          await deleteDoc(existingDoc.ref).catch(() => null);
        }
      }

      const lessonRef = await addDoc(collection(db, LESSONS), {
        title:        firstRow.lessonName.trim(),
        lessonNumber,
        order:        lessonOrder,
        centerId:     scope.centerId  ?? null,
        studentId:    scope.studentId ?? null,
        createdAt:    serverTimestamp(),
        updatedAt:    serverTimestamp(),
      });

      const lessonId         = lessonRef.id;
      let itemOrder          = 1;
      const createdItemRefs: string[] = [];

      try {
        for (const row of lessonRows) {
          const itemType    = row.itemType.trim().toLowerCase() as LessonItemType;
          const maxAttempts = MAX_ATTEMPTS_BY_TYPE[itemType];
          const itemRef = await addDoc(collection(db, LESSON_ITEMS), {
            lessonId,
            type:        itemType,
            title:       row.itemTitle.trim(),
            maxAttempts,
            order:       itemOrder++,
            createdAt:   serverTimestamp(),
            updatedAt:   serverTimestamp(),
          });
          createdItemRefs.push(itemRef.id);
        }
        result.created++;
      } catch (itemErr) {
        // Rollback: delete created items + lesson
        for (const id of createdItemRefs) {
          await deleteDoc(doc(db, LESSON_ITEMS, id)).catch(() => null);
        }
        await deleteDoc(lessonRef).catch(() => null);
        const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
        result.errors.push(`${rowLabel}: item creation failed and was rolled back — ${msg}`);
        result.skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${rowLabel}: ${msg}`);
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
      created: result.created,
      skipped: result.skipped,
      scope:   scope.centerId ? `center:${scope.centerId}` : `student:${scope.studentId}`,
    },
  });

  return result;
}
