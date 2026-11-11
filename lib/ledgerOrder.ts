// One ordering for every student ledger (Finance → History / Recent, Student →
// Financial Statement, student portal → My Fees), both wings:
//   1. months oldest first, keyed by the billing month the row belongs to
//      (not the day the money moved: October's fee paid on 3 Nov is October);
//   2. inside a month, Due first, then charges, then what was paid;
//   3. ties → oldest date first.
//
// Rows arrive in every shape the collection has accumulated: `date` as a
// "YYYY-MM-DD" string, a Firestore Timestamp, a Date, a number or missing;
// `billingMonth` as "YYYY-MM", null or absent (legacy backdated rows carry
// `billedMonth` instead). Everything is normalised here so no view has to.
//
// A payment recorded without a month (unallocated credit, or any receipt
// written before the month picker existed) belongs with the due it settled.
// There is no stored link for that, so `ledgerMonths` pairs it through the
// only allocation metadata the service writes: the due's `paidAt`, stamped
// with the payment date when the due closed. When nothing pairs, the payment
// stays in the month of its own date, below that month's due.

export type LedgerTx = {
  id?:           string;
  studentUid?:   string | null;
  type?:         string | null;
  method?:       string | null;
  status?:       string | null;
  billingMonth?: unknown;
  /** Legacy backdated rows (Ledger History page) stored the month under this key. */
  billedMonth?:  unknown;
  /** Explicit link to the fee_due a payment settles, if a writer ever adds one. */
  dueId?:        unknown;
  date?:         unknown;
  createdAt?:    unknown;
  paidAt?:       unknown;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Any date-ish value → an ISO-like string that sorts lexicographically
 * ("YYYY-MM-DD" or a full ISO timestamp), or "" when it can't be read.
 */
export function ledgerDateStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;                 // YYYY-MM-DD or ISO
    if (/^\d{4}-\d{1,2}$/.test(s)) return ledgerMonthKey(s) + "-01";
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : "";
  }
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  if (typeof v === "object") {
    const o = v as { toDate?: unknown; seconds?: unknown; _seconds?: unknown };
    if (typeof o.toDate === "function") {                        // Firestore Timestamp
      const d = (o as { toDate: () => Date }).toDate();
      return Number.isNaN(d.getTime()) ? "" : d.toISOString();
    }
    const secs = typeof o.seconds === "number" ? o.seconds : typeof o._seconds === "number" ? o._seconds : null;
    if (secs !== null) return new Date(secs * 1000).toISOString();   // serialised Timestamp
  }
  return "";
}

/** Any month-ish value ("2026-10", "2026-10-01", "October 2026", a date) → "YYYY-MM", or "". */
export function ledgerMonthKey(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    const s = v.trim();
    const m = /^(\d{4})-(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${pad2(Number(m[2]))}`;
    if (!s) return "";
    const t = new Date(s);                                        // "October 2026", "Oct 2026", …
    return Number.isNaN(t.getTime()) ? "" : `${t.getFullYear()}-${pad2(t.getMonth() + 1)}`;
  }
  return ledgerDateStr(v).slice(0, 7);
}

/** The day the row happened: its date, else when it was written, else when it was settled. */
export function ledgerDateOf(tx: LedgerTx): string {
  return ledgerDateStr(tx.date) || ledgerDateStr(tx.createdAt) || ledgerDateStr(tx.paidAt);
}

/** The month a row is explicitly tagged with, or "" when untagged. */
function taggedMonth(tx: LedgerTx): string {
  return ledgerMonthKey(tx.billingMonth) || ledgerMonthKey(tx.billedMonth);
}

/** "YYYY-MM" the row belongs to on its own: its billing month, else the month of its date. */
export function ledgerMonthOf(tx: LedgerTx): string {
  return taggedMonth(tx) || ledgerDateOf(tx).slice(0, 7);
}

/** 0 Due · 1 Charge · 2 Admission fee · 3 Paid · 4 Deposit (credit). */
export function ledgerRank(tx: LedgerTx): number {
  if (tx.type === "fee_due") return 0;
  if (tx.type === "charge" || tx.type === "adjustment"
      || tx.method === "auto" || tx.method === "auto-monthly") return 1;
  if (tx.type === "admission_fee") return 2;
  if (tx.type === "deposit") return 4;
  return 3;
}

/**
 * The month every row belongs to, with untagged payments paired to the due
 * they settled where the data allows. Keyed by row identity, so pass the same
 * objects you render.
 *
 * Pairing, in order:
 *   1. an explicit `dueId` on the payment → that due's month, always;
 *   2. the one due whose `paidAt` is the payment's date — but only when that
 *      due's month has no payment of its own yet and no other untagged payment
 *      shares the day. Legacy dues had `paidAt` stamped with the day they were
 *      *recorded*, which can coincide with an unrelated later payment, so an
 *      already-paid month or an ambiguous day falls back to the date month.
 */
export function ledgerMonths<T extends LedgerTx>(txs: readonly T[]): Map<T, string> {
  const months = new Map<T, string>();
  const dues = txs.filter(t => t.type === "fee_due");
  const uidOf = (t: LedgerTx) => t.studentUid || "";
  const sameStudent = (a: LedgerTx, b: LedgerTx) => !uidOf(a) || !uidOf(b) || uidOf(a) === uidOf(b);

  // Months that already hold a payment on their own (tagged, or by date) and
  // how many untagged payments fall on each day — both before any pairing.
  const paidMonths = new Set<string>();
  const untaggedPerDay = new Map<string, number>();
  for (const t of txs) {
    if (ledgerRank(t) !== 3) continue;
    paidMonths.add(`${uidOf(t)}|${ledgerMonthOf(t)}`);
    if (!taggedMonth(t)) {
      const k = `${uidOf(t)}|${ledgerDateOf(t).slice(0, 10)}`;
      untaggedPerDay.set(k, (untaggedPerDay.get(k) ?? 0) + 1);
    }
  }

  for (const tx of txs) {
    let month = ledgerMonthOf(tx);
    if (ledgerRank(tx) === 3 && !taggedMonth(tx)) {
      const linked = typeof tx.dueId === "string" && tx.dueId
        ? dues.find(d => d.id === tx.dueId) : undefined;
      if (linked) {
        month = ledgerMonthOf(linked) || month;
      } else {
        const payDay = ledgerDateOf(tx).slice(0, 10);
        const unambiguous = !!payDay && untaggedPerDay.get(`${uidOf(tx)}|${payDay}`) === 1;
        const candidates = new Set(
          dues.filter(d => unambiguous && sameStudent(d, tx) && ledgerDateStr(d.paidAt).slice(0, 10) === payDay)
              .map(ledgerMonthOf).filter(Boolean),
        );
        if (candidates.size === 1) {
          const m = candidates.values().next().value as string;
          if (!paidMonths.has(`${uidOf(tx)}|${m}`)) month = m;
        }
      }
    }
    months.set(tx, month);
  }
  return months;
}

function compareWithin(a: LedgerTx, b: LedgerTx, monthA: string, monthB: string): number {
  // Oldest first, like a bank statement (user's choice 2026-11-11):
  // Sep Due → Sep Paid → Oct Due → Oct Paid.
  return monthA.localeCompare(monthB)
      || ledgerRank(a) - ledgerRank(b)
      || ledgerDateOf(a).localeCompare(ledgerDateOf(b))
      || ledgerDateStr(a.createdAt).localeCompare(ledgerDateStr(b.createdAt))
      || String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/** Context-free comparator (no due pairing). Prefer `sortLedger` for a student's rows. */
export function compareLedger(a: LedgerTx, b: LedgerTx): number {
  return compareWithin(a, b, ledgerMonthOf(a), ledgerMonthOf(b));
}

/**
 * The canonical statement order for one student's rows: oldest month first,
 * Due → Charge → Paid → Deposit inside a month, oldest date first on ties.
 * Returns a new array; the input is left as is.
 */
export function sortLedger<T extends LedgerTx>(txs: readonly T[]): T[] {
  const months = ledgerMonths(txs);
  return [...txs].sort((a, b) => compareWithin(a, b, months.get(a) ?? "", months.get(b) ?? ""));
}
