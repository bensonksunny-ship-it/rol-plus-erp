// Course certificate numbers — typed by staff when downloading a certificate.
// Saved per completed course on the student (`certificateNumbers[course]`) and
// registered in `certificate_numbers/{number}` so a number already used on
// another certificate can be flagged. Both wings.

import { FieldPath, deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";

/** Comparable form of a certificate number: trimmed, no spaces, upper-case. */
export function normalizeCertNo(no: string): string {
  return no.replace(/\s+/g, "").toUpperCase();
}
const keyOf = (no: string) => encodeURIComponent(normalizeCertNo(no));

/** The number saved for this student's completed course, or "". */
export async function getSavedCertificateNo(uid: string, course: string): Promise<string> {
  const snap = await getDoc(doc(db, "users", uid));
  const map = snap.data()?.certificateNumbers as Record<string, unknown> | undefined;
  const v = map?.[course];
  return typeof v === "string" ? v : "";
}

export interface CertNoUse { uid: string; course: string; studentName: string }

/** Who else already has this number — null when it's free or it's this same certificate. */
export async function findCertificateNoUse(no: string, uid: string, course: string): Promise<CertNoUse | null> {
  const snap = await getDoc(doc(db, "certificate_numbers", keyOf(no)));
  if (!snap.exists()) return null;
  const d = snap.data() as Partial<CertNoUse>;
  if (d.uid === uid && d.course === course) return null;
  return { uid: String(d.uid ?? ""), course: String(d.course ?? ""), studentName: String(d.studentName ?? "") };
}

/** Saves `no` for the student's course (replacing an earlier number). */
export async function saveCertificateNo(args: {
  uid: string; course: string; no: string; previous: string; studentName: string; wing: string;
  by: { uid: string; role: string };
}): Promise<void> {
  const { uid, course, no, previous, studentName, wing, by } = args;
  const value = no.trim();
  await setDoc(doc(db, "certificate_numbers", keyOf(value)), {
    number: value, uid, course, studentName, wing, savedBy: by.uid, savedAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "users", uid), new FieldPath("certificateNumbers", course), value, "updatedAt", serverTimestamp());
  if (previous && normalizeCertNo(previous) !== normalizeCertNo(value)) {
    // Free the old number — only if it still points at this certificate.
    const old = doc(db, "certificate_numbers", keyOf(previous));
    const snap = await getDoc(old).catch(() => null);
    const d = snap?.data();
    if (d && d.uid === uid && d.course === course) await deleteDoc(old).catch(() => {});
  }
  logAction({
    action: "CERTIFICATE_NUMBER_SET",
    initiatorId: by.uid, initiatorRole: by.role as Parameters<typeof logAction>[0]["initiatorRole"],
    approverId: null, approverRole: null, reason: null,
    metadata: { uid, course, number: value, previous: previous || null },
  });
}
