// =============================================================================
// Duplicate guards + Registry merge. Matching rules live in lib/dedup.ts.
//
// Merging is always a reviewed, per-pair action (Founder / Admin / Director):
// everything that points at the duplicate student is moved to the kept one,
// then the duplicate is retired — role "merged_student", status "merged",
// mergedInto → kept uid — and taken off its centre. Never deleted, so a wrong
// merge can be traced.
// =============================================================================

import {
  arrayRemove, arrayUnion, collection, doc, getDoc, getDocs, query, serverTimestamp,
  setDoc, updateDoc, where, writeBatch,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import {
  compareKeys, findMatches, normAdmNo, normEmail, normName, normPhone,
  type DedupCandidate, type DedupMatch, type MatchLevel, type PersonKeys,
} from "@/lib/dedup";

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ─── Candidates ──────────────────────────────────────────────────────────────

function studentCandidate(id: string, d: Record<string, unknown>): DedupCandidate {
  return {
    id, kind: "student",
    name: str(d.displayName) || str(d.name), phone: str(d.phone), email: str(d.email),
    dob: str(d.dob), admissionNo: str(d.admissionNumber) || str(d.admissionNo),
    status: str(d.status) || str(d.studentStatus) || "active", centre: str(d.centerId),
  };
}

/** Students (not merged) + open applications + open enquiries to check a new entry against. */
export async function loadDedupCandidates(opts: { applications?: boolean; enquiries?: boolean } = {}): Promise<DedupCandidate[]> {
  const out: DedupCandidate[] = [];
  const jobs: Promise<void>[] = [
    getDocs(query(collection(db, "users"), where("role", "==", "student"))).then(snap => {
      snap.docs.forEach(d => { if (d.data().status !== "merged") out.push(studentCandidate(d.id, d.data())); });
    }),
  ];
  if (opts.applications !== false) {
    jobs.push(getDocs(collection(db, "admissions")).then(snap => {
      snap.docs.forEach(d => {
        const a = d.data();
        if (a.status === "enrolled" || str(a.enrolledStudentId)) return;   // represented by the student now
        out.push({
          id: d.id, kind: "application", name: str(a.fullName), phone: str(a.phone), email: str(a.email),
          dob: str(a.dob), admissionNo: str(a.admissionNumber), status: "Application", centre: str(a.centre),
        });
      });
    }));
  }
  if (opts.enquiries) {
    jobs.push(getDocs(collection(db, "enquiries")).then(snap => {
      snap.docs.forEach(d => {
        const e = d.data();
        if (e.status === "converted") return;
        out.push({
          id: d.id, kind: "enquiry", name: str(e.studentName), phone: str(e.phone),
          status: `Enquiry (${str(e.status) || "new"})`, centre: str(e.place),
        });
      });
    }));
  }
  await Promise.all(jobs);
  return out;
}

/** Matches for a new/edited person, strongest first. */
export async function checkDuplicates(
  keys: PersonKeys,
  opts: { applications?: boolean; enquiries?: boolean; excludeIds?: string[] } = {},
): Promise<DedupMatch[]> {
  const candidates = await loadDedupCandidates(opts);
  return findMatches(keys, candidates, opts.excludeIds);
}

// ─── Registry scan ───────────────────────────────────────────────────────────

export interface StudentRecord { id: string; data: Record<string, unknown> }
export interface DuplicatePair { a: StudentRecord; b: StudentRecord; level: MatchLevel; reasons: string[]; key: string }

const pairKey = (x: string, y: string) => [x, y].sort().join("__");

/** Suspected duplicate student pairs (excluding pairs marked "Keep Separate"). */
export async function scanStudentDuplicates(): Promise<DuplicatePair[]> {
  const [usersSnap, decisionsSnap] = await Promise.all([
    getDocs(query(collection(db, "users"), where("role", "==", "student"))),
    getDocs(collection(db, "dedup_decisions")),
  ]);
  const kept = new Set(decisionsSnap.docs.filter(d => d.data().decision === "separate").map(d => d.id));
  const students: StudentRecord[] = usersSnap.docs
    .filter(d => d.data().status !== "merged")
    .map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }));

  // Bucket by each key so only records sharing something are compared.
  const buckets = new Map<string, StudentRecord[]>();
  const add = (k: string, s: StudentRecord) => { if (!k) return; const b = buckets.get(k); if (b) b.push(s); else buckets.set(k, [s]); };
  for (const s of students) {
    const c = studentCandidate(s.id, s.data);
    add(`adm:${normAdmNo(c.admissionNo)}`, s);
    add(`name:${normName(c.name)}`, s);
    add(`phone:${normPhone(c.phone)}`, s);
    add(`email:${normEmail(c.email)}`, s);
  }
  const pairs = new Map<string, DuplicatePair>();
  for (const [k, list] of buckets) {
    if (list.length < 2 || k.endsWith(":")) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const key = pairKey(list[i].id, list[j].id);
      if (pairs.has(key) || kept.has(key)) continue;
      const r = compareKeys(studentCandidate(list[i].id, list[i].data), studentCandidate(list[j].id, list[j].data));
      if (r) pairs.set(key, { a: list[i], b: list[j], ...r, key });
    }
  }
  const rank: Record<MatchLevel, number> = { same: 0, possible: 1, family: 2 };
  return [...pairs.values()].sort((x, y) => rank[x.level] - rank[y.level]);
}

/** Which of two records to keep by default: active, has admission no., older. */
export function suggestPrimary(p: DuplicatePair): string {
  const score = (s: StudentRecord) =>
    (s.data.status === "active" ? 4 : 0) + (str(s.data.admissionNumber) ? 2 : 0) + (str(s.data.centerId) ? 1 : 0);
  const sa = score(p.a), sb = score(p.b);
  if (sa !== sb) return sa > sb ? p.a.id : p.b.id;
  const t = (s: StudentRecord) => {
    const v = s.data.createdAt as { toMillis?: () => number } | string | undefined;
    return typeof v === "string" ? Date.parse(v) || Infinity : v?.toMillis?.() ?? Infinity;
  };
  return t(p.a) <= t(p.b) ? p.a.id : p.b.id;
}

export async function keepSeparate(uidA: string, uidB: string, by: string): Promise<void> {
  await setDoc(doc(db, "dedup_decisions", pairKey(uidA, uidB)), {
    decision: "separate", uids: [uidA, uidB], by, at: new Date().toISOString(),
  });
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/** Collections whose docs point at a student by one field. */
const STUDENT_REFS: [collection: string, field: string][] = [
  ["transactions", "studentUid"],
  ["fees", "studentUid"],
  ["attendance", "studentUid"],
  ["attendance", "studentId"],
  ["lessons", "studentId"],
  ["student_lesson_progress", "studentId"],
  ["screenings", "studentId"],
  ["guitar-screenings", "studentId"],
  ["keyboard-screenings", "studentId"],
  ["drum-screenings", "studentId"],
  ["alerts", "studentId"],
  ["admissions", "enrolledStudentId"],
];
/** Per-student docs keyed by the student's uid — copied over only if the kept record has none. */
const STUDENT_DOCS = ["student_syllabus", "student_progress_summary"];

/** Profile fields filled from the duplicate when the kept record is blank. */
const FILL_FIELDS = [
  "phone", "email", "dob", "age", "parentName", "address1", "address2", "photo", "admissionNumber", "studentID",
  "centerId", "batchId", "batch", "dateOfAdmission", "firstClassDate", "instruments", "screening",
  "syllabusLevel", "syllabusInstrument", "monthlyFee", "feePerClass",
];

const blank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Merge `secondaryUid` into `primaryUid`. Returns how many linked records moved.
 */
export async function mergeStudents(primaryUid: string, secondaryUid: string, by: string): Promise<number> {
  if (!primaryUid || !secondaryUid || primaryUid === secondaryUid) throw new Error("Pick two different records.");
  const [pSnap, sSnap] = await Promise.all([getDoc(doc(db, "users", primaryUid)), getDoc(doc(db, "users", secondaryUid))]);
  if (!pSnap.exists() || !sSnap.exists()) throw new Error("One of the records no longer exists.");
  const P = pSnap.data() as Record<string, unknown>;
  const S = sSnap.data() as Record<string, unknown>;
  if (P.status === "merged" || S.status === "merged") throw new Error("One of these records was already merged — rescan to see the current pairs.");

  // 1. Re-point every linked record (chunked batches).
  let moved = 0;
  for (const [col, field] of STUDENT_REFS) {
    const snap = await getDocs(query(collection(db, col), where(field, "==", secondaryUid))).catch(() => null);
    if (!snap || snap.empty) continue;
    for (let i = 0; i < snap.docs.length; i += 450) {
      const b = writeBatch(db);
      snap.docs.slice(i, i + 450).forEach(d => b.update(d.ref, { [field]: primaryUid }));
      await b.commit();
    }
    moved += snap.size;
  }
  for (const col of STUDENT_DOCS) {
    const [pd, sd] = await Promise.all([getDoc(doc(db, col, primaryUid)), getDoc(doc(db, col, secondaryUid))]).catch(() => [null, null]);
    if (sd?.exists() && !pd?.exists()) await setDoc(doc(db, col, primaryUid), { ...sd.data(), studentId: primaryUid }).catch(() => {});
  }

  // 2. Kept record: fill blanks from the duplicate, carry the cached balance.
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp(), mergedFrom: arrayUnion(secondaryUid) };
  for (const f of FILL_FIELDS) if (blank(P[f]) && !blank(S[f])) patch[f] = S[f];
  const bal = (Number(P.currentBalance) || 0) + (Number(S.currentBalance) || 0);
  if (bal !== (Number(P.currentBalance) || 0)) patch.currentBalance = bal;
  await updateDoc(doc(db, "users", primaryUid), patch);

  // 3. Centre rosters: duplicate off, kept one on.
  const sCentre = str(S.centerId);
  if (sCentre) await updateDoc(doc(db, "centers", sCentre), { studentUids: arrayRemove(secondaryUid) }).catch(() => {});
  const pCentre = str(patch.centerId) || str(P.centerId);
  if (pCentre) await updateDoc(doc(db, "centers", pCentre), { studentUids: arrayUnion(primaryUid) }).catch(() => {});

  // 4. Retire the duplicate (kept for traceability). Changing the role takes it
  //    out of every `role == "student"` query — rosters, Finance, Attendance,
  //    Registry, reports — without touching each screen.
  await updateDoc(doc(db, "users", secondaryUid), {
    role: "merged_student", mergedFromRole: "student",
    status: "merged", studentStatus: "merged", mergedInto: primaryUid,
    mergedAt: new Date().toISOString(), mergedBy: by,
    centerId: "", batchId: null, currentBalance: 0, updatedAt: serverTimestamp(),
  });
  await setDoc(doc(db, "dedup_decisions", pairKey(primaryUid, secondaryUid)), {
    decision: "merged", uids: [primaryUid, secondaryUid], primary: primaryUid, by, at: new Date().toISOString(), moved,
  });
  logAction({
    action: "STUDENTS_MERGED", initiatorId: by, initiatorRole: "admin", approverId: null, approverRole: null, reason: null,
    metadata: { primaryUid, secondaryUid, moved },
  });
  return moved;
}
