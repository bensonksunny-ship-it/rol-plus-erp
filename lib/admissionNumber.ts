// =============================================================================
// School of Music admission numbers.
// Format: <PREFIX><DDMMYYYY of admission date><zero-padded sequence>
//   e.g.  ROLCC + 20112017 + 101  →  "ROLCC20112017101"
// =============================================================================

import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";

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
