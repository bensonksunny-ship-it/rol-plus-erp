// =============================================================================
// Fee waivers ("Un-due"). A fee_due that is no longer owed (the student went on
// break or discontinued) is never deleted: its status becomes "waived" and it
// records how much was written off, who did it and why. Every place that sums
// dues or balances reads the waived part through waivedAmountOf, so a waived
// due stops counting as owed everywhere at once while the ledger keeps the
// record.
//
// Only the part still unpaid at the time is waived. Money already received
// against that month stays a normal payment.
// =============================================================================

export const WAIVED = "waived";

/** Any transaction-shaped record: typed Transactions and raw Firestore docs alike. */
type TxLike = object;
type TxFields = { type?: unknown; status?: unknown; amount?: unknown; waivedAmount?: unknown };

/** The rupees written off on this transaction (0 for anything but a waived due). */
export function waivedAmountOf(record: TxLike): number {
  const tx = record as TxFields;
  if (tx.type !== "fee_due" || tx.status !== WAIVED) return 0;
  const amount = Number(tx.amount ?? 0) || 0;
  const waived = tx.waivedAmount == null ? amount : Number(tx.waivedAmount) || 0;
  return Math.min(Math.max(waived, 0), amount);
}

/** What a fee_due still charges after any waiver: its amount minus the waived part. */
export function chargedAmountOf(record: TxLike): number {
  return (Number((record as TxFields).amount ?? 0) || 0) - waivedAmountOf(record);
}

export function isWaivedDue(tx: TxLike): boolean {
  return waivedAmountOf(tx) > 0;
}

// ─── Payment discounts ───────────────────────────────────────────────────────
// A payment's `amount` is the cash actually received (after discount). The
// discount itself is a concession on the fee: it must also come off what the
// student owes, otherwise a ₹2,800 due paid as ₹1,950 + ₹850 discount keeps
// showing ₹850 due. Money-received totals (Collected, statements) still use
// `amount` alone — only balances and due settlement add the discount.

/** The discount given on a payment (0 for dues, charges and plain payments). */
export function discountAmountOf(record: TxLike): number {
  const tx = record as TxFields & { discountAmt?: unknown };
  if (tx.type === "fee_due" || tx.type === "charge") return 0;
  return Math.max(0, Number(tx.discountAmt ?? 0) || 0);
}

/** What a payment takes off the balance: cash received + any discount given. */
export function creditedAmountOf(record: TxLike): number {
  return (Number((record as TxFields).amount ?? 0) || 0) + discountAmountOf(record);
}
