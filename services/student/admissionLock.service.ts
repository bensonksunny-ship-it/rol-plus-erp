// =============================================================================
// Admission-number lock — one student per admission number per wing.
//
// Firestore has no unique indexes, so each number is reserved in
// `admission_locks/{wing}__{NUMBER}` → { uid, wing, admNo }, claimed inside a
// transaction (two people saving the same number at once can't both win).
// Every place that creates a student or changes a student's number claims it
// first. A reservation whose holder is gone (merged away, deleted, moved to
// another number/wing) is stale and is simply taken over — so merges and old
// records never jam the lock. Numbers already in use before the lock existed
// are caught by the pre-check against live student records.
// =============================================================================

import {
  collection, deleteDoc, doc, getDoc, getDocs, query, runTransaction, where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { normAdmNo } from "@/lib/dedup";
import { wingOf } from "@/lib/wing";

const LOCKS = "admission_locks";
const str = (v: unknown) => (typeof v === "string" ? v : "");

const lockRef = (wing: string, norm: string) =>
  doc(db, LOCKS, `${wing}__${norm.replace(/[^A-Z0-9-]/g, "_")}`);

/** A student doc still holds `norm` in `wing` (not merged / deleted). */
function holds(data: Record<string, unknown> | undefined, wing: string, norm: string): boolean {
  if (!data || data.role !== "student") return false;
  if (data.status === "merged" || data.status === "deleted") return false;
  if (wingOf(data) !== wing) return false;
  return normAdmNo(str(data.admissionNumber) || str(data.admissionNo)) === norm;
}

export class AdmissionNoTakenError extends Error {
  constructor(public admNo: string, public holderName: string) {
    super(`Admission number ${admNo} is already used by ${holderName || "another student"} in this wing. Each admission number can belong to only one student.`);
  }
}

/**
 * Reserve `admNo` in `wing` for student `uid` (an existing id, or one generated
 * with doc(collection(db, "users")) before creating the student). Throws
 * AdmissionNoTakenError when another live student in the wing has it.
 */
export async function claimAdmissionNo(wing: string, admNo: string, uid: string): Promise<void> {
  const norm = normAdmNo(admNo);
  if (!norm || !uid) return;

  // Numbers in use from before the lock (no reservation yet): check live records.
  const raw = admNo.trim();
  const variants = [...new Set([raw, norm])];
  const snaps = await Promise.all(variants.flatMap(v => [
    getDocs(query(collection(db, "users"), where("admissionNumber", "==", v))),
    getDocs(query(collection(db, "users"), where("admissionNo", "==", v))),
  ]));
  const other = snaps.flatMap(s => s.docs).find(d => d.id !== uid && holds(d.data(), wing, norm));
  if (other) throw new AdmissionNoTakenError(raw, str(other.data().displayName) || str(other.data().name));

  const ref = lockRef(wing, norm);
  await runTransaction(db, async tx => {
    const lock = await tx.get(ref);
    const holder = lock.exists() ? str(lock.data().uid) : "";
    if (holder && holder !== uid) {
      const h = await tx.get(doc(db, "users", holder));
      if (h.exists() && holds(h.data(), wing, norm)) {
        throw new AdmissionNoTakenError(raw, str(h.data()?.displayName) || str(h.data()?.name));
      }
      // stale reservation → take it over
    }
    tx.set(ref, { uid, wing, admNo: norm, claimedAt: new Date().toISOString() });
  });
}

/** Free `admNo` in `wing` if `uid` holds it (number changed / record removed). Best-effort. */
export async function releaseAdmissionNo(wing: string, admNo: string, uid: string): Promise<void> {
  const norm = normAdmNo(admNo);
  if (!norm || !uid) return;
  const ref = lockRef(wing, norm);
  const snap = await getDoc(ref).catch(() => null);
  if (snap?.exists() && snap.data().uid === uid) await deleteDoc(ref).catch(() => {});
}
