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
/** "waived" — a fee_due written off ("Un-due"), see lib/feeWaiver.ts. */
export type TransactionStatus = "completed" | "pending" | "failed" | "due" | "waived";
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

  // Waiver ("Un-due") on a fee_due — status "waived".
  waivedAmount?:  number;
  waiveReason?:   string | null;
  waivedBy?:      string;
  waivedByName?:  string | null;
  waivedAt?:      string;
  /** Status before the waiver, so the record shows what was reversed. */
  statusBeforeWaive?: TransactionStatus;
}

export type CreateTransactionInput = Omit<Transaction, "id" | "createdAt">;

export type EditableTransactionInput = Pick<
  Transaction,
  "amount" | "method" | "date" | "status" | "note"
>;
