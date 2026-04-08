"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  query, where, doc, serverTimestamp,
  increment,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuth } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { getTransactions } from "@/services/finance/finance.service";
import type { Transaction } from "@/types/finance";
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
  lastBilledMonth: string | null;
}

interface CenterOption { id: string; name: string; centerCode: string; }

type PayMethod      = "UPI" | "Cash" | "Bank";
type DiscountType   = "fixed" | "percent";
// Which inline panel is open for a student row
type RowAction      = "pay" | "adjust" | "bill" | "deposit";

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
      <FinanceContent />
    </ProtectedRoute>
  );
}

type ActiveTab = "overview" | "students" | "transactions";

function FinanceContent() {
  const { user }                             = useAuth();
  const [tab, setTab]                        = useState<ActiveTab>("overview");
  const [transactions, setTransactions]      = useState<Transaction[]>([]);
  const [students, setStudents]              = useState<StudentFeeRow[]>([]);
  const [centers, setCenters]                = useState<CenterOption[]>([]);
  const [loading, setLoading]                = useState(true);
  const [billing, setBilling]                = useState(false);
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
  const [discountType, setDiscountType]      = useState<DiscountType>("fixed");
  const [discountValue, setDiscountValue]    = useState<string>("");
  const [paySubmitting, setPaySubmitting]    = useState(false);
  const payInputRef                          = useRef<HTMLInputElement>(null);

  // Adjust fee state
  const [adjustFee, setAdjustFee]            = useState<string>("");
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const adjustInputRef                       = useRef<HTMLInputElement>(null);

  // Per-student billing state
  const [billSubmitting, setBillSubmitting]  = useState(false);

  // Deposit state (prepay advance)
  const [depositAmount, setDepositAmount]    = useState<string>("");
  const [depositMethod, setDepositMethod]    = useState<PayMethod>("Cash");
  const [depositNote, setDepositNote]        = useState<string>("");
  const [depositSubmitting, setDepositSubmitting] = useState(false);
  const depositInputRef                      = useRef<HTMLInputElement>(null);

  // Filters
  const [filterCenter, setFilterCenter]      = useState<string>("all");
  const [filterStatus, setFilterStatus]      = useState<string>("all");
  const [filterDate, setFilterDate]          = useState<string>("");
  const [studentSearch, setStudentSearch]    = useState<string>("");
  const [filterClassType, setFilterClassType]   = useState<string>("all");  // "all" | "group" | "personal"
  const [filterBillingMode, setFilterBillingMode] = useState<string>("all"); // "all" | "prepay" | "postpay"

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

      // ── Attendance count for the selected month ────────────────────────────
      const monthAttMap = new Map<string, number>();
      attSnap.docs.forEach(d => {
        const data = d.data();
        const date = (data.date ?? "") as string;
        if (!date.startsWith(month)) return;
        const uid = (data.studentUid ?? "") as string;
        if (!uid) return;
        monthAttMap.set(uid, (monthAttMap.get(uid) ?? 0) + 1);
      });

      // ── Historical balance reconstruction for past months ─────────────────
      // For the current month we trust the live `currentBalance` on the student doc.
      // For past months we replay all transactions up to end-of-that-month to
      // reconstruct what the balance was at that point in time.
      //
      // Sign convention (same as Firestore writes):
      //   Payment received  → increment(-net)  → reduces balance (good for student)
      //   Billing charge    → increment(+amt)  → increases balance (student owes more)
      //   Deposit (prepay)  → increment(-amt)  → reduces balance (credit added)
      //
      // Transaction type detection (fields written by this page):
      //   method === "auto-monthly"  → monthly billing charge  (+balance)
      //   method === "auto"          → per-class charge         (+balance)
      //   type   === "deposit"       → prepay deposit           (-balance)
      //   everything else            → payment received         (-balance)

      const isCurrent = month === currentMonth();
      // Last day of the selected month (e.g. "2025-04-30")
      const [yr, mo] = month.split("-").map(Number);
      const lastDayOfMonth = new Date(yr, mo, 0).getDate(); // day 0 of next month = last day of this month
      const monthEnd = `${month}-${String(lastDayOfMonth).padStart(2, "0")}`;

      // Per-student balance as of end of selected month (only needed for past months)
      const historicalBalanceMap = new Map<string, number>();
      // Per-student: was a billing charge recorded IN the selected month?
      const billedThisMonthSet  = new Set<string>();

      if (!isCurrent) {
        // We need to replay ALL transactions up to monthEnd
        txData.forEach(tx => {
          if (tx.status !== "completed") return;
          const txDate = (tx.date ?? "").slice(0, 10);
          if (!tx.studentUid || txDate > monthEnd) return; // skip future tx

          const raw = tx as unknown as Record<string, unknown>;
          const method = (raw.method ?? "") as string;
          const type   = (raw.type   ?? "") as string;
          const amt    = Number(tx.amount ?? 0);
          const uid    = tx.studentUid;

          const prev = historicalBalanceMap.get(uid) ?? 0;

          if (method === "auto-monthly" || method === "auto") {
            // Billing charge — adds to balance (student owes)
            historicalBalanceMap.set(uid, prev + amt);
            // Mark billed for THIS month specifically
            if (txDate.startsWith(month)) billedThisMonthSet.add(uid);
          } else if (type === "deposit") {
            // Prepay deposit — reduces balance (adds credit)
            historicalBalanceMap.set(uid, prev - amt);
          } else {
            // Payment received — reduces balance
            historicalBalanceMap.set(uid, prev - amt);
          }
        });
      } else {
        // Current month: check transactions for billing in this month
        txData.forEach(tx => {
          if (tx.status !== "completed" || !tx.studentUid) return;
          const txDate = (tx.date ?? "").slice(0, 10);
          if (!txDate.startsWith(month)) return;
          const raw    = tx as unknown as Record<string, unknown>;
          const method = (raw.method ?? "") as string;
          if (method === "auto-monthly") billedThisMonthSet.add(tx.studentUid);
        });
      }

      setStudents(studentSnap.docs.map(d => {
        const s           = d.data();
        const c           = cMap.get(s.centerId as string);
        const feePerClass = Number(s.feePerClass ?? 0);
        const monthlyFee  = Number(s.monthlyFee  ?? s.feePerClass ?? 0);
        const attCount    = monthAttMap.get(d.id) ?? 0;
        const estimatedFee = feePerClass > 0 ? attCount * feePerClass : 0;

        // Balance: live for current month, reconstructed for past months
        const liveBalance = Number(s.currentBalance ?? 0);
        const balance = isCurrent
          ? liveBalance
          : (historicalBalanceMap.get(d.id) ?? 0);

        // lastBilledMonth: for current month use student doc field;
        // for past months derive from transaction history
        const liveLastBilled = (s.lastBilledMonth as string | null) ?? null;
        const lastBilledMonth = isCurrent
          ? liveLastBilled
          : (billedThisMonthSet.has(d.id) ? month : liveLastBilled);

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
          lastBilledMonth,
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

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const today      = todayStr();
    // Filter transactions to the selected month
    const monthTx    = transactions.filter(t =>
      t.status === "completed" && (t.date ?? "").startsWith(selectedMonth)
    );
    const total      = monthTx.reduce((s, t) => s + (t.amount ?? 0), 0);
    // "Today" only meaningful if viewing current month
    const todayAmt   = isCurrentMonth
      ? transactions.filter(t => t.status === "completed" && t.date?.startsWith(today))
          .reduce((s, t) => s + (t.amount ?? 0), 0)
      : 0;
    const overdueStudents = students.filter(s => s.balance > 0);
    const pendingBal      = overdueStudents.reduce((acc, s) => acc + s.balance, 0);
    const activeCount     = students.filter(s => s.status === "active").length;
    const totalEstFee     = students.reduce((acc, s) => acc + s.estimatedFee, 0);
    const groupCount      = students.filter(s => s.classType === "group").length;
    const personalCount   = students.filter(s => s.classType === "personal").length;
    // Prepay credit (live balance, not month-specific)
    const prepayStudents  = students.filter(s => s.billingMode === "prepay");
    const prepayCredit    = prepayStudents.filter(s => s.balance < 0).reduce((acc, s) => acc + Math.abs(s.balance), 0);
    const prepayCount     = prepayStudents.length;
    const lowCreditCount  = prepayStudents.filter(s => {
      const fee = s.feeCycle === "monthly" ? s.monthlyFee : s.feePerClass;
      return s.balance >= -fee;
    }).length;
    return { total, todayAmt, pendingBal, activeCount, totalEstFee, overdueCount: overdueStudents.length, groupCount, personalCount, prepayCredit, prepayCount, lowCreditCount };
  }, [transactions, students, selectedMonth, isCurrentMonth]);

  // ── Last tx per student (scoped to selected month) ───────────────────────────
  const lastTxMap = useMemo(() => {
    const m = new Map<string, Transaction>();
    // transactions are sorted newest-first; find the newest one in selected month per student
    transactions.forEach(tx => {
      if (tx.status === "completed" && tx.studentUid && !m.has(tx.studentUid)) {
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
    setPayAmount(action === "pay" ? (student.balance > 0 ? String(student.balance) : String(student.estimatedFee)) : "");
    setPayMethod("Cash");
    setPayNote("");
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
    if (action === "pay")     setTimeout(() => payInputRef.current?.focus(),     60);
    if (action === "adjust")  setTimeout(() => adjustInputRef.current?.focus(),  60);
    if (action === "deposit") setTimeout(() => depositInputRef.current?.focus(), 60);
  }

  function closePanel() {
    setActiveUid(null);
    setPayAmount("");
    setPayNote("");
    setDiscountValue("");
    setAdjustFee("");
    setDepositAmount("");
    setDepositNote("");
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
      const receivedBy    = user?.displayName ?? user?.email ?? "admin";
      const rawAmount     = Number(payAmount);
      const discountAmt   = rawAmount - net;

      await addDoc(collection(db, "transactions"), {
        studentUid:   student.uid,
        centerId:     student.centerId,
        amount:       net,
        rawAmount:    rawAmount !== net ? rawAmount : null,
        discountAmt:  discountAmt > 0 ? discountAmt : null,
        discountType: discountAmt > 0 ? discountType : null,
        method:       payMethod,
        receivedBy,
        note:         payNote.trim() || null,
        date:         todayStr(),
        status:       "completed",
        createdAt:    serverTimestamp(),
      });
      await updateDoc(doc(db, "users", student.uid), {
        currentBalance: increment(-net),
        updatedAt:      new Date().toISOString(),
      });
      closePanel();
      await fetchAll(selectedMonth);
      const discMsg = discountAmt > 0
        ? ` (discount ${fmtINR(discountAmt)} applied)`
        : "";
      toast(`✓ ${fmtINR(net)} received from ${student.name} via ${payMethod}${discMsg}`, "success");
    } catch (err) {
      console.error("Payment failed:", err);
      toast("Payment failed. Try again.", "error");
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

  // ── Submit: per-student monthly billing ─────────────────────────────────────
  async function submitBillStudent(student: StudentFeeRow) {
    if (student.lastBilledMonth === selectedMonth) {
      toast(`${student.name} has already been billed for ${fmtMonth(selectedMonth)}`, "error");
      return;
    }
    if (student.feeCycle !== "monthly") {
      toast(`${student.name} is on per-class billing — monthly billing does not apply`, "error");
      return;
    }
    const amount = student.monthlyFee;
    if (!amount || amount <= 0) {
      toast(`No monthly fee set for ${student.name}`, "error");
      return;
    }
    // For past months, use the last day of that month as the billing date
    const billingDate = isCurrentMonth ? todayStr() : `${selectedMonth}-01`;
    setBillSubmitting(true);
    try {
      await addDoc(collection(db, "transactions"), {
        studentUid:    student.uid,
        centerId:      student.centerId,
        amount,
        method:        "auto-monthly",
        receivedBy:    user?.displayName ?? user?.email ?? "system",
        date:          billingDate,
        billingMonth:  selectedMonth,
        status:        "completed",
        createdAt:     serverTimestamp(),
      });
      await updateDoc(doc(db, "users", student.uid), {
        currentBalance:  increment(amount),
        lastBilledMonth: selectedMonth,
        updatedAt:       new Date().toISOString(),
      });
      closePanel();
      await fetchAll(selectedMonth);
      toast(`Monthly fee ${fmtINR(amount)} billed to ${student.name} for ${fmtMonth(selectedMonth)}`, "success");
    } catch (err) {
      console.error("Per-student billing failed:", err);
      toast("Billing failed. Try again.", "error");
    } finally {
      setBillSubmitting(false);
    }
  }

  // ── Submit: prepay advance deposit ──────────────────────────────────────────
  async function submitDeposit(student: StudentFeeRow) {
    const amt = Number(depositAmount);
    if (!amt || amt <= 0) {
      toast("Enter a valid deposit amount (> 0)", "error");
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
      toast(`✓ Advance deposit ${fmtINR(amt)} recorded for ${student.name} via ${depositMethod}`, "success");
    } catch (err) {
      console.error("Deposit failed:", err);
      toast("Deposit failed. Try again.", "error");
    } finally {
      setDepositSubmitting(false);
    }
  }

  // ── Bulk monthly billing ─────────────────────────────────────────────────────
  async function runMonthlyBilling() {
    const month = selectedMonth;
    setBilling(true);
    let charged = 0; let skipped = 0;
    const billingDate = isCurrentMonth ? todayStr() : `${month}-01`;
    try {
      const snap    = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
      const monthly = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
        .filter(s => s.feeCycle === "monthly");

      await Promise.all(monthly.map(async student => {
        if ((student.lastBilledMonth as string | undefined) === month) { skipped++; return; }
        const amount = Number(student.monthlyFee ?? student.feePerClass ?? 0);
        if (amount <= 0) { skipped++; return; }
        await addDoc(collection(db, "transactions"), {
          studentUid:   student.id,
          centerId:     (student.centerId as string) ?? "",
          amount,
          method:       "auto-monthly",
          receivedBy:   "system",
          date:         billingDate,
          billingMonth: month,
          status:       "completed",
          createdAt:    serverTimestamp(),
        });
        await updateDoc(doc(db, "users", student.id), {
          currentBalance:  increment(amount),
          lastBilledMonth: month,
          updatedAt:       new Date().toISOString(),
        });
        charged++;
      }));

      await fetchAll(month);
      toast(
        `Billing for ${fmtMonth(month)} complete — ${charged} student${charged !== 1 ? "s" : ""} charged, ${skipped} already billed`,
        "success"
      );
    } catch (err) {
      console.error("Monthly billing failed:", err);
      toast("Monthly billing failed. Check console for details.", "error");
    } finally {
      setBilling(false);
    }
  }

  // ── Filters ──────────────────────────────────────────────────────────────────
  const filteredTx = useMemo(() => {
    return transactions.filter(tx => {
      // Always scope to selected month (override-able by specific date filter)
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

  const filteredStudents = useMemo(() => {
    let list = filterCenter === "all" ? students : students.filter(s => s.centerId === filterCenter);
    if (filterClassType !== "all") {
      list = list.filter(s => s.classType === filterClassType);
    }
    if (filterBillingMode !== "all") {
      list = list.filter(s => s.billingMode === filterBillingMode);
    }
    if (studentSearch.trim()) {
      const q = studentSearch.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.studentID.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      if (b.balance > 0 && a.balance <= 0) return 1;
      if (a.balance > 0 && b.balance <= 0) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [students, filterCenter, studentSearch, filterClassType, filterBillingMode]);

  function formatDate(value: unknown): string {
    if (!value || typeof value !== "string") return "-";
    return value.slice(0, 10);
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
        <button onClick={runMonthlyBilling} disabled={billing}
          style={{ ...st.billingBtn, opacity: billing ? 0.6 : 1, cursor: billing ? "not-allowed" : "pointer" }}>
          {billing ? "⏳ Processing…" : `⚡ Run Billing — ${fmtMonth(selectedMonth)}`}
        </button>
      </div>

      {/* ── Summary Cards ────────────────────────────────────────────────────── */}
      <div style={st.cardGrid}>
        <SummaryCard label={`Collected — ${fmtMonth(selectedMonth)}`} value={loading ? "…" : fmtINR(summary.total)} accent="#16a34a" icon="💰" />
        {isCurrentMonth
          ? <SummaryCard label="Collected Today"  value={loading ? "…" : fmtINR(summary.todayAmt)}  accent="#4f46e5" icon="📅" />
          : <SummaryCard label="Month (Past)"     value={fmtMonth(selectedMonth)}                   accent="#b45309" icon="🕐" hint="Historical view" />
        }
        <SummaryCard label="Pending Balance"   value={loading ? "…" : fmtINR(summary.pendingBal)}    accent="#d97706" icon="⏳" />
        <SummaryCard label="Overdue Students"  value={loading ? "…" : String(summary.overdueCount)}  accent="#dc2626" icon="🚨"
          urgent={summary.overdueCount > 0} />
        <SummaryCard label="Prepay Credit Held" value={loading ? "…" : fmtINR(summary.prepayCredit)} accent="#9d174d" icon="⬆"
          hint={`${summary.prepayCount} prepay student${summary.prepayCount !== 1 ? "s" : ""}`} />
        <SummaryCard label="Low Credit Alert"  value={loading ? "…" : String(summary.lowCreditCount)} accent="#b45309" icon="⚠"
          urgent={summary.lowCreditCount > 0}
          hint="Credit < 1 month fee" />
        <SummaryCard label="Active Students"   value={loading ? "…" : String(summary.activeCount)}   accent="#059669" icon="🎓" />
        <SummaryCard label={`Est. Fees — ${fmtMonth(selectedMonth)}`} value={loading ? "…" : fmtINR(summary.totalEstFee)} accent="#7c3aed" icon="📊"
          hint="Attendance × fee/class" />
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────────── */}
      <div style={st.tabs}>
        {([
          { key: "overview",     label: "📊 Overview" },
          { key: "students",     label: `🎓 Students${summary.overdueCount > 0 && !loading ? ` (${summary.overdueCount} overdue)` : ""}` },
          { key: "transactions", label: "🧾 Transactions" },
        ] as { key: ActiveTab; label: string }[]).map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              ...st.tab,
              ...(tab === key ? st.tabActive : {}),
              ...(key === "students" && summary.overdueCount > 0 && !loading && tab !== key
                ? { color: "#dc2626", fontWeight: 600 } : {}),
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Shared filters ───────────────────────────────────────────────────── */}
      <div style={st.filterRow}>
        <select value={filterCenter} onChange={e => setFilterCenter(e.target.value)} style={st.filterSelect}>
          <option value="all">All Centers</option>
          {centers.map(c => (
            <option key={c.id} value={c.id}>[{c.centerCode}] {c.name}</option>
          ))}
        </select>
        {tab === "students" && (
          <>
            <input type="search" placeholder="Search name or ID…" value={studentSearch}
              onChange={e => setStudentSearch(e.target.value)} style={st.searchInput} />
            {/* Class type segmentation chips */}
            <div style={{ display: "flex", gap: 4, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6, padding: 3 }}>
              {([
                { key: "all",      label: "All" },
                { key: "group",    label: "👥 Group" },
                { key: "personal", label: "👤 Personal" },
              ] as { key: string; label: string }[]).map(({ key, label }) => (
                <button key={key} onClick={() => setFilterClassType(key)}
                  style={{
                    padding: "4px 12px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer",
                    background: filterClassType === key ? "var(--color-accent, #f59e0b)" : "transparent",
                    color: filterClassType === key ? "#fff" : "var(--color-text-secondary)",
                  }}>
                  {label}
                </button>
              ))}
            </div>
            {/* Billing mode chips */}
            <div style={{ display: "flex", gap: 4, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6, padding: 3 }}>
              {([
                { key: "all",     label: "All Billing" },
                { key: "postpay", label: "⬇ Postpay" },
                { key: "prepay",  label: "⬆ Prepay" },
              ] as { key: string; label: string }[]).map(({ key, label }) => (
                <button key={key} onClick={() => setFilterBillingMode(key)}
                  style={{
                    padding: "4px 12px", borderRadius: 4, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer",
                    background: filterBillingMode === key ? "#9d174d" : "transparent",
                    color: filterBillingMode === key ? "#fff" : "var(--color-text-secondary)",
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        {tab === "transactions" && (
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

      {/* ══ OVERVIEW TAB ═══════════════════════════════════════════════════════ */}
      {tab === "overview" && (
        <div>
          <div style={st.sectionTitle}>
            Transactions — {fmtMonth(selectedMonth)}
          </div>
          <TxTable transactions={filteredTx.slice(0, 15)} students={students}
            centers={centers} loading={loading} formatDate={formatDate} />
          {filteredTx.length > 15 && (
            <div style={st.moreHint}>
              Showing 15 of {filteredTx.length}.{" "}
              <button onClick={() => setTab("transactions")} style={st.linkBtn}>View all →</button>
            </div>
          )}
          {!loading && filteredTx.length === 0 && (
            <div style={st.stateRow}>No transactions for {fmtMonth(selectedMonth)}.</div>
          )}
        </div>
      )}

      {/* ══ STUDENTS TAB ═══════════════════════════════════════════════════════ */}
      {tab === "students" && (
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
                Any actions (pay/bill/deposit) will update the <strong>live balance</strong>.
              </span>
            </div>
          )}

          <div style={st.tableWrapper}>
            {loading ? (
              <div style={st.stateRow}>Loading…</div>
            ) : filteredStudents.length === 0 ? (
              <div style={st.stateRow}>No students found.</div>
            ) : (
              <table style={st.table}>
                <thead>
                  <tr>
                    <th style={st.th}>Student</th>
                    <th style={st.th}>Class</th>
                    <th style={st.th}>Center</th>
                    <th style={st.th}>Cycle</th>
                    <th style={st.th}>Fee</th>
                    <th style={st.th}>
                      Att.{" "}
                      <span style={{ fontSize: 10, fontWeight: 400, color: "#9ca3af" }}>
                        {fmtMonth(selectedMonth).split(" ")[0].slice(0,3)}
                      </span>
                    </th>
                    <th style={st.th}>Est. Fee</th>
                    <th style={st.th}>
                      Balance
                      {!isCurrentMonth && (
                        <span style={{ fontSize: 10, fontWeight: 400, color: "#b45309", display: "block" }}>
                          as of {fmtMonth(selectedMonth)}
                        </span>
                      )}
                    </th>
                    <th style={st.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.map((s) => {
                    const isPrepay   = s.billingMode === "prepay";
                    const overdue    = s.balance > 0;   // owes money
                    const hasCredit  = isPrepay && s.balance < 0; // prepay credit remaining
                    const isOpen     = activeUid === s.uid;
                    const month      = selectedMonth;
                    const alreadyBilled = s.lastBilledMonth === month;
                    const canBill    = s.feeCycle === "monthly" && !alreadyBilled;
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
                        {/* ── Main data row ─────────────────────────────────── */}
                        <tr key={s.uid} style={{ background: rowBg, transition: "background 0.15s" }}>

                          <td style={{ ...st.td, minWidth: 160 }}>
                            <div style={{ fontWeight: 600 }}>{s.name}</div>
                            <span style={st.studentIDChip}>{s.studentID}</span>
                          </td>

                          {/* Class Type + Billing Mode */}
                          <td style={st.td}>
                            <span style={{
                              ...st.badge,
                              ...(s.classType === "personal"
                                ? { background: "#fef9c3", color: "#92400e" }
                                : { background: "#dcfce7", color: "#166534" }),
                            }}>
                              {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
                            </span>
                            <div style={{ marginTop: 3 }}>
                              <span style={{
                                ...st.badge, fontSize: 10,
                                ...(isPrepay
                                  ? { background: "#fce7f3", color: "#9d174d" }
                                  : { background: "#f3f4f6", color: "#374151" }),
                              }}>
                                {isPrepay ? "⬆ Prepay" : "⬇ Postpay"}
                              </span>
                            </div>
                          </td>

                          <td style={{ ...st.td, fontSize: 12, color: "var(--color-text-secondary)" }}>
                            {s.centerName}
                          </td>

                          <td style={st.td}>
                            <span style={s.feeCycle === "per_class"
                              ? { ...st.badge, background: "#ede9fe", color: "#7c3aed" }
                              : { ...st.badge, background: "#dbeafe", color: "#1d4ed8" }}>
                              {s.feeCycle === "per_class" ? "Per Class" : "Monthly"}
                            </span>
                          </td>

                          {/* Fee amount — with edit hint */}
                          <td style={{ ...st.td, fontWeight: 600 }}>
                            <span style={{ color: "var(--color-text-primary)" }}>
                              {s.feeCycle === "monthly"
                                ? fmtINR(s.monthlyFee)
                                : fmtINR(s.feePerClass)}
                            </span>
                          </td>

                          <td style={{ ...st.td, textAlign: "center" as const }}>
                            <span style={{
                              ...st.badge,
                              background: s.attendanceCount === 0 ? "#f3f4f6" : "#dbeafe",
                              color:      s.attendanceCount === 0 ? "#9ca3af" : "#1d4ed8",
                              fontWeight: 700,
                            }}>
                              {s.attendanceCount}
                            </span>
                          </td>

                          <td style={{ ...st.td, fontWeight: 600 }}>
                            {s.feeCycle === "per_class"
                              ? <span style={{ color: s.estimatedFee > 0 ? "#7c3aed" : "#9ca3af" }}>{fmtINR(s.estimatedFee)}</span>
                              : <span style={{ color: "#9ca3af" }}>—</span>}
                          </td>

                          <td style={{ ...st.td, fontWeight: 700 }}>
                            {overdue ? (
                              <span style={{ color: "#dc2626", display: "flex", alignItems: "center", gap: 4 }}>
                                {fmtINR(s.balance)}
                                <span style={st.overduePill}>DUE</span>
                              </span>
                            ) : hasCredit ? (
                              <div>
                                <span style={{ color: "#16a34a" }}>Credit {fmtINR(creditAmt)}</span>
                                {lowCredit && (
                                  <div style={{ fontSize: 10, color: "#b45309", fontWeight: 600, marginTop: 2 }}>
                                    ⚠ Low credit
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span style={{ color: "#16a34a" }}>✓ Cleared</span>
                            )}
                          </td>

                          {/* ── Action buttons ──────────────────────────────── */}
                          <td style={{ ...st.td, whiteSpace: "nowrap" as const }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>

                              {/* Deposit (prepay only) */}
                              {isPrepay && (
                                <button
                                  onClick={() => openPanel(s.uid, "deposit", s)}
                                  style={{
                                    ...st.actionBtn,
                                    ...(isOpen && activeAction === "deposit" ? st.actionBtnActive : {}),
                                    background: lowCredit ? "#9d174d" : undefined,
                                    color: lowCredit ? "#fff" : undefined,
                                    border: lowCredit ? "none" : undefined,
                                  }}
                                  title="Add advance deposit"
                                >
                                  ⬆ Deposit
                                </button>
                              )}

                              {/* Pay — for overdue or postpay collection */}
                              {(!isPrepay || overdue) && (
                                <button
                                  onClick={() => openPanel(s.uid, "pay", s)}
                                  style={{
                                    ...st.actionBtn,
                                    ...(isOpen && activeAction === "pay" ? st.actionBtnActive : {}),
                                    ...(overdue ? { background: "#dc2626", color: "#fff", border: "none" } : {}),
                                  }}
                                  title="Record payment received"
                                >
                                  💳 Pay
                                </button>
                              )}

                              {/* Adjust fee */}
                              <button
                                onClick={() => openPanel(s.uid, "adjust", s)}
                                style={{
                                  ...st.actionBtn,
                                  ...(isOpen && activeAction === "adjust" ? st.actionBtnActive : {}),
                                }}
                                title="Adjust fee amount"
                              >
                                ✏️ Fee
                              </button>

                              {/* Per-student bill (monthly only) */}
                              {s.feeCycle === "monthly" && (
                                <button
                                  onClick={() => openPanel(s.uid, "bill", s)}
                                  disabled={alreadyBilled}
                                  style={{
                                    ...st.actionBtn,
                                    ...(isOpen && activeAction === "bill" ? st.actionBtnActive : {}),
                                    ...(alreadyBilled ? { opacity: 0.4, cursor: "not-allowed" } : {}),
                                  }}
                                  title={alreadyBilled ? `Already billed for ${fmtMonth(month)}` : `Bill for ${fmtMonth(month)}`}
                                >
                                  🗓 Bill
                                </button>
                              )}

                              {/* Close */}
                              {isOpen && (
                                <button onClick={closePanel} style={st.closePanelBtn} title="Close">✕</button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {/* ── Inline panel row ──────────────────────────────── */}
                        {isOpen && (
                          <tr key={`${s.uid}-panel`}>
                            <td colSpan={9} style={{ padding: "0 14px 16px", background: "#fffbeb" }}>

                              {/* ════ PAY PANEL ════════════════════════════════ */}
                              {activeAction === "pay" && (
                                <div style={st.panel}>
                                  <div style={st.panelTitle}>💳 Record Payment — {s.name}</div>

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
                                        {s.balance > 0 && (
                                          <>
                                            <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>→</div>
                                            <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                              <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>
                                                {isCurrentMonth ? "Outstanding" : `Balance — ${fmtMonth(selectedMonth)}`}
                                              </span>
                                              <span style={{ fontSize: 22, fontWeight: 800, color: "#dc2626", lineHeight: 1 }}>{fmtINR(s.balance)}</span>
                                              <span style={{ fontSize: 11, color: "#dc2626" }}>{isCurrentMonth ? "due now" : "as of that month"}</span>
                                            </div>
                                          </>
                                        )}
                                      </>
                                    )}
                                  </div>

                                  {/* Context info */}
                                  <div style={st.panelInfo}>
                                    {s.balance > 0 && (
                                      <span style={st.infoChipRed}>
                                        Outstanding: {fmtINR(s.balance)}
                                      </span>
                                    )}
                                    {lastTxMap.get(s.uid) && (
                                      <span style={st.infoChip}>
                                        {isCurrentMonth ? "Last pay" : `Pay in ${fmtMonth(selectedMonth)}`}: {fmtINR(lastTxMap.get(s.uid)!.amount)} on {formatDate(lastTxMap.get(s.uid)!.date ?? lastTxMap.get(s.uid)!.createdAt)}
                                      </span>
                                    )}
                                  </div>

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

                              {/* ════ BILL PANEL ═══════════════════════════════ */}
                              {activeAction === "bill" && (
                                <div style={st.panel}>
                                  <div style={st.panelTitle}>🗓 Monthly Billing — {s.name}</div>

                                  {/* Attendance context for monthly billing */}
                                  <div style={{
                                    background: "#eff6ff",
                                    border: "1px solid #bfdbfe",
                                    borderRadius: 10,
                                    padding: "12px 16px",
                                    marginBottom: 12,
                                    display: "flex",
                                    gap: 20,
                                    alignItems: "center",
                                    flexWrap: "wrap" as const,
                                  }}>
                                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                      <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Monthly Fee</span>
                                      <span style={{ fontSize: 22, fontWeight: 800, color: "#1d4ed8", lineHeight: 1 }}>{fmtINR(s.monthlyFee)}</span>
                                    </div>
                                    <div style={{ fontSize: 20, color: "#9ca3af" }}>·</div>
                                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                                      <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5 }}>Classes — {fmtMonth(selectedMonth)}</span>
                                      <span style={{ fontSize: 22, fontWeight: 800, color: "#374151", lineHeight: 1 }}>{s.attendanceCount}</span>
                                      <span style={{ fontSize: 11, color: "#6b7280" }}>attended</span>
                                    </div>
                                  </div>

                                  <div style={st.panelInfo}>
                                    <span style={st.infoChip}>
                                      Monthly fee: <strong>{fmtINR(s.monthlyFee)}</strong>
                                    </span>
                                    <span style={alreadyBilled ? st.infoChipGreen : st.infoChipRed}>
                                      {alreadyBilled ? `✓ Already billed for ${fmtMonth(month)}` : `Not yet billed for ${fmtMonth(month)}`}
                                    </span>
                                  </div>

                                  {!canBill ? (
                                    <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>
                                      {alreadyBilled
                                        ? `${s.name} has already been billed for ${fmtMonth(month)}. No action needed.`
                                        : `Per-class students are billed automatically on attendance. Manual monthly billing does not apply.`}
                                    </div>
                                  ) : (
                                    <>
                                      <div style={{ fontSize: 13, color: "#374151", padding: "8px 0" }}>
                                        {isPrepay ? (
                                          <>
                                            This will deduct <strong>{fmtINR(s.monthlyFee)}</strong> from <strong>{s.name}</strong>{"'s"} prepay credit for {fmtMonth(month)}.{" "}
                                            {hasCredit
                                              ? <>Remaining credit after billing: <strong style={{ color: creditAmt >= s.monthlyFee ? "#16a34a" : "#dc2626" }}>{fmtINR(creditAmt - s.monthlyFee)}</strong></>
                                              : <span style={{ color: "#dc2626" }}>No credit — balance will go further into due.</span>
                                            }
                                          </>
                                        ) : (
                                          <>
                                            This will raise a monthly fee invoice of <strong>{fmtINR(s.monthlyFee)}</strong> for{" "}
                                            <strong>{s.name}</strong> and add it to their balance for {fmtMonth(month)}.
                                          </>
                                        )}
                                      </div>
                                      <div style={st.panelActions}>
                                        <button onClick={() => submitBillStudent(s)}
                                          disabled={billSubmitting}
                                          style={{
                                            ...st.confirmBtn,
                                            background: "#0369a1",
                                            opacity: billSubmitting ? 0.6 : 1,
                                            cursor: billSubmitting ? "not-allowed" : "pointer",
                                          }}>
                                          {billSubmitting ? "Billing…" : `⚡ Bill ${fmtINR(s.monthlyFee)} — ${fmtMonth(month)}`}
                                        </button>
                                        <button onClick={closePanel} style={st.cancelBtn}>Cancel</button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}

                              {/* ════ DEPOSIT PANEL ══════════════════════════════ */}
                              {activeAction === "deposit" && (
                                <div style={{ ...st.panel, borderLeft: "3px solid #9d174d" }}>
                                  <div style={st.panelTitle}>⬆ Add Advance Deposit — {s.name}</div>

                                  <div style={st.panelInfo}>
                                    {hasCredit && (
                                      <span style={{ ...st.infoChipGreen }}>
                                        Current credit: {fmtINR(creditAmt)}
                                      </span>
                                    )}
                                    {overdue && (
                                      <span style={st.infoChipRed}>
                                        Outstanding due: {fmtINR(s.balance)}
                                      </span>
                                    )}
                                    {lowCredit && !overdue && (
                                      <span style={{ ...st.infoChip, color: "#b45309", background: "#fef3c7", border: "1px solid #fde68a" }}>
                                        ⚠ Credit low — less than one fee cycle remaining
                                      </span>
                                    )}
                                    <span style={st.infoChip}>
                                      Monthly fee: <strong>{fmtINR(s.feeCycle === "monthly" ? s.monthlyFee : s.feePerClass)}</strong>
                                    </span>
                                  </div>

                                  <div style={st.panelRow}>
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>Deposit Amount (₹)</label>
                                      <input
                                        ref={depositInputRef}
                                        type="number" min={1}
                                        placeholder="0"
                                        value={depositAmount}
                                        onChange={e => setDepositAmount(e.target.value)}
                                        style={st.panelInput}
                                        onKeyDown={e => { if (e.key === "Enter") submitDeposit(s); if (e.key === "Escape") closePanel(); }}
                                      />
                                    </div>

                                    {/* Mode of deposit */}
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>Mode of Receipt</label>
                                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                                        {(["Cash", "UPI", "Bank"] as PayMethod[]).map(m => (
                                          <button key={m} onClick={() => setDepositMethod(m)}
                                            style={{
                                              ...st.methodChip,
                                              ...(depositMethod === m
                                                ? METHOD_STYLES[m] ?? {}
                                                : { background: "#f3f4f6", color: "#374151" }),
                                              fontWeight: depositMethod === m ? 700 : 400,
                                              border: depositMethod === m ? "1.5px solid currentColor" : "1px solid #e5e7eb",
                                            }}>
                                            {m}
                                          </button>
                                        ))}
                                      </div>
                                    </div>

                                    {/* Note */}
                                    <div style={st.panelField}>
                                      <label style={st.panelLabel}>Note (optional)</label>
                                      <input
                                        type="text"
                                        placeholder="e.g. Advance for 3 months"
                                        value={depositNote}
                                        onChange={e => setDepositNote(e.target.value)}
                                        style={{ ...st.panelInput, maxWidth: 240 }}
                                        onKeyDown={e => { if (e.key === "Escape") closePanel(); }}
                                      />
                                    </div>
                                  </div>

                                  {/* Preview */}
                                  {depositAmount && Number(depositAmount) > 0 && (
                                    <div style={{ fontSize: 13, color: "#374151", padding: "8px 0", borderTop: "1px solid #e5e7eb", marginTop: 8 }}>
                                      New credit after deposit:{" "}
                                      <strong style={{ color: "#16a34a" }}>
                                        {fmtINR(creditAmt + Number(depositAmount))}
                                      </strong>
                                      {overdue && Number(depositAmount) >= s.balance && (
                                        <span style={{ marginLeft: 8, fontSize: 11, color: "#16a34a" }}>
                                          (clears outstanding due)
                                        </span>
                                      )}
                                    </div>
                                  )}

                                  <div style={st.panelActions}>
                                    <button
                                      onClick={() => submitDeposit(s)}
                                      disabled={depositSubmitting || !depositAmount || Number(depositAmount) <= 0}
                                      style={{
                                        ...st.confirmBtn,
                                        background: "#9d174d",
                                        opacity: depositSubmitting || !depositAmount || Number(depositAmount) <= 0 ? 0.6 : 1,
                                        cursor: depositSubmitting || !depositAmount || Number(depositAmount) <= 0 ? "not-allowed" : "pointer",
                                      }}>
                                      {depositSubmitting ? "Saving…" : `⬆ Record Deposit ${depositAmount ? fmtINR(Number(depositAmount)) : ""}`}
                                    </button>
                                    <button onClick={closePanel} style={st.cancelBtn}>Cancel</button>
                                  </div>
                                </div>
                              )}

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

      {/* ══ TRANSACTIONS TAB ═══════════════════════════════════════════════════ */}
      {tab === "transactions" && (
        <div>
          <div style={st.filterSummary}>
            {fmtMonth(selectedMonth)} — {filteredTx.length} transaction{filteredTx.length !== 1 ? "s" : ""}
            {(filterDate || filterCenter !== "all" || filterStatus !== "all") && " (filtered)"}
          </div>
          <TxTable transactions={filteredTx} students={students}
            centers={centers} loading={loading} formatDate={formatDate} />
        </div>
      )}
    </div>
  );
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, accent, icon, hint, urgent }: {
  label: string; value: string; accent: string; icon: string; hint?: string; urgent?: boolean;
}) {
  return (
    <div style={{ ...st.card, ...(urgent ? { boxShadow: `0 0 0 2px ${accent}33, 0 1px 4px rgba(0,0,0,0.06)` } : {}) }}>
      <div style={{ ...st.cardAccent, background: accent }} />
      <div style={st.cardBody}>
        <div style={st.cardIcon}>{icon}</div>
        <div style={st.cardLabel}>{label}</div>
        <div style={{ ...st.cardValue, color: accent }}>{value}</div>
        {hint && <div style={st.cardHint}>{hint}</div>}
      </div>
    </div>
  );
}

// ─── Transaction Table ────────────────────────────────────────────────────────

function TxTable({ transactions, students, centers, loading, formatDate }: {
  transactions: Transaction[];
  students:     StudentFeeRow[];
  centers:      CenterOption[];
  loading:      boolean;
  formatDate:   (v: unknown) => string;
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

  if (loading) return <div style={st.stateRow}>Loading…</div>;
  if (transactions.length === 0) return <div style={st.stateRow}>No transactions found.</div>;

  return (
    <div style={st.tableWrapper}>
      <table style={st.table}>
        <thead>
          <tr>
            <th style={st.th}>Student</th>
            <th style={st.th}>Center</th>
            <th style={st.th}>Amount</th>
            <th style={st.th}>Discount</th>
            <th style={st.th}>Method</th>
            <th style={st.th}>Status</th>
            <th style={st.th}>Date</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx, i) => {
            const student    = tx.studentUid ? studentMap.get(tx.studentUid) : null;
            const centerName = tx.centerId   ? (centerMap.get(tx.centerId) ?? tx.centerId) : "—";
            const txData     = tx as Transaction & { rawAmount?: number; discountAmt?: number };
            return (
              <tr key={tx.id} style={i % 2 === 0 ? st.rowEven : st.rowOdd}>
                <td style={{ ...st.td, minWidth: 160 }}>
                  <div style={{ fontWeight: 600 }}>{student?.name ?? tx.studentUid ?? "—"}</div>
                  {student?.studentID && (
                    <div style={{ marginTop: 2 }}>
                      <span style={st.studentIDChip}>{student.studentID}</span>
                    </div>
                  )}
                </td>
                <td style={st.td}>{centerName}</td>
                <td style={{ ...st.td, fontWeight: 700 }}>
                  {tx.amount != null ? fmtINR(tx.amount) : "—"}
                  {txData.rawAmount && txData.rawAmount !== tx.amount && (
                    <div style={{ fontSize: 10, color: "#9ca3af", textDecoration: "line-through" }}>
                      {fmtINR(txData.rawAmount)}
                    </div>
                  )}
                </td>
                <td style={st.td}>
                  {txData.discountAmt && txData.discountAmt > 0 ? (
                    <span style={{ ...st.badge, background: "#dcfce7", color: "#16a34a" }}>
                      −{fmtINR(txData.discountAmt)}
                    </span>
                  ) : (
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>
                  )}
                </td>
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
  header:      { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16 },
  heading:     { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 4 },
  overdueAlert:{ fontSize: 12, color: "#dc2626", fontWeight: 600, background: "#fee2e2", display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 99 },
  billingBtn:  { background: "#059669", color: "#fff", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" as const, flexShrink: 0 },

  cardGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 14, marginBottom: 24 },
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
  filterSelect:  { padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", cursor: "pointer", minWidth: 160 },
  filterDate:    { padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)" },
  clearDate:     { background: "none", border: "none", fontSize: 12, color: "#6b7280", cursor: "pointer", padding: "4px 8px" },
  filterSummary: { fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 },
  searchInput:   { padding: "7px 12px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", minWidth: 200 },

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
  panelRow:    { display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" as const, marginBottom: 14 },
  panelField:  { display: "flex", flexDirection: "column" as const, gap: 5, flex: 1, minWidth: 130 },
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
};
