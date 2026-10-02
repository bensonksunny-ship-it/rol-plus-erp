// =============================================================================
// Founder Suite metrics — pure functions over raw Firestore docs, per wing.
// Definitions match the rest of the app so numbers agree everywhere:
//   active student   lib/activeStudents isCurrentlyActiveStudent (active centre,
//                    "active"/"confirm", admission no.), one per centre + adm. no.
//   revenue          completed manual payments (no fee_due / charge / auto) — Center Suite
//   pending fees     this month's fee_due not yet covered by a payment — Center Suite
//   turnout          Present ÷ (Present + Absent)
//   compliance       scheduled class slots (last 7 days, up to today) with any mark
//   class days       batch → personal days → centre schedule (attendance/matrix studentDays)
// A record's wing comes from its centre (legacy docs without `wing` = ROL+).
// =============================================================================

import { isCurrentlyActiveStudent } from "@/lib/activeStudents";
import { normAdmNo } from "@/lib/dedup";
import { wingOf } from "@/lib/wing";
import { studentDays } from "@/app/dashboard/attendance/matrix";
import { classMarkState } from "@/lib/attendanceStatus";
import { centreUnits, isSplitCentre, studentUnitKey, unitTitle, NO_BATCH } from "@/lib/batchUnits";
import type { Center, Wing } from "@/types";

export type Doc = Record<string, unknown> & { id: string };
export type WingKey = Wing | "all";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dowOf = (iso: string) => DAY[new Date(iso + "T00:00:00").getDay()];

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function monthKey(offset: number): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - offset);
  return isoDate(d).slice(0, 7);
}
export const monthShort = (ym: string) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-IN", { month: "short" });

export interface Dataset {
  centres:     Center[];
  students:    Doc[];
  attendance:  Doc[];
  transactions: Doc[];
}

export interface Prepared extends Dataset {
  centreWing:   Map<string, Wing>;
  centreById:   Map<string, Center>;
  activeCentres: Center[];
  /** Deduped currently-active students. */
  active:       Doc[];
  studentWing:  Map<string, Wing>;
  /** Student uid → class key: centre id, or "centreId|batchId" in a 2+-batch centre (lib/batchUnits). */
  unitOf:       Map<string, string>;
  payments:     Doc[];
  today:        string;
}

const isPayment = (t: Doc) => {
  if (t.status !== "completed") return false;
  const type = str(t.type), method = str(t.method);
  return type !== "fee_due" && type !== "charge" && method !== "auto" && method !== "auto-monthly";
};

export function prepare(d: Dataset): Prepared {
  const centreWing = new Map(d.centres.map(c => [c.id, wingOf(c)]));
  const centreById = new Map(d.centres.map(c => [c.id, c]));
  const activeCentres = d.centres.filter(c => String(c.status ?? "active").toLowerCase() === "active");
  const activeIds = new Set(activeCentres.map(c => c.id));
  const seen = new Set<string>();
  const active = d.students.filter(s => {
    if (!isCurrentlyActiveStudent(s, activeIds)) return false;
    const k = `${str(s.centerId)}|${normAdmNo(str(s.admissionNo) || str(s.admissionNumber))}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const studentWing = new Map<string, Wing>();
  d.students.forEach(s => {
    const w = centreWing.get(str(s.centerId)) ?? wingOf(s as { wing?: unknown });
    studentWing.set(s.id, w);
  });
  const unitOf = new Map<string, string>();
  d.students.forEach(s => {
    const c = centreById.get(str(s.centerId));
    if (c) unitOf.set(s.id, studentUnitKey(c, str(s.batchId) || null));
  });
  return { ...d, centreWing, centreById, activeCentres, active, studentWing, unitOf, payments: d.transactions.filter(isPayment), today: isoDate(new Date()) };
}

/** Wing of a transaction / attendance record: its centre, else its student. */
function recWing(p: Prepared, r: Doc): Wing | undefined {
  return p.centreWing.get(str(r.centerId)) ?? p.studentWing.get(str(r.studentUid));
}
const inScope = (w: Wing | undefined, scope: WingKey) => !!w && (scope === "all" || w === scope);

// ── Headline numbers ─────────────────────────────────────────────────────────

export interface WingSummary {
  activeStudents: number;
  activeCentres:  number;
  density:        number | null;   // students per active centre
  revenue:        number;          // this month
  revenuePrev:    number;          // last month
  revenueDelta:   number | null;   // %
  pending:        number;          // ₹ this month
  pendingCount:   number;
  overdueRatio:   number | null;   // pending ÷ (collected + pending), %
  turnout:        number | null;   // this month, %
  compliance:     { expected: number; marked: number; pct: number | null };   // last 7 days
  collectionRate: number | null;   // students with this month's due who have paid, %
  daysToPay:      number | null;   // median days from fee due → payment, this month
}

export function summary(p: Prepared, scope: WingKey): WingSummary {
  const m0 = monthKey(0), m1 = monthKey(1);
  const centres = p.activeCentres.filter(c => inScope(p.centreWing.get(c.id), scope));
  const students = p.active.filter(s => inScope(p.centreWing.get(str(s.centerId)), scope));
  const pays = p.payments.filter(t => inScope(recWing(p, t), scope));
  const revenue = pays.filter(t => str(t.date).startsWith(m0)).reduce((a, t) => a + num(t.amount), 0);
  const revenuePrev = pays.filter(t => str(t.date).startsWith(m1)).reduce((a, t) => a + num(t.amount), 0);

  const { dues } = pendingDues(p, scope);
  const pending = dues.reduce((a, x) => a + x.amount, 0);

  // Fee collection velocity: due → payment, this month.
  const dueRecs = p.transactions.filter(t => str(t.type) === "fee_due" && (str(t.billingMonth) || str(t.date).slice(0, 7)) === m0 && inScope(recWing(p, t), scope));
  const firstPay = new Map<string, string>();
  pays.filter(t => str(t.date).startsWith(m0)).forEach(t => {
    const u = str(t.studentUid), dt = str(t.date).slice(0, 10);
    if (u && (!firstPay.has(u) || dt < firstPay.get(u)!)) firstPay.set(u, dt);
  });
  const dueUids = new Set(dueRecs.map(t => str(t.studentUid)).filter(Boolean));
  const paidOfDue = [...dueUids].filter(u => firstPay.has(u));
  const gaps = dueRecs.flatMap(t => {
    const pay = firstPay.get(str(t.studentUid));
    if (!pay) return [];
    const g = Math.round((Date.parse(pay) - Date.parse(str(t.date).slice(0, 10))) / 86400000);
    return Number.isFinite(g) ? [Math.max(0, g)] : [];
  }).sort((a, b) => a - b);

  return {
    activeStudents: students.length,
    activeCentres:  unitCount(centres),
    density:        unitCount(centres) ? Math.round((students.length / unitCount(centres)) * 10) / 10 : null,
    revenue, revenuePrev,
    revenueDelta:   revenuePrev > 0 ? Math.round(((revenue - revenuePrev) / revenuePrev) * 100) : null,
    pending, pendingCount: dues.length,
    overdueRatio:   revenue + pending > 0 ? Math.round((pending / (revenue + pending)) * 100) : null,
    turnout:        turnoutFor(p, scope, m0),
    compliance:     complianceFor(p, scope, 7),
    collectionRate: dueUids.size ? Math.round((paidOfDue.length / dueUids.size) * 100) : null,
    daysToPay:      gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
  };
}

/** Classes: a centre, or each batch of a centre with 2+ batches. */
const unitCount = (centres: Center[]) => centres.reduce((n, c) => n + (isSplitCentre(c) ? (c.batches ?? []).length : 1), 0);

/** Does a record / student belong to class `key` (centre id or "centreId|batchId")? */
function inUnit(p: Prepared, key: string, centreId: string, studentUid: string): boolean {
  if (!key.includes("|")) return centreId === key;
  return p.unitOf.get(studentUid) === key;
}

export function turnoutFor(p: Prepared, scope: WingKey, ym: string, centreId?: string): number | null {
  let pr = 0, ab = 0;
  p.attendance.forEach(a => {
    if (!str(a.date).startsWith(ym)) return;
    if (centreId ? !inUnit(p, centreId, str(a.centerId), str(a.studentUid)) : !inScope(recWing(p, a), scope)) return;
    if (a.status === "present") pr++; else if (a.status === "absent") ab++;
  });
  return pr + ab ? Math.round((pr / (pr + ab)) * 100) : null;
}

/** Scheduled class slots in the last `days` days (≤ today) vs those with any mark. */
export function complianceFor(p: Prepared, scope: WingKey, days: number, centreId?: string) {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); dates.push(isoDate(d)); }
  const marked = new Set(p.attendance.filter(a => a.status).map(a => `${str(a.studentUid)}|${str(a.date)}`));
  let expected = 0, done = 0;
  p.active.forEach(s => {
    const cid = str(s.centerId);
    if (centreId ? !inUnit(p, centreId, cid, s.id) : !inScope(p.centreWing.get(cid), scope)) return;
    const c = p.centreById.get(cid);
    if (!c) return;
    const sd = new Set(studentDays(
      { id: c.id, name: c.name, daysOfWeek: (c as Center & { daysOfWeek?: string[] }).daysOfWeek ?? [], batches: c.batches ?? [] },
      { uid: s.id, name: "", admissionNo: "", classType: s.classType === "personal" ? "personal" : "group",
        classDays: Array.isArray(s.classDays) ? (s.classDays as string[]) : [], batchId: str(s.batchId) || null },
    ));
    dates.forEach(d => { if (sd.has(dowOf(d))) { expected++; if (marked.has(`${s.id}|${d}`)) done++; } });
  });
  return { expected, marked: done, pct: expected ? Math.round((done / expected) * 100) : null };
}

// ── Pending fee dues (this month), largest first ────────────────────────────

export interface Due { uid: string; name: string; centreId: string; centreName: string; wing: Wing; amount: number }

export function pendingDues(p: Prepared, scope: WingKey): { dues: Due[] } {
  const m0 = monthKey(0);
  const dueAmt = new Map<string, number>();
  p.transactions.forEach(t => {
    if (str(t.type) !== "fee_due" || !str(t.studentUid)) return;
    if ((str(t.billingMonth) || str(t.date).slice(0, 7)) === m0) dueAmt.set(str(t.studentUid), num(t.amount));
  });
  const paid = new Set(p.payments.filter(t => str(t.date).startsWith(m0)).map(t => str(t.studentUid)));
  const byId = new Map(p.students.map(s => [s.id, s]));
  const dues: Due[] = [];
  dueAmt.forEach((amount, uid) => {
    if (paid.has(uid) || amount <= 0) return;
    const s = byId.get(uid);
    const w = p.studentWing.get(uid);
    if (!s || !inScope(w, scope)) return;
    const cid = str(s.centerId);
    dues.push({ uid, name: str(s.displayName) || str(s.name) || "—", centreId: cid, centreName: p.centreById.get(cid)?.name ?? "No centre", wing: w!, amount });
  });
  return { dues: dues.sort((a, b) => b.amount - a.amount) };
}

// ── 6-month growth & fall ────────────────────────────────────────────────────

export interface MonthPoint { ym: string; label: string; revenue: number; admissions: number; dropouts: number; turnout: number | null }

export function trend(p: Prepared, scope: WingKey, months = 6): MonthPoint[] {
  return Array.from({ length: months }, (_, i) => monthKey(months - 1 - i)).map(ym => {
    const revenue = p.payments.filter(t => str(t.date).startsWith(ym) && inScope(recWing(p, t), scope)).reduce((a, t) => a + num(t.amount), 0);
    let admissions = 0, dropouts = 0;
    p.students.forEach(s => {
      if (s.status === "merged" || s.role === "merged_student") return;
      if (!inScope(p.studentWing.get(s.id), scope)) return;
      if (str(s.dateOfAdmission).startsWith(ym)) admissions++;
      if (str(s.inactivatedAt).startsWith(ym)) dropouts++;
    });
    return { ym, label: monthShort(ym), revenue, admissions, dropouts, turnout: turnoutFor(p, scope, ym) };
  });
}

// ── Centre performance ───────────────────────────────────────────────────────

export interface CentreRow { id: string; name: string; wing: Wing; students: number; revenue: number; pending: number; turnout: number | null; compliance: number | null }

/** Active centres as classes: one per centre, or one per batch of a 2+-batch centre (+ "No batch" if used). */
function classesOf(p: Prepared, scope: WingKey): { key: string; centre: Center; name: string }[] {
  return p.activeCentres.filter(c => inScope(p.centreWing.get(c.id), scope)).flatMap(c => {
    const units = centreUnits(c, [] as { batchId?: string | null }[]).map(u => ({ key: u.key, centre: c, name: unitTitle(u) }));
    if (isSplitCentre(c) && p.active.some(s => p.unitOf.get(s.id) === `${c.id}|${NO_BATCH}`)) {
      units.push({ key: `${c.id}|${NO_BATCH}`, centre: c, name: `${c.name} — No batch` });
    }
    return units;
  });
}

export function centreRows(p: Prepared, scope: WingKey): CentreRow[] {
  const m0 = monthKey(0);
  const { dues } = pendingDues(p, scope);
  return classesOf(p, scope).map(({ key, centre: c, name }) => ({
    id: key, name, wing: p.centreWing.get(c.id)!,
    students: p.active.filter(s => inUnit(p, key, str(s.centerId), s.id)).length,
    revenue: p.payments.filter(t => str(t.date).startsWith(m0) && inUnit(p, key, str(t.centerId), str(t.studentUid))).reduce((a, t) => a + num(t.amount), 0),
    pending: dues.filter(d => inUnit(p, key, d.centreId, d.uid)).reduce((a, d) => a + d.amount, 0),
    turnout: turnoutFor(p, scope, m0, key),
    compliance: complianceFor(p, scope, 7, key).pct,
  })).sort((a, b) => b.revenue - a.revenue || b.students - a.students);
}

// ── Today's classes not fully marked ─────────────────────────────────────────

export interface UnmarkedClass { centreId: string; centreName: string; wing: Wing; batchName: string; time: string; teacherUid: string; ended: boolean; marked: number; expected: number }

function endMinutes(time: string): number | null {
  const m = time.match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  return m ? Number(m[3]) * 60 + Number(m[4]) : null;
}

export function unmarkedToday(p: Prepared, scope: WingKey): UnmarkedClass[] {
  const today = p.today, dow = dowOf(today);
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const recs = p.attendance.filter(a => a.date === today);
  const out: UnmarkedClass[] = [];
  p.activeCentres.forEach(c => {
    const w = p.centreWing.get(c.id)!;
    if (!inScope(w, scope)) return;
    const cd = (c as Center & { daysOfWeek?: string[] }).daysOfWeek ?? [];
    const batches = c.batches ?? [];
    const sessions = batches.length
      ? batches.filter(b => (b.daysOfWeek ?? []).includes(dow)).map(b => ({ batchName: batches.length > 1 ? b.name : "", time: b.startTime && b.endTime ? `${b.startTime}–${b.endTime}` : str(c.timeSlot), teacherUid: b.teacherUid || str(c.teacherUid) }))
      : cd.includes(dow) ? [{ batchName: "", time: str(c.timeSlot), teacherUid: str(c.teacherUid) }] : [];
    if (sessions.length === 0) return;
    const centreRecs = recs.filter(a => a.centerId === c.id).map(a => ({ studentUid: str(a.studentUid), status: str(a.status) }));
    const split = isSplitCentre(c);
    sessions.forEach((s, i) => {
      // A batch of a 2+-batch centre is its own class: its roster and marks only.
      const b = split ? batches.filter(x => (x.daysOfWeek ?? []).includes(dow))[i] : undefined;
      const key = b ? `${c.id}|${b.id}` : c.id;
      const activeUids = new Set(p.active.filter(st => inUnit(p, key, str(st.centerId), st.id)).map(st => st.id));
      if (activeUids.size === 0) return;
      const mk = classMarkState(b ? centreRecs.filter(r => activeUids.has(r.studentUid)) : centreRecs, activeUids);
      if (mk.state === "complete") return;
      const end = endMinutes(s.time);
      out.push({ centreId: c.id, centreName: c.name, wing: w, ...s, batchName: split ? s.batchName : "", ended: end === null || nowMin >= end, marked: mk.marked, expected: mk.expected });
    });
  });
  return out.sort((a, b) => Number(b.ended) - Number(a.ended) || a.time.localeCompare(b.time));
}
