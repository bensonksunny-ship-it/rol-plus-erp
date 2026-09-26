import type { Timestamp } from "firebase/firestore";

export type BillingCycle = "monthly" | "per_class";

export interface FeeStructure {
  id:           string;
  centerId:     string;
  amount:       number;
  billingCycle: BillingCycle;
  dueDay:       number;
  lateFee:      number;
  createdAt:    Timestamp | string;
  updatedAt:    Timestamp | string;
}

export type CreateFeeStructureInput = Omit<FeeStructure, "id" | "createdAt" | "updatedAt">;

export type PaymentMethod = "UPI" | "Cash" | "Card" | "Bank" | "auto" | "auto-monthly" | "manual";
export type TransactionStatus = "completed" | "pending" | "failed" | "due";
/**
 * "admission_fee" — one-off fee paid before enrolment (School of Music).
 * Counts as money collected, but never touches a student's balance or
 * settles a monthly due.
 */
export type TransactionKind = "payment" | "deposit" | "charge" | "fee_due" | "admission_fee";

export interface Transaction {
  id:            string;
  studentUid:    string;
  centerId:      string;
  amount:        number;
  method:        PaymentMethod;
  receivedBy:    string;
  date:          string;
  status:        TransactionStatus;
  createdAt:     Timestamp | string;

  type?:         TransactionKind;
  note?:         string | null;
  billingMonth?: string;
  rawAmount?:    number;
  discountAmt?:  number;

  // Admission fee (type "admission_fee") — paid before the student exists, so
  // it carries the applicant's details; studentUid is filled in on enrolment.
  admissionId?:     string;
  payerName?:       string;
  admissionNumber?: string;
  reference?:       string | null;
}

export type CreateTransactionInput = Omit<Transaction, "id" | "createdAt">;

export type EditableTransactionInput = Pick<
  Transaction,
  "amount" | "method" | "date" | "status" | "note"
>;
