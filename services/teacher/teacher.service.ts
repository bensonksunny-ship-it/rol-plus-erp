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
import {
  createUserWithEmailAndPassword,
  getAuth,
  signOut as fbSignOut,
} from "firebase/auth";
import { deleteApp } from "firebase/app";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type { TeacherUser } from "@/types";
import type { Role } from "@/types";

const USERS = "users";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateTeacherInput {
  displayName: string;
  email:       string;
  password:    string;
  centerIds:   string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a secondary Firebase App instance so we can call
 * createUserWithEmailAndPassword without displacing the current
 * admin session.
 */
async function createAuthUserInSecondaryApp(
  email:    string,
  password: string,
): Promise<string> {
  const { initializeApp }   = await import("firebase/app");
  const { default: primaryApp } = await import("@/services/firebase/firebase");

  const secondaryApp  = initializeApp(primaryApp.options, `teacher-create-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  } finally {
    await fbSignOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

// ─── Create teacher ───────────────────────────────────────────────────────────

/**
 * Creates a Firebase Auth user + Firestore user doc with role:"teacher".
 * centerIds are written at creation time and also synced back to each
 * center's teacherUid field.
 *
 * Throws on duplicate email (Firestore or Firebase Auth).
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

  // ── Create Firebase Auth user ─────────────────────────────────────────────
  const uid = await createAuthUserInSecondaryApp(email, input.password);

  // ── Write Firestore user doc ──────────────────────────────────────────────
  const userRef = doc(db, USERS, uid);
  await setDoc(userRef, {
    uid,
    email,
    displayName:  input.displayName.trim(),
    role:         "teacher",
    centerIds:    input.centerIds,
    status:       "active",
    lastActivity: null,
    qrCodeURL:    null,
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

// ─── Get all teachers ─────────────────────────────────────────────────────────

export async function getTeachers(): Promise<TeacherUser[]> {
  const snap = await getDocs(
    query(collection(db, USERS), where("role", "==", "teacher"))
  );
  return snap.docs.map(d => ({ ...d.data() } as TeacherUser));
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
