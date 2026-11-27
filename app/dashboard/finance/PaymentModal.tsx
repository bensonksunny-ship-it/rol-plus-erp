"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DueSettlement } from "@/services/finance/finance.service";
import { HISTORY_NOTE, dueLabel, fmtINR, fmtMonth, isOverdueMonth, todayStr } from "./format";

export type PayMethod    = "UPI" | "Cash" | "Bank" | "Card";

/** Unified Fee & Payment window (both wings): also edits the fee and the month's due status. */
export interface SomControls {
  /** What the fee box edits: a monthly fee, or the per-class rate (Wing 1). */
  feeKind:        "monthly" | "per_class";
  /** Current value of that fee (0 = not set). */
  currentFee:     number;
  /** What Mark Due would raise for the month (0 = nothing to raise). */
  dueAmount:      number;
  /** Short explanation under Mark Due (e.g. classes × rate), or why it is off. */
  dueNote?:       string;
  /** Owed money with no month due (Wing 1 per-class charges): payment form stays open. */
  payWithoutDue:  boolean;
  /** Section to scroll to / focus on open. */
  focus:          "fee" | "due" | "pay";
  /** Centre default monthly fee (0 = none). */
  centreDefault:  number;
  savingFee:      boolean;
  onSaveFee:      (fee: number) => void;
  /** This month's due was waived (Un-due) — nothing left to pay. */
  monthWaived:    boolean;
  /** Opens Un-due (delete a mistaken due, optionally set break / discontinued); undefined → plain delete. */
  onUndue?:       () => void;
  /** Another dialog is on top — Esc / backdrop must not close this one. */
  covered:        boolean;
}
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
  paidOn, paidWithoutRecord, reopening, onReopenDue,
  saving, generatingDue, undoingDue, onGenerateDue, onUndoDue, onConfirm, onClose, som,
}: {
  som?:           SomControls;
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
  /** Date the selected month was paid (dd/mm/yyyy), when known. */
  paidOn?:        string | null;
  /** Marked Paid but no payment record exists for it (payment was removed / legacy). */
  paidWithoutRecord?: boolean;
  reopening?:     boolean;
  onReopenDue?:   () => void;
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
  // A due bills the month of its date — say so when that isn't the month on screen.
  const dueBillsOther = /^\d{4}-\d{2}/.test(dueDate) && dueDate.slice(0, 7) !== month;

  const dialogRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const feeRef    = useRef<HTMLInputElement>(null);
  const dueRef    = useRef<HTMLDivElement>(null);

  // SoM fee editor: current rate, else the centre default.
  const curFee   = som ? som.currentFee : student.monthlyFee;
  const feeStart = curFee > 0 ? curFee : som?.centreDefault ?? 0;
  const [feeInput, setFeeInput] = useState(feeStart > 0 ? String(feeStart) : "");
  // The fee is read-only until ✎ is clicked; a saved fee (curFee changes) closes the editor.
  const [isEditingFee, setIsEditingFee] = useState(false);
  const feeEditBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setFeeInput(feeStart > 0 ? String(feeStart) : ""); setIsEditingFee(false); }, [curFee]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setIsEditingFee(false); }, [student.name]);
  const feeN      = Math.round(Number(feeInput));
  const feeValid  = Number.isFinite(feeN) && feeN > 0;
  const feeDirty  = isEditingFee && feeValid && feeN !== curFee;
  function startFeeEdit() {
    setFeeInput(feeStart > 0 ? String(feeStart) : "");
    setIsEditingFee(true);
    requestAnimationFrame(() => { feeRef.current?.focus(); feeRef.current?.select(); });
  }
  function cancelFeeEdit() {
    setFeeInput(feeStart > 0 ? String(feeStart) : "");
    setIsEditingFee(false);
    requestAnimationFrame(() => feeEditBtnRef.current?.focus());
  }

  const hasDue      = dueThisMonth !== null;
  // Any unpaid month can take a payment, not only the one being viewed.
  const showForm    = unpaid.length > 0 || !!som?.payWithoutDue;
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
    // Owed with no month due (Wing 1 per-class charges): offer the balance.
    if (!preferred && som?.payWithoutDue && !amountEdited && student.balance > 0) setAmount(String(student.balance));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unpaidKey]);

  // A payment can't be abandoned half-written to Firestore, so nothing closes
  // the dialog while it saves.
  const closeRef = useRef(onClose);
  const covered = !!som?.covered;
  closeRef.current = () => { if (!saving && !som?.savingFee && !covered) onClose(); };
  const coveredRef = useRef(covered);
  coveredRef.current = covered;

  // Focus moves into the dialog on open and back to the row's button on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    if (som?.focus === "fee") { feeEditBtnRef.current?.focus(); return; }
    if (som?.focus === "due") { dueRef.current?.scrollIntoView({ block: "nearest" }); dialogRef.current?.focus(); return; }
    (amountRef.current ?? dialogRef.current)?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (coveredRef.current) return;
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

  if (som) return createPortal(
    <div style={m.backdrop} onMouseDown={e => { if (e.target === e.currentTarget && !amountEdited && !feeDirty) closeRef.current(); }}>
      <style>{`
        @keyframes payBackdropIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes payDialogIn { from { opacity: 0; transform: translateY(10px) scale(0.98) } to { opacity: 1; transform: none } }
        @media (prefers-reduced-motion: reduce) { .pay-anim { animation: none !important } }
      `}</style>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Fee & payment — ${student.name}`} tabIndex={-1}
        className="pay-anim" style={m.dialog}>
        {/* ── Header: who, which month, where it stands ─────────────────────── */}
        <div style={m.header}>
          <div style={{ minWidth: 0 }}>
            <div style={m.title}>{monthName(month)}{!isCurrentMonth && <span title={HISTORY_NOTE} style={{ cursor: "help" }}> ⓘ</span>}</div>
            <div style={m.name}>{student.name}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <StatusPill hasDue={hasDue} settled={monthSettled} waived={som.monthWaived} due={dueThisMonth ?? 0} month={month} paidOn={paidOn} />
            <button type="button" onClick={() => closeRef.current()} disabled={saving} aria-label="Close" style={m.closeBtn}>✕</button>
          </div>
        </div>

        <form onSubmit={submit} style={m.form}>
          <div style={m.body}>
            {/* ── 1 · Monthly fee ───────────────────────────────────────────── */}
            <section style={m.section}>
              <div style={m.secHead}><span style={m.secNo}>1</span> {som.feeKind === "per_class" ? "Fee per class" : "Monthly fee"}</div>
              {!isEditingFee ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "var(--color-text-primary)" }}>
                    {curFee > 0 ? fmtINR(curFee) : "-"}
                  </span>
                  <button ref={feeEditBtnRef} type="button" onClick={startFeeEdit}
                    aria-label={som.feeKind === "per_class" ? "Edit fee per class" : "Edit monthly fee"} title="Edit fee"
                    style={m.feeEditBtn}>✎</button>
                </div>
              ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
                <input ref={feeRef} type="number" min={1} inputMode="numeric" placeholder="e.g. 2500" aria-label={som.feeKind === "per_class" ? "Fee per class (₹)" : "Monthly fee (₹)"}
                  value={feeInput} disabled={som.savingFee}
                  onChange={e => setFeeInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); if (feeDirty) som.onSaveFee(feeN); }
                    // Esc leaves the editor, not the whole window.
                    if (e.key === "Escape" && !som.savingFee) { e.preventDefault(); e.nativeEvent.stopPropagation(); cancelFeeEdit(); }
                  }}
                  style={{ ...m.input, flex: "1 1 120px", fontSize: 14, fontWeight: 700, ...(feeInput !== "" && !feeValid ? { border: "1.5px solid #f87171" } : {}) }} />
                <button type="button" onClick={() => som.onSaveFee(feeN)} disabled={!feeDirty || som.savingFee}
                  style={{ ...m.confirmBtn, background: "#d97706", padding: "7px 14px", ...(!feeDirty || som.savingFee ? m.disabled : {}) }}>
                  {som.savingFee ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={cancelFeeEdit} disabled={som.savingFee}
                  style={{ ...m.cancelBtn, padding: "7px 12px", ...(som.savingFee ? m.disabled : {}) }}>
                  Cancel
                </button>
              </div>
              )}
              {isEditingFee && ((feeInput !== "" && !feeValid) || (som.centreDefault > 0 && feeN !== som.centreDefault)) && <div style={m.hint}>
                {feeInput !== "" && !feeValid && <span style={{ color: "#b91c1c" }}>Enter an amount above ₹0.</span>}
                {som.centreDefault > 0 && feeN !== som.centreDefault && (
                  <button type="button" onClick={() => setFeeInput(String(som.centreDefault))} style={m.linkBtn}>
                    Use centre default {fmtINR(som.centreDefault)}
                  </button>
                )}
              </div>}
            </section>

            {/* ── 2 · Due status for the month ──────────────────────────────── */}
            <section ref={dueRef} style={m.section}>
              <div style={m.secHead}><span style={m.secNo}>2</span> Due · {fmtMonth(month)}</div>
              {!hasDue && !monthSettled ? (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <Field label="Due Date">
                    <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{ ...m.input, width: 160 }} />
                  </Field>
                  {dueBillsOther && <div style={{ ...m.hint, marginTop: 0, flexBasis: "100%", color: "#b45309" }}>Bills {fmtMonth(dueDate.slice(0, 7))}, not {fmtMonth(month)}</div>}
                  <button type="button" onClick={() => onGenerateDue(dueDate)} disabled={generatingDue || !dueDate || som.dueAmount <= 0}
                    style={{ ...m.confirmBtn, background: "#f59e0b", ...(generatingDue || !dueDate || som.dueAmount <= 0 ? m.disabled : {}) }}>
                    {generatingDue ? "Marking…" : som.dueAmount > 0 ? `⚠️ Mark Due · ${fmtINR(som.dueAmount)}` : curFee <= 0 ? "Mark Due · set fee first" : "Mark Due"}
                  </button>
                  {som.dueNote && <div style={{ ...m.hint, marginTop: 0, flexBasis: "100%" }}>{som.dueNote}</div>}
                </div>
              ) : hasDue ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ ...m.duePill, background: "#fffbeb", color: isOverdueMonth(month) ? OVERDUE_TEXT : "#b45309" }}>
                    {fmtINR(dueThisMonth ?? 0)}
                  </span>
                  {/* Undue = the due was a mistake: it's deleted. A concession is a Discount on the payment. */}
                  <button type="button" onClick={som.onUndue ?? onUndoDue} disabled={undoingDue} title="Due marked by mistake — remove it"
                    style={{ ...m.cancelBtn, fontSize: 12, padding: "5px 12px", color: "#c2410c", borderColor: "#fed7aa", background: "#fff7ed", ...(undoingDue ? m.disabled : {}) }}>
                    {undoingDue ? "Removing…" : "Mark Undue"}
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ ...m.duePill, ...(som.monthWaived ? { background: "#ffedd5", color: "#c2410c" } : { background: "#dcfce7", color: "#16a34a" }) }}>
                    {som.monthWaived ? "Marked Undue" : `✓ Paid${paidOn ? ` · ${paidOn}` : ""}`}
                  </span>
                  {paidWithoutRecord && onReopenDue && (
                    <button type="button" onClick={onReopenDue} disabled={reopening}
                      style={{ ...m.cancelBtn, fontSize: 12, padding: "5px 12px", ...(reopening ? m.disabled : {}) }}>
                      {reopening ? "Reopening…" : "↩ Not paid — set to Due"}
                    </button>
                  )}
                  <button type="button" onClick={() => onGenerateDue(dueDate)} disabled={generatingDue || som.dueAmount <= 0}
                    title={som.dueNote ?? "Raise a further due for this month (revised fee)"}
                    style={{ ...m.cancelBtn, fontSize: 12, padding: "5px 12px", ...(generatingDue || som.dueAmount <= 0 ? m.disabled : {}) }}>
                    {generatingDue ? "Marking…" : som.dueAmount > 0 ? `Mark Due again · ${fmtINR(som.dueAmount)}` : "Mark Due again"}
                  </button>
                </div>
              )}
            </section>

            {/* ── 3 · Record payment ────────────────────────────────────────── */}
            <section style={{ ...m.section, borderBottom: "none", paddingBottom: 0 }}>
              <div style={m.secHead}><span style={m.secNo}>3</span> Record payment</div>
              {!showForm ? (
                <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
                  {monthSettled
                    ? <span style={{ ...m.duePill, ...(som.monthWaived ? { background: "#ffedd5", color: "#c2410c" } : { background: "#dcfce7", color: "#16a34a" }) }}>{som.monthWaived ? "Marked Undue · nothing to pay" : "✓ Paid · nothing to pay"}</span>
                    : "Nothing owed. Mark a due first to take a payment."}
                </div>
              ) : (
                <>
                  {unpaid.length === 0 && student.balance > 0 && (
                    <div style={{ fontSize: 12.5, color: "#b45309", fontWeight: 600 }}>Owed {fmtINR(student.balance)} · per-class charges</div>
                  )}
                  {student.balance < 0 && (
                    <div style={{ fontSize: 12.5, color: "#059669", fontWeight: 600 }}>Credit {fmtINR(-student.balance)}</div>
                  )}
                  {unpaid.length > 1 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {unpaid.map(d => {
                        const selected = billingMonth === d.billingMonth;
                        return (
                          <button key={d.billingMonth} type="button" aria-pressed={selected}
                            onClick={() => { setMonthPicked(true); selectMonth(d.billingMonth); }}
                            style={{ ...m.monthChip, ...(selected ? m.chipActive : {}) }}>
                            <span style={{ fontWeight: 700, color: !selected && isOverdueMonth(d.billingMonth) ? OVERDUE_TEXT : undefined }}>{dueLabel(d.billingMonth)}</span>
                            <span style={{ opacity: 0.85 }}>{d.state === "partial" ? `${fmtINR(d.remaining)} left` : fmtINR(d.remaining)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
                    <Field label="Amount (₹)">
                      <input ref={amountRef} type="number" min={1} placeholder="0" value={amount} style={m.input}
                        onChange={e => { setAmount(e.target.value); setAmountEdited(e.target.value !== ""); }}
                        onFocus={e => e.target.select()} />
                    </Field>
                    <Field label="Discount (₹)">
                      <input type="number" min={0} placeholder="0" value={discountValue}
                        onChange={e => { setDiscountType("fixed"); setDiscountValue(e.target.value); }} style={m.input} />
                    </Field>
                    <Field label="Mode" group>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                        {(["UPI", "Cash", "Bank", "Card"] as PayMethod[]).map(x => (
                          <button key={x} type="button" aria-pressed={method === x} onClick={() => setMethod(x)}
                            style={{ ...m.methodChip, padding: "7px 4px", ...(method === x ? m.chipActive : {}) }}>
                            {x === "Bank" ? "Bank Transfer" : x}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Date" badge={isPastDate ? "Past" : undefined}>
                      <input type="date" value={date} max={todayStr()} onChange={e => setDate(e.target.value || todayStr())}
                        style={{ ...m.input, ...(isPastDate ? { border: "1.5px solid #f59e0b" } : {}) }} />
                    </Field>
                  </div>
                  {amount && (() => {
                    const owed = unpaid.find(d => d.billingMonth === billingMonth)?.remaining ?? 0;
                    const left = Math.max(0, owed - net - (discountAmt > 0 ? discountAmt : 0));
                    return (
                      <div style={m.netPreview}>
                        {discountAmt > 0 && <span>Discount <strong>{fmtINR(discountAmt)}</strong></span>}
                        <span style={{ fontWeight: 700 }}>Receiving <strong>{fmtINR(net)}</strong></span>
                        {billingMonth && <span style={{ color: left > 0 ? "#b45309" : "#059669" }}>{left > 0 ? `${fmtINR(left)} left after` : "Clears the due"}</span>}
                      </div>
                    );
                  })()}
                </>
              )}
            </section>
          </div>

          <div style={m.footer}>
            <button type="button" onClick={() => closeRef.current()} disabled={saving} style={{ ...m.cancelBtn, ...(saving ? m.disabled : {}) }}>Close</button>
            {showForm && (
              <button type="submit" disabled={!canSubmit} style={{ ...m.confirmBtn, ...(canSubmit ? {} : m.disabled) }}>
                {saving ? "Saving…" : billingMonth || (unpaid.length === 0 && student.balance > 0) ? "✓ Confirm Payment" : "✓ Record as Credit"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );

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
                {dueBillsOther && <div style={{ ...m.hint, color: "#b45309" }}>Bills {fmtMonth(dueDate.slice(0, 7))}, not {fmtMonth(month)}</div>}
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
                  {monthSettled ? `✓ Paid${paidOn ? ` · ${paidOn}` : ""}` : `${dueLabel(month)} · ${fmtINR(dueThisMonth ?? 0)}`}
                </span>
                <span title={isCurrentMonth ? undefined : HISTORY_NOTE} style={{ fontSize: 11, color: "var(--color-text-secondary)", cursor: isCurrentMonth ? undefined : "help" }}>
                  {monthSettled && fmtMonth(month)}{!isCurrentMonth && " ⓘ"}
                </span>
                {monthSettled && paidWithoutRecord && onReopenDue && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexBasis: "100%", fontSize: 11.5, color: "#b45309", marginTop: 4 }}>
                    ⚠ No payment record for this month.
                    <button type="button" onClick={onReopenDue} disabled={reopening}
                      style={{ ...m.cancelBtn, fontSize: 11, padding: "3px 10px", ...(reopening ? m.disabled : {}) }}>
                      {reopening ? "Reopening…" : "↩ Not paid — set to Due"}
                    </button>
                  </span>
                )}
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

/** "2026-11" → "November". */
function monthName(month: string): string {
  const d = new Date(`${month}-01T00:00:00`);
  return isNaN(d.getTime()) ? month : d.toLocaleString("en-IN", { month: "long" });
}

function StatusPill({ hasDue, settled, waived, due, month, paidOn }: {
  hasDue: boolean; settled: boolean; waived: boolean; due: number; month: string; paidOn?: string | null;
}) {
  const [bg, fg, text] = hasDue
    ? ["#fffbeb", isOverdueMonth(month) ? OVERDUE_TEXT : "#b45309", `Due ${fmtINR(due)}`]
    : settled && waived ? ["#ffedd5", "#c2410c", "Undue"]
    : settled ? ["#dcfce7", "#16a34a", "✓ Paid"]
    : ["var(--color-surface-2)", "var(--color-text-secondary)", "No due"];
  return <span title={settled && !waived && paidOn ? `Paid ${paidOn}` : undefined} style={{ ...m.duePill, background: bg, color: fg, whiteSpace: "nowrap" }}>{text}</span>;
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
  section:    { display: "flex", flexDirection: "column", gap: 10, paddingBottom: 14, borderBottom: "1px solid var(--color-border)" },
  secHead:    { display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800, color: "var(--color-text-primary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  secNo:      { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 99, background: "#f59e0b", color: "#fff", fontSize: 10.5, fontWeight: 800 },
  hint:       { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 10px", fontSize: 11.5, color: "var(--color-text-secondary)", marginTop: -4 },
  feeEditBtn: { width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-surface-2)", color: "var(--color-text-secondary)", fontSize: 14, cursor: "pointer", padding: 0 },
  linkBtn:    { border: "none", background: "none", padding: 0, color: "#b45309", fontSize: 11.5, fontWeight: 700, cursor: "pointer", textDecoration: "underline" },
};
