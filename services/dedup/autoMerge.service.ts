// =============================================================================
// Automatic duplicate merge — runs inside the app, no button needed.
//
// Most duplicate student records were created by the app itself (the Registry
// import once only checked the current wing, and older records keep their number
// in `admissionNo`), not by the uploaded sheet. This applies the same rules as
// "Merge all exact duplicates" (services/dedup/dedup.service) on its own:
//   same admission no. + same name        → merged into one record
//   same name, different admission numbers → recorded as "keep separate"
//   anything else                          → left for manual review
// Both wings. The kept record is the one carrying the most attendance +
// payments; after a merge it moves to the wing of its centre (no centre → it
// keeps its own wing).
//
// Runs at most once every 6 hours across all users (Firestore lock), triggered
// by a Founder / Admin / Director session and right after a Registry import.
// Merged copies are retired, never deleted (see mergeStudents).
// =============================================================================

import { collection, doc, getCountFromServer, getDoc, query, runTransaction, updateDoc, where, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import { isWing } from "@/lib/wing";
import {
  isAutoMergePair, isSameNameDifferentAdmission, keepSeparate, mergeStudents, scanStudentDuplicates, suggestPrimary,
  type StudentRecord,
} from "@/services/dedup/dedup.service";

const JOB = () => doc(db, "system_jobs", "dedup_auto_merge");
const EVERY_MS = 6 * 60 * 60 * 1000;
const LOCK_MS  = 20 * 60 * 1000;   // a run cut short (tab closed) frees the lock after this

export interface AutoMergeResult {
  merged: number;        // duplicate records retired
  keptSeparate: number;  // same-name / different-number pairs recorded
  wingMoved: number;     // kept records moved to their centre's wing
  failed: number;
}

/** Take the run lock. `force` skips the 6-hour wait (used right after an import). */
async function claim(by: string, force: boolean): Promise<boolean> {
  return runTransaction(db, async tx => {
    const snap = await tx.get(JOB());
    const d = snap.data() ?? {};
    const now = Date.now();
    if (Number(d.lockedUntil) > now) return false;
    if (!force && Number(d.lastRunAt) > now - EVERY_MS) return false;
    tx.set(JOB(), { lockedUntil: now + LOCK_MS, lockedBy: by }, { merge: true });
    return true;
  }).catch(e => { console.warn("[autoMerge] lock:", e); return false; });
}

async function history(uid: string): Promise<number> {
  const [att, tx] = await Promise.all([
    getCountFromServer(query(collection(db, "attendance"), where("studentUid", "==", uid))).catch(() => null),
    getCountFromServer(query(collection(db, "transactions"), where("studentUid", "==", uid))).catch(() => null),
  ]);
  return (att?.data().count ?? 0) + (tx?.data().count ?? 0);
}

/** Groups of records that are the same student (chains A~B~C → one group). */
function groupPairs(pairs: { a: StudentRecord; b: StudentRecord }[]): StudentRecord[][] {
  const parent = new Map<string, string>();
  const recs = new Map<string, StudentRecord>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const { a, b } of pairs) {
    recs.set(a.id, a); recs.set(b.id, b);
    const ra = find(a.id), rb = find(b.id);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, StudentRecord[]>();
  for (const [id, r] of recs) { const k = find(id); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups.values()].filter(g => g.length > 1);
}

/** Master = most attendance + payments; tie → active / has adm. no. / has centre / older. */
async function pickMaster(group: StudentRecord[]): Promise<StudentRecord> {
  const counts = await Promise.all(group.map(r => history(r.id)));
  let best = 0;
  for (let i = 1; i < group.length; i++) {
    if (counts[i] > counts[best]) best = i;
    else if (counts[i] === counts[best]
      && suggestPrimary({ a: group[best], b: group[i], level: "same", reasons: [], key: "" }) === group[i].id) best = i;
  }
  return group[best];
}

/** Move the kept record to its centre's wing. */
async function alignWing(uid: string): Promise<boolean> {
  const s = await getDoc(doc(db, "users", uid));
  const centerId = typeof s.data()?.centerId === "string" ? s.data()!.centerId as string : "";
  if (!s.exists() || !centerId) return false;
  const c = await getDoc(doc(db, "centers", centerId)).catch(() => null);
  const centreWing = c?.data()?.wing;
  if (!isWing(centreWing) || s.data()!.wing === centreWing) return false;
  await updateDoc(doc(db, "users", uid), { wing: centreWing, updatedAt: serverTimestamp() });
  return true;
}

/**
 * Run the automatic merge if it's due (and nobody else is running it).
 * Returns null when it didn't run.
 */
export async function runAutoMerge(by: string, opts: { force?: boolean } = {}): Promise<AutoMergeResult | null> {
  if (!by || !(await claim(by, !!opts.force))) return null;
  const res: AutoMergeResult = { merged: 0, keptSeparate: 0, wingMoved: 0, failed: 0 };
  try {
    const pairs = await scanStudentDuplicates();

    for (const p of pairs.filter(isSameNameDifferentAdmission)) {
      try { await keepSeparate(p.a.id, p.b.id, by); res.keptSeparate++; }
      catch (e) { console.warn("[autoMerge] keep separate:", e); }
    }

    for (const group of groupPairs(pairs.filter(isAutoMergePair))) {
      const master = await pickMaster(group);
      for (const r of group) {
        if (r.id === master.id) continue;
        try { await mergeStudents(master.id, r.id, by); res.merged++; }
        catch (e) { console.warn("[autoMerge] merge:", e); res.failed++; }
      }
      try { if (await alignWing(master.id)) res.wingMoved++; }
      catch (e) { console.warn("[autoMerge] wing:", e); }
    }

    if (res.merged || res.keptSeparate || res.failed) {
      logAction({
        action: "STUDENTS_AUTO_MERGED", initiatorId: by, initiatorRole: "admin",
        approverId: null, approverRole: null, reason: "Automatic duplicate merge (same admission no. + name)",
        metadata: { ...res },
      });
    }
    await updateDoc(JOB(), { lastRunAt: Date.now(), lockedUntil: 0, lastResult: res, lastRunBy: by });
  } catch (e) {
    console.warn("[autoMerge] run failed:", e);
    await updateDoc(JOB(), { lockedUntil: 0 }).catch(() => {});
  }
  return res;
}
