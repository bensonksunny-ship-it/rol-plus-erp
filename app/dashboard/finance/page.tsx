"use client";

import { useState, useEffect, useMemo } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  query, where, doc, serverTimestamp,
  increment,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { getTransactions } from "@/services/finance/finance.service";
import type { Transaction } from "@/types/finance";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StudentFeeRow {
  uid:         string;
  name:        string;
  studentID:   string;
  admissionNo: string;
  centerName:  string;
  centerId:    string;
  feeCycle:    string;
  feePerClass: number;
  balance:     number;   // currentBalance from Firestore
  status:      string;
}

interface CenterOption { id: string; name: string; centerCode: string; }

// ─── Constants ─────────────────────────────────────────────────────────────────

const METHOD_STYLES: Record<string, React.CSSProperties> = {
  UPI:            { background: "#ede9fe", color: "#4f46e5" },
  Cash:           { background: "#dcfce7", color: "#16a34a" },
  Bank:           { background: "#dbeafe", color: "#1d4ed8" },
  auto:           { background: "#f3f4f6", color: "#374151" },
  "auto-monthly": { background: "#fef9c3", color: "#b45309" },
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
  const [tab, setTab]                     = useState<ActiveTab>("overview");
  const [transactions, setTransactions]   = useState<Transaction[]>([]);
  const [students, setStudents]           = useState<StudentFeeRow[]>([]);
  const [centers, setCenters]             = useState<CenterOption[]>([]);
  const [loading, setLoading]             = useState(true);
  const [billing, setBilling]             = useState(false);
  const { toasts, toast, remove }         = useToast();

  // Filter state
  const [filterCenter, setFilterCenter]   = useState<string>("all");
  const [filterStatus, setFilterStatus]   = useState<string>("all");
  const [filterDate, setFilterDate]       = useState<string>("");  // YYYY-MM-DD or ""

  async function fetchAll() {
    try {
      const [txData, studentSnap, centerSnap] = await Promise.all([
        getTransactions(),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "centers")),
      ]);

      const cMap = new Map<string, { name: string; centerCode: string }>();
      centerSnap.docs.forEach(d => cMap.set(d.id, {
        name:       (d.data().name       as string) ?? d.id,
        centerCode: (d.data().centerCode as string) ?? "—",
      }));
      setCenters(centerSnap.docs.map(d => ({
        id:         d.id,
        name:       (d.data().name       as string) ?? d.id,
        centerCode: (d.data().centerCode as string) ?? "—",
      })));

      setTransactions(txData.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")));

      setStudents(studentSnap.docs.map(d => {
        const s = d.data();
        const c = cMap.get(s.centerId as string);
        return {
          uid:         d.id,
          name:        (s.displayName ?? s.name ?? "—") as string,
          studentID:   (s.studentID   ?? "—") as string,
          admissionNo: (s.admissionNo ?? s.admissionNumber ?? "—") as string,
          centerName:  c?.name ?? (s.centerId as string) ?? "—",
          centerId:    (s.centerId ?? "") as string,
          feeCycle:    (s.feeCycle  ?? "—") as string,
          feePerClass: Number(s.feePerClass ?? 0),
          balance:     Number(s.currentBalance ?? 0),
          status:      (s.status ?? "active") as string,
        };
      }));
    } catch (err) {
      console.error("Finance fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, []);

  // ── Live summary cards ─────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const today   = todayStr();
    const total   = transactions.filter(t => t.status === "completed").reduce((s, t) => s + (t.amount ?? 0), 0);
    const todayAmt = transactions.filter(t =>
      t.status === "completed" && t.date?.startsWith(today)
    ).reduce((s, t) => s + (t.amount ?? 0), 0);
    const pending  = students.filter(s => s.balance > 0).reduce((acc, s) => acc + s.balance, 0);
    const activeCount = students.filter(s => s.status === "active").length;
    return { total, todayAmt, pending, activeCount };
  }, [transactions, students]);

  // ── Monthly billing ────────────────────────────────────────────────────────
  async function runMonthlyBilling() {
    setBilling(true);
    const month = currentMonth();
    let charged = 0; let skipped = 0;
    try {
      const snap     = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
      const monthly  = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
        .filter(s => s.feeCycle === "monthly");

      await Promise.all(monthly.map(async student => {
        if ((student.lastBilledMonth as string | undefined) === month) { skipped++; return; }
        const amount = Number(student.monthlyFee ?? student.feePerClass ?? 0);
        if (amount <= 0) { skipped++; return; }

        await addDoc(collection(db, "transactions"), {
          studentUid: student.id,
          centerId:   (student.centerId as string) ?? "",
          amount,
          method:     "auto-monthly",
          receivedBy: "system",
          date:       todayStr(),
          status:     "completed",
          createdAt:  serverTimestamp(),
        });
        await updateDoc(doc(db, "users", student.id), {
          currentBalance:  increment(amount),
          lastBilledMonth: month,
          updatedAt:       new Date().toISOString(),
        });
        charged++;
      }));

      await fetchAll();
      toast(`Monthly billing done. Charged: ${charged}, Skipped: ${skipped}.`, "success");
    } catch (err) {
      console.error("Monthly billing failed:", err);
      toast("Monthly billing failed.", "error");
    } finally {
      setBilling(false);
    }
  }

  // ── Filtered transactions ─────────────────────────────────────────────────
  const filteredTx = useMemo(() => {
    return transactions.filter(tx => {
      if (filterCenter !== "all" && tx.centerId !== filterCenter) return false;
      if (filterStatus !== "all" && tx.status !== filterStatus)   return false;
      if (filterDate) {
        const txDate = (tx.date ?? "").slice(0, 10);
        if (txDate !== filterDate) return false;
      }
      return true;
    });
  }, [transactions, filterCenter, filterStatus, filterDate]);

  // ── Student table ─────────────────────────────────────────────────────────
  const filteredStudents = useMemo(() => {
    return filterCenter === "all"
      ? students
      : students.filter(s => s.centerId === filterCenter);
  }, [students, filterCenter]);

  function formatDate(value: unknown): string {
    if (!value || typeof value !== "string") return "-";
    return value.slice(0, 10);
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={st.header}>
        <h1 style={st.heading}>Finance</h1>
        <button onClick={runMonthlyBilling} disabled={billing}
          style={{ ...st.billingBtn, opacity: billing ? 0.6 : 1 }}>
          {billing ? "Processing…" : "Run Monthly Billing"}
        </button>
      </div>

      {/* ── Live Summary Cards ──────────────────────────────────────────── */}
      <div style={st.cardGrid}>
        <SummaryCard label="Total Collected" value={loading ? "…" : fmtINR(summary.total)} accent="#16a34a" icon="💰" />
        <SummaryCard label="Pending Balance" value={loading ? "…" : fmtINR(summary.pending)} accent="#d97706" icon="⏳" />
        <SummaryCard label="Collected Today"  value={loading ? "…" : fmtINR(summary.todayAmt)} accent="#4f46e5" icon="📅" />
        <SummaryCard label="Active Students"  value={loading ? "…" : String(summary.activeCount)} accent="#059669" icon="🎓" />
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div style={st.tabs}>
        {(["overview", "students", "transactions"] as ActiveTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...st.tab, ...(tab === t ? st.tabActive : {}) }}>
            {t === "overview" ? "📊 Overview" : t === "students" ? "🎓 Students" : "🧾 Transactions"}
          </button>
        ))}
      </div>

      {/* Center filter (shared across tabs) */}
      <div style={st.filterRow}>
        <select value={filterCenter} onChange={e => setFilterCenter(e.target.value)} style={st.filterSelect}>
          <option value="all">All Centers</option>
          {centers.map(c => (
            <option key={c.id} value={c.id}>[{c.centerCode}] {c.name}</option>
          ))}
        </select>
        {tab === "transactions" && (
          <>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={st.filterSelect}>
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
            </select>
            <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)}
              style={st.filterDate} title="Filter by date" />
            {filterDate && (
              <button onClick={() => setFilterDate("")} style={st.clearDate}>✕ Clear date</button>
            )}
          </>
        )}
      </div>

      {/* ── OVERVIEW TAB ────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <div>
          <div style={st.sectionTitle}>Recent Transactions</div>
          <TxTable
            transactions={transactions.slice(0, 10)}
            students={students}
            centers={centers}
            loading={loading}
            formatDate={formatDate}
          />
          {transactions.length > 10 && (
            <div style={st.moreHint}>
              Showing 10 of {transactions.length} transactions.{" "}
              <button onClick={() => setTab("transactions")} style={st.linkBtn}>View all →</button>
            </div>
          )}
        </div>
      )}

      {/* ── STUDENTS TAB ─────────────────────────────────────────────────── */}
      {tab === "students" && (
        <div style={st.tableWrapper}>
          {loading ? (
            <div style={st.stateRow}>Loading…</div>
          ) : filteredStudents.length === 0 ? (
            <div style={st.stateRow}>No students found{filterCenter !== "all" ? " for this center" : ""}.</div>
          ) : (
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Student ID</th>
                  <th style={st.th}>Name</th>
                  <th style={st.th}>Center</th>
                  <th style={st.th}>Fee Cycle</th>
                  <th style={st.th}>Fee/Class</th>
                  <th style={st.th}>Balance Due</th>
                  <th style={st.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((s, i) => (
                  <tr key={s.uid} style={i % 2 === 0 ? st.rowEven : st.rowOdd}>
                    <td style={{ ...st.td, ...st.mono }}>
                      <span style={st.studentIDChip}>{s.studentID}</span>
                    </td>
                    <td style={{ ...st.td, fontWeight: 600 }}>{s.name}</td>
                    <td style={st.td}>{s.centerName}</td>
                    <td style={st.td}>
                      <span style={s.feeCycle === "per_class"
                        ? { ...st.badge, background: "#ede9fe", color: "#7c3aed" }
                        : { ...st.badge, background: "#dbeafe", color: "#1d4ed8" }}>
                        {s.feeCycle === "per_class" ? "Per Class" : "Monthly"}
                      </span>
                    </td>
                    <td style={st.td}>
                      {s.feeCycle === "per_class" ? fmtINR(s.feePerClass) : "—"}
                    </td>
                    <td style={{ ...st.td, fontWeight: 600, color: s.balance > 0 ? "#d97706" : "#16a34a" }}>
                      {fmtINR(s.balance)}
                    </td>
                    <td style={st.td}>
                      <span style={{
                        ...st.badge,
                        ...(s.status === "active"
                          ? { background: "#dcfce7", color: "#16a34a" }
                          : { background: "#f3f4f6", color: "#6b7280" }),
                      }}>{s.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TRANSACTIONS TAB ────────────────────────────────────────────── */}
      {tab === "transactions" && (
        <div>
          {filterDate || filterCenter !== "all" || filterStatus !== "all" ? (
            <div style={st.filterSummary}>
              Showing {filteredTx.length} of {transactions.length} transactions
            </div>
          ) : null}
          <TxTable
            transactions={filteredTx}
            students={students}
            centers={centers}
            loading={loading}
            formatDate={formatDate}
          />
        </div>
      )}
    </div>
  );
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, accent, icon }: {
  label: string; value: string; accent: string; icon: string;
}) {
  return (
    <div style={st.card}>
      <div style={{ ...st.cardAccent, background: accent }} />
      <div style={st.cardBody}>
        <div style={st.cardIcon}>{icon}</div>
        <div style={st.cardLabel}>{label}</div>
        <div style={{ ...st.cardValue, color: accent }}>{value}</div>
      </div>
    </div>
  );
}

// ─── Transaction Table ────────────────────────────────────────────────────────

function TxTable({ transactions, students, centers, loading, formatDate }: {
  transactions:  Transaction[];
  students:      StudentFeeRow[];
  centers:       CenterOption[];
  loading:       boolean;
  formatDate:    (v: unknown) => string;
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
            <th style={st.th}>Method</th>
            <th style={st.th}>Status</th>
            <th style={st.th}>Date</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx, i) => {
            const student  = tx.studentUid ? studentMap.get(tx.studentUid) : null;
            const centerName = tx.centerId  ? (centerMap.get(tx.centerId) ?? tx.centerId) : "—";
            return (
              <tr key={tx.id} style={i % 2 === 0 ? st.rowEven : st.rowOdd}>
                <td style={{ ...st.td, minWidth: 160 }}>
                  <div style={{ fontWeight: 600 }}>{student?.name ?? tx.studentUid ?? "—"}</div>
                  {student?.studentID && (
                    <div style={{ ...st.mono, fontSize: 11, marginTop: 1 }}>
                      <span style={st.studentIDChip}>{student.studentID}</span>
                    </div>
                  )}
                </td>
                <td style={st.td}>{centerName}</td>
                <td style={{ ...st.td, fontWeight: 700 }}>
                  {tx.amount != null ? fmtINR(tx.amount) : "—"}
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
  header:      { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  heading:     { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)" },
  billingBtn:  { background: "#059669", color: "#fff", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 24 },
  card:     { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" as const, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" },
  cardAccent:  { height: 4, width: "100%" },
  cardBody:    { padding: "14px 18px" },
  cardIcon:    { fontSize: 20, marginBottom: 4 },
  cardLabel:   { fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  cardValue:   { fontSize: 24, fontWeight: 700 },

  tabs: { display: "flex", gap: 4, marginBottom: 16, background: "var(--color-surface)", borderRadius: 8, padding: 4, border: "1px solid var(--color-border)" },
  tab:  { flex: 1, padding: "8px 0", borderRadius: 6, border: "none", background: "transparent", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", cursor: "pointer", textAlign: "center" as const },
  tabActive: { background: "#ede9fe", color: "#6d28d9", fontWeight: 700 },

  filterRow:   { display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  filterSelect:{ padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", cursor: "pointer", minWidth: 160 },
  filterDate:  { padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", cursor: "pointer" },
  clearDate:   { background: "none", border: "none", fontSize: 12, color: "#6b7280", cursor: "pointer", padding: "4px 8px" },
  filterSummary: { fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 },

  tableWrapper: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "auto" },
  stateRow:     { padding: "24px 16px", textAlign: "center" as const, fontSize: 13, color: "var(--color-text-secondary)" },
  table:        { width: "100%", minWidth: 720, borderCollapse: "collapse" as const },
  th: { padding: "11px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", borderBottom: "1px solid var(--color-border)", background: "#f9fafb" },
  td:           { padding: "11px 14px", fontSize: 13, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:      { background: "var(--color-surface)" },
  rowOdd:       { background: "#fafafa" },
  mono:         { fontFamily: "monospace", fontSize: 12, color: "var(--color-text-secondary)" },
  badge:        { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize" as const },
  studentIDChip:{ display: "inline-block", fontFamily: "monospace", fontSize: 10, fontWeight: 700, background: "#dbeafe", color: "#1e40af", padding: "1px 6px", borderRadius: 4 },

  sectionTitle: { fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 10, textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  moreHint:     { padding: "10px 14px", fontSize: 12, color: "var(--color-text-secondary)", textAlign: "center" as const },
  linkBtn:      { background: "none", border: "none", color: "#4f46e5", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 },
};
