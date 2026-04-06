"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where, orderBy, limit, doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { getCenters } from "@/services/center/center.service";
import { getClassesByCenter } from "@/services/attendance/attendance.service";
import { getAllTeacherQuality } from "@/services/quality/quality.service";
import type { TeacherQuality } from "@/types/quality";
import type { Center } from "@/types";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface BasicStats {
  totalStudents:     number;
  studentsLast30:    number;
  studentsPrev30:    number;
  totalCenters:      number;
  attendancePresent: number;
  attendanceTotal:   number;
  pendingFees:       number;
}

interface AlertItem {
  id:        string;
  type:      string;
  severity:  "red" | "yellow";
  message:   string;
  createdAt: number;
}

interface StudentDoc {
  uid:            string;
  centerId:       string;
  status:         string;
  classType:      string;  // "group" | "personal"
  currentBalance: number;
  createdAt:      string;
}

interface TeacherDoc {
  uid:          string;
  displayName:  string;
  centerIds:    string[];
  status:       string;
}

interface AttendanceDoc {
  centerId:   string;
  studentUid: string;
  date:       string;
  status:     "present" | "absent";
}

interface TransactionDoc {
  studentUid: string;
  centerId:   string;
  amount:     number;
  date:       string;
  status:     string;
}

interface CenterRow {
  center:         Center;
  studentCount:   number;
  activeCount:    number;
  groupCount:     number;
  personalCount:  number;
  attendancePct:  number | null;
  teacherName:    string;
  pendingFeeCount:number;
  revenue30d:     number;
  growthPct:      number | null;
}

interface SystemData {
  students:     StudentDoc[];
  teachers:     TeacherDoc[];
  centers:      Center[];
  attendance:   AttendanceDoc[];
  transactions: TransactionDoc[];
  quality:      TeacherQuality[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(n: number): string { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
function isoMonthStart(offset = 0): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - offset);
  return d.toISOString().slice(0, 7);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE SHELL
// ═══════════════════════════════════════════════════════════════════════════════

export default function DashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT]}>
      <DashboardContent />
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const { user, loading: authLoading } = useAuthContext();
  const router = useRouter();

  useEffect(() => {
    if (authLoading) return;
    if (user?.role === ROLES.STUDENT) router.replace("/dashboard/student");
  }, [authLoading, user, router]);

  if (authLoading || !user || user.role === ROLES.STUDENT) return null;
  if (user.role === ROLES.SUPER_ADMIN) return <CommandCenter />;
  return <AdminDashboard />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN — COMMAND CENTER
// Layout: KPI strip → Alerts → Centre table → Teacher leaderboard → Revenue
// ═══════════════════════════════════════════════════════════════════════════════

function CommandCenter() {
  const router = useRouter();
  const [data,    setData]    = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const today     = isoToday();
  const days7ago  = isoDaysAgo(7);
  const days30ago = isoDaysAgo(30);
  const thisMonth = isoMonthStart(0);
  const lastMonth = isoMonthStart(1);

  useEffect(() => {
    async function load() {
      try {
        const [studentsSnap, teachersSnap, centersSnap, attSnap, txSnap, quality] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getCenters(),
          getDocs(query(collection(db, "attendance"), where("date", ">=", days7ago))),
          getDocs(collection(db, "transactions")),
          getAllTeacherQuality(),
        ]);
        setData({
          students:     studentsSnap.docs.map(d => ({ uid: d.id, ...d.data() } as StudentDoc)),
          teachers:     teachersSnap.docs.map(d => ({ uid: d.id, ...d.data() } as TeacherDoc)),
          centers:      centersSnap,
          attendance:   attSnap.docs.map(d => d.data() as AttendanceDoc),
          transactions: txSnap.docs.map(d => d.data() as TransactionDoc),
          quality,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load.");
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── All hooks BEFORE any early return ────────────────────────────────────────

  const students     = data?.students     ?? [];
  const teachers     = data?.teachers     ?? [];
  const centers      = data?.centers      ?? [];
  const attendance   = data?.attendance   ?? [];
  const transactions = data?.transactions ?? [];
  const quality      = data?.quality      ?? [];

  // KPI: students
  const totalStudents   = students.length;
  const activeStudents  = students.filter(s => s.status === "active").length;
  const groupStudents   = students.filter(s => s.classType === "group").length;
  const personalStudents = students.filter(s => s.classType === "personal").length;

  // KPI: attendance today
  const todayAtt     = attendance.filter(a => a.date === today);
  const todayPresent = todayAtt.filter(a => a.status === "present").length;
  const todayTotal   = todayAtt.length;
  const todayPct     = todayTotal > 0 ? Math.round((todayPresent / todayTotal) * 100) : null;

  // KPI: revenue this month
  const completedTx  = useMemo(() => transactions.filter(t => t.status === "completed"), [transactions]);
  const revThisMonth = useMemo(() => completedTx.filter(t => t.date?.startsWith(thisMonth)).reduce((s, t) => s + t.amount, 0), [completedTx, thisMonth]);
  const revLastMonth = useMemo(() => completedTx.filter(t => t.date?.startsWith(lastMonth)).reduce((s, t) => s + t.amount, 0), [completedTx, lastMonth]);
  const revGrowthPct = revLastMonth > 0 ? Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 100) : null;

  // KPI: pending fees
  const totalPendingFees   = useMemo(() => students.filter(s => s.currentBalance > 0).reduce((s, st) => s + st.currentBalance, 0), [students]);
  const pendingFeeStudents = students.filter(s => s.currentBalance > 0).length;

  // Centre rows
  const teacherNameMap = useMemo(() => Object.fromEntries(teachers.map(t => [t.uid, t.displayName])), [teachers]);

  const centreRows: CenterRow[] = useMemo(() => {
    const days60ago = isoDaysAgo(60);
    return centers.map(center => {
      const cStudents         = students.filter(s => s.centerId === center.id);
      const activeCount       = cStudents.filter(s => s.status === "active").length;
      const pendingFeeCount   = cStudents.filter(s => s.currentBalance > 0).length;
      const cGroupCount       = cStudents.filter(s => s.classType === "group").length;
      const cPersonalCount    = cStudents.filter(s => s.classType === "personal").length;
      const cAtt7d          = attendance.filter(a => a.centerId === center.id && a.date >= days7ago);
      const prs7d           = cAtt7d.filter(a => a.status === "present").length;
      const attPct          = cAtt7d.length > 0 ? Math.round((prs7d / cAtt7d.length) * 100) : null;
      const rev30           = completedTx.filter(t => t.centerId === center.id && t.date >= days30ago).reduce((s, t) => s + t.amount, 0);
      const withDate        = cStudents.filter(s => !!s.createdAt);
      let growthPct: number | null = null;
      if (withDate.length > 0) {
        const n = withDate.filter(s => s.createdAt >= days30ago).length;
        const p = withDate.filter(s => s.createdAt >= days60ago && s.createdAt < days30ago).length;
        growthPct = p > 0 ? Math.round(((n - p) / p) * 100) : n > 0 ? 100 : 0;
      }
      return {
        center, studentCount: cStudents.length, activeCount,
        groupCount: cGroupCount, personalCount: cPersonalCount,
        attendancePct: attPct, teacherName: teacherNameMap[center.teacherUid] ?? "—",
        pendingFeeCount, revenue30d: rev30, growthPct,
      };
    }).sort((a, b) => (b.attendancePct ?? -1) - (a.attendancePct ?? -1));
  }, [centers, students, attendance, completedTx, teacherNameMap, days7ago, days30ago]);

  // Teacher leaderboard
  const teacherPerf = useMemo(() => teachers.map(t => {
    const q = quality.find(q => q.teacherId === t.uid);
    return { uid: t.uid, name: t.displayName, score: q?.score ?? null, factors: q?.factors ?? null };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)), [teachers, quality]);

  // Revenue 7-day trend
  const revTrend = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const date  = isoDaysAgo(6 - i);
    const amt   = completedTx.filter(t => t.date === date).reduce((s, t) => s + t.amount, 0);
    const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short" });
    return { date, label, amt };
  }), [completedTx]);
  const maxRev = Math.max(...revTrend.map(d => d.amt), 1);

  // Alerts (priority issues)
  const alerts = useMemo(() => {
    const list: { icon: string; msg: string; level: "critical" | "warning" }[] = [];
    if (todayPct !== null && todayPct < 50)
      list.push({ icon: "📉", msg: `Attendance critically low today — ${todayPct}%`, level: "critical" });
    const lowAtt = centreRows.filter(c => c.attendancePct !== null && c.attendancePct < 60);
    if (lowAtt.length > 0)
      list.push({ icon: "🏫", msg: `Low attendance: ${lowAtt.map(c => c.center.name).join(", ")}`, level: "critical" });
    if (revGrowthPct !== null && revGrowthPct < -10)
      list.push({ icon: "💸", msg: `Revenue down ${Math.abs(revGrowthPct)}% vs last month`, level: "critical" });
    const pendingDeact = students.filter(s => s.status === "deactivation_requested").length;
    if (pendingDeact > 0)
      list.push({ icon: "🔔", msg: `${pendingDeact} deactivation request${pendingDeact > 1 ? "s" : ""} pending approval`, level: "warning" });
    const inactiveTeachers = teachers.filter(t => t.status !== "active").length;
    if (inactiveTeachers > 0)
      list.push({ icon: "👤", msg: `${inactiveTeachers} teacher${inactiveTeachers > 1 ? "s" : ""} marked inactive`, level: "warning" });
    if (totalPendingFees > 0)
      list.push({ icon: "💰", msg: `₹${totalPendingFees.toLocaleString("en-IN")} pending fees — ${pendingFeeStudents} students`, level: "warning" });
    return list;
  }, [todayPct, centreRows, revGrowthPct, students, teachers, totalPendingFees, pendingFeeStudents]);

  // ── Early returns AFTER all hooks ────────────────────────────────────────────
  if (loading) return (
    <div style={s.shell}>
      <div style={s.spinner} />
      <span style={s.loadingText}>Loading…</span>
    </div>
  );
  if (error) return <div style={s.errorShell}>⚠ {error}</div>;

  const attColor = todayPct === null ? "var(--color-text-muted)"
    : todayPct < 50  ? "var(--color-danger)"
    : todayPct < 75  ? "var(--color-warning)"
    : "var(--color-success)";

  const revColor = revGrowthPct === null ? "var(--color-text-muted)"
    : revGrowthPct < 0 ? "var(--color-danger)" : "var(--color-success)";

  return (
    <div style={s.page}>

      {/* ── HEADER ── */}
      <div style={s.header}>
        <div>
          <div style={s.eyebrow}>COMMAND CENTER</div>
          <div style={s.date}>
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
        </div>
        <div style={s.actions}>
          <button style={s.btn}    onClick={() => router.push("/dashboard/centers")}>+ Centre</button>
          <button style={s.btn}    onClick={() => router.push("/dashboard/students")}>+ Student</button>
          <button style={s.btnPri} onClick={() => router.push("/dashboard/finance")}>Finance →</button>
        </div>
      </div>

      {/* ── KPI STRIP ── */}
      <div style={s.kpiStrip}>

        <div style={s.kpi}>
          <div style={s.kpiLabel}>Students</div>
          <div style={s.kpiValue}>{totalStudents}</div>
          <div style={s.kpiSub}>{activeStudents} active · {groupStudents} group · {personalStudents} personal</div>
        </div>

        <div style={s.kpiDivider} />

        <div style={s.kpi}>
          <div style={s.kpiLabel}>Centres</div>
          <div style={s.kpiValue}>{centers.length}</div>
          <div style={s.kpiSub}>{centers.filter(c => c.status === "active").length} active</div>
        </div>

        <div style={s.kpiDivider} />

        <div style={s.kpi}>
          <div style={s.kpiLabel}>Attendance Today</div>
          <div style={{ ...s.kpiValue, color: attColor }}>
            {todayPct !== null ? `${todayPct}%` : "—"}
          </div>
          <div style={{ ...s.kpiSub, color: attColor }}>
            {todayTotal > 0 ? `${todayPresent} / ${todayTotal} present` : "No records yet"}
          </div>
        </div>

        <div style={s.kpiDivider} />

        <div style={s.kpi}>
          <div style={s.kpiLabel}>Revenue This Month</div>
          <div style={{ ...s.kpiValue, color: revColor }}>
            ₹{revThisMonth.toLocaleString("en-IN")}
          </div>
          <div style={{ ...s.kpiSub, color: revColor }}>
            {revGrowthPct !== null
              ? `${revGrowthPct >= 0 ? "▲" : "▼"} ${Math.abs(revGrowthPct)}% vs last month`
              : "No prior data"}
          </div>
        </div>

        <div style={s.kpiDivider} />

        <div style={s.kpi}>
          <div style={s.kpiLabel}>Pending Fees</div>
          <div style={{ ...s.kpiValue, color: totalPendingFees === 0 ? "var(--color-success)" : "var(--color-warning)" }}>
            {totalPendingFees === 0 ? "All Clear" : `₹${totalPendingFees.toLocaleString("en-IN")}`}
          </div>
          <div style={s.kpiSub}>
            {totalPendingFees === 0 ? "All fees collected" : `${pendingFeeStudents} students pending`}
          </div>
        </div>

      </div>

      {/* ── PRIORITY ALERTS ── */}
      {alerts.length > 0 && (
        <div style={s.alertsBox}>
          <div style={s.alertsHeader}>
            <span style={s.alertsTitle}>Needs Attention</span>
            <span style={s.alertsCount}>{alerts.length}</span>
          </div>
          <div style={s.alertsList}>
            {alerts.map((a, i) => (
              <div key={i} style={s.alertRow}>
                <span style={{ ...s.alertDot, background: a.level === "critical" ? "var(--color-danger)" : "var(--color-warning)" }} />
                <span style={s.alertIcon}>{a.icon}</span>
                <span style={s.alertMsg}>{a.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {alerts.length === 0 && (
        <div style={s.allClear}>✓ Everything looks healthy — no issues right now.</div>
      )}

      {/* ── CENTRE PERFORMANCE ── */}
      <div style={s.section}>
        <div style={s.sectionHeader}>
          <span style={s.sectionTitle}>Centre Performance</span>
          <span style={s.sectionSub}>7-day attendance · ranked</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={s.table}>
            <thead>
              <tr>
                {["Centre", "Teacher", "7d Att%", "Students", "Growth", "Pending Fees", "Rev (30d)"].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {centreRows.map((row, i) => {
                const ac = row.attendancePct === null ? "var(--color-text-muted)"
                  : row.attendancePct < 60  ? "var(--color-danger)"
                  : row.attendancePct < 80  ? "var(--color-warning)"
                  : "var(--color-success)";
                return (
                  <tr key={row.center.id} style={s.tr}>
                    <td style={{ ...s.td, fontWeight: 700, color: "var(--color-text-primary)" }}>
                      <span style={s.rank}>#{i + 1}</span> {row.center.name}
                    </td>
                    <td style={s.td}>{row.teacherName}</td>
                    <td style={{ ...s.td, textAlign: "center" }}>
                      <span style={{ fontWeight: 700, color: ac }}>
                        {row.attendancePct !== null ? `${row.attendancePct}%` : "—"}
                      </span>
                    </td>
                    <td style={{ ...s.td, textAlign: "center" }}>
                      <div style={{ fontWeight: 700 }}>{row.studentCount}</div>
                      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                        👥{row.groupCount} · 👤{row.personalCount}
                      </div>
                    </td>
                    <td style={{ ...s.td, textAlign: "center" }}>
                      {row.growthPct === null
                        ? <span style={{ color: "var(--color-text-muted)" }}>—</span>
                        : <span style={{ fontWeight: 700, color: row.growthPct > 0 ? "var(--color-success)" : row.growthPct < 0 ? "var(--color-danger)" : "var(--color-text-muted)" }}>
                            {row.growthPct > 0 ? "▲" : row.growthPct < 0 ? "▼" : ""}{Math.abs(row.growthPct)}%
                          </span>
                      }
                    </td>
                    <td style={{ ...s.td, textAlign: "center" }}>
                      <span style={{ color: row.pendingFeeCount > 0 ? "var(--color-warning)" : "var(--color-success)" }}>
                        {row.pendingFeeCount > 0 ? `${row.pendingFeeCount} students` : "None"}
                      </span>
                    </td>
                    <td style={{ ...s.td, textAlign: "right" }}>₹{row.revenue30d.toLocaleString("en-IN")}</td>
                  </tr>
                );
              })}
              {centreRows.length === 0 && (
                <tr><td colSpan={7} style={{ ...s.td, textAlign: "center", color: "var(--color-text-muted)", padding: "24px" }}>No centres found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── TEACHER LEADERBOARD ── */}
      <div style={s.twoCol}>

        <div style={s.section}>
          <div style={s.sectionHeader}>
            <span style={s.sectionTitle}>Top Teachers</span>
          </div>
          {teacherPerf.slice(0, 5).length === 0
            ? <div style={s.empty}>No quality scores yet.</div>
            : teacherPerf.slice(0, 5).map((t, i) => (
                <TeacherRow key={t.uid} rank={i + 1} name={t.name} score={t.score} factors={t.factors} top />
              ))
          }
        </div>

        <div style={s.section}>
          <div style={s.sectionHeader}>
            <span style={s.sectionTitle}>Needs Coaching</span>
          </div>
          {teacherPerf.length === 0
            ? <div style={s.empty}>No quality scores yet.</div>
            : [...teacherPerf].reverse().slice(0, 5).map((t, i) => (
                <TeacherRow key={t.uid} rank={teacherPerf.length - i} name={t.name} score={t.score} factors={t.factors} top={false} />
              ))
          }
        </div>

      </div>

      {/* ── REVENUE TREND ── */}
      <div style={s.section}>
        <div style={s.sectionHeader}>
          <span style={s.sectionTitle}>Revenue — Last 7 Days</span>
          <span style={s.sectionSub}>₹{completedTx.filter(t => t.date >= days30ago).reduce((a, t) => a + t.amount, 0).toLocaleString("en-IN")} this month</span>
        </div>
        <div style={s.barChart}>
          {revTrend.map(d => {
            const h   = d.amt > 0 ? Math.max(8, Math.round((d.amt / maxRev) * 64)) : 4;
            const isT = d.date === today;
            return (
              <div key={d.date} style={s.barCol}>
                <span style={{ fontSize: 10, fontWeight: 600, color: isT ? "var(--color-accent)" : "var(--color-text-muted)", marginBottom: 4 }}>
                  {d.amt > 0 ? `₹${(d.amt / 1000).toFixed(1)}k` : "—"}
                </span>
                <div style={{ ...s.bar, height: h, background: isT ? "var(--color-accent)" : d.amt > 0 ? "var(--color-success)" : "var(--color-border)" }} />
                <span style={{ fontSize: 10, color: isT ? "var(--color-accent)" : "var(--color-text-muted)", fontWeight: isT ? 800 : 400 }}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER ROW SUB-COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function TeacherRow({ rank, name, score, factors, top }: {
  rank: number; name: string; score: number | null;
  factors: { attendanceDiscipline: number; syllabusProgress: number; studentRetention: number } | null;
  top: boolean;
}) {
  const sc = score === null ? "var(--color-text-muted)"
    : score >= 75 ? "var(--color-success)"
    : score >= 50 ? "var(--color-warning)"
    : "var(--color-danger)";

  return (
    <div style={s.teacherRow}>
      <span style={{ fontSize: 12, fontWeight: 800, color: top ? "var(--color-success)" : "var(--color-danger)", minWidth: 24 }}>#{rank}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{name}</span>
      {score !== null
        ? <div style={{ display: "flex", alignItems: "baseline", gap: 1 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: sc }}>{score}</span>
            <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>/100</span>
          </div>
        : <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>—</span>
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helper: month label ────────────────────────────────────────────────────────
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface AdminStudentDoc {
  uid:            string;
  centerId:       string;
  status:         string;
  classType:      string;
  currentBalance: number;
  createdAt:      string;
  lastBilledMonth: string | null;
}

interface AdminTeacherDoc {
  uid:        string;
  displayName:string;
  centerIds:  string[];
  status:     string;
}

interface BillingMonthStatus {
  month:          string;   // "YYYY-MM"
  completed:      boolean;
  completedAt:    string | null;
  completedBy:    string | null;
  alertSent:      boolean;
  collectedAmt:   number;
  billedCount:    number;
  paidCount:      number;
}

// ── Admin Dashboard Component ──────────────────────────────────────────────────
function AdminDashboard() {
  const { user } = useAuthContext();
  const router   = useRouter();

  const today     = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const thisMonth = useMemo(() => today.slice(0, 7), [today]);
  // Last 3 months including current
  const months3   = useMemo(() => [thisMonth, isoMonthStart(1), isoMonthStart(2)], [thisMonth]);

  const [students,  setStudents]  = useState<AdminStudentDoc[]>([]);
  const [teachers,  setTeachers]  = useState<AdminTeacherDoc[]>([]);
  const [centers,   setCenters]   = useState<Center[]>([]);
  const [txList,    setTxList]    = useState<{ month: string; amount: number; studentUid: string; status: string }[]>([]);
  const [billing,   setBilling]   = useState<Record<string, BillingMonthStatus>>({});
  const [attStats,  setAttStats]  = useState<{ present: number; total: number } | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [completing, setCompleting] = useState<string | null>(null); // month being marked complete

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    async function load() {
      try {
        const [studSnap, teachSnap, centersData, attSnap, txSnap, ...billingSnaps] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getCenters(),
          getDocs(query(collection(db, "attendance"), where("date", "==", today))),
          getDocs(query(collection(db, "transactions"), where("date", ">=", isoMonthStart(2)))),
          ...months3.map(m => getDoc(doc(db, "billing_months", m))),
        ]);

        const studs: AdminStudentDoc[] = studSnap.docs.map(d => ({
          uid:            d.id,
          centerId:       (d.data().centerId   ?? "") as string,
          status:         (d.data().status ?? d.data().studentStatus ?? "active") as string,
          classType:      (d.data().classType  ?? "group") as string,
          currentBalance: Number(d.data().currentBalance ?? 0),
          createdAt:      (d.data().createdAt  ?? "") as string,
          lastBilledMonth:(d.data().lastBilledMonth ?? null) as string | null,
        }));
        setStudents(studs);

        setTeachers(teachSnap.docs.map(d => ({
          uid:         d.id,
          displayName: (d.data().displayName ?? d.data().name ?? "—") as string,
          centerIds:   (d.data().centerIds   ?? []) as string[],
          status:      (d.data().status      ?? "active") as string,
        })));

        setCenters(centersData);

        let attPresent = 0, attTotal = 0;
        attSnap.forEach(d => {
          attTotal++;
          if (d.data().status === "present") attPresent++;
        });
        setAttStats({ present: attPresent, total: attTotal });

        const txs = txSnap.docs.map(d => ({
          month:      ((d.data().date as string | undefined) ?? "").slice(0, 7),
          amount:     Number(d.data().amount ?? 0),
          studentUid: (d.data().studentUid ?? "") as string,
          status:     (d.data().status ?? "") as string,
        }));
        setTxList(txs);

        // Build billing status map — merge Firestore doc with derived stats
        const bMap: Record<string, BillingMonthStatus> = {};
        months3.forEach((m, i) => {
          const snap = billingSnaps[i];
          const data  = snap.exists() ? snap.data() as Partial<BillingMonthStatus> : {};
          const monthTx   = txs.filter(t => t.month === m && t.status === "completed");
          const collectedAmt = monthTx.reduce((acc, t) => acc + t.amount, 0);
          const billedCount  = studs.filter(s => s.lastBilledMonth === m && s.status === "active").length;
          const paidCount    = monthTx.length;
          bMap[m] = {
            month:       m,
            completed:   data.completed   ?? false,
            completedAt: data.completedAt ?? null,
            completedBy: data.completedBy ?? null,
            alertSent:   data.alertSent   ?? false,
            collectedAmt,
            billedCount,
            paidCount,
          };
        });
        setBilling(bMap);
      } catch (err) {
        console.error("[AdminDashboard] load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, today]);

  // ── Mark month complete ──────────────────────────────────────────────────
  async function markMonthComplete(month: string) {
    if (!user) return;
    setCompleting(month);
    try {
      const payload: BillingMonthStatus = {
        month,
        completed:   true,
        completedAt: new Date().toISOString(),
        completedBy: user.uid,
        alertSent:   billing[month]?.alertSent ?? false,
        collectedAmt:billing[month]?.collectedAmt ?? 0,
        billedCount: billing[month]?.billedCount ?? 0,
        paidCount:   billing[month]?.paidCount ?? 0,
      };
      await setDoc(doc(db, "billing_months", month), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
      setBilling(prev => ({ ...prev, [month]: payload }));
    } catch (err) {
      console.error("[AdminDashboard] markMonthComplete error:", err);
    } finally {
      setCompleting(null);
    }
  }

  // ── Derived stats ────────────────────────────────────────────────────────
  const activeStudents  = students.filter(s => s.status === "active").length;
  const groupStudents   = students.filter(s => s.classType === "group").length;
  const personalStudents = students.filter(s => s.classType === "personal").length;
  const pendingFeeAmt   = students.filter(s => s.currentBalance > 0).reduce((acc, s) => acc + s.currentBalance, 0);
  const pendingFeeCount = students.filter(s => s.currentBalance > 0).length;
  const attPct          = attStats && attStats.total > 0 ? Math.round((attStats.present / attStats.total) * 100) : null;
  const attBad          = attPct !== null && attPct < 60;

  // This month billing
  const thisMonthBilling = billing[thisMonth];
  const activeCount      = students.filter(s => s.status === "active").length;
  const billedThisMonth  = thisMonthBilling?.billedCount ?? 0;
  const paidThisMonth    = thisMonthBilling?.paidCount ?? 0;
  const collectedThisMonth = thisMonthBilling?.collectedAmt ?? 0;
  const unbilledCount    = activeCount - billedThisMonth;
  const unpaidCount      = billedThisMonth - paidThisMonth;

  // ── Alerts ───────────────────────────────────────────────────────────────
  const alerts = useMemo(() => {
    const list: { icon: string; msg: string; level: "critical" | "warning"; action?: string; href?: string }[] = [];

    // Deactivation requests
    const pendingDeact = students.filter(s => s.status === "deactivation_requested").length;
    if (pendingDeact > 0)
      list.push({ icon: "🔔", msg: `${pendingDeact} deactivation request${pendingDeact > 1 ? "s" : ""} pending approval`, level: "critical", action: "Review", href: "/dashboard/students" });

    // Attendance low
    if (attPct !== null && attPct < 60)
      list.push({ icon: "📉", msg: `Attendance low today — only ${attPct}%`, level: "critical", action: "View", href: "/dashboard/attendance" });

    // Overdue fees
    if (pendingFeeAmt > 0)
      list.push({ icon: "💰", msg: `₹${pendingFeeAmt.toLocaleString("en-IN")} outstanding — ${pendingFeeCount} student${pendingFeeCount > 1 ? "s" : ""}`, level: "warning", action: "Collect", href: "/dashboard/finance" });

    // Teachers with no center assigned
    const unassignedTeachers = teachers.filter(t => t.status === "active" && (!t.centerIds || t.centerIds.length === 0));
    if (unassignedTeachers.length > 0)
      list.push({ icon: "👤", msg: `${unassignedTeachers.length} teacher${unassignedTeachers.length > 1 ? "s" : ""} not assigned to any centre`, level: "warning", action: "Assign", href: "/dashboard/centers" });

    // Inactive teachers
    const inactiveTeachers = teachers.filter(t => t.status !== "active").length;
    if (inactiveTeachers > 0)
      list.push({ icon: "😴", msg: `${inactiveTeachers} teacher${inactiveTeachers > 1 ? "s" : ""} marked inactive`, level: "warning", action: "Review", href: "/dashboard/teachers" });

    // Centers with no students
    const emptyCenters = centers.filter(c => !students.some(s => s.centerId === c.id && s.status === "active"));
    if (emptyCenters.length > 0)
      list.push({ icon: "🏫", msg: `${emptyCenters.length} centre${emptyCenters.length > 1 ? "s" : ""} with no active students: ${emptyCenters.map(c => c.name).join(", ")}`, level: "warning", action: "View", href: "/dashboard/centers" });

    // Unbilled students this month
    if (unbilledCount > 0 && !thisMonthBilling?.completed)
      list.push({ icon: "📋", msg: `${unbilledCount} student${unbilledCount > 1 ? "s" : ""} not yet billed for ${monthLabel(thisMonth)}`, level: "warning", action: "Bill", href: "/dashboard/finance" });

    return list;
  }, [students, teachers, centers, attPct, pendingFeeAmt, pendingFeeCount, unbilledCount, thisMonth, thisMonthBilling]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={adm.page}>

      {/* ── HEADER ── */}
      <div style={adm.header}>
        <div>
          <div style={adm.eyebrow}>Admin Dashboard</div>
          <div style={adm.date}>
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
            Welcome back, {user?.displayName}
          </div>
        </div>
        <div style={adm.quickActions}>
          <button style={adm.qaBtn} onClick={() => router.push("/dashboard/students")}>+ Student</button>
          <button style={adm.qaBtn} onClick={() => router.push("/dashboard/teachers")}>+ Teacher</button>
          <button style={adm.qaBtn} onClick={() => router.push("/dashboard/centers")}>+ Centre</button>
          <button style={{ ...adm.qaBtn, ...adm.qaBtnPrimary }} onClick={() => router.push("/dashboard/finance")}>Finance →</button>
        </div>
      </div>

      {/* ── KPI STRIP ── */}
      <div style={adm.kpiStrip}>
        <KpiTile label="Students" value={loading ? "…" : String(students.length)} sub={loading ? "" : `${activeStudents} active · ${groupStudents} group · ${personalStudents} personal`} />
        <div style={adm.kpiDiv} />
        <KpiTile label="Centres" value={loading ? "…" : String(centers.length)} sub={`${centers.filter(c => c.status === "active").length} active`} />
        <div style={adm.kpiDiv} />
        <KpiTile label="Teachers" value={loading ? "…" : String(teachers.length)} sub={`${teachers.filter(t => t.status === "active").length} active`} />
        <div style={adm.kpiDiv} />
        <KpiTile
          label="Attendance Today"
          value={loading ? "…" : attStats?.total === 0 ? "—" : `${attPct ?? 0}%`}
          sub={loading ? "" : attStats?.total === 0 ? "No records yet" : `${attStats?.present ?? 0} / ${attStats?.total ?? 0} present`}
          valueColor={attBad ? "var(--color-danger)" : attPct !== null ? "var(--color-success)" : undefined}
        />
        <div style={adm.kpiDiv} />
        <KpiTile
          label="Pending Fees"
          value={loading ? "…" : pendingFeeAmt === 0 ? "All Clear" : `₹${pendingFeeAmt.toLocaleString("en-IN")}`}
          sub={loading ? "" : pendingFeeAmt === 0 ? "All collected" : `${pendingFeeCount} students due`}
          valueColor={pendingFeeAmt > 0 ? "var(--color-warning)" : "var(--color-success)"}
        />
      </div>

      {/* ── MONTHLY FINANCE PANEL ── */}
      <div style={adm.section}>
        <div style={adm.secHeader}>
          <span style={adm.secTitle}>Monthly Fee Collection</span>
          <span style={adm.secSub}>3-month view · tap a month to mark complete</span>
        </div>

        {/* Current month status strip */}
        {!loading && thisMonthBilling && (
          <div style={{
            ...adm.monthStatusBar,
            background: thisMonthBilling.completed ? "var(--color-success-dim, #f0fdf4)" : "var(--color-warning-dim, #fffbeb)",
            border: `1px solid ${thisMonthBilling.completed ? "var(--color-success-border, #bbf7d0)" : "var(--color-warning-border, #fde68a)"}`,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 4 }}>
                {thisMonthBilling.completed ? "✅" : "📋"} {monthLabel(thisMonth)}
                {thisMonthBilling.completed && (
                  <span style={{ marginLeft: 10, fontSize: 11, color: "var(--color-success)", fontWeight: 600, background: "#dcfce7", borderRadius: 99, padding: "2px 9px" }}>COMPLETED</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" as const }}>
                <MonthStatChip label="Billed" value={billedThisMonth} total={activeCount} />
                <MonthStatChip label="Paid" value={paidThisMonth} total={billedThisMonth} />
                <MonthStatChip label="Unpaid" value={unpaidCount} total={billedThisMonth} warn={unpaidCount > 0} />
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: "var(--color-text-muted)" }}>Collected </span>
                  <span style={{ fontWeight: 700, color: "var(--color-success)" }}>₹{collectedThisMonth.toLocaleString("en-IN")}</span>
                </div>
              </div>
            </div>
            {!thisMonthBilling.completed && (
              <button
                style={{
                  ...adm.completeBtn,
                  opacity: completing === thisMonth ? 0.6 : 1,
                  cursor: completing === thisMonth ? "default" : "pointer",
                }}
                disabled={completing === thisMonth}
                onClick={() => markMonthComplete(thisMonth)}
              >
                {completing === thisMonth ? "Saving…" : `✓ Complete ${monthLabel(thisMonth)}`}
              </button>
            )}
            {thisMonthBilling.completed && thisMonthBilling.completedAt && (
              <div style={{ fontSize: 11, color: "var(--color-success)", textAlign: "right" }}>
                Marked done<br />
                {new Date(thisMonthBilling.completedAt).toLocaleDateString("en-IN")}
              </div>
            )}
          </div>
        )}

        {/* 3-month history table */}
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={adm.table}>
            <thead>
              <tr>
                {["Month", "Billed", "Paid", "Unpaid", "Collected", "Status"].map(h => (
                  <th key={h} style={adm.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? <tr><td colSpan={6} style={{ ...adm.td, textAlign: "center", color: "var(--color-text-muted)", padding: 20 }}>Loading…</td></tr>
                : months3.map(m => {
                    const b = billing[m];
                    if (!b) return null;
                    const isPast = m !== thisMonth;
                    return (
                      <tr key={m} style={{ background: m === thisMonth ? "var(--color-surface-2, #f9fafb)" : "transparent" }}>
                        <td style={{ ...adm.td, fontWeight: 700, color: "var(--color-text-primary)" }}>
                          {monthLabel(m)}
                          {m === thisMonth && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--color-accent)", background: "var(--color-accent-dim,#ede9fe)", borderRadius: 99, padding: "1px 7px", fontWeight: 700 }}>CURRENT</span>}
                        </td>
                        <td style={adm.td}>{b.billedCount} <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>/ {activeCount}</span></td>
                        <td style={{ ...adm.td, color: "var(--color-success)" }}>{b.paidCount}</td>
                        <td style={{ ...adm.td, color: b.billedCount - b.paidCount > 0 ? "var(--color-danger)" : "var(--color-success)" }}>
                          {b.billedCount - b.paidCount}
                        </td>
                        <td style={{ ...adm.td, fontWeight: 700 }}>₹{b.collectedAmt.toLocaleString("en-IN")}</td>
                        <td style={adm.td}>
                          {b.completed
                            ? <span style={adm.pillDone}>✅ Done</span>
                            : isPast
                              ? <button style={{ ...adm.completeBtn, fontSize: 11, padding: "5px 12px", opacity: completing === m ? 0.6 : 1 }}
                                  disabled={completing === m}
                                  onClick={() => markMonthComplete(m)}>
                                  {completing === m ? "…" : "Mark Done"}
                                </button>
                              : <span style={adm.pillPending}>In Progress</span>
                          }
                        </td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>
        </div>
      </div>

      {/* ── ALERTS ── */}
      <div style={adm.section}>
        <div style={adm.secHeader}>
          <span style={adm.secTitle}>Needs Attention</span>
          {!loading && alerts.length > 0 && (
            <span style={adm.alertCountBadge}>{alerts.length}</span>
          )}
        </div>

        {loading
          ? <div style={adm.emptyRow}>Loading…</div>
          : alerts.length === 0
            ? <div style={{ ...adm.emptyRow, color: "var(--color-success)" }}>✓ Everything looks healthy — no issues.</div>
            : alerts.map((a, i) => (
                <div key={i} style={{ ...adm.alertRow, borderLeft: `3px solid ${a.level === "critical" ? "var(--color-danger)" : "var(--color-warning)"}` }}>
                  <span style={adm.alertIcon}>{a.icon}</span>
                  <span style={adm.alertMsg}>{a.msg}</span>
                  {a.href && (
                    <button style={adm.alertActionBtn} onClick={() => router.push(a.href!)}>
                      {a.action ?? "Go"} →
                    </button>
                  )}
                </div>
              ))
        }
      </div>

      {/* ── QUICK ACCESS ── */}
      <div style={adm.quickGrid}>
        {[
          { icon: "🎓", label: "Students",   sub: `${activeStudents} active`, href: "/dashboard/students" },
          { icon: "🏫", label: "Centres",    sub: `${centers.length} total`, href: "/dashboard/centers" },
          { icon: "👤", label: "Teachers",   sub: `${teachers.filter(t => t.status === "active").length} active`, href: "/dashboard/teachers" },
          { icon: "💰", label: "Finance",    sub: "Collect & track fees", href: "/dashboard/finance" },
          { icon: "📊", label: "Attendance", sub: "View & mark", href: "/dashboard/attendance" },
          { icon: "📚", label: "Syllabus",   sub: "Lessons & progress", href: "/dashboard/syllabus" },
        ].map(item => (
          <button key={item.href} style={adm.quickCard} onClick={() => router.push(item.href)}>
            <span style={adm.quickIcon}>{item.icon}</span>
            <span style={adm.quickLabel}>{item.label}</span>
            <span style={adm.quickSub}>{item.sub}</span>
          </button>
        ))}
      </div>

    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub, valueColor }: { label: string; value: string; sub: string; valueColor?: string }) {
  return (
    <div style={adm.kpi}>
      <div style={adm.kpiLabel}>{label}</div>
      <div style={{ ...adm.kpiValue, color: valueColor ?? "var(--color-text-primary)" }}>{value}</div>
      <div style={adm.kpiSub}>{sub}</div>
    </div>
  );
}

function MonthStatChip({ label, value, total, warn }: { label: string; value: number; total: number; warn?: boolean }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: "var(--color-text-muted)" }}>{label} </span>
      <span style={{ fontWeight: 700, color: warn ? "var(--color-danger)" : "var(--color-text-primary)" }}>{value}</span>
      {total > 0 && <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>/{total}</span>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND CENTER STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 1000, margin: "0 auto", paddingBottom: 48 },

  // Loading
  shell:       { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "40vh", gap: 12 },
  spinner:     { width: 26, height: 26, border: "3px solid var(--color-border)", borderTopColor: "var(--color-accent)", borderRadius: "50%", animation: "spin 0.7s linear infinite" },
  loadingText: { fontSize: 13, color: "var(--color-text-muted)" },
  errorShell:  { padding: "48px 24px", textAlign: "center", color: "var(--color-danger)", fontSize: 14 },

  // Header
  header:  { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  eyebrow: { fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "var(--color-accent)", textTransform: "uppercase", marginBottom: 4 },
  date:    { fontSize: 18, fontWeight: 700, color: "var(--color-text-primary)" },
  actions: { display: "flex", gap: 8 },
  btn:     { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--color-text-secondary)" },
  btnPri:  { background: "var(--color-accent)", color: "#0a0a0a", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  // KPI strip
  kpiStrip:   { display: "flex", alignItems: "stretch", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "20px 28px", marginBottom: 20, gap: 0, boxShadow: "var(--shadow-sm)", flexWrap: "wrap" },
  kpi:        { flex: 1, minWidth: 120, padding: "0 16px" },
  kpiDivider: { width: 1, background: "var(--color-border)", margin: "0 4px" },
  kpiLabel:   { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--color-text-muted)", marginBottom: 6 },
  kpiValue:   { fontSize: 26, fontWeight: 800, lineHeight: 1, color: "var(--color-text-primary)", marginBottom: 4 },
  kpiSub:     { fontSize: 11.5, color: "var(--color-text-muted)", fontWeight: 500 },

  // Alerts
  alertsBox:    { background: "var(--color-surface)", border: "1px solid var(--color-danger-border)", borderLeft: "4px solid var(--color-danger)", borderRadius: 12, marginBottom: 20, overflow: "hidden", boxShadow: "var(--shadow-sm)" },
  alertsHeader: { display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--color-border)" },
  alertsTitle:  { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--color-danger)" },
  alertsCount:  { fontSize: 11, fontWeight: 700, background: "var(--color-danger-dim)", color: "var(--color-danger)", border: "1px solid var(--color-danger-border)", borderRadius: 99, padding: "1px 8px" },
  alertsList:   { display: "flex", flexDirection: "column" },
  alertRow:     { display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", borderBottom: "1px solid var(--color-border-subtle)" },
  alertDot:     { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  alertIcon:    { fontSize: 14, flexShrink: 0 },
  alertMsg:     { flex: 1, fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.4 },
  allClear:     { fontSize: 13, color: "var(--color-success)", fontWeight: 500, padding: "14px 18px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: "4px solid var(--color-success)", borderRadius: 12, marginBottom: 20 },

  // Section
  section:       { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 20px", marginBottom: 16, boxShadow: "var(--shadow-sm)" },
  sectionHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 },
  sectionTitle:  { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-secondary)" },
  sectionSub:    { fontSize: 11, color: "var(--color-text-muted)" },

  // Two col
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 0 },

  // Table
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:    { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)", whiteSpace: "nowrap" as const },
  tr:    { borderBottom: "1px solid var(--color-border-subtle)" },
  td:    { padding: "12px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },
  rank:  { fontSize: 11, color: "var(--color-text-muted)", marginRight: 6 },

  // Teacher rows
  teacherRow: { display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--color-border-subtle)" },
  empty:      { padding: "20px", textAlign: "center", fontSize: 13, color: "var(--color-text-muted)" },

  // Bar chart
  barChart: { display: "flex", alignItems: "flex-end", gap: 10, height: 80, paddingTop: 4 },
  barCol:   { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  bar:      { width: "100%", borderRadius: 4, minHeight: 4 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const adm: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 1000, margin: "0 auto", paddingBottom: 48 },

  // Header
  header:       { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  eyebrow:      { fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "var(--color-accent)", textTransform: "uppercase", marginBottom: 4 },
  date:         { fontSize: 18, fontWeight: 700, color: "var(--color-text-primary)" },
  quickActions: { display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" },
  qaBtn:        { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--color-text-secondary)" },
  qaBtnPrimary: { background: "var(--color-accent)", color: "#0a0a0a", border: "none" },

  // KPI strip
  kpiStrip: { display: "flex", alignItems: "stretch", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "20px 24px", marginBottom: 20, gap: 0, boxShadow: "var(--shadow-sm)", flexWrap: "wrap" as const },
  kpi:      { flex: 1, minWidth: 120, padding: "0 14px" },
  kpiDiv:   { width: 1, background: "var(--color-border)", margin: "0 4px" },
  kpiLabel: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: "var(--color-text-muted)", marginBottom: 6 },
  kpiValue: { fontSize: 24, fontWeight: 800, lineHeight: 1, marginBottom: 4 },
  kpiSub:   { fontSize: 11, color: "var(--color-text-muted)", fontWeight: 500 },

  // Section
  section:   { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 20px", marginBottom: 16, boxShadow: "var(--shadow-sm)" },
  secHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  secTitle:  { fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--color-text-secondary)" },
  secSub:    { fontSize: 11, color: "var(--color-text-muted)" },

  // Monthly finance
  monthStatusBar: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, borderRadius: 10, padding: "14px 18px", flexWrap: "wrap" as const },
  completeBtn: { background: "var(--color-success)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },
  pillDone:    { fontSize: 11, fontWeight: 700, color: "var(--color-success)", background: "#dcfce7", borderRadius: 99, padding: "3px 10px" },
  pillPending: { fontSize: 11, fontWeight: 600, color: "var(--color-warning)", background: "#fef3c7", borderRadius: 99, padding: "3px 10px" },

  // Table
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th:    { textAlign: "left" as const, padding: "8px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)", whiteSpace: "nowrap" as const },
  td:    { padding: "12px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle" as const, borderBottom: "1px solid var(--color-border-subtle, #f3f4f6)" },

  // Alerts
  alertCountBadge: { fontSize: 11, fontWeight: 700, background: "var(--color-danger-dim)", color: "var(--color-danger)", border: "1px solid var(--color-danger-border)", borderRadius: 99, padding: "1px 8px" },
  alertRow:        { display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 8, borderRadius: 8, background: "var(--color-surface-2, #f9fafb)", borderLeft: "3px solid var(--color-warning)" },
  alertIcon:       { fontSize: 16, flexShrink: 0 },
  alertMsg:        { flex: 1, fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.4 },
  alertActionBtn:  { fontSize: 12, fontWeight: 700, color: "var(--color-accent)", background: "transparent", border: "1px solid var(--color-border)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap" as const },
  emptyRow:        { padding: "16px 4px", fontSize: 13, color: "var(--color-text-muted)" },

  // Quick grid
  quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 12, marginBottom: 16 },
  quickCard: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "18px 16px", display: "flex", flexDirection: "column" as const, alignItems: "flex-start", gap: 4, cursor: "pointer", transition: "box-shadow 0.15s", boxShadow: "var(--shadow-sm)", textAlign: "left" as const },
  quickIcon:  { fontSize: 22, marginBottom: 4 },
  quickLabel: { fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" },
  quickSub:   { fontSize: 11, color: "var(--color-text-muted)" },
};
