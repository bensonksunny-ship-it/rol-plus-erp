"use client";

// Monthly admissions funnel strip for /dashboard/admissions (both wings).
//
//   New Enquiries   — enquiries created in the month (leads only; applications
//                     moved back to Enquiries, source "admission", are not new)
//   Forms Filled    — admission applications submitted in the month
//   Enrollments     — applications enrolled in the month (admissions.enrolledAt)
//
// Both sources are live Firestore listeners scoped to the active wing, so the
// counts update on their own when anything is created, converted or enrolled —
// there is no query cache to invalidate.

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { subscribeEnquiries, type Enquiry } from "@/services/enquiry/enquiry.service";

/** "2026-11" for a Date, in local (IST) time. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
/** Local month of an ISO timestamp; "" when missing/invalid. */
export function monthOf(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : monthKey(d);
}
function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}
export function monthLabel(key: string, style: "long" | "short" = "long"): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: style, ...(style === "long" ? { year: "numeric" } : {}) });
}

interface AdmissionLite { submittedAt: string; enrolledAt: string }

/** Which funnel card is selected — filters the page to that month's records. */
export type FunnelKind = "enquiries" | "forms" | "enrolled";
export const FUNNEL_LABEL: Record<FunnelKind, string> = {
  enquiries: "New enquiries", forms: "Forms filled", enrolled: "Enrolled",
};

/**
 * The month and the selected card are owned by the page, so the list filter
 * follows the month switcher. Clicking the selected card again clears it.
 */
export function AdmissionsSummaryStrip({ wing, month, onMonthChange, active = null, onSelect }: {
  wing: string;
  month: string;
  onMonthChange: (month: string) => void;
  active?: FunnelKind | null;
  onSelect?: (kind: FunnelKind | null) => void;
}) {
  const thisMonth = monthKey(new Date());
  const setMonth = (next: string | ((m: string) => string)) =>
    onMonthChange(typeof next === "function" ? next(month) : next);
  const [enquiries, setEnquiries] = useState<Enquiry[] | null>(null);
  const [admissions, setAdmissions] = useState<AdmissionLite[] | null>(null);

  useEffect(() => {
    setEnquiries(null);
    return subscribeEnquiries(wing, setEnquiries, () => setEnquiries([]));
  }, [wing]);

  useEffect(() => {
    setAdmissions(null);
    // Same scoping as the admissions list: docs without a wing are ROL+.
    return onSnapshot(
      collection(db, "admissions"),
      snap => setAdmissions(snap.docs
        .map(d => d.data() as Record<string, unknown>)
        .filter(a => (typeof a.wing === "string" ? a.wing : "rol_plus") === wing)
        .map(a => ({ submittedAt: String(a.submittedAt ?? ""), enrolledAt: String(a.enrolledAt ?? "") }))),
      () => setAdmissions([]),
    );
  }, [wing]);

  const counts = useMemo(() => {
    const tally = (m: string) => ({
      enquiries: (enquiries ?? []).filter(e => e.source !== "admission" && monthOf(e.createdAt) === m).length,
      forms:     (admissions ?? []).filter(a => monthOf(a.submittedAt) === m).length,
      enrolled:  (admissions ?? []).filter(a => monthOf(a.enrolledAt) === m).length,
    });
    return { cur: tally(month), prev: tally(shiftMonth(month, -1)) };
  }, [enquiries, admissions, month]);

  const loading = enquiries === null || admissions === null;
  const isCurrent = month === thisMonth;
  const prevShort = monthLabel(shiftMonth(month, -1), "short");

  const cards: {
    kind: FunnelKind; label: string; icon: string; value: number; prev: number;
    tone: string; tint: string; ring: string; iconBg: string; sub?: string;
  }[] = [
    { kind: "enquiries", label: "New Enquiries", icon: "📇", value: counts.cur.enquiries, prev: counts.prev.enquiries,
      tone: "#4338ca", tint: "linear-gradient(135deg, #eef2ff 0%, #f0f9ff 100%)", ring: "rgba(99,102,241,0.22)",
      iconBg: "linear-gradient(135deg, #6366f1, #0ea5e9)" },
    { kind: "forms", label: "Forms Filled", icon: "📝", value: counts.cur.forms, prev: counts.prev.forms,
      tone: "#c2410c", tint: "linear-gradient(135deg, #fff7ed 0%, #fffbeb 100%)", ring: "rgba(249,115,22,0.22)",
      iconBg: "linear-gradient(135deg, #f97316, #f59e0b)" },
    { kind: "enrolled", label: "Enrollments", icon: "🎓", value: counts.cur.enrolled, prev: counts.prev.enrolled,
      tone: "#047857", tint: "linear-gradient(135deg, #ecfdf5 0%, #f0fdfa 100%)", ring: "rgba(16,185,129,0.22)",
      iconBg: "linear-gradient(135deg, #10b981, #14b8a6)",
      sub: counts.cur.forms > 0 ? `${Math.round((counts.cur.enrolled / counts.cur.forms) * 100)}% of forms` : undefined },
  ];

  return (
    <section aria-label="Monthly admissions summary" style={{ marginBottom: 20 }}>
      {/* Header: label left, month switcher right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden style={{ width: 4, height: 16, borderRadius: 4, background: "linear-gradient(180deg, #f97316, #6366f1)" }} />
          <span style={{ fontSize: 12, fontWeight: 800, color: "#334155", letterSpacing: "0.08em", textTransform: "uppercase" }}>Monthly Summary</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {active && onSelect && (
            <button type="button" onClick={() => onSelect(null)}
              className="transition-colors bg-slate-100 hover:bg-slate-200"
              title="Show every record again"
              style={{ fontSize: 11.5, fontWeight: 700, padding: "6px 12px", borderRadius: 999, border: "1px solid #cbd5e1", color: "#334155", cursor: "pointer", fontFamily: "inherit" }}>
              ✕ Clear filter
            </button>
          )}
          {!isCurrent && (
            <button type="button" onClick={() => setMonth(thisMonth)}
              className="transition-colors bg-amber-50 hover:bg-amber-100"
              style={{ fontSize: 11.5, fontWeight: 700, padding: "6px 12px", borderRadius: 999, border: "1px solid #fcd34d", color: "#b45309", cursor: "pointer", fontFamily: "inherit" }}>
              ↺ This month
            </button>
          )}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 2, padding: 3, borderRadius: 999,
            background: "#fff", border: "1px solid rgba(226,232,240,0.9)", boxShadow: "0 1px 2px rgba(15,23,42,0.06)",
          }}>
            <button type="button" aria-label="Previous month" onClick={() => setMonth(m => shiftMonth(m, -1))}
              className="transition-colors bg-transparent hover:bg-slate-100" style={arrow}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", minWidth: 124, textAlign: "center", padding: "0 6px", fontVariantNumeric: "tabular-nums" }}>
              {monthLabel(month)}
            </span>
            <button type="button" aria-label="Next month" disabled={isCurrent}
              title={isCurrent ? "Already on the current month" : undefined}
              onClick={() => setMonth(m => (m < thisMonth ? shiftMonth(m, 1) : m))}
              className={isCurrent ? "bg-transparent" : "transition-colors bg-transparent hover:bg-slate-100"}
              style={{ ...arrow, color: isCurrent ? "#cbd5e1" : arrow.color, cursor: isCurrent ? "not-allowed" : "pointer" }}>›</button>
          </div>
        </div>
      </div>

      {/* KPI cards — each one filters the page to its records for the month */}
      <style>{`
        .funnel-card { transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s, opacity 0.15s; }
        .funnel-card:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(15,23,42,0.10) !important; opacity: 1 !important; }
        .funnel-card:focus-visible { outline: 3px solid #6366f1; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .funnel-card, .funnel-card:hover { transition: none; transform: none !important; } }
      `}</style>
      <div role="group" aria-label="Filter by funnel stage" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        {cards.map(c => {
          const delta = c.value - c.prev;
          const up = delta > 0, down = delta < 0;
          const on = active === c.kind;
          const dim = !!active && !on;
          return (
            <button type="button" key={c.label} className="funnel-card"
              aria-pressed={on} disabled={!onSelect}
              title={on ? "Click again to clear the filter" : `Show ${c.label.toLowerCase()} in ${monthLabel(month)}`}
              onClick={() => onSelect?.(on ? null : c.kind)}
              style={{
                background: c.tint, border: `1.5px solid ${on ? c.tone : "rgba(226,232,240,0.8)"}`, borderRadius: 16, padding: "16px 18px",
                boxShadow: on
                  ? `0 0 0 4px ${c.ring}, 0 10px 24px ${c.ring}`
                  : `0 1px 2px rgba(15,23,42,0.05), inset 0 0 0 1px ${c.ring}`,
                display: "flex", flexDirection: "column", gap: 10, minWidth: 0,
                textAlign: "left", fontFamily: "inherit", color: "inherit", width: "100%",
                cursor: onSelect ? "pointer" : "default", opacity: dim ? 0.6 : 1,
                transform: on ? "translateY(-2px)" : undefined, position: "relative",
              }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: c.tone, textTransform: "uppercase", letterSpacing: "0.06em" }}>{c.label}</span>
                <span aria-hidden style={{
                  width: 34, height: 34, borderRadius: 11, background: c.iconBg, flexShrink: 0,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                  boxShadow: `0 4px 10px ${c.ring}`,
                }}>{c.icon}</span>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {loading ? "–" : c.value}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 20 }}>
                {!loading && (
                  <span title={`${c.prev} in ${prevShort}`} style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700,
                    padding: "2px 8px", borderRadius: 999, fontVariantNumeric: "tabular-nums",
                    background: up ? "#dcfce7" : down ? "#fee2e2" : "#f1f5f9",
                    color: up ? "#15803d" : down ? "#b91c1c" : "#64748b",
                  }}>
                    {up ? `▲ ${delta}` : down ? `▼ ${-delta}` : "No change"}
                    <span style={{ fontWeight: 500, opacity: 0.8 }}>vs {prevShort}</span>
                  </span>
                )}
                {c.sub && !loading && <span style={{ fontSize: 11.5, fontWeight: 600, color: "#64748b" }}>{c.sub}</span>}
                {onSelect && (
                  <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: on ? c.tone : "#94a3b8" }}>
                    {on ? "✓ Showing" : "View →"}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const arrow: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 999, border: "none", color: "#334155",
  fontSize: 18, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
};
