// =============================================================================
// Admission numbers — always entered manually by leadership (e.g. the house
// format "ROLCC20112017101"); the app never generates one. A student is only
// created (enrolment, registry import) once a number has been entered.
// =============================================================================

import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { ROLES, WINGS } from "@/config/constants";

// ─── Manual entry (admissions flow) ───────────────────────────────────────────
// Admission numbers for new applications are typed in by leadership — never
// generated. Only these roles may enter or change one.
export const ADMISSION_NO_ROLES: readonly string[] = [ROLES.FOUNDER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER];
/** ROL+ Music Academy (Wing 1) is run by its Admin instead of a Chief Teacher / Director. */
export const ROL_PLUS_ADMISSION_NO_ROLES: readonly string[] = [ROLES.FOUNDER, ROLES.ADMIN];

/** Who may enter / change an admission number — per wing (defaults to School of Music). */
export function canEnterAdmissionNo(role: string | null | undefined, wing?: string | null): boolean {
  if (!role) return false;
  return (wing === WINGS.ROL_PLUS ? ROL_PLUS_ADMISSION_NO_ROLES : ADMISSION_NO_ROLES).includes(role);
}

/** Uppercase, strip anything but A–Z / 0–9 / "-", max 24 chars. */
export function cleanAdmissionNo(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
}

/**
 * Whether `admNo` is already used by a student or by another application
 * (`exceptAdmissionId` = the application being edited/enrolled).
 */
export async function isAdmissionNoTaken(admNo: string, exceptAdmissionId?: string | null): Promise<boolean> {
  const no = admNo.trim();
  if (!no) return false;
  const [students, apps] = await Promise.all([
    getDocs(query(collection(db, "users"), where("admissionNumber", "==", no))),
    getDocs(query(collection(db, "admissions"), where("admissionNumber", "==", no))),
  ]);
  return !students.empty || apps.docs.some(d => d.id !== exceptAdmissionId);
}
