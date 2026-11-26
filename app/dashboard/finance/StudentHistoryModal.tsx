"use client";

// Student payment history as a centred pop-up (was an inline panel that pushed
// the Finance table down). One card per billing month, oldest first (same as
// every ledger — lib/ledgerOrder); inside a
// month every entry sits on the same 4-column grid: Date (bold) · Type/Mode/Note ·
// Amount · Remove. Due/Paid is said once, on the month header. Both wings.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Transaction } from "@/types/finance";
import type { DueSettlement } from "@/services/finance/finance.service";
import { WAIVED, waivedAmountOf, creditedAmountOf, discountAmountOf } from "@/lib/feeWaiver";
import { ledgerMonthOf, ledgerMonths, ledgerRank, sortLedger } from "@/lib/ledgerOrder";
import { fmtINR, fmtMonth } from "./format";

export interface HistoryStudent {
  uid: string; name: string; centerName: string; admissionNo: string;
  /** e.g. "₹2,500/mo" or "₹400/class"; "" hides the pill. */
  feeLabel: string;
}

function fmtDate(value: unknown): string {
  if (!value || typeof value !== "string") return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : value.slice(0, 10);
}

const GREEN  = { bg: "#dcfce7", fg: "#15803d", bd: "#86efac" };
const ORANGE = { bg: "#fff7ed", fg: "#c2410c", bd: "#fed7aa" };

export default function StudentHistoryModal({ student, transactions, settlements, canRemove, onRemove, onClose }: {
  student: HistoryStudent;
  /** This student's transactions (any order). */
  transactions: Transaction[];
  settlements: Map<string, DueSettlement>;
  canRemove: boolean;
  /** Deletes the entry and refreshes the Finance data. */
  onRemove: (txId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending]   = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // Remove buttons stay hidden until the header ✎ Edit toggle is on.
  const [isEditing, setIsEditing] = useState(false);
  const showRemove = canRemove && isEditing;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => { if (!removing) onClose(); };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (timer.current) clearTimeout(timer.current); opener?.focus?.(); };
  }, []);

  function clickRemove(id: string) {
    if (timer.current) clearTimeout(timer.current);
    if (pending !== id) {                         // first click arms, second confirms
      setPending(id);
      timer.current = setTimeout(() => setPending(null), 4000);
      return;
    }
    setPending(null);
    setRemoving(true);
    onRemove(id).finally(() => setRemoving(false));
  }

  // Admission fee is not tuition: pinned in its own card at the top (whatever
  // its date) and kept out of every month card and month status.
  const admission = sortLedger(transactions.filter(t => t.type === "admission_fee"));
  // Months oldest→newest; inside a month Due before what paid it.
  const sorted   = sortLedger(transactions.filter(t => t.type !== "admission_fee"));
  const txMonths = ledgerMonths(sorted);
  const months: { month: string; txs: Transaction[] }[] = [];
  for (const tx of sorted) {
    const mo = txMonths.get(tx) ?? ledgerMonthOf(tx);
    const last = months[months.length - 1];
    if (last && last.month === mo) last.txs.push(tx); else months.push({ month: mo, txs: [tx] });
  }

  // One ledger entry on the 5-column grid. `owing`: its month still has money due.
  const entryRow = (tx: Transaction, owing: boolean) => {
    const isDue     = tx.type === "fee_due";
    const isAdm     = tx.type === "admission_fee";
    const isDeposit = tx.type === "deposit";
    const isCharge  = tx.type === "charge" || tx.method === "auto";
    const failed    = tx.status === "failed";
    const pend      = tx.status === "pending";
    const type = isDue ? "Due" : isAdm ? "Admission" : isCharge ? "Charge" : isDeposit ? "Deposit" : "Payment";
    const typeColor = isAdm ? "#1d4ed8" : isDeposit ? "#7e22ce" : isCharge ? "#c2410c" : "#15803d";
    const plus = isDue || isCharge;
    const amtColor = plus ? (owing ? "#dc2626" : "#64748b") : "#16a34a";
    const mode = isDue ? "Generated" : tx.method === "auto" || tx.method === "auto-monthly" ? "Auto" : tx.method === "Bank" ? "Bank Transfer" : (tx.method || "—");
    const disc = !isDue ? discountAmountOf(tx) : 0;
    const notes = [
      disc > 0 ? `+${fmtINR(disc)} discount` : "",
      tx.status === WAIVED ? `Waived −${fmtINR(waivedAmountOf(tx))}${tx.waiveReason ? ` · ${tx.waiveReason}` : ""}` : "",
      pend || failed ? String(tx.status) : "",
      tx.note ? String(tx.note) : "",
    ].filter(Boolean);
    return (
      <div key={tx.id} className="hist-row" style={{ ...h.row, ...(failed ? { background: "#fef2f2" } : {}) }}>
        <span style={h.date}>{fmtDate(tx.date ?? tx.createdAt)}</span>
        <span style={h.modeCell} title={notes.join(" · ") || undefined}>
          {/* A due row shows only "Generated" — the month header already says Due. */}
          {!isDue && <span style={{ ...h.typeText, color: typeColor }}>{type}</span>}
          {!isDue && <span aria-hidden style={h.dot}>·</span>}
          <span style={h.mode}>{mode}</span>
          {notes.length > 0 && <span style={h.note}>{notes.join(" · ")}</span>}
        </span>
        <span style={{ ...h.amount, color: amtColor, textDecoration: failed ? "line-through" : undefined }}>
          {plus ? "+" : "−"}{fmtINR(tx.amount)}
        </span>
        <span style={{ justifySelf: "end" }}>
          {showRemove && (
            <button type="button" disabled={removing} onClick={() => clickRemove(tx.id)} title="Remove this entry"
              style={{ ...h.remove, ...(pending === tx.id ? h.removeArmed : {}), ...(removing ? { opacity: 0.55, cursor: "not-allowed" } : {}) }}>
              {pending === tx.id ? "Confirm?" : "Remove"}
            </button>
          )}
        </span>
      </div>
    );
  };

  return createPortal(
    <div style={h.backdrop} onMouseDown={e => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`History — ${student.name}`} tabIndex={-1} style={h.dialog}>
        <div style={h.header}>
          <div style={{ minWidth: 0 }}>
            <div style={h.kicker}>🧾 History</div>
            <div style={h.name}>{student.name}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {canRemove && (
              <button type="button" aria-pressed={isEditing} disabled={removing}
                onClick={() => { setIsEditing(v => !v); setPending(null); }}
                title={isEditing ? "Done editing" : "Edit entries"}
                style={{ ...h.editBtn, ...(isEditing ? h.editOn : {}) }}>
                {isEditing ? "✓ Done" : <><span aria-hidden>✎</span> Edit</>}
              </button>
            )}
            <button type="button" onClick={() => closeRef.current()} aria-label="Close" style={h.close}>✕</button>
          </div>
        </div>

        <div style={h.body}>
          {admission.length > 0 && (
            <section style={{ ...h.card, borderColor: "#bfdbfe" }}>
              <div style={{ ...h.cardHead, background: "#eff6ff", borderColor: "#bfdbfe" }}>
                <span style={{ fontWeight: 800, color: "var(--color-text-primary)" }}>Admission fee</span>
                <span style={{ ...h.status, ...(admission.some(t => t.status === "completed") ? { background: GREEN.bg, color: GREEN.fg, borderColor: GREEN.bd } : { background: ORANGE.bg, color: ORANGE.fg, borderColor: ORANGE.bd }) }}>
                  {admission.some(t => t.status === "completed") ? "✓ Paid" : "Not completed"}
                </span>
              </div>
              <div>{admission.map(tx => entryRow(tx, false))}</div>
            </section>
          )}
          {months.length === 0 && admission.length === 0 ? (
            <div style={{ fontSize: 13, color: "#9ca3af", textAlign: "center", padding: "28px 0" }}>No transactions</div>
          ) : months.map(({ month, txs }) => {
            // Month status: what was raised (less waivers) vs what was credited (cash + discount).
            const dues    = txs.filter(t => t.type === "fee_due");
            const pays    = txs.filter(t => ledgerRank(t) === 3 && t.status !== "failed");
            const dueAmt  = dues.reduce((n, t) => n + Number(t.amount || 0) - (t.status === WAIVED ? waivedAmountOf(t) : 0), 0);
            const paidAmt = pays.reduce((n, t) => n + creditedAmountOf(t), 0);
            const s = month ? settlements.get(`${student.uid}|${month}`) : undefined;
            const left = s ? s.remaining : Math.max(0, dueAmt - paidAmt);
            const status = dues.length === 0 ? null
              : dueAmt <= 0 ? { label: "Waived", ...ORANGE }
              : left <= 0 ? { label: "✓ Paid", ...GREEN }
              : left < dueAmt ? { label: `Due ${fmtINR(left)} · part paid`, ...ORANGE }
              : { label: `Due ${fmtINR(left)}`, ...ORANGE };
            const owing = !!status && status.label.startsWith("Due");

            return (
              <section key={month || "none"} style={h.card}>
                <div style={h.cardHead}>
                  <span style={{ fontWeight: 800, color: "var(--color-text-primary)" }}>{month ? fmtMonth(month) : "No month"}</span>
                  {status && <span style={{ ...h.status, background: status.bg, color: status.fg, borderColor: status.bd }}>{status.label}</span>}
                </div>
                <div>
                  {txs.map(tx => entryRow(tx, owing))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {/* Phone: two lines — date · amount · action / type · mode. */}
      <style>{`
        @media (max-width: 560px) {
          .hist-row { grid-template-columns: 1fr auto auto !important; row-gap: 3px !important; }
          .hist-row > :nth-child(1) { grid-column: 1; grid-row: 1; }
          .hist-row > :nth-child(2) { grid-column: 1 / 4; grid-row: 2; }
          .hist-row > :nth-child(3) { grid-column: 2; grid-row: 1; }
          .hist-row > :nth-child(4) { grid-column: 3; grid-row: 1; }
        }
      `}</style>
    </div>,
    document.body,
  );
}

const h: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, zIndex: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" },
  dialog:   { width: "100%", maxWidth: 720, maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column", outline: "none", background: "var(--color-surface)", color: "var(--color-text-primary)", border: "1px solid var(--color-border)", borderRadius: 14, boxShadow: "0 20px 50px rgba(0,0,0,0.3)" },
  header:   { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "16px 20px 12px", borderBottom: "1px solid var(--color-border)" },
  kicker:   { fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  name:     { fontSize: 17, fontWeight: 800, marginTop: 2, overflowWrap: "anywhere" },
  close:    { border: "none", background: "none", fontSize: 16, cursor: "pointer", color: "var(--color-text-secondary)", padding: 4 },
  body:     { padding: "14px 20px 18px", overflowY: "auto", overscrollBehavior: "contain", display: "flex", flexDirection: "column", gap: 12 },
  card:     { border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--color-surface-2)", borderBottom: "1px solid var(--color-border)", fontSize: 13 },
  status:   { fontSize: 11.5, fontWeight: 800, padding: "2px 10px", borderRadius: 99, border: "1px solid", whiteSpace: "nowrap" },
  row:      { display: "grid", gridTemplateColumns: "92px minmax(0,1fr) 100px auto", alignItems: "center", columnGap: 12, padding: "7px 12px", borderTop: "1px solid var(--color-border)", fontSize: 13 },
  typeText: { flexShrink: 0, fontSize: 12.5, fontWeight: 700 },
  dot:      { flexShrink: 0, color: "var(--color-text-secondary)" },
  amount:   { textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  date:     { color: "var(--color-text-primary)", fontWeight: 700, fontSize: 13, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  modeCell: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  mode:     { flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: "var(--color-text-secondary)" },
  note:     { fontSize: 11.5, color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  editBtn:  { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-text-primary)", whiteSpace: "nowrap" },
  editOn:   { background: "#f59e0b", borderColor: "#d97706", color: "#fff" },
  remove:   { minWidth: 72, fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 6, cursor: "pointer", border: "1px solid #fca5a5", background: "transparent", color: "#dc2626" },
  removeArmed: { background: "#dc2626", color: "#fff", borderColor: "#dc2626" },
};
