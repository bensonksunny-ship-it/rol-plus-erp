"use client";

// =============================================================================
// Founder Suite — executive view of both schools, always side by side.
//   Wing 1 · ROL+ (left) | Wing 2 · School of Music (right) in every section —
//   KPI cards → detail comparison → Action Required (unmarked classes today,
//   top fee overdues, with Nudge / Alert buttons tagged to that wing) →
//   6-month growth & fall (one line per wing) → centre performance.
//   Nothing is summed across wings.
// Founder only. Reads Firestore directly (like every dashboard here); numbers
// come from ./metrics, which mirrors the definitions used elsewhere.
// =============================================================================

import { Fragment, useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS } from "@/config/constants";
import { getCenters } from "@/services/center/center.service";
import { getRolesForWing } from "@/lib/wing";
import { getTeacherDisplayName } from "@/lib/teacherName";
import { FollowUpModal, type Recipient } from "@/components/founder/FollowUpModal";
import type { NotificationKind } from "@/services/notification/notification.service";
import type { User, Wing } from "@/types";
import {
  centreRows, monthKey, pendingDues, prepare, summary, trend, unmarkedToday,
  type Doc, type Prepared, type WingSummary,
} from "./metrics";

const WING_NAME: Record<Wing, string> = { rol_plus: "Wing 1 · ROL+", school_of_music: "Wing 2 · School of Music" };
const WING_SHORT: Record<Wing, string> = { rol_plus: "ROL+", school_of_music: "SoM" };
const WING_TINT: Record<Wing, { fg: string; bg: string; border: string; line: string }> = {
  rol_plus:        { fg: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe", line: "#2563eb" },   // Wing 1 — blue
  school_of_music: { fg: "#6d28d9", bg: "#f5f3ff", border: "#ddd6fe", line: "#7c3aed" },   // Wing 2 — purple
};
const BOTH: Wing[] = [WINGS.ROL_PLUS, WINGS.SCHOOL_OF_MUSIC];

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const inrK = (n: number) => (n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : inr(n));
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export default function FounderSuitePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.FOUNDER]}>
      <FounderSuite />
    </ProtectedRoute>
  );
}

interface FollowUp { title: string; recipients: Recipient[]; message: string; kind: NotificationKind; link: string | null; wing: string | null }

function FounderSuite() {
  const [data, setData] = useState<Prepared | null>(null);
  const [staff, setStaff] = useState<Doc[]>([]);
  const [error, setError] = useState("");
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const floor = monthKey(6) + "-01";
        const [centres, usersSnap, attSnap, txSnap] = await Promise.all([
          getCenters(),
          getDocs(collection(db, "users")),
          getDocs(query(collection(db, "attendance"), where("date", ">=", floor))),
          getDocs(collection(db, "transactions")),
        ]);
        if (cancelled) return;
        const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Doc);
        setStaff(users.filter(u => u.role !== "student" && u.role !== "merged_student" && u.status !== "deleted"));
        setData(prepare({
          centres,
          students:     users.filter(u => u.role === "student"),
          attendance:   attSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Doc),
          transactions: txSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Doc),
        }));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Every figure is computed per wing — nothing on this page is summed across wings.
  const view = useMemo(() => {
    if (!data) return null;
    return Object.fromEntries(BOTH.map(w => [w, {
      sum:      summary(data, w),
      dues:     pendingDues(data, w).dues,
      unmarked: unmarkedToday(data, w),
      months:   trend(data, w),
      centres:  centreRows(data, w),
    }])) as Record<Wing, WingView>;
  }, [data]);

  // ── People to follow up with ───────────────────────────────────────────────
  const person = (u: Doc, role: string): Recipient => ({
    uid: u.id,
    name: getTeacherDisplayName({ ...u, uid: u.id } as unknown as Parameters<typeof getTeacherDisplayName>[0]) || str(u.displayName) || str(u.name) || "—",
    role, phone: str(u.phone),
  });
  /** Wing leads: ROL+ → Admin; School of Music → Director + Office Manager. */
  const wingLeads = (w: Wing): Recipient[] => {
    const want = w === WINGS.ROL_PLUS ? [ROLES.ADMIN] : [ROLES.DIRECTOR, ROLES.OFFICE_MANAGER];
    return staff.flatMap(u => {
      const roles = getRolesForWing(u as unknown as User, w) as string[];
      const hit = want.find(r => roles.includes(r));
      return hit && u.status !== "inactive" ? [person(u, `${WING_SHORT[w]} ${hit.replace(/_/g, " ")}`)] : [];
    });
  };
  const teacher = (uid: string): Recipient[] => {
    const u = staff.find(s => s.id === uid);
    return u ? [person(u, "Teacher")] : [];
  };
  const alertPending = (w: Wing, s: WingSummary) => setFollowUp({
    title: `Pending fees follow-up · ${WING_SHORT[w]}`,
    recipients: wingLeads(w),
    message: `Hi, ${s.pendingCount} student${s.pendingCount !== 1 ? "s have" : " has"} fees pending this month (${inr(s.pending)} in total). Please follow up with the families and record payments in Finance.`,
    kind: "fee_followup", link: "/dashboard/finance", wing: w,
  });

  if (error) return <div style={{ padding: 24, color: "var(--color-danger)" }}>{error}</div>;

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: "var(--color-text-muted)" }}>FOUNDER SUITE</div>
        <div style={{ fontSize: 22, fontWeight: 900, color: "var(--color-text-primary)" }}>Wing 1 and Wing 2, side by side</div>
      </div>

      {!view ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--color-text-muted)" }}>Loading both schools…</div>
      ) : (
        <>
          {/* Split KPI header — one card per wing, never combined */}
          <WingColumns render={w => (
            <WingKpiCard wing={w} s={view[w].sum} onAlertPending={() => alertPending(w, view[w].sum)} />
          )} />

          {/* Detailed comparison */}
          <Section title="Wing 1 vs Wing 2 · detail">
            <WingColumns render={w => <WingCard wing={w} s={view[w].sum} />} />
          </Section>

          {/* Action required — isolated per wing */}
          <Section title="Action Required">
            <WingColumns render={w => {
              const v = view[w];
              return (
                <div style={{ display: "grid", gap: 12 }}>
                  <Panel title="Unmarked classes today" wing={w} count={v.unmarked.filter(u => u.ended).length} empty="Every class that has ended today is marked. 🎉">
                    {v.unmarked.map((u, i) => {
                      const t = teacher(u.teacherUid)[0];
                      return (
                        <Row key={`${u.centreId}-${i}`}
                          left={<>
                            <div style={{ fontWeight: 700 }}>{u.centreName}{u.batchName ? ` · ${u.batchName}` : ""}</div>
                            <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                              {u.time || "—"} · {t?.name ?? "No teacher"} · {u.marked}/{u.expected} marked{u.ended ? "" : " · later today"}
                            </div>
                          </>}
                          right={u.ended ? (
                            <SmallBtn onClick={() => setFollowUp({
                              title: `Attendance not marked · ${WING_SHORT[w]}`,
                              recipients: teacher(u.teacherUid),
                              message: `Hi ${t?.name ?? ""}, attendance for ${u.centreName}${u.batchName ? ` (${u.batchName})` : ""}${u.time ? `, ${u.time}` : ""} today isn't marked yet (${u.marked}/${u.expected}). Please mark it in My Classes. Thank you!`,
                              kind: "attendance_nudge", link: `/dashboard/my-classes?centerId=${encodeURIComponent(u.centreId)}`, wing: w,
                            })}>📋 Nudge teacher</SmallBtn>
                          ) : <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>upcoming</span>} />
                      );
                    })}
                  </Panel>

                  <Panel title="Biggest fee overdues · this month" wing={w} count={v.dues.length} empty="No fees pending this month. 🎉">
                    {v.dues.slice(0, 8).map(d => (
                      <Row key={d.uid}
                        left={<>
                          <div style={{ fontWeight: 700 }}>{d.name}</div>
                          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{d.centreName}</div>
                        </>}
                        right={<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 800, color: "#b45309" }}>{inr(d.amount)}</span>
                          <SmallBtn onClick={() => setFollowUp({
                            title: `Fee follow-up · ${WING_SHORT[w]}`,
                            recipients: wingLeads(w),
                            message: `Hi, ${d.name} (${d.centreName}) has ${inr(d.amount)} fees pending this month. Please follow up with the family and record the payment in Finance.`,
                            kind: "fee_followup", link: "/dashboard/finance", wing: w,
                          })}>💰 Alert wing admin</SmallBtn>
                        </div>} />
                    ))}
                    {v.dues.length > 8 && <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: "8px 2px 0" }}>+ {v.dues.length - 8} more in Finance</div>}
                  </Panel>
                </div>
              );
            }} />
          </Section>

          {/* Growth & fall — one line per wing on the same chart */}
          <Section title="Growth & Fall · 6 months">
            <DualTrend series={Object.fromEntries(BOTH.map(w => [w, view[w].months])) as Record<Wing, MonthPoints>} />
          </Section>

          {/* Centre performance — one table per wing */}
          <Section title="Centre Performance · this month">
            <WingColumns render={w => <CentreTable wing={w} rows={view[w].centres} />} />
          </Section>
        </>
      )}

      {followUp && <FollowUpModal {...followUp} defaultMessage={followUp.message} onClose={() => setFollowUp(null)} />}
    </div>
  );
}

type MonthPoints = ReturnType<typeof trend>;
interface WingView {
  sum: WingSummary;
  dues: ReturnType<typeof pendingDues>["dues"];
  unmarked: ReturnType<typeof unmarkedToday>;
  months: MonthPoints;
  centres: ReturnType<typeof centreRows>;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const card: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "14px 16px" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "6px 0 10px" }}>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>{title}</span>
        <span aria-hidden style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
      </div>
      {children}
    </section>
  );
}

/** Two parallel columns — Wing 1 (ROL+) left, Wing 2 (School of Music) right; stacks on narrow screens. */
function WingColumns({ render }: { render: (w: Wing) => React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12, marginBottom: 18, alignItems: "start" }}>
      {BOTH.map(w => <div key={w} style={{ minWidth: 0 }}>{render(w)}</div>)}
    </div>
  );
}

function WingPill({ w }: { w: Wing }) {
  return <span style={{ fontSize: 10.5, fontWeight: 800, borderRadius: 6, padding: "1px 7px", color: WING_TINT[w].fg, background: WING_TINT[w].bg, whiteSpace: "nowrap" }}>{WING_NAME[w]}</span>;
}

/** Top KPI card for one wing: active students, revenue, pending, turnout. */
function WingKpiCard({ wing, s, onAlertPending }: { wing: Wing; s: WingSummary; onAlertPending: () => void }) {
  const t = WING_TINT[wing];
  const stat = (label: string, value: React.ReactNode, sub?: React.ReactNode, color?: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-muted)" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 900, color: color ?? "var(--color-text-primary)", lineHeight: 1.2, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
  const delta = s.revenueDelta;
  return (
    <div style={{ ...card, borderColor: t.border, background: `linear-gradient(180deg, ${t.bg}, var(--color-surface) 65%)` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 10, marginBottom: 12, borderBottom: `1px solid ${t.border}` }}>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: t.fg }}>{WING_NAME[wing]}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: t.fg, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 999, padding: "2px 10px" }}>
          {s.activeStudents} active · {s.activeCentres} centre{s.activeCentres !== 1 ? "s" : ""}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        {stat("Revenue · month", inrK(s.revenue),
          delta === null ? `Last month ${inrK(s.revenuePrev)}`
            : <span style={{ color: delta >= 0 ? "var(--color-success)" : "var(--color-danger)", fontWeight: 700 }}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}% vs last</span>)}
        {stat("Pending", inrK(s.pending), `${s.pendingCount} student${s.pendingCount !== 1 ? "s" : ""}`, s.pending > 0 ? "#b45309" : undefined)}
        {stat("Turnout · month", pct(s.turnout), "present ÷ marked", s.turnout !== null && s.turnout < 60 ? "#b45309" : "var(--color-success)")}
      </div>
      {s.pending > 0 && (
        <button onClick={onAlertPending}
          style={{ marginTop: 12, width: "100%", padding: "7px 10px", borderRadius: 9, border: "1px solid #fcd34d", background: "#fff", color: "#92400e", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>
          📣 Alert {WING_SHORT[wing]} wing admin about pending fees
        </button>
      )}
    </div>
  );
}

function WingCard({ wing, s }: { wing: Wing; s: WingSummary }) {
  const rows: [string, string, string?][] = [
    ["Active centres", String(s.activeCentres)],
    ["Students per centre", s.density === null ? "—" : String(s.density)],
    ["Active students", String(s.activeStudents)],
    ["Revenue · month", inr(s.revenue), s.revenueDelta === null ? undefined : `${s.revenueDelta >= 0 ? "+" : "−"}${Math.abs(s.revenueDelta)}% vs last`],
    ["Overdue ratio", pct(s.overdueRatio), `${inr(s.pending)} pending`],
    ["Turnout · month", pct(s.turnout)],
    ["Attendance marked · 7 days", pct(s.compliance.pct), `${s.compliance.marked} of ${s.compliance.expected} class slots`],
    ["Fees collected (of this month's dues)", pct(s.collectionRate), s.daysToPay === null ? undefined : `median ${s.daysToPay} day${s.daysToPay !== 1 ? "s" : ""} to pay`],
  ];
  return (
    <div style={{ ...card, borderTop: `3px solid ${WING_TINT[wing].line}` }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "var(--color-text-primary)", marginBottom: 8 }}>{WING_NAME[wing]}</div>
      {rows.map(([k, v, sub]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderTop: "1px solid var(--color-border)", fontSize: 13 }}>
          <span style={{ color: "var(--color-text-secondary)" }}>{k}</span>
          <span style={{ textAlign: "right" }}>
            <b style={{ color: "var(--color-text-primary)" }}>{v}</b>
            {sub && <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{sub}</div>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, wing, count, empty, children }: { title: string; wing: Wing; count: number; empty: string; children: React.ReactNode }) {
  const hasItems = Array.isArray(children) ? children.flat().some(Boolean) : !!children;
  return (
    <div style={{ ...card, borderTop: `3px solid ${WING_TINT[wing].line}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <WingPill w={wing} />
        <span style={{ fontSize: 14, fontWeight: 800, color: "var(--color-text-primary)" }}>{title}</span>
        {count > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: "#92400e", background: "#fef3c7", borderRadius: 99, padding: "1px 8px" }}>{count}</span>}
      </div>
      {hasItems ? children : <div style={{ fontSize: 13, color: "var(--color-text-muted)", padding: "10px 0" }}>{empty}</div>}
    </div>
  );
}

function Row({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 0", borderTop: "1px solid var(--color-border)", fontSize: 13, color: "var(--color-text-primary)" }}>
      <div style={{ minWidth: 0 }}>{left}</div>
      <div style={{ flexShrink: 0 }}>{right}</div>
    </div>
  );
}

function SmallBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-primary)", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
      {children}
    </button>
  );
}

/** Growth & fall — both wings on one chart (one line each), plus per-wing rows. Never summed. */
function DualTrend({ series }: { series: Record<Wing, MonthPoints> }) {
  const months = series[BOTH[0]];
  const W = 640, H = 170, padL = 52, padR = 16, padT = 14, padB = 26;
  const maxRev = Math.max(1, ...BOTH.flatMap(w => series[w].map(m => m.revenue)));
  const x = (i: number) => padL + (months.length <= 1 ? 0 : (i * (W - padL - padR)) / (months.length - 1));
  const y = (v: number) => padT + (1 - v / maxRev) * (H - padT - padB);
  const ticks = [0, 0.5, 1].map(f => Math.round(maxRev * f));
  return (
    <div style={{ ...card, overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--color-text-primary)" }}>Revenue by month</span>
        {BOTH.map(w => (
          <span key={w} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-secondary)" }}>
            <span aria-hidden style={{ width: 18, height: 3, borderRadius: 2, background: WING_TINT[w].line }} />{WING_NAME[w]}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly revenue, Wing 1 and Wing 2" style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeDasharray={t === 0 ? undefined : "3 4"} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--color-text-muted)">{inrK(t)}</text>
          </g>
        ))}
        {months.map((m, i) => (
          <text key={m.ym} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--color-text-secondary)">{m.label}</text>
        ))}
        {BOTH.map(w => (
          <g key={w}>
            <polyline fill="none" stroke={WING_TINT[w].line} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
              points={series[w].map((m, i) => `${x(i)},${y(m.revenue)}`).join(" ")} />
            {series[w].map((m, i) => (
              <circle key={m.ym} cx={x(i)} cy={y(m.revenue)} r="3.5" fill="var(--color-surface)" stroke={WING_TINT[w].line} strokeWidth="2">
                <title>{`${WING_SHORT[w]} · ${m.label}: ${inr(m.revenue)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>

      {/* Per-wing rows: revenue, admissions vs drop-outs, turnout */}
      <div style={{ display: "grid", gridTemplateColumns: `170px repeat(${months.length}, minmax(70px, 1fr))`, gap: "6px 8px", minWidth: 640, fontSize: 12.5, marginTop: 12 }}>
        <span />
        {months.map(m => <span key={m.ym} style={{ fontWeight: 800, color: "var(--color-text-secondary)", textAlign: "center" }}>{m.label}</span>)}
        {BOTH.map(w => (
          <Fragment key={w}>
            <span style={{ gridColumn: "1 / -1", marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--color-border)" }}><WingPill w={w} /></span>
            <span style={{ color: "var(--color-text-secondary)" }}>Revenue</span>
            {series[w].map(m => <span key={m.ym} style={{ textAlign: "center", fontWeight: 700, color: "var(--color-text-primary)" }}>{inrK(m.revenue)}</span>)}
            <span style={{ color: "var(--color-text-secondary)" }}>New · left</span>
            {series[w].map(m => (
              <span key={m.ym} title={`${m.admissions} new · ${m.dropouts} left`} style={{ textAlign: "center" }}>
                <b style={{ color: "#16a34a" }}>+{m.admissions}</b> <b style={{ color: "#b45309" }}>−{m.dropouts}</b>
              </span>
            ))}
            <span style={{ color: "var(--color-text-secondary)" }}>Turnout</span>
            {series[w].map(m => <span key={m.ym} style={{ textAlign: "center", fontWeight: 700, color: "var(--color-text-primary)" }}>{pct(m.turnout)}</span>)}
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 10 }}>
        New = admission date in the month. Left = marked inactive in the month (recorded since late Sep 2026, so earlier months read 0).
      </div>
    </div>
  );
}

function CentreTable({ wing, rows }: { wing: Wing; rows: ReturnType<typeof centreRows> }) {
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", whiteSpace: "nowrap" };
  const flag = (v: number | null, warn: number) => (v !== null && v < warn ? { color: "#b45309", fontWeight: 800 } : {});
  return (
    <div style={{ ...card, padding: 0, overflowX: "auto", borderTop: `3px solid ${WING_TINT[wing].line}` }}>
      <div style={{ padding: "10px 10px 4px" }}><WingPill w={wing} /></div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Centre</th>
            <th style={{ ...th, textAlign: "right" }}>Students</th>
            <th style={{ ...th, textAlign: "right" }}>Revenue</th>
            <th style={{ ...th, textAlign: "right" }}>Pending</th>
            <th style={{ ...th, textAlign: "right" }}>Turnout</th>
            <th style={{ ...th, textAlign: "right" }} title="Class slots marked in the last 7 days">Marked · 7d</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td style={td} colSpan={6}>No active centres.</td></tr>}
          {rows.map(r => (
            <tr key={r.id}>
              <td style={td}>{r.name}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.students}</td>
              <td style={{ ...td, textAlign: "right" }}>{inr(r.revenue)}</td>
              <td style={{ ...td, textAlign: "right", ...(r.pending > 0 ? { color: "#b45309" } : {}) }}>{r.pending > 0 ? inr(r.pending) : "—"}</td>
              <td style={{ ...td, textAlign: "right", ...flag(r.turnout, 60) }}>{pct(r.turnout)}</td>
              <td style={{ ...td, textAlign: "right", ...flag(r.compliance, 70) }}>{pct(r.compliance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
