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
export const ADMISSION_NO_ROLES: readonly string[] = [ROLES.FOUNDER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.OFFICE_MANAGER];
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

// ─── Who owns a number? (edit / intake interceptor) ──────────────────────────

const normNameKey = (v: unknown) =>
  (typeof v === "string" ? v : "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export type AdmissionNoCheck =
  | { kind: "free" }
  /** Same name + same number — an existing student: offer to merge into them. */
  | { kind: "match"; studentUid: string; studentName: string; student: Record<string, unknown> }
  /** The number belongs to someone with a different name — block. */
  | { kind: "conflict"; ownerName: string }
  /** Same name, but only another (not yet enrolled) application holds the number — block. */
  | { kind: "application"; ownerName: string };

/**
 * Classify `admNo` for a person called `name` (both wings; numbers are unique
 * across them). Students are matched on `admissionNumber` and the legacy
 * `admissionNo`; merged-away copies and the application being edited
 * (`exceptAdmissionId`) are ignored, as are applications already enrolled as
 * the matched student.
 */
export async function checkAdmissionNo(admNo: string, name: string, exceptAdmissionId?: string | null): Promise<AdmissionNoCheck> {
  const no = admNo.trim();
  if (!no) return { kind: "free" };
  const [byNumber, byLegacy, apps] = await Promise.all([
    getDocs(query(collection(db, "users"), where("admissionNumber", "==", no))),
    getDocs(query(collection(db, "users"), where("admissionNo", "==", no))),
    getDocs(query(collection(db, "admissions"), where("admissionNumber", "==", no))),
  ]);
  const students = new Map<string, Record<string, unknown>>();
  for (const d of [...byNumber.docs, ...byLegacy.docs]) {
    const s = d.data();
    if (s.status === "merged" || s.role === "merged_student") continue;
    students.set(d.id, s);
  }
  const otherApps = apps.docs
    .filter(d => d.id !== exceptAdmissionId)
    .map(d => d.data())
    .filter(a => !(typeof a.enrolledStudentId === "string" && students.has(a.enrolledStudentId)));

  const want = normNameKey(name);
  const nameOf = (r: Record<string, unknown>) => String(r.displayName || r.name || r.fullName || "");
  const other = [...students.values(), ...otherApps].find(r => normNameKey(nameOf(r)) !== want);
  if (other) return { kind: "conflict", ownerName: nameOf(other) || "another student" };

  // Prefer an active record, then one with a centre.
  const hit = [...students.entries()].sort(([, a], [, b]) =>
    Number(b.status === "active") - Number(a.status === "active") || Number(!!b.centerId) - Number(!!a.centerId))[0];
  if (hit) return { kind: "match", studentUid: hit[0], studentName: nameOf(hit[1]), student: hit[1] };
  if (otherApps.length) return { kind: "application", ownerName: nameOf(otherApps[0]) };
  return { kind: "free" };
}

/** The messages the interceptor shows for a blocked number. */
export function admissionNoBlockedMessage(no: string, c: AdmissionNoCheck): string {
  if (c.kind === "conflict")
    return `Admission number ${no} belongs to another student (${c.ownerName}). Please verify or assign a unique admission number.`;
  if (c.kind === "application")
    return `Admission number ${no} is already on another application for ${c.ownerName}. Open that application instead, or assign a unique admission number.`;
  return "";
}
