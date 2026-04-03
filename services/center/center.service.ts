import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { Center, CreateCenterInput, UpdateCenterInput } from "@/types/center";

const COLLECTION = "centers";

/** Auto-increment counter for CTR001, CTR002… */
async function getNextCenterSeq(): Promise<number> {
  const ref  = doc(db, "counters", "center_global");
  const snap = await getDoc(ref);
  const next = snap.exists() ? (snap.data().seq as number) + 1 : 1;
  await setDoc(ref, { seq: next }, { merge: true });
  return next;
}

function padCode(n: number, width: number) {
  return String(n).padStart(width, "0");
}

/**
 * Create a new center. Returns the created Center with its auto-generated ID and centerCode.
 * Side-effect: adds the new centerId to teacher.centerIds so the teacher can see the centre.
 */
export async function createCenter(data: CreateCenterInput): Promise<Center> {
  const seq        = await getNextCenterSeq();
  const centerCode = `CTR${padCode(seq, 3)}`;

  const ref = await addDoc(collection(db, COLLECTION), {
    centerCode,
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

  // Sync: add this centerId to the assigned teacher's centerIds array.
  // arrayUnion is idempotent — safe to call even if already present.
  if (data.teacherUid) {
    await updateDoc(doc(db, "users", data.teacherUid), {
      centerIds: arrayUnion(ref.id),
      updatedAt: serverTimestamp(),
    }).catch(err =>
      console.warn(`[center.service] createCenter: failed to sync teacher ${data.teacherUid} centerIds:`, err)
    );
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
 * Side-effect: when teacherUid changes, removes centerId from old teacher's centerIds
 * and adds it to the new teacher's centerIds — keeps teacher ↔ student visibility consistent.
 */
export async function updateCenter(id: string, data: UpdateCenterInput): Promise<void> {
  const ref = doc(db, COLLECTION, id);

  // Read current state before writing so we can diff the teacherUid change.
  const existing = await getDocFromServer(ref);
  const prevTeacherUid = existing.exists()
    ? ((existing.data().teacherUid as string) ?? "")
    : "";

  // Only canonical fields are allowed — no spread, no unknown keys
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (data.name        !== undefined) payload.name        = data.name;
  if (data.location    !== undefined) payload.location    = data.location;
  if (data.timeSlot    !== undefined) payload.timeSlot    = data.timeSlot;
  if (data.teacherUid  !== undefined) payload.teacherUid  = data.teacherUid;
  if (data.studentUids !== undefined) payload.studentUids = data.studentUids;
  if (data.status      !== undefined) payload.status      = data.status;

  await updateDoc(ref, payload);

  // Sync teacher.centerIds when teacherUid is being changed.
  if (data.teacherUid !== undefined && data.teacherUid !== prevTeacherUid) {
    // Remove centerId from previous teacher (if any)
    if (prevTeacherUid) {
      await updateDoc(doc(db, "users", prevTeacherUid), {
        centerIds: arrayRemove(id),
        updatedAt: serverTimestamp(),
      }).catch(err =>
        console.warn(`[center.service] updateCenter: failed to remove ${id} from old teacher ${prevTeacherUid}:`, err)
      );
    }
    // Add centerId to new teacher (if any)
    if (data.teacherUid) {
      await updateDoc(doc(db, "users", data.teacherUid), {
        centerIds: arrayUnion(id),
        updatedAt: serverTimestamp(),
      }).catch(err =>
        console.warn(`[center.service] updateCenter: failed to add ${id} to new teacher ${data.teacherUid}:`, err)
      );
    }
  }
}
