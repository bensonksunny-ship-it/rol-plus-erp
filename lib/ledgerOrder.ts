// One ordering for every student ledger (Finance → History, Student →
// Financial Statement), both wings:
//   1. months newest first, keyed by the billing month the row belongs to
//      (not the day the money moved: October's fee paid on 3 Nov is October);
//   2. inside a month, Due first, then charges, then what was paid;
//   3. ties → newest date first.

type LedgerTx = {
  type?: string | null;
  method?: string | null;
  billingMonth?: string | null;
  date?: unknown;
  createdAt?: unknown;
};

function dateStr(tx: LedgerTx): string {
  const d = tx.date ?? tx.createdAt;
  if (typeof d === "string") return d;
  if (d && typeof (d as { toDate?: unknown }).toDate === "function") {
    return (d as { toDate: () => Date }).toDate().toISOString();
  }
  return d instanceof Date ? d.toISOString() : "";
}

/** "YYYY-MM" the row belongs to: its billing month, else the month of its date. */
export function ledgerMonthOf(tx: LedgerTx): string {
  return tx.billingMonth || dateStr(tx).slice(0, 7);
}

function rank(tx: LedgerTx): number {
  if (tx.type === "fee_due") return 0;                                   // Due
  if (tx.type === "charge" || tx.method === "auto" || tx.method === "auto-monthly") return 1;
  if (tx.type === "admission_fee") return 2;
  if (tx.type === "deposit") return 4;
  return 3;                                                              // Paid
}

export function compareLedger(a: LedgerTx, b: LedgerTx): number {
  return ledgerMonthOf(b).localeCompare(ledgerMonthOf(a))
      || rank(a) - rank(b)
      || dateStr(b).localeCompare(dateStr(a));
}
