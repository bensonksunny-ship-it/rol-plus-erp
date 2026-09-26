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
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { DEFAULT_WING } from "@/config/constants";
import { inWing, wingOf } from "@/lib/wing";
import type { Wing } from "@/types";
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
    wing:        data.wing ?? DEFAULT_WING,
    monthlyFee:  data.monthlyFee ?? 0,
    batches:     data.batches ?? [],
    demoClassDate:  data.demoClassDate  ?? "",
    firstClassDate: data.firstClassDate ?? "",
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
 * Pass `wing` to scope to one music school (legacy docs with no `wing` field
 * count as the default wing).
 */
export async function getCenters(wing?: Wing): Promise<Center[]> {
  const snap = await getDocs(collection(db, COLLECTION));
  const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Center);
  return wing ? all.filter(c => inWing(c, wing)) : all;
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

export interface CenterRenameResult {
  from: string;
  to: string;
  /** Student records whose stored centre name was updated (or linked by id). */
  students: number;
  /** Admission applications whose centre name was updated. */
  applications: number;
}

/**
 * Cascade a centre rename. Everything keyed by `centerId` (attendance,
 * transactions, rosters, finance) resolves the name live and needs nothing;
 * this rewrites the places that store the centre *name* as text:
 *   users.centre       — registry imports / registry edits / centre assigns
 *                        (free-text records matching the old name are also
 *                        linked to the centre by id so they don't orphan)
 *   admissions.centre  — the application form stores the chosen centre's name
 */
export async function cascadeCenterRename(
  id: string, oldName: string, newName: string, wing: Wing,
): Promise<CenterRenameResult> {
  const oldKey = oldName.trim().toLowerCase();
  const writes: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = [];
  let students = 0, applications = 0;

  const [userSnap, admSnap] = await Promise.all([
    getDocs(query(collection(db, "users"), where("role", "==", "student"))),
    getDocs(collection(db, "admissions")),
  ]);

  userSnap.docs.forEach(d => {
    const st = d.data();
    const centre = typeof st.centre === "string" ? st.centre : "";
    const cid    = typeof st.centerId === "string" ? st.centerId : "";
    if (cid === id) {
      // Linked by id: only refresh a stored name (some records keep the id in `centre`).
      if (centre && centre !== id && centre !== newName) {
        writes.push({ ref: d.ref, data: { centre: newName, updatedAt: serverTimestamp() } });
        students++;
      }
    } else if (!cid && centre.trim().toLowerCase() === oldKey && inWing(st, wing)) {
      writes.push({ ref: d.ref, data: { centre: newName, centerId: id, updatedAt: serverTimestamp() } });
      students++;
    }
  });

  admSnap.docs.forEach(d => {
    const a = d.data();
    const centre = typeof a.centre === "string" ? a.centre : "";
    if (centre.trim().toLowerCase() === oldKey && wingOf(a) === wing) {
      writes.push({ ref: d.ref, data: { centre: newName } });
      applications++;
    }
  });

  for (let i = 0; i < writes.length; i += 450) {
    const batch = writeBatch(db);
    writes.slice(i, i + 450).forEach(w => batch.update(w.ref, w.data));
    await batch.commit();
  }
  return { from: oldName, to: newName, students, applications };
}

/**
 * Update a center by ID. Only updates provided fields.
 * Side-effects:
 *  - when teacherUid changes, removes centerId from old teacher's centerIds
 *    and adds it to the new teacher's centerIds — keeps teacher ↔ student visibility consistent.
 *  - when the name changes, cascades it to records that store the name (see
 *    cascadeCenterRename) and returns what was updated.
 */
export async function updateCenter(id: string, data: UpdateCenterInput): Promise<CenterRenameResult | null> {
  const ref = doc(db, COLLECTION, id);

  // Read current state before writing so we can diff the teacherUid / name change.
  const existing = await getDocFromServer(ref);
  const prevTeacherUid = existing.exists()
    ? ((existing.data().teacherUid as string) ?? "")
    : "";
  const prevName = existing.exists() ? String(existing.data().name ?? "") : "";
  const prevWing = (existing.exists() ? wingOf(existing.data()) : DEFAULT_WING) as Wing;

  // Only canonical fields are allowed — no spread, no unknown keys
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (data.name        !== undefined) payload.name        = data.name;
  if (data.location    !== undefined) payload.location    = data.location;
  if (data.timeSlot    !== undefined) payload.timeSlot    = data.timeSlot;
  if (data.teacherUid  !== undefined) payload.teacherUid  = data.teacherUid;
  if (data.studentUids !== undefined) payload.studentUids = data.studentUids;
  if (data.status      !== undefined) payload.status      = data.status;
  if (data.monthlyFee  !== undefined) payload.monthlyFee  = data.monthlyFee;
  if (data.batches     !== undefined) payload.batches     = data.batches;
  if (data.demoClassDate  !== undefined) payload.demoClassDate  = data.demoClassDate;
  if (data.firstClassDate !== undefined) payload.firstClassDate = data.firstClassDate;

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

  const newName = data.name?.trim();
  if (newName && prevName && newName !== prevName.trim()) {
    return cascadeCenterRename(id, prevName, newName, prevWing);
  }
  return null;
}
