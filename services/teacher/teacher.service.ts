import {
  collection,
  doc,
  setDoc,
  updateDoc,
  getDocs,
  getDocFromServer,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { DEFAULT_WING, ROLES } from "@/config/constants";
import { getRolesForWing } from "@/lib/wing";
import type { TeacherUser, User, Wing } from "@/types";
import type { Role } from "@/types";

const USERS = "users";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateTeacherInput {
  displayName:    string;
  preferredName?: string;
  email:          string;
  centerIds:      string[];
  wing?:          Wing;
}

// ─── Create teacher ───────────────────────────────────────────────────────────

/**
 * Creates a profile-only Firestore user doc with role:"teacher" — no Firebase
 * Auth account. A login is provisioned separately, only via the Founder
 * Users page's "Create login" action (services/member/member.service.ts
 * createLoginForUser()), which also migrates this doc to the real Auth uid.
 * centerIds are written at creation time and also synced back to each
 * center's teacherUid field (using this doc's placeholder id in the
 * meantime — createLoginForUser() re-syncs it once a login exists).
 *
 * Throws on duplicate email.
 */
export async function createTeacher(
  input:         CreateTeacherInput,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<TeacherUser> {
  const email = input.email.trim().toLowerCase();

  // ── Duplicate email guard ─────────────────────────────────────────────────
  const dupSnap = await getDocs(
    query(collection(db, USERS), where("email", "==", email))
  );
  if (!dupSnap.empty) {
    throw new Error(`EMAIL_IN_USE: "${email}" is already registered`);
  }

  // ── Write Firestore user doc (placeholder id — no Auth account yet) ──────
  const uid = doc(collection(db, USERS)).id;
  const userRef = doc(db, USERS, uid);
  await setDoc(userRef, {
    uid,
    email,
    displayName:  input.displayName.trim(),
    preferredName: input.preferredName?.trim() ?? "",
    role:         "teacher",
    centerIds:    input.centerIds,
    wing:         input.wing ?? DEFAULT_WING,
    createdVia:   "manual",
    hasLogin:     false,
    status:       "active",
    lastActivity: null,
    qrCodeURL:    null,
    photoURL:     null,
    createdBy:    initiatorId,
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  });

  // ── Sync teacherUid on each assigned center ───────────────────────────────
  await Promise.all(
    input.centerIds.map(cid =>
      updateDoc(doc(db, "centers", cid), {
        teacherUid: uid,
        updatedAt:  serverTimestamp(),
      }).catch(err => console.error(`Failed to sync center ${cid}:`, err))
    )
  );

  await logAction({
    action:        "TEACHER_CREATED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { uid, email, centerIds: input.centerIds },
  });

  const snap = await getDocFromServer(userRef);
  return { id: snap.id, ...snap.data() } as unknown as TeacherUser;
}

// ─── Profile picture upload ────────────────────────────────────────────────────

/**
 * Uploads a teacher's profile picture to Firebase Storage and returns its
 * download URL. Does not touch the Firestore doc — callers persist the URL
 * (e.g. via updateDoc({ photoURL })) so it can be paired with other field
 * updates in a single write.
 */
export async function uploadTeacherPhoto(uid: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const photoRef = ref(storage, `teacher-photos/${uid}.${ext}`);
  await uploadBytes(photoRef, file);
  return getDownloadURL(photoRef);
}

// ─── Get all teachers ─────────────────────────────────────────────────────────

/**
 * Every account that holds the Teacher role for `wing` — whether that's
 * their legacy scalar `role` (accounts created directly as a teacher) or a
 * role granted via the Founder Users page's "Manage roles" (e.g. an Admin
 * also holding Teacher in some wing). Two targeted queries, merged and
 * de-duped, then re-checked with getRolesForWing() so the merge can't
 * include someone whose Teacher access was explicitly revoked via Manage
 * roles even though their legacy `role` field still says "teacher".
 */
export async function getTeachers(wing?: Wing): Promise<TeacherUser[]> {
  const queries = [getDocs(query(collection(db, USERS), where("role", "==", "teacher")))];
  if (wing) {
    queries.push(getDocs(query(collection(db, USERS), where(`roles.${wing}`, "array-contains", "teacher"))));
  }
  const snaps = await Promise.all(queries);

  const byId = new Map<string, TeacherUser>();
  for (const snap of snaps) {
    for (const d of snap.docs) byId.set(d.id, { uid: d.id, ...d.data() } as unknown as TeacherUser);
  }
  const all = Array.from(byId.values());
  if (!wing) return all;

  return all.filter(t => getRolesForWing(t as unknown as User, wing).includes(ROLES.TEACHER));
}

// ─── Update teacher's assigned centers ────────────────────────────────────────

/**
 * Replaces the teacher's centerIds array and syncs teacherUid on affected centers.
 *
 * Centers removed from the teacher are cleared (teacherUid → "").
 * Centers added to the teacher get teacherUid set to uid.
 */
export async function updateTeacherCenters(
  teacherUid:    string,
  newCenterIds:  string[],
  initiatorId:   string,
  initiatorRole: Role,
): Promise<void> {
  const userRef  = doc(db, USERS, teacherUid);
  const userSnap = await getDocFromServer(userRef);
  if (!userSnap.exists()) throw new Error(`USER_NOT_FOUND: ${teacherUid}`);

  const prev: string[] = (userSnap.data().centerIds as string[]) ?? [];

  // Update teacher doc
  await updateDoc(userRef, {
    centerIds: newCenterIds,
    updatedAt: serverTimestamp(),
  });

  // Removed centers — clear teacherUid
  const removed = prev.filter(id => !newCenterIds.includes(id));
  // Added centers — set teacherUid
  const added   = newCenterIds.filter(id => !prev.includes(id));

  await Promise.all([
    ...removed.map(cid =>
      updateDoc(doc(db, "centers", cid), { teacherUid: "", updatedAt: serverTimestamp() })
        .catch(err => console.error(`Failed to clear center ${cid}:`, err))
    ),
    ...added.map(cid =>
      updateDoc(doc(db, "centers", cid), { teacherUid: teacherUid, updatedAt: serverTimestamp() })
        .catch(err => console.error(`Failed to set center ${cid}:`, err))
    ),
  ]);

  await logAction({
    action:        "TEACHER_CENTERS_UPDATED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { teacherUid, prev, next: newCenterIds },
  });
}
