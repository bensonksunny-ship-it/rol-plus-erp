import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDocFromServer,
  updateDoc,
  deleteDoc,
  increment,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { User, StudentUser, Role } from "@/types";
import type {
  FeeStructure,
  CreateFeeStructureInput,
  Transaction,
  CreateTransactionInput,
  EditableTransactionInput,
  PaymentMethod,
  TransactionStatus,
} from "@/types/finance";
import { logAction } from "@/services/audit/audit.service";

const TRANSACTIONS = "transactions";

const FEE_STRUCTURES = "fee_structures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function assertCenterExists(centerId: string): Promise<void> {
  const snap = await getDocFromServer(doc(db, "centers", centerId));
  if (!snap.exists()) throw new Error(`CENTER_NOT_FOUND: ${centerId}`);
}

async function fetchStudent(studentUid: string): Promise<StudentUser> {
  const snap = await getDocFromServer(doc(db, "users", studentUid));
  if (!snap.exists()) throw new Error(`USER_NOT_FOUND: ${studentUid}`);
  const user = snap.data() as User;
  if (user.role !== "student") throw new Error(`ROLE_MISMATCH: user ${studentUid} is not a student`);
  return user as StudentUser;
}

// ─── Fee Structure Functions ──────────────────────────────────────────────────

/**
 * Create a fee structure for a center.
 * Validates: center exists, no existing fee structure for the center.
 */
export async function createFeeStructure(
  data: CreateFeeStructureInput
): Promise<FeeStructure> {
  await assertCenterExists(data.centerId);

  // Enforce one fee structure per center
  const existing = await getDocs(
    query(collection(db, FEE_STRUCTURES), where("centerId", "==", data.centerId))
  );
  if (!existing.empty) {
    throw new Error(
      `FEE_STRUCTURE_EXISTS: center ${data.centerId} already has a fee structure`
    );
  }

  const ref = await addDoc(collection(db, FEE_STRUCTURES), {
    centerId:     data.centerId,
    amount:       data.amount,
    billingCycle: data.billingCycle,
    dueDay:       data.dueDay,
    lateFee:      data.lateFee,
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) {
    throw new Error("FEE_STRUCTURE_CREATE_FAILED: document not found after write");
  }

  return { id: snap.id, ...snap.data() } as FeeStructure;
}

// ─── Transaction Functions ────────────────────────────────────────────────────

/**
 * Create a transaction and update student balance.
 * Validates: student exists + correct role, center exists.
 * Updates: transactions collection + users.currentBalance -= amount.
 */
export async function createTransaction(
  data: CreateTransactionInput
): Promise<Transaction> {
  if (data.amount <= 0) throw new Error("INVALID_AMOUNT: amount must be greater than 0");

  await fetchStudent(data.studentUid);
  await assertCenterExists(data.centerId);

  const ref = await addDoc(collection(db, TRANSACTIONS), {
    studentUid: data.studentUid,
    centerId:   data.centerId,
    amount:     data.amount,
    method:     data.method,
    receivedBy: data.receivedBy,
    date:       data.date,
    status:     data.status,
    createdAt:  serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) throw new Error("TRANSACTION_CREATE_FAILED: document not found after write");

  // Deduct from student balance atomically
  await updateDoc(doc(db, "users", data.studentUid), {
    currentBalance: increment(-data.amount),
    updatedAt:      new Date().toISOString(),
  });

  logAction({
    action:        "TRANSACTION_CREATED",
    initiatorId:   data.receivedBy,
    initiatorRole: "admin",
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      {
      transactionId: snap.id,
      studentUid:    data.studentUid,
      centerId:      data.centerId,
      amount:        data.amount,
      method:        data.method,
      status:        data.status,
    },
  });

  return { id: snap.id, ...snap.data() } as Transaction;
}

// ─── Per-Class Billing ────────────────────────────────────────────────────────

/**
 * Auto-charge a student per class attendance.
 * Used by the attendance page after a successful markAttendance.
 * Skips center/student existence validation — caller already verified.
 */
export async function chargeStudentPerClass(
  studentUid: string,
  centerId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;

  await addDoc(collection(db, TRANSACTIONS), {
    studentUid,
    centerId,
    amount,
    method:     "auto",
    receivedBy: "system",
    date:       new Date().toISOString().slice(0, 10),
    status:     "completed",
    createdAt:  serverTimestamp(),
  });

  await updateDoc(doc(db, "users", studentUid), {
    currentBalance: increment(amount),
    updatedAt:      new Date().toISOString(),
  });

  logAction({
    action:        "PER_CLASS_FEE_APPLIED",
    initiatorId:   "system",
    initiatorRole: "admin",
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      { studentUid, centerId, amount },
  });
}

/**
 * Get all transactions.
 */
export async function getTransactions(): Promise<Transaction[]> {
  const snap = await getDocs(collection(db, TRANSACTIONS));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction);
}

/**
 * Get the fee structure for a center.
 * Returns null if none exists.
 */
export async function getFeeStructureByCenter(
  centerId: string
): Promise<FeeStructure | null> {
  const snap = await getDocs(
    query(collection(db, FEE_STRUCTURES), where("centerId", "==", centerId))
  );

  if (snap.empty) return null;

  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as FeeStructure;
}

// ─── Edit / Delete (admin) ────────────────────────────────────────────────────

/**
 * Returns the *signed* effect this transaction had on `users.currentBalance`
 * when it was originally written. To reverse, apply the negation.
 *
 * Convention used throughout the codebase:
 *   • Payment (UPI/Cash/Bank, type !== "deposit"):                    -amount  (reduces balance)
 *   • Deposit (type === "deposit"):                                   -amount  (reduces balance / adds credit)
 *   • Charge  (method === "auto"/"auto-monthly", type === "charge"/"fee_due"): +amount (increases balance / owed)
 *
 * Note: `billingMonth` deliberately plays NO part in this calculation. On a
 * fee_due it records the month being billed; on a payment it records the month
 * being settled (see computeDueSettlements). Either way the balance effect is
 * decided purely by type/method, so tagging a payment with a month never
 * changes what a student owes in total — only which due it is credited to.
 *
 * A "fee_due" transaction applies its charge the moment it's generated
 * (status "due"), independent of whether it's later marked "completed" by a
 * payment — so it counts as a charge regardless of status.
 */
export function transactionBalanceEffect(tx: Transaction): number {
  const isCharge =
    tx.method === "auto-monthly" ||
    tx.method === "auto" ||
    tx.type === "charge" ||
    tx.type === "fee_due";
  if (isCharge) return tx.amount;
  // Payments/deposits only count once actually received.
  if (tx.status !== "completed") return 0;
  return -tx.amount;
}

/**
 * Single source of truth for a student's outstanding balance:
 * Total Dues Generated − Total Payments Received, derived directly from the
 * transaction ledger rather than the denormalized `users.currentBalance`
 * cache (which can drift if a charge is ever applied without a matching
 * transaction record).
 *
 * Pass `asOfDate` (YYYY-MM-DD) to reconstruct the balance as of a past date;
 * omit it for the live balance.
 */
export function computeStudentBalances(
  transactions: Transaction[],
  asOfDate?: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const tx of transactions) {
    if (!tx.studentUid) continue;
    if (asOfDate && (tx.date ?? "").slice(0, 10) > asOfDate) continue;
    map.set(tx.studentUid, (map.get(tx.studentUid) ?? 0) + transactionBalanceEffect(tx));
  }
  return map;
}

// ─── Due settlement (which payments cleared which month) ──────────────────────

export type DueState = "unpaid" | "partial" | "paid";

export interface DueSettlement {
  dueId:        string;
  studentUid:   string;
  billingMonth: string;   // "YYYY-MM"
  dueAmount:    number;
  paidAmount:   number;   // total explicitly credited to this month
  remaining:    number;   // dueAmount − paidAmount, floored at 0
  state:        DueState;
}

/** True for a real money-in receipt (not a due, charge, or system auto-entry). */
export function isSettlingPayment(tx: Transaction): boolean {
  if (tx.status !== "completed") return false;
  if (tx.type === "fee_due" || tx.type === "charge") return false;
  if (tx.method === "auto" || tx.method === "auto-monthly") return false;
  return true;
}

/**
 * The month a payment is explicitly credited to — `null` if it isn't tagged.
 *
 * Only new payments (recorded with the month picker) carry `billingMonth`.
 * Deliberately NOT falling back to "the payment's own date" here: a payment
 * dated this month is not reliably FOR this month — arrears paid late, an
 * unrelated deposit, anything logged with today's date regardless of which
 * bill it actually settles. Guessing by date previously caused a genuinely
 * unpaid month to read as settled whenever any same-month payment existed,
 * which made overdue students silently vanish from the list without any
 * data actually changing. See computeDueSettlements for how untagged
 * payments are handled instead (the due's own status field).
 */
export function paymentSettlesMonth(tx: Transaction): string | null {
  return tx.billingMonth ?? null;
}

/**
 * Reconciles every fee_due against the payments explicitly credited to its
 * month, keyed by `${studentUid}|${billingMonth}`.
 *
 * A due with at least one explicitly-tagged payment is reconciled by amount —
 * this is what lets a ₹500 payment against a ₹2,000 due leave ₹1,500 still
 * outstanding instead of closing the whole bill.
 *
 * A due with NO tagged payment (i.e. every historical due, until it receives
 * its first payment recorded through the new month picker) falls back to its
 * own `status` field — exactly what the app trusted before this reconciliation
 * existed, so historical records keep behaving as they always have.
 */
export function computeDueSettlements(transactions: Transaction[]): Map<string, DueSettlement> {
  const key = (uid: string, month: string) => `${uid}|${month}`;
  const settlements = new Map<string, DueSettlement>();
  const legacyStatus = new Map<string, TransactionStatus>();

  // 1) Seed one entry per fee_due.
  for (const tx of transactions) {
    if (!tx.studentUid || tx.type !== "fee_due") continue;
    const billingMonth = tx.billingMonth || (tx.date ?? "").slice(0, 7);
    if (!billingMonth) continue;
    const k = key(tx.studentUid, billingMonth);
    const existing = settlements.get(k);
    // Defensive: if a month was somehow billed twice, treat the total as owed
    // rather than dropping one silently.
    settlements.set(k, {
      dueId:        existing?.dueId ?? tx.id,
      studentUid:   tx.studentUid,
      billingMonth,
      dueAmount:    (existing?.dueAmount ?? 0) + tx.amount,
      paidAmount:   0,
      remaining:    0,
      state:        "unpaid",
    });
    legacyStatus.set(k, tx.status);
  }

  // 2) Credit only explicitly-tagged payments to their month.
  for (const tx of transactions) {
    if (!tx.studentUid || !isSettlingPayment(tx)) continue;
    const month = paymentSettlesMonth(tx);
    if (month === null) continue;   // untagged — resolved via legacy status below
    const k = key(tx.studentUid, month);
    const s = settlements.get(k);
    if (!s) continue;   // payment with no matching due — counts toward balance, not a settlement
    s.paidAmount += tx.amount;
  }

  // 3) Resolve state.
  settlements.forEach((s, k) => {
    if (s.paidAmount > 0) {
      // At least one tagged payment exists — reconcile by amount.
      s.remaining = Math.max(0, s.dueAmount - s.paidAmount);
      s.state = s.remaining > 0 ? "partial" : "paid";
      return;
    }
    // No tagged payment found for this due — trust the due's own status
    // field, exactly as the app did before amount-based reconciliation
    // existed. This is what keeps historical dues (paid the old way, before
    // payments recorded which month they settled) showing correctly instead
    // of being re-guessed from unrelated same-month transactions.
    const wasCompleted = legacyStatus.get(k) === "completed";
    s.remaining = wasCompleted ? 0 : s.dueAmount;
    s.state     = wasCompleted ? "paid" : "unpaid";
  });

  return settlements;
}

/** Every month a student still owes something on, oldest first. */
export function outstandingDuesForStudent(
  settlements: Map<string, DueSettlement>,
  studentUid: string,
): DueSettlement[] {
  return Array.from(settlements.values())
    .filter(s => s.studentUid === studentUid && s.remaining > 0)
    .sort((a, b) => a.billingMonth.localeCompare(b.billingMonth));
}

// ─── Record a payment ─────────────────────────────────────────────────────────

export interface RecordPaymentInput {
  studentUid:   string;
  centerId:     string;
  amount:       number;          // net received, after any discount
  rawAmount?:   number;          // pre-discount amount, if a discount was applied
  discountAmt?: number;
  discountType?: string;
  method:       PaymentMethod;
  receivedBy:   string;
  date:         string;          // YYYY-MM-DD — the date money actually changed hands
  note?:        string | null;
  billingMonth: string | null;   // "YYYY-MM" this settles; null = unallocated credit
}

/**
 * Single entry point for recording money received. Replaces the two divergent
 * implementations that previously existed (the Finance page's inline panel and
 * the student profile's RecordPaymentModal), which disagreed on three things:
 *
 *   1. Which due got closed — one used the page's selected month, so paying a
 *      student whose unpaid due was from a different month silently marked
 *      nothing at all.
 *   2. `paidAt` — one stamped today regardless of the payment date the admin
 *      had just typed, so backdated payments recorded the wrong day.
 *   3. Discounts — supported in one flow only.
 *
 * A due is now closed only when it is actually settled in full; a short payment
 * leaves the remainder outstanding.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<void> {
  if (input.amount <= 0) throw new Error("INVALID_AMOUNT: amount must be greater than 0");

  const payDate = input.date || new Date().toISOString().slice(0, 10);

  // 1) Write the receipt.
  await addDoc(collection(db, TRANSACTIONS), {
    studentUid:   input.studentUid,
    centerId:     input.centerId,
    amount:       input.amount,
    rawAmount:    input.rawAmount && input.rawAmount !== input.amount ? input.rawAmount : null,
    discountAmt:  input.discountAmt && input.discountAmt > 0 ? input.discountAmt : null,
    discountType: input.discountAmt && input.discountAmt > 0 ? (input.discountType ?? null) : null,
    method:       input.method,
    receivedBy:   input.receivedBy,
    note:         input.note?.trim() || null,
    date:         payDate,
    billingMonth: input.billingMonth,   // the month this settles
    status:       "completed",
    createdAt:    serverTimestamp(),
  });

  // 2) Reduce the denormalized balance cache.
  await updateDoc(doc(db, "users", input.studentUid), {
    currentBalance: increment(-input.amount),
    updatedAt:      new Date().toISOString(),
  });

  // 3) Close the targeted due only if it is now fully settled. Re-read the
  //    ledger rather than trusting a stale client snapshot, so concurrent
  //    payments can't both conclude the due is still short.
  if (!input.billingMonth) return;

  const snap = await getDocs(
    query(collection(db, TRANSACTIONS), where("studentUid", "==", input.studentUid)),
  );
  const txs = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction);
  const settlement = computeDueSettlements(txs).get(`${input.studentUid}|${input.billingMonth}`);
  if (!settlement) return;

  const dueRef = doc(db, TRANSACTIONS, settlement.dueId);
  if (settlement.remaining <= 0) {
    await updateDoc(dueRef, { status: "completed", paidAt: payDate });
  } else {
    // Still short — make sure a previously-closed due reopens if this write
    // followed an edit that reduced an earlier payment.
    await updateDoc(dueRef, { status: "due", paidAt: null });
  }
}

/**
 * Edit an existing transaction. Reconciles `users.currentBalance` by the delta.
 * Only the fields in EditableTransactionInput may change.
 *
 * If the new amount differs from the old, balance moves by:
 *   delta = newEffect - oldEffect
 *   (e.g. payment 2000 → 2500 ⇒ oldEffect=-2000, newEffect=-2500, delta=-500 ⇒ balance -= 500)
 */
export async function editTransaction(
  txId: string,
  patch: EditableTransactionInput,
  editorUid: string,
  editorRole: Role,
): Promise<Transaction> {
  if (patch.amount <= 0) throw new Error("INVALID_AMOUNT: amount must be greater than 0");

  const txRef  = doc(db, TRANSACTIONS, txId);
  const txSnap = await getDocFromServer(txRef);
  if (!txSnap.exists()) throw new Error(`TRANSACTION_NOT_FOUND: ${txId}`);
  const oldTx = { id: txSnap.id, ...txSnap.data() } as Transaction;

  // Build the projected new transaction (locked fields preserved from old)
  const newTx: Transaction = {
    ...oldTx,
    amount:  patch.amount,
    method:  patch.method,
    date:    patch.date,
    status:  patch.status,
    note:    patch.note ?? null,
  };

  const oldEffect = transactionBalanceEffect(oldTx);
  const newEffect = transactionBalanceEffect(newTx);
  const delta     = newEffect - oldEffect;

  // 1) Persist the patch
  await updateDoc(txRef, {
    amount:    patch.amount,
    method:    patch.method,
    date:      patch.date,
    status:    patch.status,
    note:      patch.note ?? null,
    updatedAt: new Date().toISOString(),
    editedBy:  editorUid,
  });

  // 2) Reconcile student balance by the delta (only if non-zero)
  if (delta !== 0 && oldTx.studentUid) {
    await updateDoc(doc(db, "users", oldTx.studentUid), {
      currentBalance: increment(delta),
      updatedAt:      new Date().toISOString(),
    });
  }

  // 3) Audit
  logAction({
    action:        "TRANSACTION_EDITED",
    initiatorId:   editorUid,
    initiatorRole: editorRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata: {
      transactionId: txId,
      studentUid:    oldTx.studentUid,
      centerId:      oldTx.centerId,
      before: {
        amount: oldTx.amount,
        method: oldTx.method,
        date:   oldTx.date,
        status: oldTx.status,
        note:   oldTx.note ?? null,
      },
      after: {
        amount: newTx.amount,
        method: newTx.method,
        date:   newTx.date,
        status: newTx.status,
        note:   newTx.note ?? null,
      },
      balanceDelta: delta,
    },
  });

  return newTx;
}

/**
 * Hard-delete a transaction. Reverses its effect on `users.currentBalance`.
 * If the transaction was an auto-monthly fee-due charge, also clears the
 * student's `lastBilledMonth` if it matches — re-opening the cycle so a new
 * fee due can be generated for that month.
 */
export async function deleteTransaction(
  txId: string,
  deleterUid: string,
  deleterRole: Role,
): Promise<void> {
  const txRef  = doc(db, TRANSACTIONS, txId);
  const txSnap = await getDocFromServer(txRef);
  if (!txSnap.exists()) throw new Error(`TRANSACTION_NOT_FOUND: ${txId}`);
  const tx = { id: txSnap.id, ...txSnap.data() } as Transaction;

  const oldEffect = transactionBalanceEffect(tx);

  // 1) Reverse the balance effect (subtract the original effect)
  if (oldEffect !== 0 && tx.studentUid) {
    await updateDoc(doc(db, "users", tx.studentUid), {
      currentBalance: increment(-oldEffect),
      updatedAt:      new Date().toISOString(),
    });
  }

  // 2) If this was a fee-due generation, reopen the cycle for that student/month
  if (tx.method === "auto-monthly" && tx.billingMonth && tx.studentUid) {
    const studentRef  = doc(db, "users", tx.studentUid);
    const studentSnap = await getDocFromServer(studentRef);
    if (studentSnap.exists()) {
      const data = studentSnap.data() as { lastBilledMonth?: string };
      if (data.lastBilledMonth === tx.billingMonth) {
        await updateDoc(studentRef, {
          lastBilledMonth: null,
          updatedAt:       new Date().toISOString(),
        });
      }
    }
  }

  // 3) Hard delete
  await deleteDoc(txRef);

  // 4) Audit
  logAction({
    action:        "TRANSACTION_DELETED",
    initiatorId:   deleterUid,
    initiatorRole: deleterRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata: {
      transactionId: txId,
      studentUid:    tx.studentUid,
      centerId:      tx.centerId,
      amount:        tx.amount,
      method:        tx.method,
      date:          tx.date,
      status:        tx.status,
      billingMonth:  tx.billingMonth ?? null,
      reversedEffect: -oldEffect,
    },
  });
}
