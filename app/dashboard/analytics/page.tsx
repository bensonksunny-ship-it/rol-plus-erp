"use client";

/**
 * Analytics — Year-wise and Month-wise History
 *
 * Three views:
 *  1. Finance    — monthly/yearly revenue, payments, deposits
 *  2. Students   — enrollment trend (year/month), active vs inactive
 *  3. Attendance — monthly attendance %, per-centre breakdown
 *
 * Access: Super Admin + Admin
 */

import { useState, useEffect, useMemo } from "react";
import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";

// ─── Types ────────────────────────────────────────────────────────────────────

type AnalyticsTab = "finance" | "students" | "attendance";

interface TxRecord {
  id:         string;
  studentUid: string;
  centerId:   string;
  amount:     number;
  type:       string;   // "payment" | "deposit" | "adjustment" | "auto-monthly" etc.
  status:     string;
  createdAt:  string;   // ISO
  backdated?: boolean;
}

interface StudentRecord {
  uid:        string;
  name:       string;
  centerId:   string;
  createdAt:  string;   // ISO
  status:     string;   // "active" | "inactive"
  studentStatus: string;
}

interface AttRecord {
  id:        string;
  centerId:  string;
  date:      string;   // YYYY-MM-DD
  present:   boolean;
  backdated?: boolean;
}

interface CenterOption {
  id:   string;
  name: string;
  code: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoToYearMonth(iso: string): string {
  // Handles Firestore Timestamps converted to string or standard ISO strings
  if (!iso) return "0000-00";
  // Firestore serverTimestamp comes as object but getDocs returns it as Timestamp
  // After .toDate().toISOString() or plain iso string
  const s = String(iso);
  if (s.length >= 7) return s.slice(0, 7); // "YYYY-MM"
  return "0000-00";
}

function isoToYear(iso: string): string {
  return String(iso).slice(0, 4);
}

function monthLabel(ym: string): string {
  if (!ym || ym === "0000-00") return ym;
  const [y, m] = ym.split("-");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[parseInt(m,10)-1] ?? m} ${y}`;
}

function sortedKeys<T extends Record<string, unknown>>(obj: T): string[] {
  return Object.keys(obj).sort();
}

function pct(num: number, den: number): string {
  if (den === 0) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

// Color scale for bar fill — amber theme
function barColor(val: number, max: number): string {
  if (max === 0) return "#fde68a";
  const ratio = val / max;
  if (ratio > 0.75) return "#b45309";
  if (ratio > 0.5)  return "#d97706";
  if (ratio > 0.25) return "#f59e0b";
  return "#fde68a";
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <AnalyticsContent />
    </ProtectedRoute>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function AnalyticsContent() {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>("finance");
  const [centers,   setCenters]   = useState<CenterOption[]>([]);
  const [loading,   setLoading]   = useState(true);

  // Raw data stores
  const [transactions, setTransactions] = useState<TxRecord[]>([]);
  const [students,     setStudents]     = useState<StudentRecord[]>([]);
  const [attendance,   setAttendance]   = useState<AttRecord[]>([]);

  // Filters
  const [filterCenter, setFilterCenter] = useState<string>("all");
  const [filterYear,   setFilterYear]   = useState<string>("all");
  const [groupBy,      setGroupBy]      = useState<"month" | "year">("month");

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [txSnap, studSnap, attSnap, ctrSnap] = await Promise.all([
        getDocs(collection(db, "transactions")),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "attendance")),
        getDocs(collection(db, "centers")),
      ]);

      const ctrs: CenterOption[] = ctrSnap.docs.map(d => ({
        id:   d.id,
        name: (d.data().name as string) || d.id,
        code: (d.data().centerCode as string) || "",
      }));
      setCenters(ctrs);

      // Parse transactions — handle Firestore Timestamp objects
      const txs: TxRecord[] = txSnap.docs.map(d => {
        const data = d.data();
        // Firestore Timestamp → ISO string
        let createdAt = "";
        if (data.createdAt && typeof data.createdAt === "object" && "toDate" in data.createdAt) {
          createdAt = (data.createdAt as { toDate(): Date }).toDate().toISOString();
        } else if (typeof data.createdAt === "string") {
          createdAt = data.createdAt;
        } else if (data.paidAt && typeof data.paidAt === "object" && "toDate" in data.paidAt) {
          createdAt = (data.paidAt as { toDate(): Date }).toDate().toISOString();
        }
        return {
          id:         d.id,
          studentUid: (data.studentUid as string) || "",
          centerId:   (data.centerId as string) || "",
          amount:     (data.amount as number) ?? 0,
          type:       (data.type as string) || "payment",
          status:     (data.status as string) || "completed",
          createdAt,
          backdated:  (data.backdated as boolean) || false,
        };
      });
      setTransactions(txs);

      // Parse students
      const studs: StudentRecord[] = studSnap.docs.map(d => {
        const data = d.data();
        let createdAt = "";
        if (typeof data.createdAt === "string") {
          createdAt = data.createdAt;
        }
        return {
          uid:          d.id,
          name:         (data.displayName as string) || "",
          centerId:     (data.centerId as string) || "",
          createdAt,
          status:       (data.status as string) || "active",
          studentStatus: (data.studentStatus as string) || "active",
        };
      });
      setStudents(studs);

      // Parse attendance
      const atts: AttRecord[] = attSnap.docs.map(d => {
        const data = d.data();
        return {
          id:        d.id,
          centerId:  (data.centerId as string) || "",
          date:      (data.date as string) || "",
          present:   (data.present as boolean) ?? false,
          backdated: (data.backdated as boolean) || false,
        };
      });
      setAttendance(atts);

      setLoading(false);
    }
    load();
  }, []);

  // Derive available years across all data
  const availableYears = useMemo(() => {
    const years = new Set<string>();
    transactions.forEach(t => { const y = isoToYear(t.createdAt); if (y !== "0000") years.add(y); });
    students.forEach(s => { const y = isoToYear(s.createdAt); if (y !== "0000") years.add(y); });
    attendance.forEach(a => { const y = isoToYear(a.date); if (y !== "0000") years.add(y); });
    return Array.from(years).sort().reverse();
  }, [transactions, students, attendance]);

  if (loading) return <div style={s.loadingFull}>Loading analytics…</div>;

  const sharedFilterProps = { filterCenter, filterYear, groupBy, centers, availableYears };
  const setters = {
    setFilterCenter,
    setFilterYear,
    setGroupBy,
  };

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>📊 Analytics & History</h1>
          <p style={s.subtitle}>Year-wise and month-wise trends across finance, students, and attendance</p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {(["finance","students","attendance"] as AnalyticsTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{ ...s.tabBtn, ...(activeTab === tab ? s.tabBtnActive : {}) }}
          >
            {tab === "finance"    && "₹ Finance"}
            {tab === "students"   && "🎓 Students"}
            {tab === "attendance" && "✓ Attendance"}
          </button>
        ))}
      </div>

      {/* Global filters */}
      <div style={s.filterBar}>
        <div style={s.filterGroup}>
          <label style={s.filterLabel}>Centre</label>
          <select style={s.filterSelect} value={filterCenter} onChange={e => setFilterCenter(e.target.value)}>
            <option value="all">All Centres</option>
            {centers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={s.filterGroup}>
          <label style={s.filterLabel}>Year</label>
          <select style={s.filterSelect} value={filterYear} onChange={e => setFilterYear(e.target.value)}>
            <option value="all">All Years</option>
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div style={s.filterGroup}>
          <label style={s.filterLabel}>Group By</label>
          <div style={s.chipRow}>
            {(["month","year"] as const).map(g => (
              <button key={g} onClick={() => setGroupBy(g)}
                style={{ ...s.chip, ...(groupBy === g ? s.chipActive : {}) }}>
                {g === "month" ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "finance"    && (
        <FinanceAnalytics
          transactions={transactions}
          filterCenter={filterCenter}
          filterYear={filterYear}
          groupBy={groupBy}
        />
      )}
      {activeTab === "students"   && (
        <StudentsAnalytics
          students={students}
          filterCenter={filterCenter}
          filterYear={filterYear}
          groupBy={groupBy}
        />
      )}
      {activeTab === "attendance" && (
        <AttendanceAnalytics
          attendance={attendance}
          centers={centers}
          filterCenter={filterCenter}
          filterYear={filterYear}
          groupBy={groupBy}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINANCE ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

function FinanceAnalytics({
  transactions,
  filterCenter,
  filterYear,
  groupBy,
}: {
  transactions: TxRecord[];
  filterCenter: string;
  filterYear:   string;
  groupBy:      "month" | "year";
}) {
  const filtered = useMemo(() => transactions.filter(t => {
    if (t.status !== "completed") return false;
    if (filterCenter !== "all" && t.centerId !== filterCenter) return false;
    if (filterYear !== "all" && isoToYear(t.createdAt) !== filterYear) return false;
    return true;
  }), [transactions, filterCenter, filterYear]);

  // Group by period
  interface PeriodData {
    period:     string;
    revenue:    number;   // payments
    deposits:   number;
    adjustments: number;
    count:      number;
    backdated:  number;   // count of backdated entries
  }

  const grouped = useMemo(() => {
    const map: Record<string, PeriodData> = {};
    filtered.forEach(t => {
      const period = groupBy === "month" ? isoToYearMonth(t.createdAt) : isoToYear(t.createdAt);
      if (period === "0000-00" || period === "0000") return;
      if (!map[period]) map[period] = { period, revenue: 0, deposits: 0, adjustments: 0, count: 0, backdated: 0 };
      const d = map[period];
      d.count++;
      if (t.backdated) d.backdated++;
      if (t.type === "payment" || t.type === "auto" || t.type === "auto-monthly") {
        d.revenue += t.amount;
      } else if (t.type === "deposit") {
        d.deposits += t.amount;
      } else if (t.type === "adjustment") {
        d.adjustments += t.amount;
      } else {
        d.revenue += t.amount; // fallback
      }
    });
    return sortedKeys(map).map(k => map[k]);
  }, [filtered, groupBy]);

  const maxRevenue = useMemo(() => Math.max(...grouped.map(g => g.revenue), 1), [grouped]);

  const totals = useMemo(() => ({
    revenue:     grouped.reduce((a, g) => a + g.revenue, 0),
    deposits:    grouped.reduce((a, g) => a + g.deposits, 0),
    adjustments: grouped.reduce((a, g) => a + g.adjustments, 0),
    count:       grouped.reduce((a, g) => a + g.count, 0),
  }), [grouped]);

  return (
    <div style={s.analyticsSection}>
      {/* Summary KPIs */}
      <div style={s.kpiRow}>
        <KpiBox label="Total Revenue" value={`₹${totals.revenue.toLocaleString("en-IN")}`} color="#16a34a" />
        <KpiBox label="Total Deposits" value={`₹${totals.deposits.toLocaleString("en-IN")}`} color="#b45309" />
        <KpiBox label="Adjustments" value={`₹${totals.adjustments.toLocaleString("en-IN")}`} color="#6b7280" />
        <KpiBox label="Transactions" value={String(totals.count)} color="#1d4ed8" />
      </div>

      {grouped.length === 0 && <EmptyState msg="No financial data for the selected filters." />}

      {grouped.length > 0 && (
        <>
          {/* Bar chart */}
          <div style={s.chartTitle}>Revenue Trend</div>
          <div style={s.barChart}>
            {grouped.map(g => (
              <div key={g.period} style={s.barCol}>
                <span style={s.barVal}>₹{(g.revenue/1000).toFixed(1)}k</span>
                <div style={{
                  ...s.bar,
                  height: `${Math.max(4, (g.revenue / maxRevenue) * 120)}px`,
                  background: barColor(g.revenue, maxRevenue),
                }} title={`₹${g.revenue.toLocaleString("en-IN")}`} />
                <span style={s.barLabel}>
                  {groupBy === "month" ? monthLabel(g.period).replace(" ", "\n") : g.period}
                </span>
              </div>
            ))}
          </div>

          {/* Table */}
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Period</th>
                  <th style={s.th}>Revenue</th>
                  <th style={s.th}>Deposits</th>
                  <th style={s.th}>Adjustments</th>
                  <th style={s.th}>Transactions</th>
                  <th style={s.th}>Backdated</th>
                </tr>
              </thead>
              <tbody>
                {[...grouped].reverse().map(g => (
                  <tr key={g.period} style={s.tr}>
                    <td style={{ ...s.td, fontWeight: 600 }}>
                      {groupBy === "month" ? monthLabel(g.period) : g.period}
                    </td>
                    <td style={{ ...s.td, color: "#16a34a", fontWeight: 600 }}>
                      ₹{g.revenue.toLocaleString("en-IN")}
                    </td>
                    <td style={s.td}>₹{g.deposits.toLocaleString("en-IN")}</td>
                    <td style={s.td}>₹{g.adjustments.toLocaleString("en-IN")}</td>
                    <td style={s.td}>{g.count}</td>
                    <td style={s.td}>
                      {g.backdated > 0 ? (
                        <span style={s.backdatedBadge}>📅 {g.backdated}</span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENTS ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

function StudentsAnalytics({
  students,
  filterCenter,
  filterYear,
  groupBy,
}: {
  students:    StudentRecord[];
  filterCenter: string;
  filterYear:   string;
  groupBy:      "month" | "year";
}) {
  const filtered = useMemo(() => students.filter(s => {
    if (filterCenter !== "all" && s.centerId !== filterCenter) return false;
    if (filterYear !== "all" && isoToYear(s.createdAt) !== filterYear) return false;
    return true;
  }), [students, filterCenter, filterYear]);

  interface PeriodData {
    period:   string;
    enrolled: number;
    active:   number;
    inactive: number;
  }

  const grouped = useMemo(() => {
    const map: Record<string, PeriodData> = {};
    filtered.forEach(st => {
      const period = groupBy === "month" ? isoToYearMonth(st.createdAt) : isoToYear(st.createdAt);
      if (!period || period === "0000-00" || period === "0000") return;
      if (!map[period]) map[period] = { period, enrolled: 0, active: 0, inactive: 0 };
      map[period].enrolled++;
      if (st.status === "active") map[period].active++;
      else map[period].inactive++;
    });
    return sortedKeys(map).map(k => map[k]);
  }, [filtered, groupBy]);

  const maxEnrolled = useMemo(() => Math.max(...grouped.map(g => g.enrolled), 1), [grouped]);

  const totals = useMemo(() => ({
    enrolled: filtered.length,
    active:   filtered.filter(s => s.status === "active").length,
    inactive: filtered.filter(s => s.status !== "active").length,
  }), [filtered]);

  // Cumulative running total
  const cumulative = useMemo(() => {
    let running = 0;
    return grouped.map(g => { running += g.enrolled; return { ...g, running }; });
  }, [grouped]);

  return (
    <div style={s.analyticsSection}>
      <div style={s.kpiRow}>
        <KpiBox label="Total Enrolled" value={String(totals.enrolled)} color="#b45309" />
        <KpiBox label="Currently Active" value={String(totals.active)} color="#16a34a" />
        <KpiBox label="Inactive / Left" value={String(totals.inactive)} color="#dc2626" />
      </div>

      {grouped.length === 0 && <EmptyState msg="No student enrollment data for the selected filters." />}

      {grouped.length > 0 && (
        <>
          <div style={s.chartTitle}>Enrollment Trend (new students per period)</div>
          <div style={s.barChart}>
            {cumulative.map(g => (
              <div key={g.period} style={s.barCol}>
                <span style={s.barVal}>{g.enrolled}</span>
                <div style={{
                  ...s.bar,
                  height: `${Math.max(4, (g.enrolled / maxEnrolled) * 120)}px`,
                  background: barColor(g.enrolled, maxEnrolled),
                }} />
                <span style={s.barLabel}>
                  {groupBy === "month" ? monthLabel(g.period).replace(" ", "\n") : g.period}
                </span>
              </div>
            ))}
          </div>

          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Period</th>
                  <th style={s.th}>New Enrollments</th>
                  <th style={s.th}>Active</th>
                  <th style={s.th}>Inactive</th>
                  <th style={s.th}>Running Total</th>
                </tr>
              </thead>
              <tbody>
                {[...cumulative].reverse().map(g => (
                  <tr key={g.period} style={s.tr}>
                    <td style={{ ...s.td, fontWeight: 600 }}>
                      {groupBy === "month" ? monthLabel(g.period) : g.period}
                    </td>
                    <td style={{ ...s.td, color: "#b45309", fontWeight: 600 }}>{g.enrolled}</td>
                    <td style={{ ...s.td, color: "#16a34a" }}>{g.active}</td>
                    <td style={{ ...s.td, color: "#dc2626" }}>{g.inactive}</td>
                    <td style={s.td}>{g.running}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDANCE ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

function AttendanceAnalytics({
  attendance,
  centers,
  filterCenter,
  filterYear,
  groupBy,
}: {
  attendance:   AttRecord[];
  centers:      CenterOption[];
  filterCenter: string;
  filterYear:   string;
  groupBy:      "month" | "year";
}) {
  const filtered = useMemo(() => attendance.filter(a => {
    if (filterCenter !== "all" && a.centerId !== filterCenter) return false;
    if (filterYear !== "all" && isoToYear(a.date) !== filterYear) return false;
    return true;
  }), [attendance, filterCenter, filterYear]);

  const centerMap = useMemo(() => {
    const m: Record<string, string> = {};
    centers.forEach(c => { m[c.id] = c.name; });
    return m;
  }, [centers]);

  interface PeriodData {
    period:  string;
    total:   number;
    present: number;
    absent:  number;
  }

  const grouped = useMemo(() => {
    const map: Record<string, PeriodData> = {};
    filtered.forEach(a => {
      const period = groupBy === "month" ? a.date.slice(0, 7) : a.date.slice(0, 4);
      if (!period) return;
      if (!map[period]) map[period] = { period, total: 0, present: 0, absent: 0 };
      map[period].total++;
      if (a.present) map[period].present++;
      else map[period].absent++;
    });
    return sortedKeys(map).map(k => map[k]);
  }, [filtered, groupBy]);

  // Per-centre breakdown (for non-filtered or all view)
  const centerBreakdown = useMemo(() => {
    const map: Record<string, { total: number; present: number }> = {};
    attendance.filter(a => {
      if (filterYear !== "all" && isoToYear(a.date) !== filterYear) return false;
      return true;
    }).forEach(a => {
      if (!map[a.centerId]) map[a.centerId] = { total: 0, present: 0 };
      map[a.centerId].total++;
      if (a.present) map[a.centerId].present++;
    });
    return Object.entries(map).map(([cid, v]) => ({
      centerId: cid,
      name:     centerMap[cid] || cid,
      ...v,
      pct:      v.total > 0 ? Math.round((v.present / v.total) * 100) : 0,
    })).sort((a, b) => b.pct - a.pct);
  }, [attendance, filterYear, centerMap]);

  const overall = useMemo(() => ({
    total:   filtered.length,
    present: filtered.filter(a => a.present).length,
  }), [filtered]);

  return (
    <div style={s.analyticsSection}>
      <div style={s.kpiRow}>
        <KpiBox label="Total Sessions" value={String(overall.total)} color="#b45309" />
        <KpiBox label="Present" value={String(overall.present)} color="#16a34a" />
        <KpiBox label="Absent" value={String(overall.total - overall.present)} color="#dc2626" />
        <KpiBox label="Overall %" value={pct(overall.present, overall.total)} color="#1d4ed8" />
      </div>

      {grouped.length === 0 && <EmptyState msg="No attendance data for the selected filters." />}

      {grouped.length > 0 && (
        <>
          <div style={s.chartTitle}>Attendance % Trend</div>
          <div style={s.barChart}>
            {grouped.map(g => {
              const attPct = g.total > 0 ? Math.round((g.present / g.total) * 100) : 0;
              return (
                <div key={g.period} style={s.barCol}>
                  <span style={s.barVal}>{attPct}%</span>
                  <div style={{
                    ...s.bar,
                    height: `${Math.max(4, (attPct / 100) * 120)}px`,
                    background: attPct >= 75 ? "#16a34a" : attPct >= 50 ? "#f59e0b" : "#dc2626",
                  }} />
                  <span style={s.barLabel}>
                    {groupBy === "month" ? monthLabel(g.period).replace(" ", "\n") : g.period}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Period</th>
                  <th style={s.th}>Total Sessions</th>
                  <th style={s.th}>Present</th>
                  <th style={s.th}>Absent</th>
                  <th style={s.th}>Attendance %</th>
                </tr>
              </thead>
              <tbody>
                {[...grouped].reverse().map(g => {
                  const attPct = g.total > 0 ? Math.round((g.present / g.total) * 100) : 0;
                  return (
                    <tr key={g.period} style={s.tr}>
                      <td style={{ ...s.td, fontWeight: 600 }}>
                        {groupBy === "month" ? monthLabel(g.period) : g.period}
                      </td>
                      <td style={s.td}>{g.total}</td>
                      <td style={{ ...s.td, color: "#16a34a" }}>{g.present}</td>
                      <td style={{ ...s.td, color: "#dc2626" }}>{g.absent}</td>
                      <td style={s.td}>
                        <span style={{
                          ...s.pctBadge,
                          background: attPct >= 75 ? "#dcfce7" : attPct >= 50 ? "#fef9c3" : "#fee2e2",
                          color:      attPct >= 75 ? "#16a34a" : attPct >= 50 ? "#b45309" : "#dc2626",
                        }}>{attPct}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Centre-wise breakdown */}
      {filterCenter === "all" && centerBreakdown.length > 0 && (
        <>
          <div style={{ ...s.chartTitle, marginTop: 32 }}>Centre-wise Attendance Summary</div>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Centre</th>
                  <th style={s.th}>Total Sessions</th>
                  <th style={s.th}>Present</th>
                  <th style={s.th}>Attendance %</th>
                </tr>
              </thead>
              <tbody>
                {centerBreakdown.map(c => (
                  <tr key={c.centerId} style={s.tr}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{c.name}</td>
                    <td style={s.td}>{c.total}</td>
                    <td style={{ ...s.td, color: "#16a34a" }}>{c.present}</td>
                    <td style={s.td}>
                      <span style={{
                        ...s.pctBadge,
                        background: c.pct >= 75 ? "#dcfce7" : c.pct >= 50 ? "#fef9c3" : "#fee2e2",
                        color:      c.pct >= 75 ? "#16a34a" : c.pct >= 50 ? "#b45309" : "#dc2626",
                      }}>{c.pct}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function KpiBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={s.kpiBox}>
      <div style={{ ...s.kpiValue, color }}>{value}</div>
      <div style={s.kpiLabel}>{label}</div>
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <div style={s.emptyState}>{msg}</div>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "24px 20px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#111827",
  },
  header: {
    marginBottom: 24,
  },
  title: {
    margin: 0,
    fontSize: 22,
    fontWeight: 700,
  },
  subtitle: {
    margin: "4px 0 0",
    fontSize: 14,
    color: "#6b7280",
  },
  tabBar: {
    display: "flex",
    gap: 4,
    borderBottom: "2px solid #e5e7eb",
    marginBottom: 20,
  },
  tabBtn: {
    padding: "10px 20px",
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    color: "#6b7280",
    borderBottom: "2px solid transparent",
    marginBottom: -2,
    borderRadius: "4px 4px 0 0",
  },
  tabBtnActive: {
    color: "#b45309",
    borderBottomColor: "#b45309",
    background: "#fffbeb",
  },
  filterBar: {
    display: "flex",
    gap: 16,
    marginBottom: 24,
    flexWrap: "wrap",
    alignItems: "flex-end",
    padding: "14px 16px",
    background: "#f9fafb",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
  },
  filterGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  filterSelect: {
    padding: "7px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 7,
    fontSize: 13,
    background: "#fff",
  },
  chipRow: {
    display: "flex",
    gap: 6,
  },
  chip: {
    padding: "6px 12px",
    border: "1.5px solid #d1d5db",
    borderRadius: 20,
    background: "#f9fafb",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
  },
  chipActive: {
    background: "#fef3c7",
    borderColor: "#b45309",
    color: "#92400e",
  },
  analyticsSection: {
    paddingTop: 4,
  },
  kpiRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 12,
    marginBottom: 24,
  },
  kpiBox: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "14px 16px",
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: 800,
    lineHeight: 1.2,
  },
  kpiLabel: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 4,
  },
  chartTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#374151",
    marginBottom: 12,
  },
  barChart: {
    display: "flex",
    gap: 6,
    alignItems: "flex-end",
    overflowX: "auto",
    paddingBottom: 4,
    marginBottom: 24,
    borderBottom: "1px solid #e5e7eb",
    paddingTop: 8,
    minHeight: 170,
  },
  barCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    minWidth: 48,
    gap: 2,
  },
  barVal: {
    fontSize: 10,
    color: "#6b7280",
    whiteSpace: "nowrap",
  },
  bar: {
    width: 36,
    borderRadius: "4px 4px 0 0",
    transition: "height 0.3s",
  },
  barLabel: {
    fontSize: 10,
    color: "#6b7280",
    textAlign: "center",
    whiteSpace: "pre-line",
    lineHeight: 1.2,
  },
  tableWrap: {
    overflowX: "auto",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 14,
  },
  th: {
    padding: "10px 14px",
    background: "#f9fafb",
    fontWeight: 600,
    textAlign: "left",
    fontSize: 12,
    color: "#374151",
    borderBottom: "1px solid #e5e7eb",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "10px 14px",
    borderBottom: "1px solid #f3f4f6",
    fontSize: 14,
    color: "#111827",
  },
  tr: {
    background: "#fff",
  },
  backdatedBadge: {
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: 6,
    padding: "2px 7px",
    fontSize: 12,
    fontWeight: 600,
  },
  pctBadge: {
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 700,
  },
  emptyState: {
    padding: "40px 0",
    textAlign: "center",
    color: "#9ca3af",
    fontSize: 14,
  },
  loadingFull: {
    padding: "60px 0",
    textAlign: "center",
    color: "#6b7280",
    fontSize: 15,
  },
};
