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
