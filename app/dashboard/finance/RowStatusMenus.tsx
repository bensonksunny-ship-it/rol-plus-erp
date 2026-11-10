"use client";

// Finance "Un-due": clicking a student's Due opens this dialog. The admin says
// why the fee shouldn't be charged (the student is on break, or has
// discontinued), picks the unpaid months, and both things happen together:
// the dues are waived (kept in history) and the student's status is updated.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmtINR, fmtMonth, todayStr } from "./format";

// ─── Student status chip ──────────────────────────────────────────────────────

const STATUS_CHIPS: Record<string, { label: string; fg: string; bg: string }> = {
  break_requested:        { label: "Break req.",    fg: "#0369a1", bg: "#e0f2fe" },
  on_break:               { label: "On break",      fg: "#0284c7", bg: "#e0f2fe" },
  deactivation_requested: { label: "Discont. req.", fg: "#9a3412", bg: "#ffedd5" },
};

/** Pending / break states worth flagging on a Finance row (inactive has its own tag). */
export function StudentStatusChip({ status }: { status: string }) {
  const c = STATUS_CHIPS[status];
  if (!c) return null;
  return (
    <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: c.fg, background: c.bg, borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap" }}>
      {c.label}
    </span>
  );
}

// ─── Un-due dialog ────────────────────────────────────────────────────────────

export type UndueReason = "break" | "discontinued";
export interface UndueMonth { dueId: string; billingMonth: string; remaining: number }
/** `reason` is optional: null = just waive the dues, leave the student's status alone. */
export interface UndueSubmit { reason: UndueReason | null; months: UndueMonth[]; note: string; breakFrom: string }

const REASONS: { key: UndueReason; icon: string; title: string; sub: string; color: string; tint: string }[] = [
  { key: "break",        icon: "⏸", title: "Student on break",     sub: "Coming back later",   color: "#0284c7", tint: "rgba(2,132,199,0.10)" },
  { key: "discontinued", icon: "⏹", title: "Student discontinued", sub: "Not coming back",     color: "#dc2626", tint: "rgba(220,38,38,0.08)" },
];

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "2026-11-03" → "Tue 3" */
function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : `${DAY[d.getDay()]} ${d.getDate()}`;
}

export function UndueModal({ name, months, otherBalance, status, direct, approverLabel, attendance, saving, onConfirm, onClose }: {
  name: string;
  /** Every month this student still owes on, oldest first. */
  months: UndueMonth[];
  /** Balance that isn't a monthly due (e.g. per-class charges); not waived here. */
  otherBalance: number;
  status: string;
  /** True when this user's status change applies at once; otherwise it's a request. */
  direct: boolean;
  approverLabel: string;
  /** Attended (present) dates by "YYYY-MM"; null while loading; key __error__ if it failed. */
  attendance: Record<string, string[]> | null;
  saving: boolean;
  onConfirm: (v: UndueSubmit) => void;
  onClose: () => void;
}) {
  // "pick" = choose reason + months; "confirm" = review, with attendance warnings.
  const [step, setStep]           = useState<"pick" | "confirm">("pick");
  const [reason, setReason]       = useState<UndueReason | null>(null);
  const [picked, setPicked]       = useState<Set<string>>(() => new Set(months.map(m => m.dueId)));
  const [note, setNote]           = useState("");
  const [breakFrom, setBreakFrom] = useState(todayStr());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const chosen = months.filter(m => picked.has(m.dueId));
  const total  = chosen.reduce((a, m) => a + m.remaining, 0);
  // Only the months are required. Break / discontinued is extra logging.
  const valid  = chosen.length > 0 && (reason !== "break" || !direct || !!breakFrom);
  const r      = REASONS.find(x => x.key === reason);

  const already =
    reason === "break" ? status === "on_break" || (!direct && status === "break_requested")
    : reason === "discontinued" ? status === "inactive" || (!direct && status === "deactivation_requested")
    : false;
  const statusLine = !reason ? null
    : already ? "Status already recorded."
    : direct ? (reason === "break" ? "Student goes On break: off rosters, Break in Attendance." : "Student becomes Inactive everywhere.")
    : `Status change is sent to ${approverLabel} to confirm.`;

  const attLoading  = attendance === null;
  const attFailed   = !!attendance && "__error__" in attendance;
  const attendedIn  = (month: string) => (attendance && !attFailed ? attendance[month] ?? [] : []);
  const anyAttended = chosen.some(m => attendedIn(m.billingMonth).length > 0);

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Closes only via Cancel / ✕ / Esc, so a stray click can't drop the choice.
  return createPortal(
    <div style={s.backdrop}>
      <form role="dialog" aria-modal="true" aria-label={`Un-due: ${name}`} style={s.dialog}
        onSubmit={e => {
          e.preventDefault();
          if (!valid) return;
          if (step === "pick") { setStep("confirm"); return; }
          if (!attLoading) onConfirm({ reason, months: chosen, note: note.trim(), breakFrom });
        }}>

        <div style={s.head}>
          <div style={{ minWidth: 0 }}>
            <div style={s.kicker}>Un-due</div>
            <div style={s.name}>{name}</div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" style={s.close}>✕</button>
        </div>

        {step === "confirm" ? (
          <div style={s.body}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>
              {anyAttended ? "⚠ Attended classes in this period" : "Are you sure?"}
            </div>
            <div style={s.muted}>
              Un-due <b style={{ color: "var(--color-text-primary)" }}>{fmtINR(total)}</b> for {name}{r ? ` · ${r.title.toLowerCase()}` : ""}.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {chosen.map(m => {
                const dates = attendedIn(m.billingMonth);
                const came = dates.length > 0;
                return (
                  <div key={m.dueId} style={{ ...s.monthCard, ...(came ? s.monthCardWarn : {}) }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: 700, fontSize: 13 }}>
                      <span>{fmtMonth(m.billingMonth)}</span>
                      <span>{fmtINR(m.remaining)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4, color: came ? "#9a3412" : "var(--color-text-secondary)" }}>
                      {attLoading ? "Checking attendance…"
                        : attFailed ? "Attendance couldn't be checked."
                        : came ? `Attended ${dates.length} class${dates.length === 1 ? "" : "es"}:`
                        : "No classes attended."}
                    </div>
                    {came && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                        {dates.map(d => <span key={d} style={s.dateChip}>{fmtDay(d)}</span>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {anyAttended && (
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#9a3412" }}>
                This student came to class in a month you&apos;re un-dueing. Are you sure?
              </div>
            )}
            {statusLine && <div style={s.muted}>{statusLine}</div>}
          </div>
        ) : (
        <div style={s.body}>
          <div style={s.amountBox}>
            <div style={s.amountLabel}>Waive</div>
            <div style={s.amount}>{fmtINR(total)}</div>
          </div>

          <div style={{ ...s.label, marginBottom: -6 }}>Status <span style={{ textTransform: "none", fontWeight: 500, letterSpacing: 0 }}>(optional)</span></div>
          <div role="group" aria-label="Status (optional)" style={s.reasonGrid}>
            {REASONS.map(x => {
              const on = reason === x.key;
              return (
                // Toggle: click again to clear — un-due works without either.
                <button key={x.key} type="button" aria-pressed={on} onClick={() => setReason(on ? null : x.key)} disabled={saving}
                  style={{ ...s.reason, ...(on ? { borderColor: x.color, background: x.tint, boxShadow: `0 0 0 1px ${x.color}` } : {}) }}>
                  <span style={{ ...s.reasonIcon, color: x.color }}>{x.icon}</span>
                  <span style={s.reasonTitle}>{x.title}</span>
                  <span style={s.reasonSub}>{x.sub}</span>
                </button>
              );
            })}
          </div>

          {months.length > 1 && (
            <div>
              <div style={s.label}>Months</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {months.map(m => {
                  const on = picked.has(m.dueId);
                  return (
                    <button key={m.dueId} type="button" aria-pressed={on} onClick={() => toggle(m.dueId)} disabled={saving}
                      style={{ ...s.month, ...(on ? s.monthOn : {}) }}>
                      {on ? "✓ " : ""}{fmtMonth(m.billingMonth)} · {fmtINR(m.remaining)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {months.length === 1 && <div style={s.muted}>{fmtMonth(months[0].billingMonth)}</div>}

          {reason === "break" && direct && !already && (
            <label style={s.label}>On break from
              <input type="date" value={breakFrom} onChange={e => setBreakFrom(e.target.value)} disabled={saving} style={s.input} />
            </label>
          )}

          <label style={s.label}>Note
            <input type="text" value={note} onChange={e => setNote(e.target.value)} disabled={saving} placeholder="Optional" style={s.input} />
          </label>

          {(statusLine || otherBalance > 0) && (
            <div style={s.muted}>
              {statusLine}
              {otherBalance > 0 && <> {fmtINR(otherBalance)} in other charges stays due.</>}
            </div>
          )}
        </div>
        )}

        <div style={s.foot}>
          {step === "confirm"
            ? <button type="button" onClick={() => setStep("pick")} disabled={saving} style={s.cancel}>← Back</button>
            : <button type="button" onClick={onClose} disabled={saving} style={s.cancel}>Cancel</button>}
          {(() => {
            const off = saving || !valid || (step === "confirm" && attLoading);
            const color = step === "confirm" && anyAttended ? "#c2410c" : r?.color ?? "#ea580c";
            return (
              <button type="submit" disabled={off} autoFocus={step === "confirm"}
                style={{ ...s.confirm, background: color, opacity: off ? 0.55 : 1, cursor: off ? "not-allowed" : "pointer" }}>
                {saving ? "Saving…"
                  : step === "pick" ? `Continue · ${fmtINR(total)}`
                  : attLoading ? "Checking…"
                  : anyAttended ? `Yes, un-due ${fmtINR(total)}`
                  : `Confirm un-due ${fmtINR(total)}`}
              </button>
            );
          })()}
        </div>
      </form>
    </div>,
    document.body,
  );
}

const s: Record<string, React.CSSProperties> = {
  backdrop:   { position: "fixed", inset: 0, zIndex: 700, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  dialog:     { width: "100%", maxWidth: 420, maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column", background: "var(--color-surface)", color: "var(--color-text-primary)", border: "1px solid var(--color-border)", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.3)", overflow: "hidden" },
  head:       { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "16px 20px 12px", borderBottom: "1px solid var(--color-border)" },
  kicker:     { fontSize: 11, fontWeight: 700, color: "#ea580c", textTransform: "uppercase", letterSpacing: "0.05em" },
  name:       { fontSize: 17, fontWeight: 800, marginTop: 2, overflowWrap: "anywhere" },
  close:      { border: "none", background: "none", fontSize: 16, color: "var(--color-text-secondary)", cursor: "pointer", padding: 4 },
  body:       { padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" },
  amountBox:  { display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "12px 14px", borderRadius: 12, background: "rgba(249,115,22,0.12)", border: "1px solid rgba(249,115,22,0.35)" },
  amountLabel:{ fontSize: 12, fontWeight: 700, color: "#c2410c", textTransform: "uppercase", letterSpacing: "0.05em" },
  amount:     { fontSize: 24, fontWeight: 800, color: "#c2410c" },
  reasonGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  reason:     { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "14px 14px 12px", borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-text-primary)", cursor: "pointer", textAlign: "left", transition: "all 0.12s" },
  reasonIcon: { fontSize: 22, lineHeight: 1, marginBottom: 6 },
  reasonTitle:{ fontSize: 13.5, fontWeight: 800 },
  reasonSub:  { fontSize: 11.5, color: "var(--color-text-secondary)" },
  label:      { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  input:      { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--color-border)", fontSize: 14, color: "var(--color-text-primary)", background: "var(--color-surface)", textTransform: "none", letterSpacing: 0, fontWeight: 400 },
  month:      { padding: "5px 11px", borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-text-secondary)" },
  monthOn:    { background: "#ea580c", borderColor: "#ea580c", color: "#fff" },
  muted:      { fontSize: 12, color: "var(--color-text-secondary)" },
  monthCard:  { padding: "10px 12px", borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface)" },
  monthCardWarn: { border: "1px solid #fb923c", background: "rgba(249,115,22,0.10)" },
  dateChip:   { fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: "#fed7aa", color: "#9a3412" },
  foot:       { display: "flex", justifyContent: "flex-end", gap: 10, padding: "12px 20px", borderTop: "1px solid var(--color-border)" },
  cancel:     { padding: "9px 16px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-text-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  confirm:    { padding: "9px 20px", borderRadius: 8, border: "none", color: "#fff", fontSize: 13, fontWeight: 700 },
};
