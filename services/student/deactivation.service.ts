// =============================================================================
// Student inactivation — request / approve / reject.
//
// A Teacher can only *request* that a student be made inactive; the request is
// stored on the student doc (status "deactivation_requested") and waits for a
// Founder / Admin / Director / Chief Teacher to approve or reject it — from the
// Students page, the centre's student preview, or the dashboard's
// "Inactivation Requests" panel. Approvers can also inactivate directly.
//
// Approval only flips status → "inactive". centerId / batchId are kept, so:
//   • Enrollments / Attendance rosters drop the student (they list active only)
//   • Registry shows them Inactive
//   • Finance keeps listing them — its "Pending balance" filter shows anyone
//     with an outstanding balance, whatever their status, until it's paid.
// =============================================================================

import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { LEGACY_SUPER_ADMIN_ROLE, ROLES, WINGS } from "@/config/constants";
import type { Role } from "@/types";

export const DEACTIVATION_REQUESTED = "deactivation_requested";

/**
 * Roles that may approve / reject a request or inactivate a student directly,
 * per wing. ROL+ Music Academy (Wing 1) is run by its Admin; School of Music
 * (Wing 2) by the Director / Chief Teacher. The Founder approves in both.
 */
const APPROVER_ROLES = new Set<string>([ROLES.FOUNDER, LEGACY_SUPER_ADMIN_ROLE, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]);
const ROL_PLUS_APPROVER_ROLES = new Set<string>([ROLES.FOUNDER, LEGACY_SUPER_ADMIN_ROLE, ROLES.ADMIN]);
export function canApproveDeactivation(role: string | null | undefined, wing?: string | null): boolean {
  if (!role) return false;
  return (wing === WINGS.ROL_PLUS ? ROL_PLUS_APPROVER_ROLES : APPROVER_ROLES).has(role);
}

export interface Actor {
  uid: string; role: Role | string | null | undefined; name?: string;
  /** The student's wing — decides who may approve (ROL+ → Admin). */
  wing?: string | null;
}

const asRole = (r: Actor["role"]) => (r ?? ROLES.TEACHER) as Role;

/** Teacher (or anyone) asks for a student to be made inactive. */
export async function requestStudentDeactivation(studentUid: string, by: Actor, reason?: string): Promise<void> {
  const now = new Date().toISOString();
  await updateDoc(doc(db, "users", studentUid), {
    status:                      DEACTIVATION_REQUESTED,
    studentStatus:               DEACTIVATION_REQUESTED,
    deactivationApprovalStatus:  "pending",
    deactivationRequestedBy:     by.uid,
    deactivationRequestedByName: by.name ?? null,
    deactivationRequestedAt:     now,
    deactivationReason:          reason?.trim() || null,
    updatedAt:                   serverTimestamp(),
  });
  logAction({ action: "DEACTIVATION_REQUESTED", initiatorId: by.uid, initiatorRole: asRole(by.role),
    approverId: null, approverRole: null, reason: reason?.trim() || null, metadata: { studentId: studentUid } });
}

/** Approver confirms — the student becomes inactive (also used for a direct inactivation). */
export async function approveStudentDeactivation(studentUid: string, by: Actor, requestedBy?: string | null): Promise<void> {
  if (!canApproveDeactivation(by.role as string, by.wing)) throw new Error(by.wing === WINGS.ROL_PLUS ? "Only an Admin or the Founder can inactivate a ROL+ student." : "Only a Chief Teacher, Director, Admin or the Founder can inactivate a student.");
  await updateDoc(doc(db, "users", studentUid), {
    status:                     "inactive",
    studentStatus:              "inactive",
    deactivationApprovalStatus: "approved",
    deactivationApprovedBy:     by.uid,
    deactivationApprovedAt:     new Date().toISOString(),
    updatedAt:                  serverTimestamp(),
  });
  logAction({ action: "DEACTIVATION_APPROVED", initiatorId: requestedBy || by.uid, initiatorRole: asRole(requestedBy ? ROLES.TEACHER : by.role),
    approverId: by.uid, approverRole: asRole(by.role), reason: null, metadata: { studentId: studentUid } });
}

/** Approver turns the request down — the student stays active. */
export async function rejectStudentDeactivation(studentUid: string, by: Actor, requestedBy?: string | null): Promise<void> {
  if (!canApproveDeactivation(by.role as string, by.wing)) throw new Error(by.wing === WINGS.ROL_PLUS ? "Only an Admin or the Founder can reject a ROL+ request." : "Only a Chief Teacher, Director, Admin or the Founder can reject a request.");
  await updateDoc(doc(db, "users", studentUid), {
    status:                      "active",
    studentStatus:               "active",
    deactivationApprovalStatus:  "rejected",
    deactivationRequestedBy:     null,
    deactivationRequestedByName: null,
    deactivationRequestedAt:     null,
    updatedAt:                   serverTimestamp(),
  });
  logAction({ action: "DEACTIVATION_REJECTED", initiatorId: requestedBy || by.uid, initiatorRole: asRole(requestedBy ? ROLES.TEACHER : by.role),
    approverId: by.uid, approverRole: asRole(by.role), reason: null, metadata: { studentId: studentUid } });
}
