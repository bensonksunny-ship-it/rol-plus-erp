// =============================================================================
// Rol's School of Music generic user accounts.
// These sign in with a login id (not an email). Firebase Auth stores a
// synthetic `${loginId}@<SOM_LOGIN_DOMAIN>` address; the real email is kept on
// the Firestore doc as contact info only.
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
import { ROLES, WINGS, loginIdToAuthEmail } from "@/config/constants";
import { wingOf } from "@/lib/wing";
import type { MemberUser, Role, User, Wing } from "@/types";

const USERS = "users";

const LOGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/;

export interface CreateMemberInput {
  displayName: string;
  email:       string;   // real contact email (optional-ish; stored as-is)
  loginId:     string;   // unique sign-in id
  password:    string;
  wing:        Wing;
}

export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidLoginId(raw: string): boolean {
  return LOGIN_ID_RE.test(normalizeLoginId(raw));
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const { initializeApp }       = await import("firebase/app");
  const { default: primaryApp } = await import("@/services/firebase/firebase");
  const secondaryApp  = initializeApp(primaryApp.options, `member-create-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  } finally {
    await fbSignOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

export async function createMember(
  input:         CreateMemberInput,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<MemberUser> {
  const loginId = normalizeLoginId(input.loginId);
  if (!isValidLoginId(loginId)) {
    throw new Error("INVALID_LOGIN_ID: use 3–32 chars, letters/numbers/._- , start and end alphanumeric");
  }
  if (input.password.length < 6) {
    throw new Error("WEAK_PASSWORD: at least 6 characters");
  }

  // Uniqueness — login id
  const dupId = await getDocs(query(collection(db, USERS), where("loginId", "==", loginId)));
  if (!dupId.empty) throw new Error(`LOGIN_ID_IN_USE: "${loginId}" is already taken`);

  const authEmail = loginIdToAuthEmail(loginId);
  const uid = await createAuthUser(authEmail, input.password);
  const userRef = doc(db, USERS, uid);

  await setDoc(userRef, {
    uid,
    role:         ROLES.MEMBER,
    wing:         input.wing ?? WINGS.SCHOOL_OF_MUSIC,
    displayName:  input.displayName.trim(),
    email:        input.email.trim().toLowerCase(),   // real contact email
    loginId,
    authEmail,                                        // synthetic Firebase Auth email
    plainPassword: input.password,                    // shown on the Founder Users page
    status:       "active",
    lastActivity: null,
    qrCodeURL:    null,
    photoURL:     null,
    createdBy:    initiatorId,
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  });

  await logAction({
    action:        "MEMBER_CREATED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { uid, loginId, wing: input.wing },
  });

  const snap = await getDocFromServer(userRef);
  return { id: snap.id, ...snap.data() } as unknown as MemberUser;
}

export async function getMembers(wing: Wing): Promise<MemberUser[]> {
  const snap = await getDocs(query(collection(db, USERS), where("role", "==", ROLES.MEMBER)));
  return snap.docs
    .map(d => ({ ...(d.data() as Record<string, unknown>) } as unknown as MemberUser))
    .filter(m => (m.wing ?? WINGS.ROL_PLUS) === wing)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Every user account, all roles (students, teachers, leadership, parents,
 * members) across both wings. `wing` on each doc tells you which school it
 * belongs to (legacy docs → "rol_plus").
 */
export async function getAllUsers(): Promise<User[]> {
  const snap = await getDocs(collection(db, USERS));
  return snap.docs
    .map(d => ({ uid: d.id, ...(d.data() as Record<string, unknown>) } as unknown as User))
    .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""));
}

/**
 * User accounts scoped to one wing (all roles). The Founder is wing-agnostic
 * and is always included.
 */
export async function getWingUsers(wing: Wing): Promise<User[]> {
  return (await getAllUsers()).filter(
    u => u.role === ROLES.FOUNDER || wingOf(u as { wing?: unknown }) === wing,
  );
}

export async function setMemberStatus(uid: string, status: "active" | "inactive"): Promise<void> {
  await setDoc(doc(db, USERS, uid), { status, updatedAt: serverTimestamp() }, { merge: true });
}
