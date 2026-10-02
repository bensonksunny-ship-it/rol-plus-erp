// One active centre per student (both wings, each within its own wing).
//
// A student doc carries a single `centerId`, so one record can't be in two
// centres — but two records of the same person (same admission number) can
// each be active in a different centre, and centres keep a `studentUids`
// roster mirror that a centre change must also update. Every path that sets a
// student's centre (centre "+" picker, Students edit, Registry edit) calls
// enforceSingleActiveCentre() so the person ends up active in exactly one.

import { arrayRemove, collection, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { normAdmNo } from "@/lib/dedup";
import { isActiveStudentStatus, hasAdmissionNo } from "@/lib/activeStudents";
import { wingOf } from "@/lib/wing";

export interface SingleCentreResult {
  /** Other records of the same person that were active elsewhere and are now Inactive. */
  inactivated: { uid: string; centerId: string }[];
}

/**
 * Call after (or together with) moving `uid` to `targetCenterId`.
 *  - removes `uid` from its previous centre's roster mirror (`prevCenterId`), and
 *  - marks Inactive every OTHER record in the same wing with the same admission
 *    number that is still active in a different centre (removing it from that
 *    centre's mirror). History, attendance and finance stay on those records.
 */
export async function enforceSingleActiveCentre(args: {
  uid: string;
  admissionNo: string;
  wing: string;
  targetCenterId: string;
  prevCenterId?: string | null;
  /** The moved record is active at the target (default). False → only fix the roster mirror. */
  active?: boolean;
}): Promise<SingleCentreResult> {
  const { uid, admissionNo, wing, targetCenterId, prevCenterId, active = true } = args;
  const batch = writeBatch(db);
  let writes = 0;
  // Roster mirrors are best-effort — a deleted centre must not block the move.
  const mirrorRemovals: { centerId: string; uid: string }[] = [];

  if (prevCenterId && prevCenterId !== targetCenterId) mirrorRemovals.push({ centerId: prevCenterId, uid });

  const inactivated: SingleCentreResult["inactivated"] = [];
  const key = normAdmNo(admissionNo);
  if (active && hasAdmissionNo(admissionNo) && key) {
    // Admission numbers live under either field name, possibly with spacing differences.
    const variants = [...new Set([admissionNo.trim(), key])];
    const snaps = await Promise.all(variants.flatMap(v => [
      getDocs(query(collection(db, "users"), where("role", "==", "student"), where("admissionNo", "==", v))),
      getDocs(query(collection(db, "users"), where("role", "==", "student"), where("admissionNumber", "==", v))),
    ]));
    const seen = new Set<string>([uid]);
    for (const snap of snaps) {
      for (const d of snap.docs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const st = d.data();
        if (wingOf(st) !== wing) continue;
        if (normAdmNo(st.admissionNo ?? st.admissionNumber) !== key) continue;
        const cid = typeof st.centerId === "string" ? st.centerId : "";
        if (!cid || cid === targetCenterId) continue;
        if (!isActiveStudentStatus(st.status ?? st.studentStatus)) continue;
        batch.update(d.ref, {
          status: "inactive", studentStatus: "inactive",
          inactivatedAt: new Date().toISOString(),
          inactivatedReason: "moved_to_other_centre",
          movedToCenterId: targetCenterId,
          updatedAt: serverTimestamp(),
        });
        mirrorRemovals.push({ centerId: cid, uid: d.id });
        writes++;
        inactivated.push({ uid: d.id, centerId: cid });
      }
    }
  }

  if (writes > 0) await batch.commit();
  await Promise.all(mirrorRemovals.map(m =>
    updateDoc(doc(db, "centers", m.centerId), { studentUids: arrayRemove(m.uid) })
      .catch(err => console.warn("[singleCentre] roster mirror not updated:", m.centerId, err))));
  return { inactivated };
}
