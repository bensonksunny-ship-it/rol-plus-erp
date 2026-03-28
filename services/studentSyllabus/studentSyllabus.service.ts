import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  getDocFromServer,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import type {
  StudentSyllabusDoc,
  SyllabusLesson,
  SyllabusItem,
  SyllabusImportRow,
  AttemptSlots,
} from "@/types/studentSyllabus";

// ─── Collection name ──────────────────────────────────────────────────────────

const COLLECTION = "student_syllabus";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toIsoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

const VALID_TYPES = new Set(["concept", "exercise", "songsheet"]);

function normaliseType(raw: string): SyllabusItem["type"] {
  const t = raw.trim().toLowerCase();
  if (VALID_TYPES.has(t)) return t as SyllabusItem["type"];
  return "concept"; // fallback — validated before saving
}

// ─── Build lesson structure from raw import rows ──────────────────────────────

export function buildLessonsFromRows(rows: SyllabusImportRow[]): SyllabusLesson[] {
  const map = new Map<string, { items: SyllabusImportRow[]; order: number }>();
  let order = 1;

  for (const row of rows) {
    const key = row.lesson.trim();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { items: [], order: order++ });
    }
    map.get(key)!.items.push(row);
  }

  const lessons: SyllabusLesson[] = [];

  for (const [title, { items, order: lessonOrder }] of map.entries()) {
    const syllabusItems: SyllabusItem[] = items.map(row => ({
      id:            uuid(),
      type:          normaliseType(row.type),
      title:         row.title.trim(),
      attempts:      [0, 0, 0, 0, 0] as AttemptSlots,
      completed:     false,
      startDate:     null,
      completedDate: null,
    }));

    lessons.push({
      id:    uuid(),
      title,
      order: lessonOrder,
      items: syllabusItems,
    });
  }

  return lessons;
}

// ─── Validate rows before import ──────────────────────────────────────────────

export interface ImportValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSyllabusRows(rows: SyllabusImportRow[]): ImportValidationResult {
  const errors: string[] = [];

  if (rows.length === 0) {
    errors.push("No rows found in the file.");
    return { valid: false, errors };
  }

  rows.forEach((row, i) => {
    const rowNum = i + 2; // 1-based + header row
    if (!row.lesson?.trim()) errors.push(`Row ${rowNum}: "Lesson" column is empty.`);
    if (!row.title?.trim())  errors.push(`Row ${rowNum}: "Title" column is empty.`);
    if (!VALID_TYPES.has(row.type?.trim().toLowerCase())) {
      errors.push(`Row ${rowNum}: Invalid type "${row.type}" — must be concept, exercise, or songsheet.`);
    }
  });

  return { valid: errors.length === 0, errors };
}

// ─── Save syllabus to Firestore ───────────────────────────────────────────────

export async function saveStudentSyllabus(
  studentUid: string,
  lessons: SyllabusLesson[],
): Promise<void> {
  const ref = doc(db, COLLECTION, studentUid);
  await setDoc(ref, {
    studentUid,
    lessons,
    importedAt: serverTimestamp(),
    updatedAt:  serverTimestamp(),
  });
}

// ─── Fetch syllabus ───────────────────────────────────────────────────────────

export async function getStudentSyllabusDoc(
  studentUid: string,
): Promise<StudentSyllabusDoc | null> {
  const snap = await getDocFromServer(doc(db, COLLECTION, studentUid));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as StudentSyllabusDoc;
}

// ─── Mark one attempt slot ────────────────────────────────────────────────────
// Finds the next 0-slot, sets it to 1. Sets startDate on first attempt.
// Returns error string if max attempts reached or item already completed.

export async function markAttempt(
  studentUid: string,
  lessonId:   string,
  itemId:     string,
): Promise<string | null> {
  const sylDoc = await getStudentSyllabusDoc(studentUid);
  if (!sylDoc) return "Syllabus not found.";

  const lesson = sylDoc.lessons.find(l => l.id === lessonId);
  if (!lesson) return "Lesson not found.";

  const item = lesson.items.find(i => i.id === itemId);
  if (!item) return "Item not found.";

  if (item.completed) return "Item is already completed.";

  const nextSlot = item.attempts.indexOf(0);
  if (nextSlot === -1) return "Maximum 5 attempts reached.";

  const now = toIsoDate(new Date());
  item.attempts[nextSlot] = 1;
  if (nextSlot === 0) item.startDate = now; // first attempt

  const ref = doc(db, COLLECTION, studentUid);
  await setDoc(ref, { lessons: sylDoc.lessons, updatedAt: serverTimestamp() }, { merge: true });

  return null; // success
}

// ─── Mark item as completed ───────────────────────────────────────────────────

export async function markItemCompleted(
  studentUid: string,
  lessonId:   string,
  itemId:     string,
): Promise<string | null> {
  const sylDoc = await getStudentSyllabusDoc(studentUid);
  if (!sylDoc) return "Syllabus not found.";

  const lesson = sylDoc.lessons.find(l => l.id === lessonId);
  if (!lesson) return "Lesson not found.";

  const item = lesson.items.find(i => i.id === itemId);
  if (!item) return "Item not found.";

  if (item.completed) return "Already completed.";

  const now = toIsoDate(new Date());
  item.completed     = true;
  item.completedDate = now;
  if (!item.startDate) item.startDate = now; // edge case: completed before any attempt

  const ref = doc(db, COLLECTION, studentUid);
  await setDoc(ref, { lessons: sylDoc.lessons, updatedAt: serverTimestamp() }, { merge: true });

  return null; // success
}

// ─── Analytics helper (computed, not stored) ──────────────────────────────────

export function computeItemAnalytics(item: SyllabusItem): {
  attemptsUsed: number;
  daysTaken: number | null;
} {
  const attemptsUsed = item.attempts.filter(a => a === 1).length;

  let daysTaken: number | null = null;
  if (item.startDate && item.completedDate) {
    const start = new Date(item.startDate).getTime();
    const end   = new Date(item.completedDate).getTime();
    daysTaken   = Math.round((end - start) / (1000 * 60 * 60 * 24));
  }

  return { attemptsUsed, daysTaken };
}
