"use client";

import { useState, useEffect } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import type { Transaction } from "@/types/finance";

export default function MyFeesPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.STUDENT]}>
      <MyFeesContent />
    </ProtectedRoute>
  );
}

interface FeeStructure {
  amount:       number;
  billingCycle: string;
  dueDay:       number;
  lateFee:      number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtINR(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y}`;
}

function formatDate(value: unknown): string {
  if (!value || typeof value !== "string") return "—";
  const d = value.slice(0, 10);
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
}

function nth(n: number): string {
  if (n >= 11 && n <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// ─── Content ─────────────────────────────────────────────────────────────────

function MyFeesContent() {
  const { user }                     = useAuthContext();
  const [balance, setBalance]        = useState<number | null>(null);
  const [transactions, setTx]        = useState<Transaction[]>([]);
  const [feeStructure, setFeeStr]    = useState<FeeStructure | null>(null);
  const [loading, setLoading]        = useState(true);
  const [error, setError]            = useState<string | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    load(user.uid);
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(uid: string) {
    setLoading(true);
    setError(null);
    try {
      const [userSnap, txSnap] = await Promise.all([
        getDoc(doc(db, "users", uid)),
        getDocs(query(collection(db, "transactions"), where("studentUid", "==", uid))),
      ]);

      const userData = userSnap.exists() ? userSnap.data() : {};
      setBalance((userData.currentBalance as number) ?? 0);

      const centerId = (userData.centerId as string) ?? null;
      if (centerId) {
        const feeSnap = await getDocs(
          query(collection(db, "fee_structures"), where("centerId", "==", centerId))
        );
        if (!feeSnap.empty) {
          const d = feeSnap.docs[0]!.data();
          setFeeStr({ amount: d.amount, billingCycle: d.billingCycle, dueDay: d.dueDay, lateFee: d.lateFee });
        }
      }

      // Filter out auto and auto-monthly transactions — students never see these
      const txList = txSnap.docs
        .map(d => ({ id: d.id, ...d.data() }) as Transaction)
        .filter(t => t.method !== "auto-monthly" && t.method !== "auto")
        .sort((a, b) => (String(b.date ?? b.createdAt ?? "")).localeCompare(String(a.date ?? a.createdAt ?? "")));
      setTx(txList);
    } catch {
      setError("Failed to load fee details. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={s.state}>Loading fees…</div>;
  if (error)   return <div style={{ ...s.state, color: "#dc2626" }}>{error}</div>;

  const bal           = balance ?? 0;
  const balanceOwed   = bal > 0;
  const balanceCredit = bal < 0;

  const paid    = transactions.filter(t => t.status === "completed" && t.type !== "fee_due" && t.type !== "charge");
  const dues    = transactions.filter(t => t.status === "due" || t.type === "fee_due");
  const pending = transactions.filter(t => t.status === "pending");

  return (
    <div style={s.page}>
      <div style={s.heading}>My Fees</div>

      {/* Balance hero */}
      <div style={{ ...s.balanceCard, borderColor: balanceOwed ? "#fca5a5" : "#86efac" }}>
        <div style={s.balanceLeft}>
          <div style={s.balanceLabel}>Current Balance</div>
          <div style={{ ...s.balanceAmt, color: balanceOwed ? "#dc2626" : "#16a34a" }}>
            {balanceOwed
              ? `${fmtINR(bal)} due`
              : balanceCredit
                ? `${fmtINR(Math.abs(bal))} credit`
                : "₹0 — All clear"}
          </div>
          <div style={s.balanceSub}>
            {balanceOwed
              ? "Please pay at the earliest to avoid late fees."
              : balanceCredit
                ? "You have a credit on your account."
                : "You have no outstanding dues."}
          </div>
        </div>
        <div style={s.balanceIcon}>{balanceOwed ? "🔴" : "✅"}</div>
      </div>

      {/* Fee structure */}
      {feeStructure && (
        <div style={s.feeStructCard}>
          <div style={s.feeStructTitle}>Fee Structure</div>
          <div style={s.feeStructGrid}>
            <div style={s.feeItem}>
              <div style={s.feeItemLabel}>Fee Amount</div>
              <div style={s.feeItemVal}>{fmtINR(feeStructure.amount)}</div>
            </div>
            <div style={s.feeItem}>
              <div style={s.feeItemLabel}>Billing Cycle</div>
              <div style={s.feeItemVal}>{feeStructure.billingCycle === "monthly" ? "Monthly" : "Per Class"}</div>
            </div>
            <div style={s.feeItem}>
              <div style={s.feeItemLabel}>Due Day</div>
              <div style={s.feeItemVal}>{feeStructure.dueDay}{nth(feeStructure.dueDay)} of month</div>
            </div>
            <div style={s.feeItem}>
              <div style={s.feeItemLabel}>Late Fee</div>
              <div style={s.feeItemVal}>{fmtINR(feeStructure.lateFee)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Summary chips */}
      <div style={s.chips}>
        <div style={{ ...s.chip, background: "#f0fdf4", border: "1px solid #86efac" }}>
          <div style={{ ...s.chipNum, color: "#16a34a" }}>{paid.length}</div>
          <div style={s.chipLabel}>Payments Made</div>
        </div>
        <div style={{ ...s.chip, background: "#fef2f2", border: "1px solid #fca5a5" }}>
          <div style={{ ...s.chipNum, color: "#dc2626" }}>{dues.length}</div>
          <div style={s.chipLabel}>Dues</div>
        </div>
        <div style={{ ...s.chip, background: "#fffbeb", border: "1px solid #fde68a" }}>
          <div style={{ ...s.chipNum, color: "#b45309" }}>{pending.length}</div>
          <div style={s.chipLabel}>Pending</div>
        </div>
      </div>

      {/* Transaction history — same format as admin history panel */}
      <div style={s.sectionTitle}>Transaction History</div>
      {transactions.length === 0 ? (
        <div style={s.empty}>No transactions on record yet.</div>
      ) : (
        <div style={s.txList}>
          {transactions.map(tx => {
            const isFeedue  = tx.type === "fee_due";
            const isDeposit = tx.type === "deposit";
            const isCharge  = tx.type === "charge";
            const isPending = tx.status === "pending";
            const isFailed  = tx.status === "failed";

            const typeLabel = isFeedue ? "Fee Due" : isDeposit ? "Payment" : isCharge ? "Charge" : "Payment";
            const typeColor = isFeedue
              ? { bg: "#fffbeb", border: "#fde68a",  text: "#b45309"  }
              : isDeposit
              ? { bg: "#fdf4ff", border: "#e9d5ff",  text: "#7e22ce"  }
              : isCharge
              ? { bg: "#fff7ed", border: "#fed7aa",  text: "#c2410c"  }
              : { bg: "#f0fdf4", border: "#86efac",  text: "#15803d"  };

            const methodLabel = isFeedue ? "Generated" : (tx.method ?? "—");

            const displayMonth = tx.billingMonth
              ? fmtMonth(tx.billingMonth)
              : fmtMonth((tx.date ?? tx.createdAt as string ?? "").slice(0, 7));

            return (
              <div
                key={tx.id}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 16px", borderRadius: 8, flexWrap: "wrap" as const,
                  background: isFailed ? "#fef2f2" : isPending ? "#fffbeb" : "#f9fafb",
                  border: `1px solid ${isFailed ? "#fecaca" : isPending ? "#fde68a" : "#e5e7eb"}`,
                  fontSize: 13,
                }}
              >
                {/* Month / billing period */}
                <span style={{ fontWeight: 700, color: "#111827", minWidth: 100 }}>
                  {displayMonth}
                </span>

                {/* Type badge */}
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
                  background: typeColor.bg, border: `1px solid ${typeColor.border}`, color: typeColor.text,
                }}>
                  {typeLabel}
                </span>

                {/* Amount */}
                <span style={{ fontWeight: 700, color: (isCharge || isFeedue) ? "#c2410c" : "#16a34a", minWidth: 80 }}>
                  {(isCharge || isFeedue) ? "−" : "+"}{fmtINR(tx.amount)}
                </span>

                {/* Payment / fee due date */}
                <span style={{ color: "#6b7280", fontSize: 12 }}>
                  {formatDate(tx.date ?? tx.createdAt as string)}
                </span>

                {/* Method badge */}
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
                  background: "#e0e7ff", color: "#3730a3",
                }}>
                  {methodLabel}
                </span>

                {/* Status — only if not completed */}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 720, margin: "0 auto", padding: "0 0 40px" },
  state:   { padding: "60px 0", textAlign: "center", fontSize: 14, color: "#6b7280" },
  heading: { fontSize: 24, fontWeight: 700, color: "#111111", marginBottom: 24 },

  balanceCard: {
    background: "#fff", border: "2px solid", borderRadius: 14,
    padding: "24px 28px", marginBottom: 20,
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
  },
  balanceLeft:  { flex: 1 },
  balanceLabel: { fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 6 },
  balanceAmt:   { fontSize: 32, fontWeight: 800, lineHeight: 1.1, marginBottom: 6 },
  balanceSub:   { fontSize: 13, color: "#6b7280" },
  balanceIcon:  { fontSize: 36 },

  feeStructCard: {
    background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12,
    padding: "18px 22px", marginBottom: 20,
  },
  feeStructTitle: { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 14 },
  feeStructGrid:  { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 16 },
  feeItem:        {},
  feeItemLabel:   { fontSize: 11, color: "#9ca3af", marginBottom: 3 },
  feeItemVal:     { fontSize: 15, fontWeight: 700, color: "#111111" },

  chips: { display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" as const },
  chip:  { flex: 1, minWidth: 110, borderRadius: 12, padding: "14px 18px", textAlign: "center" as const },
  chipNum:   { fontSize: 28, fontWeight: 800, lineHeight: 1.1 },
  chipLabel: { fontSize: 11, color: "#6b7280", marginTop: 4 },

  sectionTitle: {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 12,
  },
  empty: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
    padding: "28px", textAlign: "center" as const, fontSize: 13, color: "#9ca3af",
  },
  txList: { display: "flex", flexDirection: "column" as const, gap: 6 },
};
