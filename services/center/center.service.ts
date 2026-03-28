import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDocFromServer,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { Center, CreateCenterInput, UpdateCenterInput } from "@/types/center";

const COLLECTION = "centers";

/**
 * Create a new center. Returns the created Center with its auto-generated ID.
 */
export async function createCenter(data: CreateCenterInput): Promise<Center> {
  const ref = await addDoc(collection(db, COLLECTION), {
    name:        data.name,
    location:    data.location,
    timeSlot:    data.timeSlot,
    teacherUid:  data.teacherUid,
    studentUids: data.studentUids ?? [],
    status:      data.status,
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) {
    throw new Error("CENTER_CREATE_FAILED: document not found after write");
  }

  return { id: snap.id, ...snap.data() } as Center;
}

/**
 * Get all centers from Firestore (server read, no cache).
 */
export async function getCenters(): Promise<Center[]> {
  const snap = await getDocs(collection(db, COLLECTION));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Center);
}

/**
 * Get a single center by ID (server read, no cache).
 */
export async function getCenterById(id: string): Promise<Center> {
  const ref  = doc(db, COLLECTION, id);
  const snap = await getDocFromServer(ref);

  if (!snap.exists()) {
    throw new Error(`CENTER_NOT_FOUND: no center with id "${id}"`);
  }

  return { id: snap.id, ...snap.data() } as Center;
}

/**
 * Update a center by ID. Only updates provided fields.
 */
export async function updateCenter(id: string, data: UpdateCenterInput): Promise<void> {
  const ref = doc(db, COLLECTION, id);

  // Only canonical fields are allowed — no spread, no unknown keys
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (data.name        !== undefined) payload.name        = data.name;
  if (data.location    !== undefined) payload.location    = data.location;
  if (data.timeSlot    !== undefined) payload.timeSlot    = data.timeSlot;
  if (data.teacherUid  !== undefined) payload.teacherUid  = data.teacherUid;
  if (data.studentUids !== undefined) payload.studentUids = data.studentUids;
  if (data.status      !== undefined) payload.status      = data.status;

  await updateDoc(ref, payload);
}
