// =============================================================================
// Staff accounts — create / list the leadership + parent accounts for a wing.
// Teachers are still created via services/teacher/teacher.service.ts (they carry
// centerIds and centre-sync side-effects); this module covers founder-created
// admins is out of scope — see app/dashboard/admins. Here: director,
// chief_teacher, parent.
// =============================================================================

import {
  collection,
  doc,
  setDoc,
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
import { ROLES, DEFAULT_WING } from "@/config/constants";
import { inWing } from "@/lib/wing";
import type { Role, Wing, User } from "@/types";

const USERS = "users";

/** Roles this module can provision. */
export type StaffRole =
  | typeof ROLES.DIRECTOR
  | typeof ROLES.CHIEF_TEACHER
  | typeof ROLES.PARENT;

export interface CreateStaffInput {
  displayName: string;
  email:       string;
  password:    string;
  role:        StaffRole;
  wing:        Wing;
  childUids?:  string[];   // parent only
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const { initializeApp }       = await import("firebase/app");
  const { default: primaryApp } = await import("@/services/firebase/firebase");
  const secondaryApp  = initializeApp(primaryApp.options, `staff-create-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  } finally {
    await fbSignOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

export async function createStaffUser(
  input:         CreateStaffInput,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<User> {
  const email = input.email.trim().toLowerCase();

  const dup = await getDocs(query(collection(db, USERS), where("email", "==", email)));
  if (!dup.empty) throw new Error(`EMAIL_IN_USE: "${email}" is already registered`);

  const uid = await createAuthUser(email, input.password);
  const userRef = doc(db, USERS, uid);

  await setDoc(userRef, {
    uid,
    email,
    displayName:  input.displayName.trim(),
    role:         input.role,
    wing:         input.wing ?? DEFAULT_WING,
    plainPassword: input.password,   // shown on the Founder Users page
    status:       "active",
    lastActivity: null,
    qrCodeURL:    null,
    photoURL:     null,
    ...(input.role === ROLES.PARENT ? { childUids: input.childUids ?? [] } : {}),
    createdBy:    initiatorId,
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  });

  await logAction({
    action:        "STAFF_CREATED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { uid, email, role: input.role, wing: input.wing },
  });

  const snap = await getDocFromServer(userRef);
  return { id: snap.id, ...snap.data() } as unknown as User;
}

/** All leadership + parent accounts scoped to a wing (excludes students). */
export async function getStaffUsers(wing: Wing): Promise<User[]> {
  const roles = [
    ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER,
    ROLES.TEACHER, ROLES.PARENT,
  ];
  const snap = await getDocs(
    query(collection(db, USERS), where("role", "in", roles)),
  );
  return snap.docs
    .map(d => ({ ...(d.data() as Record<string, unknown>) } as unknown as User))
    .filter(u => u.role === ROLES.FOUNDER || inWing(u as { wing?: unknown }, wing));
}

/** Update a parent's linked children. */
export async function setParentChildren(parentUid: string, childUids: string[]): Promise<void> {
  await setDoc(
    doc(db, USERS, parentUid),
    { childUids, updatedAt: serverTimestamp() },
    { merge: true },
  );
}
