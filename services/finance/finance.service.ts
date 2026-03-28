import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDocFromServer,
  updateDoc,
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
} from "@/types/finance";

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

  return { id: snap.id, ...snap.data() } as Transaction;
}

// ─── Monthly Billing ──────────────────────────────────────────────────────────

const MONTHLY_CHARGES = "monthly_charges";

/**
 * Apply monthly fee to a student's balance.
 * Validates: student exists, has a center, feeStructure is monthly.
 * Prevents duplicate charge for the same student + billing cycle (YYYY-MM).
 * Returns true if charge applied, false if skipped (already charged or wrong cycle).
 */
export async function applyMonthlyFee(studentUid: string): Promise<boolean> {
  const student = await fetchStudent(studentUid);

  if (!student.centerId) {
    throw new Error(`STUDENT_NO_CENTER: student ${studentUid} has no assigned center`);
  }

  const feeStructure = await getFeeStructureByCenter(student.centerId);
  if (!feeStructure) {
    throw new Error(`FEE_STRUCTURE_NOT_FOUND: no fee structure for center ${student.centerId}`);
  }
  if (feeStructure.billingCycle !== "monthly") {
    return false;
  }

  // Cycle key = "YYYY-MM" — one charge per student per calendar month
  const cycleKey = new Date().toISOString().slice(0, 7);

  const duplicateSnap = await getDocs(
    query(
      collection(db, MONTHLY_CHARGES),
      where("studentUid", "==", studentUid),
      where("cycleKey",   "==", cycleKey)
    )
  );
  if (!duplicateSnap.empty) {
    return false; // already charged this month
  }

  // Record the charge to prevent duplicates
  const ref = await addDoc(collection(db, MONTHLY_CHARGES), {
    studentUid: studentUid,
    centerId:   student.centerId,
    cycleKey:   cycleKey,
    amount:     feeStructure.amount,
    createdAt:  serverTimestamp(),
  });

  const snap = await getDocFromServer(ref);
  if (!snap.exists()) throw new Error("MONTHLY_CHARGE_CREATE_FAILED: document not found after write");

  // Apply charge to student balance
  await updateDoc(doc(db, "users", studentUid), {
    currentBalance: increment(feeStructure.amount),
    updatedAt:      new Date().toISOString(),
  });

  return true;
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
