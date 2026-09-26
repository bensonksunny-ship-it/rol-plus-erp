// Server-only duplicate check for the public /apply and /enquiry routes
// (Admin SDK — never import from a "use client" file).

import { adminDb } from "@/services/firebase/firebase-admin";
import { findMatches, type DedupCandidate, type DedupMatch, type PersonKeys } from "@/lib/dedup";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function checkDuplicatesServer(keys: PersonKeys, opts: { enquiries?: boolean } = {}): Promise<DedupMatch[]> {
  const db = adminDb();
  const out: DedupCandidate[] = [];
  const [users, apps, enq] = await Promise.all([
    db.collection("users").where("role", "==", "student").get(),
    db.collection("admissions").get(),
    opts.enquiries ? db.collection("enquiries").get() : Promise.resolve(null),
  ]);
  users.docs.forEach(d => {
    const u = d.data();
    if (u.status === "merged") return;
    out.push({ id: d.id, kind: "student", name: str(u.displayName) || str(u.name), phone: str(u.phone), email: str(u.email), dob: str(u.dob), admissionNo: str(u.admissionNumber), status: str(u.status) });
  });
  apps.docs.forEach(d => {
    const a = d.data();
    if (a.status === "enrolled" || str(a.enrolledStudentId)) return;
    out.push({ id: d.id, kind: "application", name: str(a.fullName), phone: str(a.phone), email: str(a.email), dob: str(a.dob), admissionNo: str(a.admissionNumber), status: "Application" });
  });
  enq?.docs.forEach(d => {
    const e = d.data();
    if (e.status === "converted") return;
    out.push({ id: d.id, kind: "enquiry", name: str(e.studentName), phone: str(e.phone), status: "Enquiry" });
  });
  return findMatches(keys, out);
}
