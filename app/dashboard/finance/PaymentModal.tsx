"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DueSettlement } from "@/services/finance/finance.service";
import { HISTORY_NOTE, dueLabel, fmtINR, fmtMonth, isOverdueMonth, todayStr } from "./format";

export type PayMethod    = "UPI" | "Cash" | "Bank";
export type DiscountType = "fixed" | "percent";

export interface PaymentFormValues {
  /** Amount typed in, before discount. */
  rawAmount:    number;
  /** Amount actually received, after discount. */
  net:          number;
  discountAmt:  number;
  discountType: DiscountType;
  method:       PayMethod;
  date:         string;
  billingMonth: string | null;
}

export interface PaymentModalStudent {
  name:            string;
  admissionNo:     string;
  unitName:        string;
  billingMode:     string;
  feeCycle:        string;
  feePerClass:     number;
  monthlyFee:      number;
  balance:         number;
  attendanceCount: number;
  estimatedFee:    number;
}

const OVERDUE_TEXT = "#b91c1c";

function netAmount(raw: string, type: DiscountType, value: string): number {
  const base = Number(raw);
  if (!base || base <= 0) return 0;
  const disc = Number(value) || 0;
  if (type === "percent") return Math.max(0, Math.round(base - (base * Math.min(disc, 100)) / 100));
  return Math.max(0, base - disc);
}

export default function PaymentModal({
  student, month, isCurrentMonth, isSom, unpaid, dueThisMonth, monthSettled, lastPayment,
  saving, generatingDue, undoingDue, onGenerateDue, onUndoDue, onConfirm, onClose,
}: {
  student:        PaymentModalStudent;
  month:          string;
  isCurrentMonth: boolean;
  isSom:          boolean;
  /** Every month this student still owes on, oldest first. */
  unpaid:         DueSettlement[];
  /** What's left on the selected month's due; null when nothing is left or no due exists. */
  dueThisMonth:   number | null;
  /** The selected month was billed and is fully paid, so it must not be billed again. */
  monthSettled:   boolean;
  lastPayment:    { amount: number; date: string } | null;
  saving:         boolean;
  generatingDue:  boolean;
  undoingDue:     boolean;
  onGenerateDue:  (dueDate: string) => void;
  onUndoDue:      () => void;
  onConfirm:      (values: PaymentFormValues) => void;
  onClose:        () => void;
}) {
  const [amount, setAmount]             = useState("");
  // Typed by hand, so auto-fill must leave it alone.
  const [amountEdited, setAmountEdited] = useState(false);
  const [method, setMethod]             = useState<PayMethod>("Cash");
  const [date, setDate]                 = useState(todayStr());
  const [billingMonth, setBillingMonth] = useState<string | null>(null);
  // The admin chose a month (or chose none), so it is no longer preselected.
  const [monthPicked, setMonthPicked]   = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>("fixed");
  const [discountValue, setDiscountValue] = useState("");
  const [dueDate, setDueDate]           = useState(isCurrentMonth ? todayStr() : `${month}-01`);

  const dialogRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const hasDue      = dueThisMonth !== null;
  // Any unpaid month can take a payment, not only the one being viewed.
  const showForm    = unpaid.length > 0;
  const net       = netAmount(amount, discountType, discountValue);
  const discountAmt = Number(amount) - net;
  const canSubmit   = !saving && !!amount && net > 0;
  const outstanding = unpaid.reduce((sum, d) => sum + d.remaining, 0);
  const perClass    = student.feeCycle === "per_class";
  const prepaid     = isSom || student.billingMode === "prepay";
  const dueFee      = isSom || student.feeCycle === "monthly" ? student.monthlyFee : student.estimatedFee;
  const isPastDate  = date !== todayStr();

  function selectMonth(next: string | null) {
    setBillingMonth(next);
    if (amountEdited) return;
    const due = unpaid.find(d => d.billingMonth === next);
    setAmount(due ? String(due.remaining) : "");
  }

  // With no month chosen a payment becomes unallocated credit and the due stays
  // open, so one is always preselected: the month being viewed if unpaid, else
  // the oldest. Re-runs when dues change, e.g. Generate Due or Undo in this dialog.
  const unpaidKey = unpaid.map(d => `${d.billingMonth}:${d.remaining}`).join();
  useEffect(() => {
    const gone = billingMonth !== null && !unpaid.some(d => d.billingMonth === billingMonth);
    if (monthPicked && !gone) return;
    const preferred = unpaid.find(d => d.billingMonth === month) ?? unpaid[0];
    selectMonth(preferred?.billingMonth ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unpaidKey]);

  // A payment can't be abandoned half-written to Firestore, so nothing closes
  // the dialog while it saves.
  const closeRef = useRef(onClose);
  closeRef.current = () => { if (!saving) onClose(); };

  // Focus moves into the dialog on open and back to the row's button on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    (amountRef.current ?? dialogRef.current)?.focus();
  }, [showForm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeRef.current(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      const here = document.activeElement;
      if (e.shiftKey && (here === first || here === dialogRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm({
      rawAmount: Number(amount), net, discountAmt, discountType, method,
      date: date || todayStr(), billingMonth,
    });
  }

  return createPortal(
    <div
      style={m.backdrop}
      // A stray click outside must not throw away a typed-in payment.
      onMouseDown={e => { if (e.target === e.currentTarget && !amountEdited) closeRef.current(); }}
    >
      <style>{`
        @keyframes payBackdropIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes payDialogIn { from { opacity: 0; transform: translateY(10px) scale(0.98) } to { opacity: 1; transform: none } }
        @media (prefers-reduced-motion: reduce) { .pay-anim { animation: none !important } }
      `}</style>
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Payment — ${student.name}`} tabIndex={-1}
        className="pay-anim" style={m.dialog}
      >
        <div style={m.header}>
          <div style={{ minWidth: 0 }}>
            <div style={m.title}>💳 Payment</div>
            <div style={m.name}>{student.name}</div>
            <div style={m.sub}>{student.admissionNo} · {student.unitName}</div>
          </div>
          <button type="button" onClick={() => closeRef.current()} disabled={saving} aria-label="Close" style={m.closeBtn}>✕</button>
        </div>

        <form onSubmit={submit} style={m.form}>
          <div style={m.body}>
            {/* ── Student summary ──────────────────────────────────────────── */}
            <div className={prepaid ? "grid grid-cols-2" : "grid grid-cols-3"} style={m.summary}>
              <Meta label="Fee" value={perClass ? `${fmtINR(student.feePerClass)}/class` : fmtINR(student.monthlyFee)} />
              {!prepaid && <Meta label="Attended" value={String(student.attendanceCount)} />}
              <Meta
                label="Balance"
                value={fmtINR(outstanding)}
                color={outstanding > 0 ? "#b45309" : "#059669"}
                sub={student.balance < 0 ? `${fmtINR(-student.balance)} credit` : undefined}
              />
            </div>

            {(perClass || lastPayment) && (
              <div style={m.context}>
                {perClass && <span>Est. <b>{fmtINR(student.estimatedFee)}</b></span>}
                {lastPayment && <span>Last: <b>{fmtINR(lastPayment.amount)}</b> · {lastPayment.date}</span>}
                {perClass && !prepaid && student.attendanceCount === 0 && <span style={{ color: "#b45309" }}>⚠ No attendance</span>}
              </div>
            )}

            {!hasDue && !monthSettled ? (
              /* ── This month hasn't been billed yet ──────────────────────── */
              <div style={m.box}>
                <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                  No due · <strong>{fmtMonth(month)}</strong>
                </div>
                <Field label="Due Date">
                  <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={m.input} />
                </Field>
                <button
                  type="button" onClick={() => onGenerateDue(dueDate)} disabled={generatingDue || !dueDate}
                  style={{ ...m.confirmBtn, background: "#f59e0b", marginTop: 10, ...(generatingDue || !dueDate ? m.disabled : {}) }}
                >
                  {generatingDue ? "Generating…" : `Generate Due · ${fmtINR(dueFee)}`}
                </button>
              </div>
            ) : (
              <div style={m.dueRow}>
                <span style={{
                  ...m.duePill,
                  background: monthSettled ? "#dcfce7" : "#fffbeb",
                  color:      monthSettled ? "#16a34a" : isOverdueMonth(month) ? OVERDUE_TEXT : "#b45309",
                }}>
                  {monthSettled ? "✓ Paid" : `${dueLabel(month)} · ${fmtINR(dueThisMonth ?? 0)}`}
                </span>
                <span title={isCurrentMonth ? undefined : HISTORY_NOTE} style={{ fontSize: 11, color: "var(--color-text-secondary)", cursor: isCurrentMonth ? undefined : "help" }}>
                  {monthSettled && fmtMonth(month)}{!isCurrentMonth && " ⓘ"}
                </span>
                {!monthSettled && (
                  <button type="button" onClick={onUndoDue} disabled={undoingDue}
                    style={{ ...m.cancelBtn, fontSize: 11, padding: "3px 10px", ...(undoingDue ? m.disabled : {}) }}>
                    {undoingDue ? "Undoing…" : "↩ Undo"}
                  </button>
                )}
              </div>
            )}

            {showForm && (
              <>
                {/* ── Which month is this payment settling? ─────────────────── */}
                {unpaid.length > 0 && (
                  <div style={m.box}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {unpaid.map(d => {
                        const selected = billingMonth === d.billingMonth;
                        return (
                          <button
                            key={d.billingMonth} type="button" aria-pressed={selected}
                            // Radio semantics: a click only ever picks a month. Re-clicking
                            // the selected chip used to clear it, which silently turned the
                            // payment into unallocated credit and left the due open.
                            onClick={() => { setMonthPicked(true); selectMonth(d.billingMonth); }}
                            style={{ ...m.monthChip, ...(selected ? m.chipActive : {}) }}
                          >
                            <span style={{ fontWeight: 700, color: !selected && isOverdueMonth(d.billingMonth) ? OVERDUE_TEXT : undefined }}>{dueLabel(d.billingMonth)}</span>
                            <span style={{ opacity: 0.85 }}>
                              {d.state === "partial" ? `${fmtINR(d.remaining)} left · ${fmtINR(d.paidAmount)} paid` : fmtINR(d.remaining)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
                  <Field label="Amount Received (₹)">
                    <input
                      ref={amountRef} type="number" min={1} placeholder="0"
                      value={amount} style={m.input}
                      onChange={e => { setAmount(e.target.value); setAmountEdited(e.target.value !== ""); }}
                      onFocus={e => e.target.select()}
                    />
                  </Field>

                  <Field label="Discount" group>
                    <div style={{ display: "flex", gap: 6 }}>
                      <div style={m.segment}>
                        {(["fixed", "percent"] as DiscountType[]).map(t => (
                          <button key={t} type="button" aria-pressed={discountType === t} onClick={() => setDiscountType(t)}
                            style={{ ...m.segmentBtn, ...(discountType === t ? m.chipActive : {}), border: "none" }}>
                            {t === "fixed" ? "₹" : "%"}
                          </button>
                        ))}
                      </div>
                      <input
                        type="number" min={0} placeholder={discountType === "percent" ? "0–100" : "0"}
                        value={discountValue} onChange={e => setDiscountValue(e.target.value)}
                        style={{ ...m.input, flex: 1, minWidth: 0 }}
                      />
                    </div>
                  </Field>

                  <Field label="Mode" group>
                    <div style={{ display: "flex", gap: 6 }}>
                      {(["Cash", "UPI", "Bank"] as PayMethod[]).map(x => (
                        <button key={x} type="button" aria-pressed={method === x} onClick={() => setMethod(x)}
                          style={{ ...m.methodChip, ...(method === x ? m.chipActive : {}) }}>
                          {x === "Cash" ? "💵" : x === "UPI" ? "📱" : "🏦"} {x}
                        </button>
                      ))}
                    </div>
                  </Field>

                  <Field label="Date" badge={isPastDate ? "Past" : undefined}>
                    <input
                      type="date" value={date} max={todayStr()}
                      onChange={e => setDate(e.target.value || todayStr())}
                      style={{ ...m.input, ...(isPastDate ? { border: "1.5px solid #f59e0b" } : {}) }}
                    />
                  </Field>
                </div>

                {amount && (
                  <div style={m.netPreview}>
                    {discountAmt > 0 ? (
                      <>
                        <span>Gross: <strong>{fmtINR(Number(amount))}</strong></span>
                        <span style={{ color: "#059669" }}>− Discount: <strong>{fmtINR(discountAmt)}</strong></span>
                        <span style={{ fontWeight: 700 }}>= Net: <strong>{fmtINR(net)}</strong></span>
                      </>
                    ) : (
                      <span>Total: <strong>{fmtINR(Number(amount))}</strong></span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={m.footer}>
            <button type="button" onClick={() => closeRef.current()} disabled={saving} style={{ ...m.cancelBtn, ...(saving ? m.disabled : {}) }}>Cancel</button>
            {showForm && (
              <button type="submit" disabled={!canSubmit} style={{ ...m.confirmBtn, ...(canSubmit ? {} : m.disabled) }}>
                {saving ? "Saving…" : billingMonth ? "✓ Confirm Payment" : "✓ Record as Credit"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function Meta({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...m.label, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color ?? "var(--color-text-primary)", overflowWrap: "anywhere" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#059669", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

/** `group` is for button sets: inside a <label>, clicking the caption would press the first button. */
function Field({ label, badge, group, children }: { label: string; badge?: string; group?: boolean; children: React.ReactNode }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <span style={m.label}>
        {label}
        {badge && <span style={m.badge}>{badge}</span>}
      </span>
      {children}
    </Tag>
  );
}

const m: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed", inset: 0, zIndex: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
    animation: "payBackdropIn 0.16s ease-out",
  },
  dialog: {
    width: "100%", maxWidth: 600, maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column", outline: "none",
    background: "var(--color-surface)", color: "var(--color-text-primary)", border: "1px solid var(--color-border)",
    borderRadius: 14, boxShadow: "0 20px 50px rgba(0,0,0,0.3)", animation: "payDialogIn 0.18s ease-out",
  },
  header:  { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "16px 20px 12px", borderBottom: "1px solid var(--color-border)" },
  title:   { fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  name:    { fontSize: 17, fontWeight: 800, marginTop: 2, overflowWrap: "anywhere" },
  sub:     { fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2, overflowWrap: "anywhere" },
  closeBtn:{ border: "none", background: "none", fontSize: 16, cursor: "pointer", color: "var(--color-text-secondary)", padding: 4 },
  form:    { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  body:    { padding: "14px 20px", overflowY: "auto", overscrollBehavior: "contain", display: "flex", flexDirection: "column", gap: 12 },
  footer:  { display: "flex", justifyContent: "flex-end", gap: 10, padding: "12px 20px", borderTop: "1px solid var(--color-border)" },
  summary: { gap: 12, padding: "12px 14px", borderRadius: 10, background: "var(--color-surface-2)", border: "1px solid var(--color-border)" },
  context: { display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 12, color: "var(--color-text-secondary)" },
  box:     { padding: "12px 14px", borderRadius: 10, border: "1px solid var(--color-border)" },
  dueRow:  { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  duePill: { fontSize: 12, padding: "3px 12px", borderRadius: 99, fontWeight: 700 },
  label:   { fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  badge:   { marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "1px 7px", borderRadius: 99, textTransform: "none", letterSpacing: 0 },
  input:   { width: "100%", padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)" },
  segment: { display: "flex", border: "1px solid var(--color-border)", borderRadius: 6, overflow: "hidden", flexShrink: 0 },
  segmentBtn: { padding: "7px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--color-surface-2)", color: "var(--color-text-primary)" },
  methodChip: { flex: 1, padding: "7px 6px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--color-surface-2)", color: "var(--color-text-primary)", whiteSpace: "nowrap" },
  monthChip:  { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, padding: "6px 10px", fontSize: 11.5, borderRadius: 8, border: "1px solid var(--color-border)", cursor: "pointer", background: "var(--color-surface-2)", color: "var(--color-text-primary)" },
  chipActive: { background: "#f59e0b", color: "#fff", border: "1px solid #d97706" },
  netPreview: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, padding: "8px 12px", borderRadius: 6, background: "#05966915", border: "1px solid #05966933" },
  confirmBtn: { background: "#059669", color: "#fff", border: "none", borderRadius: 6, padding: "9px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  cancelBtn:  { background: "var(--color-surface-2)", color: "var(--color-text-primary)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  disabled:   { opacity: 0.6, cursor: "not-allowed" },
};
