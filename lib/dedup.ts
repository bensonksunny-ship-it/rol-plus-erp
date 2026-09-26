// =============================================================================
// Duplicate-person matching — pure (no Firebase), shared by the staff screens,
// the public /apply + /enquiry API routes and the Registry "Scan & Merge
// Duplicates" tool.
//
// Rules (agreed with the school):
//   • Same admission number                          → SAME record (block)
//   • Same name + same date of birth                 → SAME person (block)
//   • Same name + same phone                         → SAME person (block)
//   • Same phone or same email, different name       → FAMILY (warn — a sibling
//                                                      or parent may share a
//                                                      number; staff can continue)
//   • Same name only                                 → POSSIBLE (warn — two
//                                                      children can share a name)
// Phone numbers are compared as 10-digit Indian mobiles (see lib/enquiry).
// =============================================================================

import { normalizePhone } from "@/lib/enquiry";

export type MatchLevel = "same" | "family" | "possible";

export interface PersonKeys {
  name?:        string;
  phone?:       string;
  email?:       string;
  dob?:         string;   // any format — compared as digits (DD/MM/YYYY vs YYYY-MM-DD handled)
  admissionNo?: string;
}

export interface DedupCandidate extends PersonKeys {
  id:     string;
  kind:   "student" | "application" | "enquiry";
  status: string;
  /** Centre name or id, for display. */
  centre?: string;
}

export interface DedupMatch {
  candidate: DedupCandidate;
  level:     MatchLevel;
  reasons:   string[];
}

export function normName(v: unknown): string {
  return (typeof v === "string" ? v : "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
export function normPhone(v: unknown): string {
  const d = normalizePhone(typeof v === "string" ? v : "");
  return d.length >= 10 ? d.slice(-10) : "";
}
export function normEmail(v: unknown): string {
  return (typeof v === "string" ? v : "").trim().toLowerCase();
}
export function normAdmNo(v: unknown): string {
  return (typeof v === "string" ? v : "").trim().toUpperCase();
}
/** Date of birth → "YYYYMMDD" from DD/MM/YYYY, YYYY-MM-DD or an ISO timestamp. */
export function normDob(v: unknown): string {
  const s = (typeof v === "string" ? v : "").trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}${m[2].padStart(2, "0")}${m[1].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return "";
}

/** How strongly `a` and `b` look like the same person (null = unrelated). */
export function compareKeys(a: PersonKeys, b: PersonKeys): { level: MatchLevel; reasons: string[] } | null {
  const reasons: string[] = [];
  const admA = normAdmNo(a.admissionNo), admB = normAdmNo(b.admissionNo);
  const nameA = normName(a.name), nameB = normName(b.name);
  const phA = normPhone(a.phone), phB = normPhone(b.phone);
  const emA = normEmail(a.email), emB = normEmail(b.email);
  const dobA = normDob(a.dob), dobB = normDob(b.dob);

  const sameAdm   = !!admA && admA === admB;
  const sameName  = !!nameA && nameA === nameB;
  const samePhone = !!phA && phA === phB;
  const sameEmail = !!emA && emA === emB;
  const sameDob   = !!dobA && dobA === dobB;

  if (sameAdm)   reasons.push("same admission number");
  if (sameName)  reasons.push("same name");
  if (sameDob)   reasons.push("same date of birth");
  if (samePhone) reasons.push("same phone");
  if (sameEmail) reasons.push("same email");

  if (sameAdm || (sameName && (sameDob || samePhone))) return { level: "same", reasons };
  if (samePhone || sameEmail) return { level: "family", reasons };
  if (sameName) return { level: "possible", reasons };
  return null;
}

const LEVEL_RANK: Record<MatchLevel, number> = { same: 0, family: 1, possible: 2 };

/** Every candidate that matches `keys`, strongest first. */
export function findMatches(keys: PersonKeys, candidates: DedupCandidate[], excludeIds: string[] = []): DedupMatch[] {
  const skip = new Set(excludeIds.filter(Boolean));
  const out: DedupMatch[] = [];
  for (const c of candidates) {
    if (skip.has(c.id)) continue;
    const r = compareKeys(keys, c);
    if (r) out.push({ candidate: c, ...r });
  }
  return out.sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level]);
}

/** "Record already exists in Registry under Admission No: X / Status: Y" */
export function duplicateMessage(m: DedupMatch): string {
  const c = m.candidate;
  const where = c.kind === "student" ? "Registry" : c.kind === "application" ? "Admissions" : "Enquiries";
  return `Record already exists in ${where} under Admission No: ${c.admissionNo?.trim() || "—"} / Status: ${c.status || "—"}`;
}
