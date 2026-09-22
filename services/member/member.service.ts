// =============================================================================
// Rol's School of Music generic user accounts.
// These sign in with a login id (not an email). Firebase Auth stores a
// synthetic `${loginId}@<SOM_LOGIN_DOMAIN>` address; the real email is kept on
// the Firestore doc as contact info only.
// =============================================================================

import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  setDoc,
  getDocs,
  getDocFromServer,
  query,
  updateDoc,
  where,
  serverTimestamp,
  writeBatch,
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
  /** Primary role for `wing`. Defaults to plain "member" (no leadership access). */
  role?:       Role;
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
    role:         input.role ?? ROLES.MEMBER,
    wing:         input.wing ?? WINGS.SCHOOL_OF_MUSIC,
    displayName:  input.displayName.trim(),
    email:        input.email.trim().toLowerCase(),   // real contact email
    loginId,
    authEmail,                                        // synthetic Firebase Auth email
    plainPassword: input.password,                    // shown on the Founder Users page
    createdVia:   "manual",
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

/**
 * Assigns (or clears) a user's role(s) in one wing, without touching their
 * roles in any other wing. `roles` replaces the full set for that wing — pass
 * every role they should hold there at once (e.g. ["admin", "teacher"]), not
 * just the one being added. Works for any account, not just members — this
 * is what the Founder Users page's "Manage Roles" action calls. See
 * types/index.ts `roles` and lib/wing.ts getRolesForWing()/getUserWings().
 */
export async function setWingRoles(uid: string, wing: Wing, roles: Role[] | null): Promise<void> {
  const unique = roles ? Array.from(new Set(roles)) : [];
  await updateDoc(doc(db, USERS, uid), {
    [`roles.${wing}`]: unique.length === 0 ? deleteField() : unique,
    updatedAt: serverTimestamp(),
  });
}

// ─── Create login (for an existing profile-only record) ─────────────────────

export interface CreateLoginInput {
  /** Existing profile-only doc id (a placeholder, not yet a real Auth uid). */
  uid:        string;
  authMethod: "email" | "loginId";
  /** Required when authMethod === "loginId". */
  loginId?:   string;
  /** Overrides the profile's existing email when authMethod === "email". */
  email?:     string;
  password:   string;
}

/**
 * Provisions a real Firebase Auth account for an existing profile-only user
 * doc (one created by a Staff/Teacher/Admin/Student form with no login) and
 * migrates the Firestore doc to a new id equal to the new Auth uid, since the
 * rest of the app assumes `users/{uid}` doc id === Firebase Auth uid. The old
 * placeholder doc is deleted, and a teacher's centerIds are re-synced to
 * `centers.teacherUid` at the new id. This is the ONLY place in the app that
 * creates a login — see app/dashboard/users/page.tsx "Create login".
 *
 * Historical references to the old placeholder id elsewhere (audit logs,
 * attendance `markedBy`, screening `screenedBy`) are left as-is: informational
 * history, not used for access control, so they go stale rather than break.
 */
export async function createLoginForUser(
  input:         CreateLoginInput,
  initiatorId:   string,
  initiatorRole: Role,
): Promise<{ uid: string }> {
  const oldRef  = doc(db, USERS, input.uid);
  const oldSnap = await getDocFromServer(oldRef);
  if (!oldSnap.exists()) throw new Error("USER_NOT_FOUND");
  const data = oldSnap.data();
  if (data.hasLogin) throw new Error("ALREADY_HAS_LOGIN");
  if (input.password.length < 6) throw new Error("WEAK_PASSWORD: at least 6 characters");

  let authEmail: string;
  let loginId: string | null = null;
  if (input.authMethod === "loginId") {
    loginId = normalizeLoginId(input.loginId ?? "");
    if (!isValidLoginId(loginId)) {
      throw new Error("INVALID_LOGIN_ID: use 3–32 chars, letters/numbers/._- , start and end alphanumeric");
    }
    const dupId = await getDocs(query(collection(db, USERS), where("loginId", "==", loginId)));
    if (dupId.docs.some(d => d.id !== input.uid)) throw new Error(`LOGIN_ID_IN_USE: "${loginId}" is already taken`);
    authEmail = loginIdToAuthEmail(loginId);
  } else {
    authEmail = (input.email ?? (data.email as string) ?? "").trim().toLowerCase();
    if (!authEmail) throw new Error("EMAIL_REQUIRED");
    const dupEmail = await getDocs(query(collection(db, USERS), where("email", "==", authEmail)));
    if (dupEmail.docs.some(d => d.id !== input.uid)) throw new Error(`EMAIL_IN_USE: "${authEmail}" is already registered`);
  }

  const newUid = await createAuthUser(authEmail, input.password);
  const newRef = doc(db, USERS, newUid);

  await setDoc(newRef, {
    ...data,
    uid:               newUid,
    email:             authEmail,
    ...(loginId ? { loginId, authEmail } : {}),
    plainPassword:     input.password,
    hasLogin:          true,
    mustResetPassword: true,
    updatedAt:         serverTimestamp(),
  });

  // Re-sync the one known cross-reference: a teacher's assigned centers.
  if (data.role === ROLES.TEACHER && Array.isArray(data.centerIds) && data.centerIds.length > 0) {
    const batch = writeBatch(db);
    for (const cid of data.centerIds as string[]) {
      batch.update(doc(db, "centers", cid), { teacherUid: newUid, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }

  await deleteDoc(oldRef);

  await logAction({
    action:        "LOGIN_CREATED",
    initiatorId,
    initiatorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { oldUid: input.uid, newUid, authMethod: input.authMethod },
  });

  return { uid: newUid };
}
