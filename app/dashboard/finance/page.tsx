"use client";

import { useState, useEffect } from "react";
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

// ─── Constants ─────────────────────────────────────────────────────────────────

const SUMMARY_CARDS = [
  { label: "Total Collected", value: "₹1,24,500", accent: "#16a34a" },
  { label: "Pending",         value: "₹18,200",  accent: "#d97706" },
  { label: "Today",           value: "₹3,400",   accent: "#4f46e5" },
];

const METHOD_STYLES: Record<string, React.CSSProperties> = {
  UPI:            { background: "#ede9fe", color: "#4f46e5" },
  Cash:           { background: "#dcfce7", color: "#16a34a" },
  Bank:           { background: "#dbeafe", color: "#1d4ed8" },
  auto:           { background: "#f3f4f6", color: "#374151" },
  "auto-monthly": { background: "#fef9c3", color: "#b45309" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-03"
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <FinanceContent />
    </ProtectedRoute>
  );
}

function FinanceContent() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading]           = useState(true);
  const [billing, setBilling]           = useState(false);
  const [admissionMap, setAdmissionMap] = useState<Record<string, string>>({});
  const { toasts, toast, remove }       = useToast();

  async function fetchData() {
    try {
      const data = await getTransactions();
      setTransactions(data);
    } catch (err) {
      console.error("Failed to fetch transactions:", err);
    } finally {
      setLoading(false);
    }
  }

  // Build uid → admissionNumber map once on mount
  useEffect(() => {
    async function fetchAdmissions() {
      try {
        const snap = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
        const map: Record<string, string> = {};
        snap.docs.forEach(d => {
          const admNo = d.data().admissionNumber;
          if (admNo) map[d.id] = admNo;
        });
        setAdmissionMap(map);
      } catch {
        // non-critical — fallback to UID handled in render
      }
    }
    fetchAdmissions();
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function runMonthlyBilling() {
    setBilling(true);
    const month = currentMonth();
    let charged = 0;
    let skipped = 0;

    try {
      const q    = query(collection(db, "users"), where("role", "==", "student"));
      const snap = await getDocs(q);

      const students = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
        .filter(s => s.feeCycle === "monthly");

      await Promise.all(
        students.map(async (student) => {
          // Safety: skip if already billed this month
          if ((student.lastBilledMonth as string | undefined) === month) {
            skipped++;
            return;
          }

          const amount = Number(student.monthlyFee ?? student.feePerClass ?? 0);
          if (amount <= 0) { skipped++; return; }

          // Create transaction
          await addDoc(collection(db, "transactions"), {
            studentUid: student.id,
            centerId:   (student.centerId as string) ?? "",
            amount,
            method:     "auto-monthly",
            receivedBy: "system",
            date:       new Date().toISOString().slice(0, 10),
            status:     "completed",
            createdAt:  serverTimestamp(),
          });

          // Update balance + lastBilledMonth atomically
          await updateDoc(doc(db, "users", student.id), {
            currentBalance:  increment(amount),
            lastBilledMonth: month,
            updatedAt:       new Date().toISOString(),
          });

          charged++;
        })
      );

      await fetchData();
      toast(
        `Monthly billing completed. Charged: ${charged}, Skipped: ${skipped}.`,
        "success"
      );
    } catch (err) {
      console.error("Monthly billing failed:", err);
      toast("Monthly billing failed. Check console.", "error");
    } finally {
      setBilling(false);
    }
  }

  function formatDate(value: string | unknown): string {
    if (!value || typeof value !== "string") return "-";
    return value.slice(0, 10);
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.heading}>Finance</h1>
        <button
          onClick={runMonthlyBilling}
          disabled={billing}
          style={{ ...styles.billingBtn, opacity: billing ? 0.6 : 1 }}
        >
          {billing ? "Processing…" : "Run Monthly Billing"}
        </button>
      </div>

      {/* Summary Cards — static */}
      <div style={styles.cardGrid}>
        {SUMMARY_CARDS.map(card => (
          <div key={card.label} style={styles.card}>
            <div style={{ ...styles.cardAccent, background: card.accent }} />
            <div style={styles.cardBody}>
              <div style={styles.cardLabel}>{card.label}</div>
              <div style={styles.cardValue}>{card.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Transactions Table */}
      <div style={styles.tableWrapper}>
        {loading ? (
          <div style={styles.stateRow}>Loading…</div>
        ) : transactions.length === 0 ? (
          <div style={styles.stateRow}>No transactions found.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Student</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Method</th>
                <th style={styles.th}>Date</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx, i) => (
                <tr key={tx.id} style={i % 2 === 0 ? styles.rowEven : styles.rowOdd}>
                  <td style={{ ...styles.td, ...styles.mono }}>
                    {tx.studentUid ? (admissionMap[tx.studentUid] ?? tx.studentUid) : "-"}
                  </td>
                  <td style={styles.td}>
                    {tx.amount != null ? `₹${tx.amount.toLocaleString("en-IN")}` : "-"}
                  </td>
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, ...(METHOD_STYLES[tx.method] ?? {}) }}>
                      {tx.method ?? "-"}
                    </span>
                  </td>
                  <td style={styles.td}>{formatDate(tx.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  billingBtn: {
    background: "#059669",
    color: "#ffffff",
    border: "none",
    padding: "8px 18px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
    marginBottom: 28,
  },
  card: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    boxShadow: "var(--shadow-sm)",
  },
  cardAccent: {
    height: 4,
    width: "100%",
  },
  cardBody: {
    padding: "18px 20px",
  },
  cardLabel: {
    fontSize: 12,
    color: "var(--color-text-secondary)",
    marginBottom: 8,
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  cardValue: {
    fontSize: 26,
    fontWeight: 700,
    color: "var(--color-text-primary)",
  },
  tableWrapper: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    overflow: "auto",
  },
  stateRow: {
    padding: "24px 16px",
    textAlign: "center",
    fontSize: 13,
    color: "var(--color-text-secondary)",
  },
  table: {
    width: "100%",
    minWidth: 600,
    borderCollapse: "collapse",
  },
  th: {
    padding: "11px 16px",
    textAlign: "left",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--color-text-secondary)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    borderBottom: "1px solid var(--color-border)",
    background: "#f9fafb",
  },
  td: {
    padding: "12px 16px",
    fontSize: 13,
    color: "var(--color-text-primary)",
    borderBottom: "1px solid var(--color-border)",
  },
  rowEven: { background: "var(--color-surface)" },
  rowOdd:  { background: "#fafafa" },
  mono: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "var(--color-text-secondary)",
  },
  badge: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 600,
  },
};
