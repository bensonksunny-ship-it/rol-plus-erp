// =============================================================================
// Student break: request / approve / reject.
//
// Same shape as deactivation.service.ts, and the same people approve
// (canApproveDeactivation: ROL+ → Admin / Founder; School of Music → Chief
// Teacher / Director / Admin / Founder). Writes the fields the Students page,
// Attendance and Registry already read:
//   • break_requested — still attends and stays on rosters until approved
//   • on_break        — drops off rosters; Attendance shows Break from
//                       breakStartDate
// The Students page has its own inline copy of these writes (BreakRequestModal);
// they produce identical documents.
// =============================================================================

import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { ROLES } from "@/config/constants";
import { canApproveDeactivation, type Actor } from "@/services/student/deactivation.service";
import type { Role } from "@/types";

export const BREAK_REQUESTED = "break_requested";
export const ON_BREAK = "on_break";

export const canApproveBreak = canApproveDeactivation;

const asRole = (r: Actor["role"]) => (r ?? ROLES.TEACHER) as Role;

/** Local YYYY-MM-DD (IST-safe), the default break start. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Ask for a break; an approver confirms it later. */
export async function requestStudentBreak(studentUid: string, by: Actor, reason: string): Promise<void> {
  await updateDoc(doc(db, "users", studentUid), {
    status:              BREAK_REQUESTED,
    studentStatus:       BREAK_REQUESTED,
    breakApprovalStatus: "pending",
    breakRequestedBy:    by.uid,
    breakRequestedByName: by.name ?? null,
    breakRequestedAt:    new Date().toISOString(),
    breakReason:         reason.trim(),
    updatedAt:           serverTimestamp(),
  });
  logAction({ action: "BREAK_REQUESTED", initiatorId: by.uid, initiatorRole: asRole(by.role),
    approverId: null, approverRole: null, reason: reason.trim(), metadata: { studentId: studentUid } });
}

/**
 * Put a student on break: confirms a pending request, or applies one directly
 * (pass `reason` when there was no request).
 */
export async function approveStudentBreak(
  studentUid: string, by: Actor, opts: { startDate?: string; reason?: string; requestedBy?: string | null } = {},
): Promise<string> {
  if (!canApproveBreak(by.role as string, by.wing)) throw new Error("You can't approve a break for this student.");
  const startDate = opts.startDate || todayLocal();
  await updateDoc(doc(db, "users", studentUid), {
    status:              ON_BREAK,
    studentStatus:       ON_BREAK,
    breakApprovalStatus: "approved",
    breakStartDate:      startDate,
    breakApprovedBy:     by.uid,
    breakApprovedAt:     new Date().toISOString(),
    ...(opts.reason ? { breakReason: opts.reason.trim(), breakRequestedBy: by.uid, breakRequestedAt: new Date().toISOString() } : {}),
    updatedAt:           serverTimestamp(),
  });
  logAction({ action: "BREAK_APPROVED", initiatorId: opts.requestedBy || by.uid, initiatorRole: asRole(opts.requestedBy ? ROLES.TEACHER : by.role),
    approverId: by.uid, approverRole: asRole(by.role), reason: opts.reason?.trim() || null,
    metadata: { studentId: studentUid, breakStartDate: startDate } });
  return startDate;
}

/** Turn a break request down; the student stays active. */
export async function rejectStudentBreak(studentUid: string, by: Actor): Promise<void> {
  if (!canApproveBreak(by.role as string, by.wing)) throw new Error("You can't reject a break for this student.");
  await updateDoc(doc(db, "users", studentUid), {
    status:              "active",
    studentStatus:       "active",
    breakApprovalStatus: "rejected",
    breakRequestedBy:    null,
    breakRequestedAt:    null,
    breakStartDate:      null,
    breakReason:         null,
    updatedAt:           serverTimestamp(),
  });
  logAction({ action: "BREAK_REJECTED", initiatorId: by.uid, initiatorRole: asRole(by.role),
    approverId: by.uid, approverRole: asRole(by.role), reason: null, metadata: { studentId: studentUid } });
}
