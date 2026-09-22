// =============================================================================
// Staff accounts — list the leadership + parent accounts for a wing, and edit
// a parent's linked children. All account creation (leadership, parent, admin,
// login-id members) now happens exclusively on the Founder Users page — see
// app/dashboard/users/page.tsx. Teachers remain the one profile-only exception,
// created via services/teacher/teacher.service.ts (they carry centerIds and
// centre-sync side-effects).
// =============================================================================

import {
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { ROLES } from "@/config/constants";
import { inWing } from "@/lib/wing";
import type { Wing, User } from "@/types";

const USERS = "users";

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
