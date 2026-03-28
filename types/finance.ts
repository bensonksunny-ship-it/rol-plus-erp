import type { Timestamp } from "firebase/firestore";

export type BillingCycle = "monthly" | "per_class";

export interface FeeStructure {
  id:           string;
  centerId:     string;
  amount:       number;
  billingCycle: BillingCycle;
  dueDay:       number;         // day of month (1–31) for monthly billing
  lateFee:      number;
  createdAt:    Timestamp | string;
  updatedAt:    Timestamp | string;
}

export type CreateFeeStructureInput = Omit<FeeStructure, "id" | "createdAt" | "updatedAt">;

// ─── Transaction ──────────────────────────────────────────────────────────────

export type PaymentMethod = "UPI" | "Cash" | "Bank";
export type TransactionStatus = "completed" | "pending" | "failed";

export interface Transaction {
  id:         string;
  studentUid: string;
  centerId:   string;
  amount:     number;
  method:     PaymentMethod;
  receivedBy: string;        // UID of admin/teacher who recorded the payment
  date:       string;        // ISO date string
  status:     TransactionStatus;
  createdAt:  Timestamp | string;
}

export type CreateTransactionInput = Omit<Transaction, "id" | "createdAt">;
