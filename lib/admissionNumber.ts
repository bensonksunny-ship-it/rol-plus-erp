// =============================================================================
// School of Music admission numbers.
// Format: <PREFIX><DDMMYYYY of admission date><zero-padded sequence>
//   e.g.  ROLCC + 20112017 + 101  →  "ROLCC20112017101"
// =============================================================================

import { collection, doc, getDoc, getDocs, query, setDoc, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { ROLES } from "@/config/constants";

/** Default org prefix for School of Music admission numbers. */
export const SOM_ADMISSION_PREFIX = "ROLCC";

const SEQ_COUNTER = doc(db, "counters", "som_admission");

function ddmmyyyy(dateISO?: string | null): string {
  const d = dateISO ? new Date(dateISO) : new Date();
  const v = Number.isNaN(d.getTime()) ? new Date() : d;
  return (
    String(v.getDate()).padStart(2, "0") +
    String(v.getMonth() + 1).padStart(2, "0") +
    String(v.getFullYear())
  );
}

/** Sanitize a prefix; fall back to the org prefix. `CTR001`-style auto centre
 *  codes are not meaningful to families, so they are ignored. */
export function admissionPrefix(centreCode?: string | null): string {
  const c = String(centreCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c || /^CTR\d+$/.test(c)) return SOM_ADMISSION_PREFIX;
  return c;
}

export function formatAdmissionNo(opts: { prefix?: string; dateISO?: string | null; seq: number }): string {
  const prefix = admissionPrefix(opts.prefix);
  return `${prefix}${ddmmyyyy(opts.dateISO)}${String(Math.max(1, opts.seq)).padStart(3, "0")}`;
}

/** True when a string already looks like an admission code: 2–8 letters, 6+ digits. */
export function looksLikeAdmissionNo(v: string): boolean {
  return /^[A-Za-z]{2,8}\d{6,}$/.test(String(v ?? "").trim());
}

/**
 * Reserve `count` sequential admission-sequence numbers atomically-ish (single
 * read + write on a shared counter doc). Returns the first reserved number;
 * callers use first, first+1, … first+count-1.
 */
export async function reserveAdmissionSeq(count = 1): Promise<number> {
  const snap = await getDoc(SEQ_COUNTER);
  const current = snap.exists() ? Number(snap.data().seq ?? 0) : 0;
  const first = current + 1;
  await setDoc(SEQ_COUNTER, { seq: current + count }, { merge: true });
  return first;
}

// ─── Manual entry (admissions flow) ───────────────────────────────────────────
// Admission numbers for new applications are typed in by leadership — never
// generated. Only these roles may enter or change one.
export const ADMISSION_NO_ROLES: readonly string[] = [ROLES.FOUNDER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER];

export function canEnterAdmissionNo(role: string | null | undefined): boolean {
  return !!role && ADMISSION_NO_ROLES.includes(role);
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
