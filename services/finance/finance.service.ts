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
import type { User, StudentUser } from "@/types";
import type {
  FeeStructure,
  CreateFeeStructureInput,
  Transaction,
  CreateTransactionInput,
  EditableTransactionInput,
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
 *   • Payment (UPI/Cash/Bank, no billingMonth, type !== "deposit"): -amount  (reduces balance)
 *   • Deposit (type === "deposit"):                                  -amount  (reduces balance / adds credit)
 *   • Charge  (method === "auto" or "auto-monthly"):                +amount  (increases balance / owed)
 */
function balanceEffectFor(tx: Transaction): number {
  const isCharge =
    tx.method === "auto-monthly" ||
    tx.method === "auto" ||
    tx.type === "charge";
  return isCharge ? +tx.amount : -tx.amount;
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
  editorRole: "admin" | "super_admin",
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

  const oldEffect = balanceEffectFor(oldTx);
  const newEffect = balanceEffectFor(newTx);
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
  deleterRole: "admin" | "super_admin",
): Promise<void> {
  const txRef  = doc(db, TRANSACTIONS, txId);
  const txSnap = await getDocFromServer(txRef);
  if (!txSnap.exists()) throw new Error(`TRANSACTION_NOT_FOUND: ${txId}`);
  const tx = { id: txSnap.id, ...txSnap.data() } as Transaction;

  const oldEffect = balanceEffectFor(tx);

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
