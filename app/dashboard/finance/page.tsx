"use client";

import { useState, useEffect, useMemo, useRef, Fragment, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, doc, serverTimestamp,
  increment,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuth } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import {
  getTransactions,
  editTransaction,
  deleteTransaction,
  computeStudentBalances,
  computeDueSettlements,
  outstandingDuesForStudent,
  isSettlingPayment,
  recordPayment,
  type DueSettlement,
} from "@/services/finance/finance.service";
import type {
  Transaction,
  EditableTransactionInput,
  PaymentMethod,
  TransactionStatus,
} from "@/types/finance";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StudentFeeRow {
  uid:             string;
  name:            string;
  studentID:       string;
  admissionNo:     string;
  centerName:      string;
  centerId:        string;
  classType:       string;   // "group" | "personal"
  billingMode:     string;   // "postpay" | "prepay"
  feeCycle:        string;
  feePerClass:     number;
  monthlyFee:      number;
  balance:         number;   // <0 = prepay credit remaining; >0 = owes money
  status:          string;
  attendanceCount: number;
  estimatedFee:    number;
}

interface CenterOption { id: string; name: string; centerCode: string; }

type PayMethod      = "UPI" | "Cash" | "Bank";
type DiscountType   = "fixed" | "percent";
// Which inline panel is open for a student row
type RowAction      = "pay" | "adjust" | "deposit" | "history";

// ─── Constants ─────────────────────────────────────────────────────────────────

const METHOD_STYLES: Record<string, React.CSSProperties> = {
  UPI:            { background: "#ede9fe", color: "#4f46e5" },
  Cash:           { background: "#dcfce7", color: "#16a34a" },
  Bank:           { background: "#dbeafe", color: "#1d4ed8" },
  auto:           { background: "#f3f4f6", color: "#374151" },
  "auto-monthly": { background: "#fef9c3", color: "#b45309" },
  deposit:        { background: "#fce7f3", color: "#9d174d" },
};

const STATUS_BADGE: Record<string, React.CSSProperties> = {
  completed: { background: "#dcfce7", color: "#16a34a" },
  pending:   { background: "#fef9c3", color: "#b45309" },
  failed:    { background: "#fee2e2", color: "#dc2626" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
/** "2025-04" → "April 2025" */
function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y}`;
}
/** Earliest selectable month — 3 years back */
function minMonth(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 7);
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <Suspense fallback={null}>
        <FinanceContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// Clicking a summary tile drills into the transactions behind that number.
// null = the normal student list.
type DrillDown = null | "collected" | "overdue" | "prepay";

function FinanceContent() {
  const { user, isAdmin, isSuperAdmin }      = useAuth();
  const canManageTx                          = isAdmin || isSuperAdmin;
  const searchParams                         = useSearchParams();
  const [drillDown, setDrillDown]            = useState<DrillDown>(null);
  // Deep-link support, e.g. from the dashboard's Pending Fees KPI card:
  // /dashboard/finance?filter=pending
  const [feeStatusFilter, setFeeStatusFilter] = useState<"all" | "pending">(
    () => searchParams.get("filter") === "pending" ? "pending" : "all"
  );
  const [transactions, setTransactions]      = useState<Transaction[]>([]);
  const [students, setStudents]              = useState<StudentFeeRow[]>([]);
  const [centers, setCenters]                = useState<CenterOption[]>([]);
  const [loading, setLoading]                = useState(true);
  const [attDatesMap, setAttDatesMap]        = useState<Map<string, string[]>>(new Map());
  const [attPopupUid, setAttPopupUid]        = useState<string | null>(null);
  const { toasts, toast, remove }            = useToast();
  // ── Month selector ───────────────────────────────────────────────────────────
  const [selectedMonth, setSelectedMonth]    = useState<string>(currentMonth());
  const isCurrentMonth                       = selectedMonth === currentMonth();

  // ── Inline row panel state ───────────────────────────────────────────────────
  const [activeUid, setActiveUid]            = useState<string | null>(null);
  const [activeAction, setActiveAction]      = useState<RowAction>("pay");

  // Pay form state
  const [payAmount, setPayAmount]            = useState<string>("");
  const [payMethod, setPayMethod]            = useState<PayMethod>("Cash");
  const [payNote, setPayNote]                = useState<string>("");
  const [payDate, setPayDate]                = useState<string>(todayStr());
  // Which billing month this payment settles. Deliberately starts null — the
  // admin picks explicitly rather than money silently landing on a guessed month.
  const [payBillingMonth, setPayBillingMonth] = useState<string | null>(null);
  const [discountType, setDiscountType]      = useState<DiscountType>("fixed");
  const [discountValue, setDiscountValue]    = useState<string>("");
  const [paySubmitting, setPaySubmitting]    = useState(false);
  const payInputRef                          = useRef<HTMLInputElement>(null);

  // Adjust fee state
  const [adjustFee, setAdjustFee]            = useState<string>("");
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const adjustInputRef                       = useRef<HTMLInputElement>(null);


  // Deposit state (prepay advance)
  const [depositAmount, setDepositAmount]    = useState<string>("");
  const [depositMethod, setDepositMethod]    = useState<PayMethod>("Cash");
  const [depositNote, setDepositNote]        = useState<string>("");
  const [depositSubmitting, setDepositSubmitting] = useState(false);
  const depositInputRef                      = useRef<HTMLInputElement>(null);
  const [feeDueDate, setFeeDueDate]                 = useState<string>(todayStr());
  const [feeDueSubmitting, setFeeDueSubmitting]     = useState(false);
  const [undoFeeDueSubmitting, setUndoFeeDueSubmitting] = useState(false);
  const [historyDeletePending, setHistoryDeletePending] = useState<string | null>(null);
  const [historyDeleteSubmitting, setHistoryDeleteSubmitting] = useState(false);
  const historyDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filters
  const [filterCenter, setFilterCenter]      = useState<string>("all");
  const [filterStatus, setFilterStatus]      = useState<string>("all");
  const [filterDate, setFilterDate]          = useState<string>("");
  const [studentSearch, setStudentSearch]    = useState<string>("");
  const [filterType, setFilterType] = useState<string>("all"); // "all"|"group"|"personal"|"prepay"|"postpay"
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── Fetch ────────────────────────────────────────────────────────────────────
  async function fetchAll(month: string = selectedMonth) {
    try {
      const [txData, studentSnap, centerSnap, attSnap] = await Promise.all([
        getTransactions(),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "centers")),
        getDocs(query(collection(db, "attendance"), where("status", "==", "present"))),
      ]);

      const cMap = new Map<string, { name: string; centerCode: string }>();
      centerSnap.docs.forEach(d => cMap.set(d.id, {
        name:       (d.data().name       as string) ?? d.id,
        centerCode: (d.data().centerCode as string) ?? "—",
      }));
      setCenters(centerSnap.docs.map(d => ({
        id: d.id,
        name:       (d.data().name       as string) ?? d.id,
        centerCode: (d.data().centerCode as string) ?? "—",
      })));

      // Store ALL transactions (month filtering happens in useMemo/render)
      const sortedTx = txData.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      setTransactions(sortedTx);

      // ── Attendance count + dates for the selected month ───────────────────
      const monthAttMap   = new Map<string, number>();
      const monthDatesMap = new Map<string, string[]>();
      attSnap.docs.forEach(d => {
        const data = d.data();
        const date = (data.date ?? "") as string;
        if (!date.startsWith(month)) return;
        const uid = (data.studentUid ?? "") as string;
        if (!uid) return;
        monthAttMap.set(uid, (monthAttMap.get(uid) ?? 0) + 1);
        const arr = monthDatesMap.get(uid) ?? [];
        arr.push(date);
        monthDatesMap.set(uid, arr);
      });
      // Sort each student's dates ascending
      monthDatesMap.forEach(arr => arr.sort());
      setAttDatesMap(monthDatesMap);

      // ── Balance: single source of truth ────────────────────────────────────
      // Derived from the transaction ledger (Total Dues Generated − Total
      // Payments Received) via computeStudentBalances, not the denormalized
      // `currentBalance` field on the student doc (which can drift if a
      // charge is ever applied without a matching transaction record).
      // For past months, balances are reconstructed as of end-of-month by
      // replaying only transactions dated on/before that month.
      const isCurrent = month === currentMonth();
      // Last day of the selected month (e.g. "2025-04-30")
      const [yr, mo] = month.split("-").map(Number);
      const lastDayOfMonth = new Date(yr, mo, 0).getDate(); // day 0 of next month = last day of this month
      const monthEnd = `${month}-${String(lastDayOfMonth).padStart(2, "0")}`;

      const balanceMap = computeStudentBalances(txData, isCurrent ? undefined : monthEnd);

      setStudents(studentSnap.docs.map(d => {
        const s           = d.data();
        const c           = cMap.get(s.centerId as string);
        const feePerClass = Number(s.feePerClass ?? 0);
        const monthlyFee  = Number(s.monthlyFee  ?? s.feePerClass ?? 0);
        const attCount    = monthAttMap.get(d.id) ?? 0;
        const estimatedFee = feePerClass > 0 ? attCount * feePerClass : 0;

        // Balance: live for current month, reconstructed for past months
        const balance = balanceMap.get(d.id) ?? 0;

        return {
          uid:             d.id,
          name:            (s.displayName ?? s.name ?? "—") as string,
          studentID:       (s.studentID   ?? "—") as string,
          admissionNo:     (s.admissionNo ?? s.admissionNumber ?? "—") as string,
          centerName:      c?.name ?? (s.centerId as string) ?? "—",
          centerId:        (s.centerId   ?? "") as string,
          classType:       ((s.classType   as string) === "personal" ? "personal" : "group"),
          billingMode:     ((s.billingMode as string) === "prepay"   ? "prepay"   : "postpay"),
          feeCycle:        (s.feeCycle   ?? "—") as string,
          feePerClass,
          monthlyFee,
          balance,
          status:          (s.status ?? "active") as string,
          attendanceCount: attCount,
          estimatedFee,
        };
      }));
    } catch (err) {
      console.error("Finance fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch whenever selected month changes
  useEffect(() => {
    setLoading(true);
    fetchAll(selectedMonth);
    // Auto-refresh only for current month (historical data is immutable)
    if (selectedMonth !== currentMonth()) return;
    const interval = setInterval(() => fetchAll(selectedMonth), 30_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth]);

  // ── Fee-due generated this month per student ────────────────────────────────
  // Reconciles every due against the payments credited to it, so a part-paid
  // month reports what's actually left rather than counting as fully settled.
  const dueSettlements = useMemo(() => computeDueSettlements(transactions), [transactions]);

  // Keyed by student: what they still owe for the selected month. Driven by the
  // settlement engine, so a student who has part-paid stays here with the
  // remaining amount instead of dropping out the moment any payment lands.
  const feeDueMap = useMemo(() => {
    const m = new Map<string, { id: string; amount: number; original: number; paid: number; partial: boolean }>();
    dueSettlements.forEach(s => {
      if (s.billingMonth !== selectedMonth) return;
      if (s.remaining <= 0) return;
      m.set(s.studentUid, {
        id:       s.dueId,
        amount:   s.remaining,
        original: s.dueAmount,
        paid:     s.paidAmount,
        partial:  s.state === "partial",
      });
    });
    return m;
  }, [dueSettlements, selectedMonth]);

  // ── Payment recorded this month per student ──────────────────────────────────
  // "Paid" now means fully settled for the month — a part payment no longer
  // counts as done, which is what made short-paid students disappear.
  const paidMap = useMemo(() => {
    const m = new Set<string>();
    dueSettlements.forEach(s => {
      if (s.billingMonth !== selectedMonth) return;
      if (s.state === "paid") m.add(s.studentUid);
    });
    // Students with no due generated at all, but who paid something this month,
    // still read as paid rather than blank.
    transactions.forEach(tx => {
      if (!tx.studentUid || !isSettlingPayment(tx)) return;
      if (!(tx.date ?? "").startsWith(selectedMonth)) return;
      if (!feeDueMap.has(tx.studentUid)) m.add(tx.studentUid);
    });
    return m;
  }, [dueSettlements, transactions, selectedMonth, feeDueMap]);

  // ── Total amount paid this month per student ────────────────────────────────
  const paidAmountMap = useMemo(() => {
    const m = new Map<string, number>();
    transactions.forEach(tx => {
      if (!tx.studentUid) return;
      if (tx.status !== "completed") return;
      if (!(tx.date ?? "").startsWith(selectedMonth)) return;
      const raw    = tx as unknown as Record<string, unknown>;
      const type   = (raw.type   as string) ?? "";
      const method = (tx.method  as string) ?? "";
      if (type === "fee_due" || type === "charge" || method === "auto" || method === "auto-monthly") return;
      m.set(tx.studentUid, (m.get(tx.studentUid) ?? 0) + tx.amount);
    });
    return m;
  }, [transactions, selectedMonth]);

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const today      = todayStr();
    const isManualPayment = (t: Transaction) => {
      const raw    = t as unknown as Record<string, unknown>;
      const type   = (raw.type   as string) ?? "";
      const method = (t.method   as string) ?? "";
      return t.status === "completed"
        && type   !== "fee_due"  && type   !== "charge"
        && method !== "auto"     && method !== "auto-monthly";
    };
    const monthTx    = transactions.filter(t =>
      isManualPayment(t) && (t.date ?? "").startsWith(selectedMonth)
    );
    const total      = monthTx.reduce((s, t) => s + (t.amount ?? 0), 0);
    const todayAmt   = isCurrentMonth
      ? transactions.filter(t => isManualPayment(t) && t.date?.startsWith(today))
          .reduce((s, t) => s + (t.amount ?? 0), 0)
      : 0;
    const overdueStudents = students.filter(s => feeDueMap.has(s.uid) && !paidMap.has(s.uid));
    const pendingBal      = overdueStudents.reduce((acc, s) => acc + (feeDueMap.get(s.uid)?.amount ?? 0), 0);
    const activeCount     = students.filter(s => s.status === "active").length;
    const totalEstFee     = students.reduce((acc, s) => acc + s.estimatedFee, 0);
    const groupCount      = students.filter(s => s.classType === "group").length;
    const personalCount   = students.filter(s => s.classType === "personal").length;
    const prepayStudents  = students.filter(s => s.billingMode === "prepay");
    const postpayStudents = students.filter(s => s.billingMode !== "prepay");
    const prepayCount     = prepayStudents.length;
    const postpayCount    = postpayStudents.length;
    // Collected this month, split by billing mode
    const prepayCollected  = prepayStudents.reduce((acc, s)  => acc + (paidAmountMap.get(s.uid) ?? 0), 0);
    const postpayCollected = postpayStudents.reduce((acc, s) => acc + (paidAmountMap.get(s.uid) ?? 0), 0);
    // Prepay students with fee generated but not yet paid
    const lowCreditCount   = prepayStudents.filter(s => feeDueMap.has(s.uid) && !paidMap.has(s.uid)).length;
    return { total, todayAmt, pendingBal, activeCount, totalEstFee, overdueCount: overdueStudents.length, groupCount, personalCount, prepayCollected, postpayCollected, prepayCount, postpayCount, lowCreditCount };
  }, [transactions, students, selectedMonth, isCurrentMonth, feeDueMap, paidMap, paidAmountMap]);

  // ── Last tx per student (scoped to selected month) ───────────────────────────
  const lastTxMap = useMemo(() => {
    const m = new Map<string, Transaction>();
    // transactions are sorted newest-first; find the newest one in selected month per student
    transactions.forEach(tx => {
      if (tx.status === "completed" && tx.studentUid && !m.has(tx.studentUid)
          && tx.method !== "auto-monthly" && tx.method !== "auto") {
        if ((tx.date ?? "").startsWith(selectedMonth)) {
          m.set(tx.studentUid, tx);
        }
      }
    });
    return m;
  }, [transactions, selectedMonth]);

  // ── Derived: net pay amount after discount ───────────────────────────────────
  function computeNetAmount(raw: string, dType: DiscountType, dVal: string): number {
    const base = Number(raw);
    if (!base || base <= 0) return 0;
    const disc = Number(dVal) || 0;
    if (dType === "percent") {
      return Math.max(0, Math.round(base - (base * Math.min(disc, 100)) / 100));
    }
    return Math.max(0, base - disc);
  }

  // ── Row panel helpers ────────────────────────────────────────────────────────
  function openPanel(uid: string, action: RowAction, student: StudentFeeRow) {
    // Close if already open with same action
    if (activeUid === uid && activeAction === action) {
      closePanel();
      return;
    }
    setActiveUid(uid);
    setActiveAction(action);
    // Reset all form states
    // Amount is left for the admin to fill once they pick a month — selecting a
    // month prefills that month's outstanding figure.
    setPayAmount("");
    setPayBillingMonth(null);
    setPayMethod("Cash");
    setPayNote("");
    setPayDate(todayStr());
    setDiscountType("fixed");
    setDiscountValue("");
    setAdjustFee(
      action === "adjust"
        ? (student.feeCycle === "monthly" ? String(student.monthlyFee) : String(student.feePerClass))
        : ""
    );
    setDepositAmount(action === "deposit"
      ? (student.feeCycle === "monthly" ? String(student.monthlyFee) : String(student.feePerClass))
      : ""
    );
    setDepositMethod("Cash");
    setDepositNote("");
    setFeeDueDate(selectedMonth === currentMonth() ? todayStr() : `${selectedMonth}-01`);
    if (action === "pay")     setTimeout(() => payInputRef.current?.focus(),     60);
    if (action === "adjust")  setTimeout(() => adjustInputRef.current?.focus(),  60);
    if (action === "deposit") setTimeout(() => depositInputRef.current?.focus(), 60);
  }

  function closePanel() {
    setActiveUid(null);
    setPayAmount("");
    setPayNote("");
    setPayDate(todayStr());
    setDiscountValue("");
    setAdjustFee("");
    setDepositAmount("");
    setDepositNote("");
    setFeeDueDate(selectedMonth === currentMonth() ? todayStr() : `${selectedMonth}-01`);
  }

  // ── Submit: record payment ───────────────────────────────────────────────────
  async function submitPay(student: StudentFeeRow) {
    const net = computeNetAmount(payAmount, discountType, discountValue);
    if (!net || net <= 0) {
      toast("Enter a valid amount (after discount must be > 0)", "error");
      return;
    }
    setPaySubmitting(true);
    try {
      const rawAmount   = Number(payAmount);
      const discountAmt = rawAmount - net;

      // One shared service call — it writes the receipt, adjusts the balance,
      // and closes the targeted due only if this payment actually settles it.
      await recordPayment({
        studentUid:   student.uid,
        centerId:     student.centerId,
        amount:       net,
        rawAmount,
        discountAmt,
        discountType,
        method:       payMethod,
        receivedBy:   user?.displayName ?? user?.email ?? "admin",
        date:         payDate || todayStr(),
        note:         payNote.trim() || null,
        billingMonth: payBillingMonth,
      });

      // Report what actually happened to the due, so a short payment doesn't
      // read as if the bill were cleared.
      const target = payBillingMonth
        ? dueSettlements.get(`${student.uid}|${payBillingMonth}`)
        : undefined;
      const stillOwed = target ? Math.max(0, target.remaining - net) : 0;

      closePanel();
      await fetchAll(selectedMonth);

      const discMsg  = discountAmt > 0 ? ` · discount ${fmtINR(discountAmt)}` : "";
      const monthMsg = payBillingMonth ? ` for ${fmtMonth(payBillingMonth)}` : "";
      const leftMsg  = stillOwed > 0 ? ` — ${fmtINR(stillOwed)} still due` : "";
      toast(`✓ ${fmtINR(net)} from ${student.name}${monthMsg} via ${payMethod}${discMsg}${leftMsg}`, "success");
    } catch (err) {
      console.error("Payment failed:", err);
      toast(`Payment failed: ${err instanceof Error ? err.message : "try again"}`, "error");
    } finally {
      setPaySubmitting(false);
    }
  }

  // ── Submit: adjust fee ───────────────────────────────────────────────────────
  async function submitAdjust(student: StudentFeeRow) {
    const newFee = Number(adjustFee);
    if (!newFee || newFee <= 0) {
      toast("Enter a valid fee amount", "error");
      return;
    }
    setAdjustSubmitting(true);
    try {
      const isMonthly = student.feeCycle === "monthly";
      await updateDoc(doc(db, "users", student.uid), {
        ...(isMonthly ? { monthlyFee: newFee } : { feePerClass: newFee }),
        updatedAt: new Date().toISOString(),
      });
      closePanel();
      await fetchAll(selectedMonth);
      toast(
        `Fee updated for ${student.name} — ${isMonthly ? "Monthly" : "Per Class"}: ${fmtINR(newFee)}`,
        "success"
      );
    } catch (err) {
      console.error("Fee adjust failed:", err);
      toast("Fee adjustment failed. Try again.", "error");
    } finally {
      setAdjustSubmitting(false);
    }
  }

  // ── Submit: prepay advance deposit ──────────────────────────────────────────
  async function submitDeposit(student: StudentFeeRow) {
    const amt = Number(depositAmount);
    if (!amt || amt <= 0) {
      toast("Enter a valid payment amount (> 0)", "error");
      return;
    }
    setDepositSubmitting(true);
    try {
      await addDoc(collection(db, "transactions"), {
        studentUid: student.uid,
        centerId:   student.centerId,
        amount:     amt,
        method:     depositMethod,
        type:       "deposit",
        note:       depositNote.trim() || null,
        receivedBy: user?.displayName ?? user?.email ?? "admin",
        date:       todayStr(),
        status:     "completed",
        createdAt:  serverTimestamp(),
      });
      // Deposit reduces balance (more negative = more credit)
      await updateDoc(doc(db, "users", student.uid), {
        currentBalance: increment(-amt),
        updatedAt:      new Date().toISOString(),
      });
      closePanel();
      await fetchAll(selectedMonth);
      toast(`✓ Advance payment ${fmtINR(amt)} recorded for ${student.name} via ${depositMethod}`, "success");
    } catch (err) {
      console.error("Deposit failed:", err);
      toast("Payment failed. Try again.", "error");
    } finally {
      setDepositSubmitting(false);
    }
  }

  // ── Generate fee due record ──────────────────────────────────────────────────
  async function generateFeeDue(student: StudentFeeRow) {
    const fee = student.feeCycle === "monthly" ? student.monthlyFee : student.estimatedFee;
    if (!fee || fee <= 0) {
      toast(
        student.feeCycle === "per_class"
          ? "No attendance recorded yet — cannot generate fee"
          : "Fee amount is zero",
        "error"
      );
      return;
    }
    setFeeDueSubmitting(true);
    try {
      await addDoc(collection(db, "transactions"), {
        studentUid:   student.uid,
        centerId:     student.centerId,
        amount:       fee,
        type:         "fee_due",
        method:       "manual",
        billingMonth: selectedMonth,
        date:         feeDueDate || (selectedMonth === currentMonth() ? todayStr() : `${selectedMonth}-01`),
        status:       "due",
        createdAt:    serverTimestamp(),
        receivedBy:   user?.displayName ?? user?.email ?? "admin",
      });
      await updateDoc(doc(db, "users", student.uid), {
        currentBalance: increment(fee),
        updatedAt:      new Date().toISOString(),
      });
      await fetchAll(selectedMonth);
      toast(`Fee due of ${fmtINR(fee)} generated for ${student.name}`, "success");
    } catch (err) {
      console.error("Generate fee due failed:", err);
      toast("Failed to generate fee due. Try again.", "error");
    } finally {
      setFeeDueSubmitting(false);
    }
  }

  // ── Undo generate fee due ────────────────────────────────────────────────────
  async function undoFeeDue(student: StudentFeeRow) {
    const entry = feeDueMap.get(student.uid);
    if (!entry) return;
    setUndoFeeDueSubmitting(true);
    try {
      await deleteDoc(doc(db, "transactions", entry.id));
      await updateDoc(doc(db, "users", student.uid), {
        currentBalance: increment(-entry.amount),
        updatedAt:      new Date().toISOString(),
      });
      await fetchAll(selectedMonth);
      toast(`Fee due removed for ${student.name}`, "success");
    } catch (err) {
      console.error("Undo fee due failed:", err);
      toast("Failed to undo fee due. Try again.", "error");
    } finally {
      setUndoFeeDueSubmitting(false);
    }
  }

  // ── Edit / Delete transaction (admin) ───────────────────────────────────────
  async function handleEditTx(txId: string, patch: EditableTransactionInput) {
    if (!canManageTx) {
      toast("You do not have permission to edit transactions", "error");
      return;
    }
    try {
      const editorUid  = user?.uid ?? "unknown";
      const editorRole = isSuperAdmin ? "super_admin" : "admin";
      await editTransaction(txId, patch, editorUid, editorRole);
      await fetchAll(selectedMonth);
      toast("Transaction updated", "success");
    } catch (err) {
      console.error("Edit transaction failed:", err);
      toast(`Edit failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
    }
  }

  async function handleDeleteTx(txId: string) {
    if (!canManageTx) {
      toast("You do not have permission to delete transactions", "error");
      return;
    }
    try {
      const deleterUid  = user?.uid ?? "unknown";
      const deleterRole = isSuperAdmin ? "super_admin" : "admin";
      await deleteTransaction(txId, deleterUid, deleterRole);
      await fetchAll(selectedMonth);
      toast("Transaction deleted", "success");
    } catch (err) {
      console.error("Delete transaction failed:", err);
      toast(`Delete failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
    }
  }

  // ── Filters ──────────────────────────────────────────────────────────────────
  const filteredTx = useMemo(() => {
    return transactions.filter(tx => {
      if (tx.method === "auto" || tx.method === "auto-monthly") return false;
      if (filterDate) {
        const txDate = (tx.date ?? "").slice(0, 10);
        if (txDate !== filterDate) return false;
      } else {
        if (!(tx.date ?? "").startsWith(selectedMonth)) return false;
      }
      if (filterCenter !== "all" && tx.centerId !== filterCenter) return false;
      if (filterStatus !== "all" && tx.status  !== filterStatus)  return false;
      return true;
    });
  }, [transactions, filterCenter, filterStatus, filterDate, selectedMonth]);

  // Which slice of the ledger sits behind the summary tile the admin clicked.
  const drillDownTx = useMemo(() => {
    if (drillDown === null) return [];
    if (drillDown === "overdue") {
      // Dues still carrying a balance — includes part-paid ones, which the old
      // status-only check silently dropped once any payment landed.
      return transactions.filter(tx => {
        if (tx.type !== "fee_due") return false;
        if (filterCenter !== "all" && tx.centerId !== filterCenter) return false;
        const bm = tx.billingMonth || (tx.date ?? "").slice(0, 7);
        if (bm !== selectedMonth) return false;
        const s = dueSettlements.get(`${tx.studentUid}|${bm}`);
        return (s?.remaining ?? 0) > 0;
      });
    }
    if (drillDown === "prepay") {
      return filteredTx.filter(tx => tx.type === "deposit");
    }
    // "collected" — real money in.
    return filteredTx.filter(tx => isSettlingPayment(tx));
  }, [drillDown, transactions, filteredTx, dueSettlements, filterCenter, selectedMonth]);

  const filteredStudents = useMemo(() => {
    let list = filterCenter === "all" ? students : students.filter(s => s.centerId === filterCenter);
    if      (filterType === "group")    list = list.filter(s => s.classType   === "group");
    else if (filterType === "personal") list = list.filter(s => s.classType   === "personal");
    else if (filterType === "prepay")   list = list.filter(s => s.billingMode === "prepay");
    else if (filterType === "postpay")  list = list.filter(s => s.billingMode === "postpay");
    if (feeStatusFilter === "pending") list = list.filter(s => s.balance > 0);
    if (studentSearch.trim()) {
      const q = studentSearch.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.studentID.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      // Attended students first; non-attending at bottom
      const aAttended = a.attendanceCount > 0 ? 0 : 1;
      const bAttended = b.attendanceCount > 0 ? 0 : 1;
      if (aAttended !== bAttended) return aAttended - bAttended;
      // Within attending group: overdue (positive balance) before paid/clear
      const aOverdue = a.balance > 0 ? 0 : 1;
      const bOverdue = b.balance > 0 ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      return a.name.localeCompare(b.name);
    });
  }, [students, filterCenter, studentSearch, filterType, feeStatusFilter]);

  function formatDate(value: unknown): string {
    if (!value || typeof value !== "string") return "-";
    const d = value.slice(0, 10); // YYYY-MM-DD
    const [y, m, day] = d.split("-");
    if (!y || !m || !day) return d;
    return `${day}/${m}/${y}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={st.header}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" as const }}>
            <h1 style={st.heading}>Finance</h1>
            {/* Month selector */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="month"
                value={selectedMonth}
                min={minMonth()}
                max={currentMonth()}
                onChange={e => {
                  if (e.target.value) setSelectedMonth(e.target.value);
                }}
                style={{
                  padding: "5px 10px",
                  border: "1.5px solid var(--color-border, #e5e7eb)",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  background: isCurrentMonth ? "var(--color-surface)" : "#fffbeb",
                  color: isCurrentMonth ? "var(--color-text-primary)" : "#92400e",
                  cursor: "pointer",
                }}
              />
              {!isCurrentMonth && (
                <button
                  onClick={() => setSelectedMonth(currentMonth())}
                  style={{
                    padding: "5px 10px", border: "none", borderRadius: 6,
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                    background: "#fef3c7", color: "#92400e",
                  }}
                  title="Jump back to current month"
                >
                  ← Current
                </button>
              )}
            </div>
            {!isCurrentMonth && (
              <span style={{
                fontSize: 12, fontWeight: 700, padding: "3px 10px",
                background: "#fef9c3", color: "#b45309",
                border: "1px solid #fde68a", borderRadius: 6,
              }}>
                📅 Viewing: {fmtMonth(selectedMonth)}
              </span>
            )}
          </div>
          {summary.overdueCount > 0 && !loading && (
            <div style={st.overdueAlert}>
              ⚠ {summary.overdueCount} student{summary.overdueCount !== 1 ? "s" : ""} with outstanding balance
            </div>
          )}
        </div>
      </div>

      {/* ── Summary Cards — click one to see the transactions behind it ──────── */}
      <div style={st.cardGrid}>
        <SummaryCard
          label={`Collected — ${fmtMonth(selectedMonth)}`}
          value={loading ? "…" : fmtINR(summary.total)}
          accent="#16a34a" icon="💰"
          hint={loading ? undefined : isCurrentMonth
            ? `${fmtINR(summary.todayAmt)} today`
            : "Historical view"}
          active={drillDown === "collected"}
          onClick={() => setDrillDown(d => d === "collected" ? null : "collected")}
        />
        <SummaryCard
          label="Overdue"
          value={loading ? "…" : String(summary.overdueCount)}
          accent="#dc2626" icon="🚨"
          urgent={summary.overdueCount > 0}
          hint={loading ? undefined : `${fmtINR(summary.pendingBal)} pending`}
          active={drillDown === "overdue"}
          onClick={() => setDrillDown(d => d === "overdue" ? null : "overdue")}
        />
        <SummaryCard
          label="Active Students"
          value={loading ? "…" : String(summary.activeCount)}
          accent="#059669" icon="🎓"
          hint={loading ? undefined : `${summary.groupCount} group · ${summary.personalCount} personal`}
        />
        <SummaryCard
          label="Prepay Collected"
          value={loading ? "…" : fmtINR(summary.prepayCollected)}
          accent="#9d174d" icon="⬆"
          urgent={summary.lowCreditCount > 0}
          hint={loading ? undefined : summary.lowCreditCount > 0
            ? `⚠ ${summary.lowCreditCount} due unpaid · ${summary.prepayCount} prepay`
            : `${summary.prepayCount} prepay · Postpay ${fmtINR(summary.postpayCollected)}`}
          active={drillDown === "prepay"}
          onClick={() => setDrillDown(d => d === "prepay" ? null : "prepay")}
        />
      </div>

      {/* ── Shared filters ───────────────────────────────────────────────────── */}
      <div style={st.filterRow}>
        <select value={filterCenter} onChange={e => setFilterCenter(e.target.value)} style={st.filterSelect}>
          <option value="all">All Centers</option>
          {centers.map(c => (
            <option key={c.id} value={c.id}>[{c.centerCode}] {c.name}</option>
          ))}
        </select>
        {drillDown === null ? (
          <>
            <input
              type="search"
              placeholder="Search name or ID…"
              value={studentSearch}
              onChange={e => setStudentSearch(e.target.value)}
              style={{ ...st.searchInput, flex: 1 }}
            />
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={st.filterSelect}>
              <option value="all">All Types</option>
              <option value="group">👥 Group</option>
              <option value="personal">👤 Personal</option>
              <option value="postpay">⬇ Postpay</option>
              <option value="prepay">⬆ Prepay</option>
            </select>
            <select value={feeStatusFilter} onChange={e => setFeeStatusFilter(e.target.value as "all" | "pending")} style={st.filterSelect}>
              <option value="all">All Fee Status</option>
              <option value="pending">⚠ Pending balance</option>
            </select>
            {feeStatusFilter === "pending" && (
              <button onClick={() => setFeeStatusFilter("all")} style={st.clearDate}>✕ Clear filter</button>
            )}
          </>
        ) : (
          <>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={st.filterSelect}>
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
            </select>
            <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)}
              style={st.filterDate} />
            {filterDate && (
              <button onClick={() => setFilterDate("")} style={st.clearDate}>✕ Clear date</button>
            )}
          </>
        )}
      </div>

      {/* ══ DRILL-DOWN — the transactions behind a summary tile ════════════════ */}
      {drillDown !== null && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap" as const, gap: 10 }}>
            <div style={st.sectionTitle}>
              {drillDown === "collected" ? `Payments collected — ${fmtMonth(selectedMonth)}`
                : drillDown === "overdue" ? `Outstanding dues — ${fmtMonth(selectedMonth)}`
                : `Prepay deposits — ${fmtMonth(selectedMonth)}`}
            </div>
            <button onClick={() => setDrillDown(null)} style={st.clearDate}>← Back to students</button>
          </div>
          <TxTable
            transactions={drillDownTx}
            students={students}
            centers={centers}
            loading={loading}
            formatDate={formatDate}
            canManage={canManageTx}
            onEdit={handleEditTx}
            onDelete={handleDeleteTx}
            isMobile={isMobile}
          />
        </div>
      )}

      {/* ══ STUDENT LIST — the default view ════════════════════════════════════ */}
      {drillDown === null && (
        <div>
          {summary.overdueCount > 0 && !loading && (
            <div style={st.overdueBanner}>
              <span style={{ fontSize: 16 }}>🚨</span>
              <span>
                <strong>{summary.overdueCount} student{summary.overdueCount !== 1 ? "s" : ""} </strong>
                have outstanding balances totalling <strong>{fmtINR(summary.pendingBal)}</strong>.
              </span>
            </div>
          )}

          {/* Past month notice */}
          {!isCurrentMonth && !loading && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              background: "#fffbeb", border: "1px solid #fde68a",
              borderRadius: 8, padding: "10px 14px", marginBottom: 10,
              fontSize: 13, color: "#92400e",
            }}>
              <span style={{ fontSize: 16 }}>📅</span>
              <span>
                Showing historical data for <strong>{fmtMonth(selectedMonth)}</strong>.
                Attendance, balance, and billing status reflect that month.
                Any actions (pay/bill/payment) will update the <strong>live balance</strong>.
              </span>
            </div>
          )}

          <div style={st.tableWrapper}>
            {loading ? (
              <div style={st.stateRow}>Loading…</div>
            ) : filteredStudents.length === 0 ? (
              <div style={st.stateRow}>No students found.</div>
            ) : (
              <table style={{ ...st.table, minWidth: isMobile ? 280 : 860 }}>
                <thead>
                  <tr>
                    <th style={st.th}>Student</th>
                    {!isMobile && <th style={st.th}>Type</th>}
                    {!isMobile && <th style={st.th}>Amount</th>}
                    <th style={st.th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.map((s) => {
                    const isPrepay   = s.billingMode === "prepay";
                    const overdue    = feeDueMap.has(s.uid) && !paidMap.has(s.uid);
                    const hasCredit  = isPrepay && s.balance < 0; // prepay credit remaining
                    const isOpen     = activeUid === s.uid;
                    const month      = selectedMonth;
                    const creditAmt  = hasCredit ? Math.abs(s.balance) : 0;
                    const fee        = s.feeCycle === "monthly" ? s.monthlyFee : s.feePerClass;
                    const lowCredit  = isPrepay && s.balance >= -fee; // credit ≤ one fee cycle

                    const rowBg = isOpen
                      ? "#fffbeb"
                      : overdue
                        ? "#fff7f7"
                        : hasCredit
                          ? "#f0fdf4"
                          : "var(--color-surface)";

                    const netPreview = computeNetAmount(payAmount, discountType, discountValue);
                    const discountAmt = Number(payAmount) - netPreview;

                    return (
                      <>
                        {/* ── Main data row ─────────────────────────────── */}
                        <tr
                          key={s.uid}
                          style={{ background: rowBg, transition: "background 0.15s", cursor: "pointer" }}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest("button")) return;
                            openPanel(s.uid, "history", s);
                          }}
                        >
                          {/* Student + center */}
                          <td style={{ ...st.td, minWidth: isMobile ? 180 : 160 }}>
                            <div style={{ fontWeight: 600 }}>{s.name}</div>
                            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                              {s.centerName}{" · "}{s.studentID}
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); setAttPopupUid(s.uid); }}
                              title="View attendance this month"
                              style={{
                                marginTop: 4, display: "inline-flex", alignItems: "center", gap: 4,
                                background: "none", color: "var(--color-text-secondary)",
                                border: "none", padding: 0,
                                fontSize: 11, cursor: "pointer",
                              }}
                            >
                              {s.attendanceCount} classes
                            </button>
                            {/* Mobile: type + paid/due status as plain text */}
                            {isMobile && (
                              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
                                {s.classType === "personal" ? "Personal" : "Group"} · {s.feeCycle === "monthly" ? "Monthly" : "Per Class"}
                                {paidMap.has(s.uid) ? (
                                  <span style={{ marginLeft: 6, fontWeight: 600, color: "#16a34a" }}>· Paid {fmtINR(paidAmountMap.get(s.uid) ?? 0)}</span>
                                ) : feeDueMap.has(s.uid) ? (
                                  <span style={{ marginLeft: 6, fontWeight: 600, color: "#dc2626" }}>
                                    · Due {fmtINR(feeDueMap.get(s.uid)?.amount ?? 0)}
                                    {feeDueMap.get(s.uid)?.partial && <span style={st.partlyPaidTag}>Partly paid</span>}
                                  </span>
                                ) : null}
                              </div>
                            )}
                          </td>

                          {/* Type — desktop only */}
                          {!isMobile && (
                            <td style={st.td}>
                              <div style={{ fontSize: 13, color: "var(--color-text-primary)" }}>
                                {s.classType === "personal" ? "Personal" : "Group"}
                              </div>
                              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                                {s.feeCycle === "monthly" ? "Monthly" : "Per Class"} · {isPrepay ? "Prepay" : "Postpay"}
                              </div>
                            </td>
                          )}

                          {/* Due / Paid — desktop only */}
                          {!isMobile && (
                            <td style={{ ...st.td, fontWeight: 600 }}>
                              {paidMap.has(s.uid) ? (
                                <span style={{ color: "#16a34a" }}>Paid {fmtINR(paidAmountMap.get(s.uid) ?? 0)}</span>
                              ) : feeDueMap.has(s.uid) ? (
                                <span style={{ color: "#dc2626" }}>
                                  Due {fmtINR(feeDueMap.get(s.uid)?.amount ?? 0)}
                                  {feeDueMap.get(s.uid)?.partial && <span style={st.partlyPaidTag}>Partly paid</span>}
                                </span>
                              ) : (
                                <span style={{ color: "#9ca3af" }}>—</span>
                              )}
                            </td>
                          )}

                          {/* Primary action */}
                          <td style={{ ...st.td, whiteSpace: "nowrap" as const }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <button
                                onClick={() => openPanel(s.uid, "pay", s)}
                                style={{
                                  ...st.actionBtn,
                                  ...(overdue ? { background: "#dc2626", color: "#fff", border: "none" } : {}),
                                  ...(isOpen && activeAction === "pay" ? st.actionBtnActive : {}),
                                }}
                              >
                                💳 Payment
                              </button>
                              <RowActionsMenu
                                onAdjust={() => openPanel(s.uid, "adjust", s)}
                                onDeposit={() => openPanel(s.uid, "deposit", s)}
                                onHistory={() => openPanel(s.uid, "history", s)}
                              />
                              {isOpen && (
                                <button onClick={closePanel} style={st.closePanelBtn} title="Close">✕</button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {/* ── Inline panel row ──────────────────────────────── */}
                        {isOpen && (
                          <tr key={`${s.uid}-panel`}>
                            <td colSpan={isMobile ? 2 : 5} style={{ padding: isMobile ? "0 10px 14px" : "0 14px 16px", background: "#fffbeb" }}>

                              {/* ── Attendance info strip ─────────────────────── */}
                              <div style={{
                                display: "flex", gap: 20, alignItems: "center",
                                padding: "10px 0", borderBottom: "1px solid #fde68a", marginBottom: 14,
                                flexWrap: "wrap" as const, fontSize: 13, color: "#6b7280",
                              }}>
                                <span>
                                  <span style={{ fontWeight: 700, color: "#1d4ed8" }}>{s.attendanceCount}</span>
                                  {" classes — "}{fmtMonth(selectedMonth)}
                                </span>
                                {s.feeCycle === "per_class" && (
                                  <span>
                                    Est. fee:{" "}
                                    <span style={{ fontWeight: 700, color: "#7c3aed" }}>{fmtINR(s.estimatedFee)}</span>
                                  </span>
                                )}
                                {lastTxMap.get(s.uid) && (
                                  <span>
                                    Last payment:{" "}
                                    <span style={{ fontWeight: 600 }}>{fmtINR(lastTxMap.get(s.uid)!.amount)}</span>
                                    {" · "}{formatDate(lastTxMap.get(s.uid)!.date ?? lastTxMap.get(s.uid)!.createdAt)}
                                  </span>
                                )}
                              </div>

                              {/* ════ PAY PANEL ════════════════════════════════ */}
                              {activeAction === "pay" && (
                                <div style={st.panel}>
                                  <div style={st.panelTitle}>💳 Payment — {s.name}</div>

                                  {/* ── Generate Fee Due ──────────────────────── */}
                                  {!feeDueMap.has(s.uid) ? (
                                    <div style={{ marginBottom: 14, padding: "12px 14px", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 8 }}>
                                      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
                                        No fee due generated for <strong>{fmtMonth(selectedMonth)}</strong>.
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" as const }}>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>Fee Due Date</label>
                                        <input
                                          type="date"
                                          value={feeDueDate}
                                          onChange={e => setFeeDueDate(e.target.value)}
                                          style={{ fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", color: "#111827" }}
                                        />
                                      </div>
                                      <button
                                        onClick={() => generateFeeDue(s)}
                                        disabled={feeDueSubmitting || !feeDueDate}
                                        style={{ ...st.confirmBtn, background: "#f59e0b", opacity: (feeDueSubmitting || !feeDueDate) ? 0.6 : 1, cursor: (feeDueSubmitting || !feeDueDate) ? "not-allowed" : "pointer" }}
                                      >
                                        {feeDueSubmitting ? "Generating…" : `Generate Fee Due — ${fmtINR(s.feeCycle === "monthly" ? s.monthlyFee : s.estimatedFee)}`}
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                    <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                                      <span style={{
                                        fontSize: 12, padding: "3px 12px", borderRadius: 99, fontWeight: 700,
                                        background: paidMap.has(s.uid) ? "#dcfce7" : "#fee2e2",
                                        color:      paidMap.has(s.uid) ? "#16a34a" : "#dc2626",
                                      }}>
                                        {paidMap.has(s.uid) ? "✓ Paid" : `Due — ${fmtINR(feeDueMap.get(s.uid)?.amount ?? 0)}`}
                                      </span>
                                      <span style={{ fontSize: 11, color: "#9ca3af" }}>Fee generated for {fmtMonth(selectedMonth)}</span>
                                      {!paidMap.has(s.uid) && (
                                        <button
                                          onClick={() => undoFeeDue(s)}
                                          disabled={undoFeeDueSubmitting}
                                          style={{ ...st.cancelBtn, fontSize: 11, padding: "3px 10px", opacity: undoFeeDueSubmitting ? 0.6 : 1, cursor: undoFeeDueSubmitting ? "not-allowed" : "pointer" }}
                                        >
                                          {undoFeeDueSubmitting ? "Undoing…" : "↩ Undo"}
                                        </button>
                                      )}
                                    </div>

                                  {/* Past month notice */}
                                  {!isCurrentMonth && (
                                    <div style={{ fontSize: 12, color: "#92400e", background: "#fef9c3", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 10px", marginBottom: 10 }}>
                                      📅 Viewing <strong>{fmtMonth(selectedMonth)}</strong>. Balance shown is historical. Payment will update the live balance.
                                    </div>
                                  )}

                                  {/* ── Attendance × Fee breakdown card ─────────── */}
                                  <div style={{
                                    background: s.feeCycle === "per_class" ? "#f5f3ff" : "#eff6ff",
                                    border: `1px solid ${s.feeCycle === "per_class" ? "#ddd6fe" : "#bfdbfe"}`,
                                    borderRadius: 10,
                                    padding: "12px 16px",
                                    marginBottom: 12,
                                    display: "flex",
                                    flexWrap: "wrap" as const,
                                    gap: 16,
                                    alignItems: "center",
                                  }}>
                                    {s.feeCycle === "per_class" ? (
                                      <>
                                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Classes — {fmtMonth(selectedMonth)}</span>
                                          <span style={{ fontSize: 22, fontWeight: 800, color: "#7c3aed", lineHeight: 1 }}>{s.attendanceCount}</span>
                                          <span style={{ fontSize: 11, color: "#7c3aed" }}>classes attended</span>
                                        </div>
                                        <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>×</div>
                                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Fee Per Class</span>
                                          <span style={{ fontSize: 22, fontWeight: 800, color: "#374151", lineHeight: 1 }}>{fmtINR(s.feePerClass)}</span>
                                          <span style={{ fontSize: 11, color: "#6b7280" }}>per class</span>
                                        </div>
                                        <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>=</div>
                                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Total Due</span>
                                          <span style={{ fontSize: 22, fontWeight: 800, color: s.estimatedFee > 0 ? "#7c3aed" : "#9ca3af", lineHeight: 1 }}>{fmtINR(s.estimatedFee)}</span>
                                          <span style={{ fontSize: 11, color: "#7c3aed" }}>estimated this month</span>
                                        </div>
                                        {s.attendanceCount === 0 && (
                                          <span style={{ fontSize: 12, color: "#b45309", background: "#fef3c7", padding: "4px 10px", borderRadius: 6, marginLeft: "auto" }}>
                                            ⚠ No attendance recorded yet
                                          </span>
                                        )}
                                      </>
                                    ) : (
                                      <>
                                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Monthly Fee</span>
                                          <span style={{ fontSize: 22, fontWeight: 800, color: "#1d4ed8", lineHeight: 1 }}>{fmtINR(s.monthlyFee)}</span>
                                          <span style={{ fontSize: 11, color: "#1d4ed8" }}>fixed monthly</span>
                                        </div>
                                        <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>·</div>
                                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Classes — {fmtMonth(selectedMonth)}</span>
                                          <span style={{ fontSize: 22, fontWeight: 800, color: "#374151", lineHeight: 1 }}>{s.attendanceCount}</span>
                                          <span style={{ fontSize: 11, color: "#6b7280" }}>attended</span>
                                        </div>
                                        {feeDueMap.has(s.uid) && s.balance > 0 && (
                                          <>
                                            <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>→</div>
                                            <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                              <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>
                                                {isCurrentMonth ? "Outstanding" : `Balance — ${fmtMonth(selectedMonth)}`}
                                              </span>
                                              <span style={{ fontSize: 22, fontWeight: 800, color: "#dc2626", lineHeight: 1 }}>{fmtINR(feeDueMap.get(s.uid)?.amount ?? 0)}</span>
                                              <span style={{ fontSize: 11, color: "#dc2626" }}>{isCurrentMonth ? "due now" : "as of that month"}</span>
                                            </div>
                                          </>
                                        )}
                                      </>
                                    )}
                                  </div>

                                  {/* Context info */}
                                  <div style={st.panelInfo}>
                                    {feeDueMap.has(s.uid) && !paidMap.has(s.uid) && (
                                      <span style={st.infoChipRed}>
                                        Outstanding: {fmtINR(feeDueMap.get(s.uid)?.amount ?? 0)}
                                      </span>
                                    )}
                                    {lastTxMap.get(s.uid) && (
                                      <span style={st.infoChip}>
                                        {isCurrentMonth ? "Last pay" : `Pay in ${fmtMonth(selectedMonth)}`}: {fmtINR(lastTxMap.get(s.uid)!.amount)} on {formatDate(lastTxMap.get(s.uid)!.date ?? lastTxMap.get(s.uid)!.createdAt)}
                                      </span>
                                    )}
                                  </div>

                                  {/* ── Which month is this payment settling? ──── */}
                                  {(() => {
                                    const unpaid = outstandingDuesForStudent(dueSettlements, s.uid);
                                    if (unpaid.length === 0) return null;
                                    return (
                                      <div style={st.monthPicker}>
                                        <div style={st.monthPickerLabel}>
                                          Apply this payment to
                                          {unpaid.length > 1 && (
                                            <span style={{ fontWeight: 400, color: "#92400e", marginLeft: 6 }}>
                                              — {unpaid.length} months unpaid
                                            </span>
                                          )}
                                        </div>
                                        <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
                                          {unpaid.map(d => {
                                            const selected = payBillingMonth === d.billingMonth;
                                            return (
                                              <button
                                                key={d.billingMonth}
                                                type="button"
                                                onClick={() => {
                                                  setPayBillingMonth(selected ? null : d.billingMonth);
                                                  if (!selected && !payAmount) setPayAmount(String(d.remaining));
                                                }}
                                                style={{ ...st.monthChip, ...(selected ? st.monthChipActive : {}) }}
                                              >
                                                <span style={{ fontWeight: 700 }}>{fmtMonth(d.billingMonth)}</span>
                                                <span style={{ opacity: 0.85 }}>
                                                  {fmtINR(d.remaining)} left
                                                  {d.state === "partial" && ` · ${fmtINR(d.paidAmount)} paid`}
                                                </span>
                                              </button>
                                            );
                                          })}
                                        </div>
                                        {payBillingMonth === null && (
                                          <div style={{ fontSize: 11, color: "#92400e", marginTop: 8 }}>
                                            Pick a month, or leave unselected to record this as unallocated credit.
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })()}

                                  <div style={st.panelRow}>
                                    {/* Amount received */}
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>Amount Received (₹)</label>
                                      <input
                                        ref={payInputRef}
                                        type="number" min={1}
                                        placeholder="0"
                                        value={payAmount}
                                        onChange={e => setPayAmount(e.target.value)}
                                        style={st.panelInput}
                                        onKeyDown={e => { if (e.key === "Enter") submitPay(s); if (e.key === "Escape") closePanel(); }}
                                      />
                                    </div>

                                    {/* Discount */}
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>Discount</label>
                                      <div style={{ display: "flex", gap: 6 }}>
                                        <div style={{ display: "flex", border: "1px solid #d1d5db", borderRadius: 6, overflow: "hidden" }}>
                                          {(["fixed", "percent"] as DiscountType[]).map(dt => (
                                            <button key={dt} onClick={() => setDiscountType(dt)}
                                              style={{
                                                padding: "7px 10px", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer",
                                                background: discountType === dt ? "#f59e0b" : "#f9fafb",
                                                color: discountType === dt ? "#fff" : "#374151",
                                              }}>
                                              {dt === "fixed" ? "₹" : "%"}
                                            </button>
                                          ))}
                                        </div>
                                        <input
                                          type="number" min={0}
                                          placeholder={discountType === "percent" ? "0–100" : "0"}
                                          value={discountValue}
                                          onChange={e => setDiscountValue(e.target.value)}
                                          style={{ ...st.panelInput, flex: 1 }}
                                        />
                                      </div>
                                    </div>

                                    {/* Mode of payment */}
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>Mode</label>
                                      <div style={st.methodGroup}>
                                        {(["Cash", "UPI", "Bank"] as PayMethod[]).map(m => (
                                          <button key={m} onClick={() => setPayMethod(m)}
                                            style={{
                                              ...st.methodChip,
                                              ...(payMethod === m ? st.methodChipActive : {}),
                                            }}>
                                            {m === "Cash" ? "💵" : m === "UPI" ? "📱" : "🏦"} {m}
                                          </button>
                                        ))}
                                      </div>
                                    </div>

                                    {/* Note */}
                                    <div style={{ ...st.panelField, flex: 2 }}>
                                      <label style={st.panelLabel}>Note (optional)</label>
                                      <input type="text" placeholder="e.g. April fees, partial payment…"
                                        value={payNote} onChange={e => setPayNote(e.target.value)}
                                        style={st.panelInput}
                                        onKeyDown={e => { if (e.key === "Enter") submitPay(s); if (e.key === "Escape") closePanel(); }}
                                      />
                                    </div>

                                    {/* Payment date */}
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>
                                        Payment Date
                                        {payDate !== todayStr() && (
                                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "1px 7px", borderRadius: 99 }}>
                                            Past date
                                          </span>
                                        )}
                                      </label>
                                      <input
                                        type="date"
                                        value={payDate}
                                        max={todayStr()}
                                        onChange={e => setPayDate(e.target.value || todayStr())}
                                        style={{
                                          ...st.panelInput,
                                          border: payDate !== todayStr() ? "1.5px solid #f59e0b" : st.panelInput.border,
                                          background: payDate !== todayStr() ? "#fffbeb" : st.panelInput.background,
                                        }}
                                      />
                                    </div>
                                  </div>

                                  {/* Net amount preview */}
                                  {payAmount && (
                                    <div style={st.netPreview}>
                                      {discountAmt > 0 ? (
                                        <>
                                          <span>Gross: <strong>{fmtINR(Number(payAmount))}</strong></span>
                                          <span style={{ color: "#059669" }}>− Discount: <strong>{fmtINR(discountAmt)}</strong></span>
                                          <span style={{ color: "#1d4ed8", fontWeight: 700 }}>= Net: <strong>{fmtINR(netPreview)}</strong></span>
                                        </>
                                      ) : (
                                        <span style={{ color: "#1d4ed8" }}>Amount to record: <strong>{fmtINR(Number(payAmount))}</strong></span>
                                      )}
                                    </div>
                                  )}

                                  <div style={st.panelActions}>
                                    <button onClick={() => submitPay(s)}
                                      disabled={paySubmitting || !payAmount || netPreview <= 0}
                                      style={{
                                        ...st.confirmBtn,
                                        opacity: paySubmitting || !payAmount || netPreview <= 0 ? 0.6 : 1,
                                        cursor: paySubmitting || !payAmount || netPreview <= 0 ? "not-allowed" : "pointer",
                                      }}>
                                      {paySubmitting ? "Saving…" : "✓ Confirm Payment"}
                                    </button>
                                    <button onClick={closePanel} style={st.cancelBtn}>Cancel</button>
                                  </div>
                                    </>
                                  )}
                                </div>
                              )}

                              {/* ════ ADJUST FEE PANEL ═════════════════════════ */}
                              {activeAction === "adjust" && (
                                <div style={st.panel}>
                                  <div style={st.panelTitle}>✏️ Adjust Fee — {s.name}</div>

                                  <div style={st.panelInfo}>
                                    <span style={st.infoChip}>
                                      Current {s.feeCycle === "monthly" ? "monthly fee" : "per-class fee"}:{" "}
                                      <strong>{fmtINR(s.feeCycle === "monthly" ? s.monthlyFee : s.feePerClass)}</strong>
                                    </span>
                                    <span style={st.infoChip}>Cycle: <strong>{s.feeCycle === "monthly" ? "Monthly" : "Per Class"}</strong></span>
                                  </div>

                                  <div style={st.panelRow}>
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>
                                        New {s.feeCycle === "monthly" ? "Monthly Fee" : "Fee per Class"} (₹)
                                      </label>
                                      <input
                                        ref={adjustInputRef}
                                        type="number" min={1}
                                        placeholder="Enter new fee"
                                        value={adjustFee}
                                        onChange={e => setAdjustFee(e.target.value)}
                                        style={{ ...st.panelInput, maxWidth: 200 }}
                                        onKeyDown={e => { if (e.key === "Enter") submitAdjust(s); if (e.key === "Escape") closePanel(); }}
                                      />
                                    </div>
                                    <div style={{ ...st.panelField, flex: 2 }}>
                                      <label style={st.panelLabel}>Why adjusting?</label>
                                      <div style={{ fontSize: 12, color: "#6b7280", paddingTop: 8, lineHeight: 1.5 }}>
                                        This updates the student's fee directly in Firestore.
                                        Future billing and estimations will use the new amount.
                                      </div>
                                    </div>
                                  </div>

                                  <div style={st.panelActions}>
                                    <button onClick={() => submitAdjust(s)}
                                      disabled={adjustSubmitting || !adjustFee || Number(adjustFee) <= 0}
                                      style={{
                                        ...st.confirmBtn,
                                        background: "#4f46e5",
                                        opacity: adjustSubmitting || !adjustFee || Number(adjustFee) <= 0 ? 0.6 : 1,
                                        cursor: adjustSubmitting || !adjustFee || Number(adjustFee) <= 0 ? "not-allowed" : "pointer",
                                      }}>
                                      {adjustSubmitting ? "Saving…" : "✓ Update Fee"}
                                    </button>
                                    <button onClick={closePanel} style={st.cancelBtn}>Cancel</button>
                                  </div>
                                </div>
                              )}

                              {/* ════ HISTORY PANEL ══════════════════════════════ */}
                              {activeAction === "history" && (() => {
                                // Show every transaction for this student — including system
                                // auto-charges — so this matches the Student Detail modal's
                                // Financial Statement 1:1 instead of silently hiding entries.
                                const studentTx = transactions
                                  .filter(t => t.studentUid === s.uid)
                                  .sort((a, b) => {
                                    const da = String(a.date ?? a.createdAt ?? "");
                                    const db2 = String(b.date ?? b.createdAt ?? "");
                                    return db2.localeCompare(da);
                                  });
                                return (
                                  <div style={{ ...st.panel, borderLeft: "3px solid #6d28d9" }}>
                                    <div style={st.panelTitle}>🧾 Transaction History — {s.name}</div>
                                    {studentTx.length === 0 ? (
                                      <div style={{ fontSize: 13, color: "#9ca3af", textAlign: "center" as const, padding: "16px 0" }}>
                                        No transactions recorded yet.
                                      </div>
                                    ) : (
                                      <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
                                        {studentTx.map(tx => {
                                          const isFeedue   = tx.type === "fee_due";
                                          const isDeposit  = tx.type === "deposit";
                                          const isCharge   = tx.type === "charge" || tx.method === "auto";
                                          const isPending  = tx.status === "pending";
                                          const isFailed   = tx.status === "failed";

                                          const typeLabel = isFeedue ? "Fee Due" : isDeposit ? "Payment" : isCharge ? "Auto-charge" : "Payment";
                                          const typeColor = isFeedue
                                            ? { bg: "#fffbeb", border: "#fde68a", text: "#b45309" }
                                            : isDeposit
                                            ? { bg: "#fdf4ff", border: "#e9d5ff", text: "#7e22ce" }
                                            : isCharge
                                            ? { bg: "#fff7ed", border: "#fed7aa", text: "#c2410c" }
                                            : { bg: "#f0fdf4", border: "#86efac", text: "#15803d" };

                                          const methodLabel = isFeedue ? "Generated"
                                            : tx.method === "auto" || tx.method === "auto-monthly" ? "Auto"
                                            : tx.method;

                                          const displayMonth = tx.billingMonth
                                            ? fmtMonth(tx.billingMonth)
                                            : fmtMonth((tx.date ?? tx.createdAt ?? "").slice(0, 7));

                                          return (
                                            <div key={tx.id} style={{
                                              display: "flex", alignItems: "center", gap: 12,
                                              padding: "8px 12px", borderRadius: 8,
                                              background: isFailed ? "#fef2f2" : isPending ? "#fffbeb" : "#f9fafb",
                                              border: `1px solid ${isFailed ? "#fecaca" : isPending ? "#fde68a" : "#e5e7eb"}`,
                                              fontSize: 13, flexWrap: "wrap" as const,
                                            }}>
                                              {/* Month / billing period */}
                                              <span style={{ fontWeight: 700, color: "#111827", minWidth: 90 }}>
                                                {displayMonth}
                                              </span>

                                              {/* Type badge */}
                                              <span style={{
                                                fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
                                                background: typeColor.bg, border: `1px solid ${typeColor.border}`, color: typeColor.text,
                                              }}>
                                                {typeLabel}
                                              </span>

                                              {/* Amount — charges/dues add to balance owed (+, red);
                                                  payments/deposits reduce it (−, green). */}
                                              <span style={{ fontWeight: 700, color: (isCharge || isFeedue) ? "#dc2626" : "#16a34a", minWidth: 70 }}>
                                                {(isCharge || isFeedue) ? "+" : "−"}{fmtINR(tx.amount)}
                                              </span>

                                              {/* Payment date */}
                                              <span style={{ color: "#6b7280", fontSize: 12 }}>
                                                {formatDate(tx.date ?? tx.createdAt)}
                                              </span>

                                              {/* Method */}
                                              <span style={{
                                                fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
                                                background: "#e0e7ff", color: "#3730a3",
                                              }}>
                                                {methodLabel}
                                              </span>

                                              {/* Status */}
                                              {(isPending || isFailed) && (
                                                <span style={{
                                                  fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                                                  background: isFailed ? "#fef2f2" : "#fffbeb",
                                                  color: isFailed ? "#dc2626" : "#d97706",
                                                }}>
                                                  {tx.status}
                                                </span>
                                              )}

                                              {/* Note */}
                                              {tx.note && (
                                                <span style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic" as const }}>
                                                  {tx.note}
                                                </span>
                                              )}

                                              {/* Delete */}
                                              {canManageTx && (
                                                <button
                                                  disabled={historyDeleteSubmitting}
                                                  onClick={() => {
                                                    if (historyDeletePending !== tx.id) {
                                                      setHistoryDeletePending(tx.id);
                                                      if (historyDeleteTimer.current) clearTimeout(historyDeleteTimer.current);
                                                      historyDeleteTimer.current = setTimeout(() => setHistoryDeletePending(null), 4000);
                                                    } else {
                                                      if (historyDeleteTimer.current) clearTimeout(historyDeleteTimer.current);
                                                      setHistoryDeletePending(null);
                                                      setHistoryDeleteSubmitting(true);
                                                      handleDeleteTx(tx.id).finally(() => setHistoryDeleteSubmitting(false));
                                                    }
                                                  }}
                                                  style={{
                                                    marginLeft: "auto", fontSize: 11, fontWeight: 700,
                                                    padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                                                    border: `1px solid ${historyDeletePending === tx.id ? "#dc2626" : "#fca5a5"}`,
                                                    background: historyDeletePending === tx.id ? "#dc2626" : "#fef2f2",
                                                    color: historyDeletePending === tx.id ? "#fff" : "#dc2626",
                                                    opacity: historyDeleteSubmitting ? 0.6 : 1,
                                                  }}
                                                >
                                                  {historyDeletePending === tx.id ? "Confirm?" : "Remove"}
                                                </button>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ══ ATTENDANCE POPUP ════════════════════════════════════════════════════ */}
      {attPopupUid && (() => {
        const s     = students.find(x => x.uid === attPopupUid);
        const dates = attDatesMap.get(attPopupUid) ?? [];
        if (!s) return null;
        const DAY = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
        return (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
            onClick={() => setAttPopupUid(null)}
          >
            <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>📅 Attendance — {s.name}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>{fmtMonth(selectedMonth)} · {dates.length} class{dates.length !== 1 ? "es" : ""} attended</div>
                </div>
                <button onClick={() => setAttPopupUid(null)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 }}>×</button>
              </div>
              {/* Body */}
              <div style={{ padding: "16px 20px", maxHeight: 340, overflowY: "auto" }}>
                {dates.length === 0 ? (
                  <div style={{ textAlign: "center", fontSize: 13, color: "#9ca3af", padding: "24px 0" }}>No attendance recorded for {fmtMonth(selectedMonth)}.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {dates.map((dt, i) => {
                      const d   = new Date(dt + "T00:00:00");
                      const day = DAY[d.getDay()];
                      const num = d.getDate();
                      return (
                        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "6px 10px", minWidth: 44 }}>
                          <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 600 }}>{day}</span>
                          <span style={{ fontSize: 18, fontWeight: 800, color: "#111827", lineHeight: 1.1 }}>{num}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}

// ─── Row actions menu ─────────────────────────────────────────────────────────
// Keeps "Payment" as the single obvious action on each row and tucks the rarely
// used money operations behind ⋮, rather than showing four buttons per student.

function RowActionsMenu({ onAdjust, onDeposit, onHistory }: {
  onAdjust: () => void; onDeposit: () => void; onHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        style={st.rowMenuBtn}
        title="More actions"
        aria-label="More actions"
      >
        ⋮
      </button>
      {open && (
        <div style={st.rowMenuPanel} onClick={e => e.stopPropagation()}>
          <button onClick={() => { setOpen(false); onHistory(); }} style={st.rowMenuItem}>🧾 View history</button>
          <button onClick={() => { setOpen(false); onAdjust();  }} style={st.rowMenuItem}>✏️ Adjust fee</button>
          <button onClick={() => { setOpen(false); onDeposit(); }} style={st.rowMenuItem}>⬆ Add deposit</button>
        </div>
      )}
    </div>
  );
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, accent, icon, hint, urgent, onClick, active }: {
  label: string; value: string; accent: string; icon: string; hint?: string; urgent?: boolean;
  onClick?: () => void; active?: boolean;
}) {
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick!(); } }) : undefined}
      style={{
        ...st.card,
        ...(urgent ? { boxShadow: `0 0 0 2px ${accent}33, 0 1px 4px rgba(0,0,0,0.06)` } : {}),
        ...(active ? { boxShadow: `0 0 0 2px ${accent}, 0 2px 10px rgba(0,0,0,0.10)` } : {}),
        cursor: clickable ? "pointer" : "default",
        outline: "none",
      }}
    >
      <div style={{ ...st.cardAccent, background: accent }} />
      <div style={st.cardBody}>
        <div style={st.cardIcon}>{icon}</div>
        <div style={st.cardLabel}>{label}</div>
        <div style={{ ...st.cardValue, color: accent }}>{value}</div>
        {hint && <div style={st.cardHint}>{hint}</div>}
        {clickable && (
          <div style={{ fontSize: 10, fontWeight: 700, color: accent, marginTop: 6 }}>
            {active ? "▲ Hide details" : "▼ View details"}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Transaction Table ────────────────────────────────────────────────────────

function TxTable({
  transactions, students, centers, loading, formatDate,
  canManage, onEdit, onDelete, isMobile,
}: {
  transactions: Transaction[];
  students:     StudentFeeRow[];
  centers:      CenterOption[];
  loading:      boolean;
  formatDate:   (v: unknown) => string;
  canManage?:   boolean;
  onEdit?:      (txId: string, patch: EditableTransactionInput) => Promise<void>;
  onDelete?:    (txId: string) => Promise<void>;
  isMobile?:    boolean;
}) {
  const studentMap = useMemo(() => {
    const m = new Map<string, { name: string; studentID: string }>();
    students.forEach(s => m.set(s.uid, { name: s.name, studentID: s.studentID }));
    return m;
  }, [students]);

  const centerMap = useMemo(() => {
    const m = new Map<string, string>();
    centers.forEach(c => m.set(c.id, c.name));
    return m;
  }, [centers]);

  // Edit panel state — one row open at a time
  const [editingId,  setEditingId]  = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState<string>("");
  const [editMethod, setEditMethod] = useState<PaymentMethod>("Cash");
  const [editDate,   setEditDate]   = useState<string>("");
  const [editStatus, setEditStatus] = useState<TransactionStatus>("completed");
  const [editNote,   setEditNote]   = useState<string>("");
  const [editSaving, setEditSaving] = useState(false);

  // Delete 2-click confirmation: id of row whose first delete click is pending
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const deleteResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startEdit(tx: Transaction) {
    setEditingId(tx.id);
    setEditAmount(String(tx.amount ?? ""));
    setEditMethod(tx.method);
    setEditDate((tx.date ?? "").slice(0, 10));
    setEditStatus(tx.status);
    setEditNote(tx.note ?? "");
    setDeletePending(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditAmount("");
    setEditNote("");
  }

  async function saveEdit(tx: Transaction) {
    if (!onEdit) return;
    const amt = Number(editAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    if (!editDate) return;
    setEditSaving(true);
    try {
      await onEdit(tx.id, {
        amount: amt,
        method: editMethod,
        date:   editDate,
        status: editStatus,
        note:   editNote.trim() || null,
      });
      cancelEdit();
    } finally {
      setEditSaving(false);
    }
  }

  function clickDelete(txId: string) {
    if (!onDelete) return;
    if (deletePending !== txId) {
      // First click — arm the confirmation, auto-reset after 4s
      setDeletePending(txId);
      if (deleteResetTimer.current) clearTimeout(deleteResetTimer.current);
      deleteResetTimer.current = setTimeout(() => setDeletePending(null), 4000);
      return;
    }
    // Second click — confirm
    if (deleteResetTimer.current) clearTimeout(deleteResetTimer.current);
    setDeletePending(null);
    setDeleteSubmitting(true);
    onDelete(txId).finally(() => setDeleteSubmitting(false));
  }

  if (loading) return <div style={st.stateRow}>Loading…</div>;
  if (transactions.length === 0) return <div style={st.stateRow}>No transactions found.</div>;

  const colCount = isMobile
    ? (canManage ? 5 : 4)
    : (canManage ? 8 : 7);

  return (
    <div style={st.tableWrapper}>
      <table style={{ ...st.table, minWidth: isMobile ? 360 : 860 }}>
        <thead>
          <tr>
            <th style={st.th}>Student</th>
            {!isMobile && <th style={st.th}>Center</th>}
            <th style={st.th}>Amount</th>
            {!isMobile && <th style={st.th}>Discount</th>}
            <th style={st.th}>Method</th>
            <th style={st.th}>Status</th>
            <th style={st.th}>Date</th>
            {canManage && <th style={st.th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx, i) => {
            const student    = tx.studentUid ? studentMap.get(tx.studentUid) : null;
            const centerName = tx.centerId   ? (centerMap.get(tx.centerId) ?? tx.centerId) : "—";
            const txData     = tx as Transaction & { rawAmount?: number; discountAmt?: number };
            const isEditing  = editingId === tx.id;
            const isPendingDelete = deletePending === tx.id;
            return (
              <Fragment key={tx.id}>
                <tr style={i % 2 === 0 ? st.rowEven : st.rowOdd}>
                  <td style={{ ...st.td, minWidth: 140 }}>
                    <div style={{ fontWeight: 600 }}>{student?.name ?? tx.studentUid ?? "—"}</div>
                    {student?.studentID && (
                      <div style={{ marginTop: 2 }}>
                        <span style={st.studentIDChip}>{student.studentID}</span>
                      </div>
                    )}
                    {isMobile && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{centerName}</div>}
                  </td>
                  {!isMobile && <td style={st.td}>{centerName}</td>}
                  <td style={{ ...st.td, fontWeight: 700 }}>
                    {tx.amount != null ? fmtINR(tx.amount) : "—"}
                    {txData.rawAmount && txData.rawAmount !== tx.amount && (
                      <div style={{ fontSize: 10, color: "#9ca3af", textDecoration: "line-through" }}>
                        {fmtINR(txData.rawAmount)}
                      </div>
                    )}
                    {isMobile && txData.discountAmt && txData.discountAmt > 0 && (
                      <div style={{ fontSize: 10, color: "#16a34a" }}>−{fmtINR(txData.discountAmt)} disc.</div>
                    )}
                  </td>
                  {!isMobile && (
                    <td style={st.td}>
                      {txData.discountAmt && txData.discountAmt > 0 ? (
                        <span style={{ ...st.badge, background: "#dcfce7", color: "#16a34a" }}>
                          −{fmtINR(txData.discountAmt)}
                        </span>
                      ) : (
                        <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>
                      )}
                    </td>
                  )}
                  <td style={st.td}>
                    <span style={{ ...st.badge, ...(METHOD_STYLES[tx.method] ?? {}) }}>
                      {tx.method ?? "—"}
                    </span>
                  </td>
                  <td style={st.td}>
                    <span style={{ ...st.badge, ...(STATUS_BADGE[tx.status ?? ""] ?? {}) }}>
                      {tx.status ?? "—"}
                    </span>
                  </td>
                  <td style={{ ...st.td, ...st.mono }}>
                    {formatDate(tx.date ?? tx.createdAt)}
                  </td>
                  {canManage && (
                    <td style={{ ...st.td, whiteSpace: "nowrap" as const }}>
                      <button
                        onClick={() => (isEditing ? cancelEdit() : startEdit(tx))}
                        disabled={editSaving || deleteSubmitting}
                        style={{
                          ...st.txActionBtn,
                          ...(isEditing ? st.txActionBtnActive : {}),
                        }}
                        title={isEditing ? "Close editor" : "Edit transaction"}
                      >
                        {isEditing ? "Close" : "✏️ Edit"}
                      </button>
                    </td>
                  )}
                </tr>

                {isEditing && canManage && (
                  <tr key={`${tx.id}-edit`}>
                    <td colSpan={colCount} style={{ padding: "0 14px 14px", background: "#fffbeb" }}>
                      <div style={{ ...st.panel, borderLeft: "3px solid #1d4ed8" }}>
                        <div style={st.panelTitle}>
                          ✏️ Edit Transaction — {student?.name ?? tx.studentUid}
                          {tx.method === "auto-monthly" && tx.billingMonth && (
                            <span style={{ ...st.infoChip, marginLeft: 8, fontSize: 11 }}>
                              Fee due — {fmtMonth(tx.billingMonth)}
                            </span>
                          )}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 12 }}>
                          <div>
                            <label style={st.panelLabel}>Amount (₹)</label>
                            <input
                              type="number" min={1} step={1}
                              value={editAmount}
                              onChange={e => setEditAmount(e.target.value)}
                              style={st.panelInput}
                            />
                          </div>
                          <div>
                            <label style={st.panelLabel}>Method</label>
                            <select
                              value={editMethod}
                              onChange={e => setEditMethod(e.target.value as PaymentMethod)}
                              style={st.panelInput}
                            >
                              <option value="Cash">Cash</option>
                              <option value="UPI">UPI</option>
                              <option value="Bank">Bank</option>
                              <option value="auto-monthly">auto-monthly</option>
                              <option value="auto">auto</option>
                            </select>
                          </div>
                          <div>
                            <label style={st.panelLabel}>Date</label>
                            <input
                              type="date"
                              value={editDate}
                              max={todayStr()}
                              onChange={e => setEditDate(e.target.value)}
                              style={st.panelInput}
                            />
                          </div>
                          <div>
                            <label style={st.panelLabel}>Status</label>
                            <select
                              value={editStatus}
                              onChange={e => setEditStatus(e.target.value as TransactionStatus)}
                              style={st.panelInput}
                            >
                              <option value="completed">completed</option>
                              <option value="pending">pending</option>
                              <option value="failed">failed</option>
                            </select>
                          </div>
                        </div>

                        <div style={{ marginBottom: 12 }}>
                          <label style={st.panelLabel}>Note (optional)</label>
                          <input
                            type="text"
                            value={editNote}
                            onChange={e => setEditNote(e.target.value)}
                            placeholder="Add a note explaining the change…"
                            style={st.panelInput}
                          />
                        </div>

                        {/* Diff preview */}
                        {(Number(editAmount) !== tx.amount ||
                          editMethod !== tx.method ||
                          editDate   !== (tx.date ?? "").slice(0, 10) ||
                          editStatus !== tx.status ||
                          (editNote.trim() || null) !== (tx.note ?? null)) && (
                          <div style={st.diffBox}>
                            <div style={st.diffTitle}>Changes</div>
                            <DiffRow label="Amount" before={fmtINR(tx.amount)} after={fmtINR(Number(editAmount) || 0)} />
                            <DiffRow label="Method" before={tx.method}         after={editMethod} />
                            <DiffRow label="Date"   before={formatDate(tx.date ?? "")} after={formatDate(editDate)} />
                            <DiffRow label="Status" before={tx.status}         after={editStatus} />
                            <DiffRow label="Note"   before={tx.note ?? "—"}    after={editNote.trim() || "—"} />
                          </div>
                        )}

                        <div style={{ ...st.panelActions, justifyContent: "space-between" }}>
                          {/* Left: Delete (2-click confirm) */}
                          <button
                            onClick={() => clickDelete(tx.id)}
                            disabled={editSaving || deleteSubmitting}
                            style={{
                              ...st.confirmBtn,
                              background: isPendingDelete ? "#dc2626" : "#fee2e2",
                              color:      isPendingDelete ? "#fff"    : "#b91c1c",
                              border:     isPendingDelete ? "none"    : "1px solid #fecaca",
                              opacity:    deleteSubmitting ? 0.6 : 1,
                            }}
                            title={isPendingDelete ? "Click again to confirm permanent delete" : "Delete transaction"}
                          >
                            {deleteSubmitting
                              ? "Deleting…"
                              : isPendingDelete
                                ? "⚠ Click again to confirm Delete"
                                : "🗑 Delete"}
                          </button>

                          {/* Right: Save / Cancel */}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={cancelEdit} style={st.cancelBtn} disabled={editSaving || deleteSubmitting}>
                              Cancel
                            </button>
                            <button
                              onClick={() => saveEdit(tx)}
                              disabled={
                                editSaving ||
                                deleteSubmitting ||
                                !editAmount ||
                                Number(editAmount) <= 0 ||
                                !editDate
                              }
                              style={{
                                ...st.confirmBtn,
                                background: "#1d4ed8",
                                opacity: editSaving ? 0.6 : 1,
                                cursor: editSaving ? "not-allowed" : "pointer",
                              }}
                            >
                              {editSaving ? "Saving…" : "💾 Save Changes"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DiffRow({ label, before, after }: { label: string; before: string; after: string }) {
  if (before === after) return null;
  return (
    <div style={{ fontSize: 12, color: "#374151", display: "flex", gap: 8, padding: "2px 0" }}>
      <span style={{ width: 70, color: "#6b7280", fontWeight: 600 }}>{label}:</span>
      <span style={{ color: "#9ca3af", textDecoration: "line-through" }}>{before}</span>
      <span style={{ color: "#9ca3af" }}>→</span>
      <span style={{ color: "#1d4ed8", fontWeight: 600 }}>{after}</span>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
  header:      { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16 },
  heading:     { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 4 },
  overdueAlert:{ fontSize: 12, color: "#dc2626", fontWeight: 600, background: "#fee2e2", display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 99 },

  cardGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 20 },
  card:       { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" as const, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" },
  cardAccent: { height: 4, width: "100%" },
  cardBody:   { padding: "14px 18px" },
  cardIcon:   { fontSize: 20, marginBottom: 4 },
  cardLabel:  { fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  cardValue:  { fontSize: 24, fontWeight: 700 },
  cardHint:   { fontSize: 10, color: "#9ca3af", marginTop: 4, lineHeight: 1.3 },

  tabs:      { display: "flex", gap: 4, marginBottom: 16, background: "var(--color-surface)", borderRadius: 8, padding: 4, border: "1px solid var(--color-border)" },
  tab:       { flex: 1, padding: "8px 0", borderRadius: 6, border: "none", background: "transparent", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", cursor: "pointer", textAlign: "center" as const, transition: "all 0.15s" },
  tabActive: { background: "#ede9fe", color: "#6d28d9", fontWeight: 700 },

  filterRow:     { display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  filterSelect:  { padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", cursor: "pointer", minWidth: 130, flex: "1 1 130px" },
  filterDate:    { padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)" },
  clearDate:     { background: "none", border: "none", fontSize: 12, color: "#6b7280", cursor: "pointer", padding: "4px 8px" },
  filterSummary: { fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 },
  searchInput:   { padding: "7px 12px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", minWidth: 140, flex: "1 1 140px" },

  overdueBanner: { display: "flex", alignItems: "flex-start", gap: 10, background: "#fff1f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#be123c" },
  overduePill:   { display: "inline-block", fontSize: 9, fontWeight: 800, background: "#fee2e2", color: "#dc2626", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.06em" },

  tableWrapper: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "auto" },
  stateRow:     { padding: "24px 16px", textAlign: "center" as const, fontSize: 13, color: "var(--color-text-secondary)" },
  table:        { width: "100%", minWidth: 860, borderCollapse: "collapse" as const },
  th:           { padding: "11px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", borderBottom: "1px solid var(--color-border)", background: "#f9fafb" },
  td:           { padding: "11px 14px", fontSize: 13, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:      { background: "var(--color-surface)" },
  rowOdd:       { background: "#fafafa" },
  mono:         { fontFamily: "monospace", fontSize: 12, color: "var(--color-text-secondary)" },
  badge:        { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize" as const },
  studentIDChip:{ display: "inline-block", fontFamily: "monospace", fontSize: 10, fontWeight: 700, background: "#dbeafe", color: "#1e40af", padding: "1px 6px", borderRadius: 4 },

  sectionTitle: { fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 10, textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  moreHint:     { padding: "10px 14px", fontSize: 12, color: "var(--color-text-secondary)", textAlign: "center" as const },
  linkBtn:      { background: "none", border: "none", color: "#4f46e5", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 },

  // Action buttons per row
  actionBtn:      { padding: "5px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--color-surface)", color: "var(--color-text-primary)", transition: "all 0.1s" },
  actionBtnActive:{ background: "#fef9c3", borderColor: "#f59e0b", color: "#92400e" },
  closePanelBtn:  { background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: "2px 4px", lineHeight: 1 },

  // Panel (shared for all 3 modes)
  panel:       { background: "#fff", border: "1px solid #fde68a", borderRadius: 10, padding: "16px 18px", marginTop: 6, boxShadow: "0 2px 10px rgba(0,0,0,0.06)" },
  panelTitle:  { fontSize: 14, fontWeight: 700, color: "#92400e", marginBottom: 12 },
  panelInfo:   { display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 14 },
  infoChip:    { fontSize: 12, background: "#f3f4f6", color: "#374151", padding: "3px 10px", borderRadius: 99, fontWeight: 500 },
  infoChipRed: { fontSize: 12, background: "#fee2e2", color: "#dc2626", padding: "3px 10px", borderRadius: 99, fontWeight: 700 },
  infoChipGreen:{ fontSize: 12, background: "#dcfce7", color: "#16a34a", padding: "3px 10px", borderRadius: 99, fontWeight: 700 },
  partlyPaidTag: {
    display: "inline-block", marginLeft: 6, padding: "1px 8px", borderRadius: 99,
    fontSize: 10, fontWeight: 700, background: "#fef9c3", color: "#92400e",
    border: "1px solid #fde68a", verticalAlign: "middle",
  },

  rowMenuBtn: {
    background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 8,
    width: 28, height: 28, fontSize: 15, fontWeight: 700, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, flexShrink: 0,
  },
  rowMenuPanel: {
    position: "absolute" as const, top: "calc(100% + 6px)", right: 0, background: "#fff",
    border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
    minWidth: 165, overflow: "hidden", zIndex: 20,
  },
  rowMenuItem: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px",
    fontSize: 13, fontWeight: 500, color: "#111827", background: "none", border: "none",
    textAlign: "left" as const, cursor: "pointer", boxSizing: "border-box" as const, whiteSpace: "nowrap" as const,
  },

  monthPicker: {
    background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10,
    padding: "12px 14px", marginBottom: 14,
  },
  monthPickerLabel: {
    fontSize: 11, fontWeight: 700, color: "#92400e",
    textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 8,
  },
  monthChip: {
    display: "flex", flexDirection: "column" as const, gap: 2, alignItems: "flex-start",
    padding: "7px 14px", borderRadius: 8, cursor: "pointer",
    background: "#fff", border: "1.5px solid #e5e7eb", color: "#374151",
    fontSize: 11, fontFamily: "inherit", textAlign: "left" as const,
  },
  monthChipActive: { background: "#f59e0b", color: "#fff", border: "1.5px solid #d97706" },

  panelRow:    { display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" as const, marginBottom: 14 },
  panelField:  { display: "flex", flexDirection: "column" as const, gap: 5, flex: 1, minWidth: 110 },
  panelLabel:  { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  panelInput:  { padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, background: "#fff", color: "#111" },
  netPreview:  { display: "flex", gap: 16, alignItems: "center", fontSize: 13, padding: "8px 12px", background: "#f0fdf4", borderRadius: 6, marginBottom: 12, flexWrap: "wrap" as const },
  panelActions:{ display: "flex", gap: 10, alignItems: "center" },
  confirmBtn:  { background: "#059669", color: "#fff", border: "none", borderRadius: 6, padding: "9px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  cancelBtn:   { background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 6, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },

  // Method selector
  methodGroup:     { display: "flex", gap: 6 },
  methodChip:      { padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "#f9fafb", color: "#374151" },
  methodChipActive:{ background: "#f59e0b", color: "#fff", border: "1px solid #d97706" },

  // Per-row tx actions (Edit / Delete)
  txActionBtn:       { padding: "5px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--color-surface)", color: "var(--color-text-primary)" },
  txActionBtnActive: { background: "#dbeafe", borderColor: "#1d4ed8", color: "#1d4ed8" },

  // Diff box for edit preview
  diffBox:   { background: "#f9fafb", border: "1px dashed #d1d5db", borderRadius: 8, padding: "10px 14px", marginBottom: 12 },
  diffTitle: { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 6 },
};
