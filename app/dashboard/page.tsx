"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where, orderBy, limit, doc, setDoc, getDoc, serverTimestamp, onSnapshot } from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { getCenters } from "@/services/center/center.service";
import { getClassesByCenter } from "@/services/attendance/attendance.service";
import { getAllTeacherQuality } from "@/services/quality/quality.service";
import { useWing } from "@/hooks/useWing";
import { inWing, isSchoolOfMusic } from "@/lib/wing";
import type { TeacherQuality } from "@/types/quality";
import type { Center, Wing } from "@/types";

/** Keep only rows whose centre belongs to the active wing. */
function scopeToWing<T extends { centerId?: string }>(rows: T[], centerIds: Set<string>): T[] {
  return rows.filter(r => !r.centerId || centerIds.has(r.centerId));
}

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

// Month-over-month widget (Super Admin only, see MonthComparisonWidget below):
// how many months of attendance history to fetch, and how far back the
// selector may navigate. MOM_MAX_OFFSET stays one below MOM_MONTHS_BACK so
// the comparison month (offset + 1) never falls outside the fetched range.
const MOM_MONTHS_BACK = 5;
const MOM_MAX_OFFSET  = MOM_MONTHS_BACK - 1;
function mondayOf(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00");
  const day = d.getDay();            // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function addDaysISO(dateISO: string, n: number): string {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseClassEndMinutes(timeSlot: string): number | null {
  const m24 = timeSlot.match(/\d{1,2}:\d{2}\s*[–\-]\s*(\d{1,2}):(\d{2})/);
  if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2]);
  const m12 = timeSlot.match(/\d{1,2}:\d{2}\s*(?:AM|PM)\s*[–\-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m12) {
    let h = parseInt(m12[1]);
    const ampm = m12[3].toUpperCase();
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + parseInt(m12[2]);
  }
  return null;
}

function classHasEnded(timeSlot: string): boolean {
  const end = parseClassEndMinutes(timeSlot);
  if (end === null) return true;
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes() >= end;
}

// Extracts both start and end minutes-past-midnight from a timeSlot string
// like "Mon/Wed/Fri 17:00–18:30" or "Mon/Wed/Fri 5:00 PM–6:30 PM".
function parseClassTimeRange(timeSlot: string): { startMin: number; endMin: number } | null {
  const m24 = timeSlot.match(/(\d{1,2}):(\d{2})\s*[–\-]\s*(\d{1,2}):(\d{2})(?!\s*(?:AM|PM))/i);
  if (m24) {
    return {
      startMin: parseInt(m24[1]) * 60 + parseInt(m24[2]),
      endMin:   parseInt(m24[3]) * 60 + parseInt(m24[4]),
    };
  }
  const m12 = timeSlot.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[–\-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m12) {
    let sh = parseInt(m12[1]);
    const sAmPm = m12[3].toUpperCase();
    if (sAmPm === "PM" && sh !== 12) sh += 12;
    if (sAmPm === "AM" && sh === 12) sh = 0;
    let eh = parseInt(m12[4]);
    const eAmPm = m12[6].toUpperCase();
    if (eAmPm === "PM" && eh !== 12) eh += 12;
    if (eAmPm === "AM" && eh === 12) eh = 0;
    return { startMin: sh * 60 + parseInt(m12[2]), endMin: eh * 60 + parseInt(m12[5]) };
  }
  return null;
}

function fmtClockMinutes(mins: number): string {
  let h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

// "Mon/Wed/Fri 17:00–18:30" → "5:00 PM - 6:30 PM"; falls back to the raw
// timeSlot (or a neutral placeholder) when it can't be parsed.
function fmtTimeSlotRange(timeSlot: string): string {
  const r = parseClassTimeRange(timeSlot);
  if (!r) return timeSlot || "Scheduled";
  return `${fmtClockMinutes(r.startMin)} - ${fmtClockMinutes(r.endMin)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE SHELL
// ═══════════════════════════════════════════════════════════════════════════════

export default function DashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.PARENT, ROLES.MEMBER]}>
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
    if (user?.role === ROLES.PARENT) router.replace("/dashboard/parent");
    if (user?.role === ROLES.MEMBER) router.replace("/dashboard/account");
  }, [authLoading, user, router]);

  if (authLoading || !user) return null;
  if (user.role === ROLES.STUDENT || user.role === ROLES.PARENT || user.role === ROLES.MEMBER) return null;
  if (user.role === ROLES.FOUNDER) return <CommandCenter />;
  return <AdminDashboard />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN — COMMAND CENTER
// Layout: KPI strip → Alerts → Centre table → Teacher leaderboard → Revenue
// ═══════════════════════════════════════════════════════════════════════════════

function CommandCenter() {
  const router = useRouter();
  const { wing } = useWing();
  const [data,    setData]    = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Stabilise date strings inside useMemo so they never change reference mid-render.
  // Plain const declarations like `const today = isoToday()` return a new string
  // instance on every render — even though the VALUE is the same, some useMemo
  // dependencies compare with Object.is() and would see a change, triggering
  // unnecessary recomputation that cascades into extra re-renders.
  const today     = useMemo(() => isoToday(),       []);
  const days7ago  = useMemo(() => isoDaysAgo(7),    []);
  const days30ago = useMemo(() => isoDaysAgo(30),   []);
  const thisMonth = useMemo(() => isoMonthStart(0), []);
  const lastMonth = useMemo(() => isoMonthStart(1), []);
  // Fetch floor for the Super Admin month-over-month widget below — needs
  // several months of history, not just the current month's attendance.
  const momFetchFloor = useMemo(() => isoMonthStart(MOM_MONTHS_BACK), []);

  useEffect(() => {
    async function load() {
      try {
        const [studentsSnap, teachersSnap, centersSnap, attSnap, txSnap, quality] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getCenters(wing),
          getDocs(query(collection(db, "attendance"), where("date", ">=", momFetchFloor + "-01"))),
          getDocs(collection(db, "transactions")),
          getAllTeacherQuality(),
        ]);
        const centerIds = new Set(centersSnap.map(c => c.id));
        setData({
          students:     studentsSnap.docs.filter(d => inWing(d.data(), wing)).map(d => ({ uid: d.id, ...d.data() } as StudentDoc)),
          teachers:     teachersSnap.docs.filter(d => inWing(d.data(), wing)).map(d => ({ uid: d.id, ...d.data() } as TeacherDoc)),
          centers:      centersSnap,
          attendance:   scopeToWing(attSnap.docs.map(d => d.data() as AttendanceDoc), centerIds),
          transactions: scopeToWing(txSnap.docs.map(d => d.data() as TransactionDoc), centerIds),
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
  }, [wing]);

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
  // Only manual payment receipts — excludes fee_due records, auto-charges, and deposits
  // (mirrors the isManualPayment filter in the finance page summary)
  const completedTx  = useMemo(() => transactions.filter(t => {
    const raw = t as unknown as Record<string, unknown>;
    if (t.status !== "completed") return false;
    const type   = (raw.type   as string) ?? "";
    const method = (raw.method as string) ?? "";
    return type !== "fee_due" && type !== "charge" && method !== "auto" && method !== "auto-monthly";
  }), [transactions]);
  const revThisMonth = useMemo(() => completedTx.filter(t => t.date?.startsWith(thisMonth)).reduce((s, t) => s + t.amount, 0), [completedTx, thisMonth]);
  const revLastMonth = useMemo(() => completedTx.filter(t => t.date?.startsWith(lastMonth)).reduce((s, t) => s + t.amount, 0), [completedTx, lastMonth]);
  const revGrowthPct = revLastMonth > 0 ? Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 100) : null;

  // KPI: pending fees — mirrors finance page: fee_due tx for this month, not yet covered by a manual payment
  const feeDueMap = useMemo(() => {
    const m = new Map<string, number>();
    transactions.forEach(tx => {
      const raw = tx as unknown as Record<string, unknown>;
      if (!tx.studentUid || (raw.type as string) !== "fee_due") return;
      const bm = (raw.billingMonth as string) || tx.date.slice(0, 7);
      if (bm === thisMonth) m.set(tx.studentUid, Number(raw.amount ?? 0));
    });
    return m;
  }, [transactions, thisMonth]);

  const paidSet = useMemo(() => {
    const s = new Set<string>();
    transactions.forEach(tx => {
      const raw = tx as unknown as Record<string, unknown>;
      if (!tx.studentUid || tx.status !== "completed") return;
      if (!tx.date.startsWith(thisMonth)) return;
      const type   = (raw.type   as string) ?? "";
      const method = (raw.method as string) ?? "";
      if (type === "fee_due" || type === "charge" || method === "auto" || method === "auto-monthly") return;
      s.add(tx.studentUid);
    });
    return s;
  }, [transactions, thisMonth]);

  const totalPendingFees = useMemo(() => {
    let amt = 0;
    feeDueMap.forEach((fee, uid) => { if (!paidSet.has(uid)) amt += fee; });
    return amt;
  }, [feeDueMap, paidSet]);

  const pendingFeeStudents = useMemo(() => {
    let n = 0;
    feeDueMap.forEach((_, uid) => { if (!paidSet.has(uid)) n++; });
    return n;
  }, [feeDueMap, paidSet]);

  // Centre rows
  const teacherNameMap = useMemo(() => Object.fromEntries(teachers.map(t => [t.uid, t.displayName])), [teachers]);

  const centreRows: CenterRow[] = useMemo(() => {
    const days60ago = isoDaysAgo(60);
    return centers.map(center => {
      const cStudents         = students.filter(s => s.centerId === center.id);
      const activeCount       = cStudents.filter(s => s.status === "active").length;
      const pendingFeeCount   = cStudents.filter(s => feeDueMap.has(s.uid) && !paidSet.has(s.uid)).length;
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
  }, [centers, students, attendance, completedTx, teacherNameMap, days7ago, days30ago, feeDueMap, paidSet]);

  // Teacher leaderboard
  const teacherPerf = useMemo(() => teachers.map(t => {
    const q = quality.find(q => q.teacherId === t.uid);
    return { uid: t.uid, name: t.displayName, score: q?.score ?? null, factors: q?.factors ?? null };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)), [teachers, quality]);

  // Monthly revenue trend (last 6 months)
  const revMonthlyTrend = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i));
    const ym  = d.toISOString().slice(0, 7);
    const amt = completedTx.filter(t => t.date?.startsWith(ym)).reduce((s, t) => s + t.amount, 0);
    const label = d.toLocaleDateString("en-IN", { month: "short" });
    return { ym, label, amt };
  }), [completedTx]);

  // Weekly attendance trend (last 7 days)
  const attWeeklyTrend = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const date  = isoDaysAgo(6 - i);
    const recs  = attendance.filter(a => a.date === date);
    const pct   = recs.length > 0 ? Math.round((recs.filter(a => a.status === "present").length / recs.length) * 100) : null;
    const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short" });
    return { date, label, pct };
  }), [attendance]);

  // Top 5 centres by revenue + students
  const top5Rev      = [...centreRows].sort((a,b) => b.revenue30d - a.revenue30d).slice(0,5);
  const top5Students = [...centreRows].sort((a,b) => b.studentCount - a.studentCount).slice(0,5);

  // Attendance breakdown (present / absent / cancelled)
  const attBreakdown = useMemo(() => {
    return centreRows.slice(0,5).map(row => {
      const recs = attendance.filter(a => a.centerId === row.center.id);
      return {
        name:      row.center.name.length > 10 ? row.center.name.slice(0,10)+"…" : row.center.name,
        present:   recs.filter(a => a.status === "present").length,
        absent:    recs.filter(a => a.status === "absent").length,
        cancelled: recs.filter(a => a.status?.startsWith("cancelled")).length,
      };
    });
  }, [centreRows, attendance]);

  // Monthly attendance totals — every student remark counts
  const monthlyTotals = useMemo(() => {
    const monthRecs = attendance.filter(a => a.date?.startsWith(thisMonth));
    return {
      present:   monthRecs.filter(a => a.status === "present").length,
      absent:    monthRecs.filter(a => a.status === "absent").length,
      break:     monthRecs.filter(a => (a.status as string) === "break").length,
      cancelled: monthRecs.filter(a => (a.status as string)?.startsWith("cancelled")).length,
      total:     monthRecs.length,
    };
  }, [attendance, thisMonth]);

  // Fee pie
  const feePaid    = completedTx.reduce((s,t) => s + t.amount, 0);
  const feePending = totalPendingFees;

  // Revenue goal (hardcoded target = 1.2× last month or 50000 floor)
  const revGoal = Math.max(50000, Math.round(revLastMonth * 1.2));


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

      {/* ── 1. HEADER ── */}
      <div style={s.header}>
        <div>
          <div style={s.eyebrow}>CENTER SUITE</div>
          <div style={s.date}>{new Date().toLocaleDateString("en-IN", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</div>
        </div>
      </div>

      {/* ── 2. KPI ROW ── */}
      <div style={s.kpiStrip}>
        <KpiCard label="Total Students"   value={String(totalStudents)}   sub={`${activeStudents} active`} color="#4f46e5"
          onClick={() => router.push("/dashboard/students")} />
        <KpiCard label="Active Centres"   value={String(centers.filter(c=>c.status==="active").length)} sub={`of ${centers.length} total`} color="#0891b2"
          onClick={() => router.push("/dashboard/centers")} />
        <KpiCard label="Revenue · Month"  value={`₹${(revThisMonth/1000).toFixed(1)}k`}
          sub={revGrowthPct!==null ? `${revGrowthPct>=0?"▲":"▼"} ${Math.abs(revGrowthPct)}% vs last` : "no prior data"}
          color={revGrowthPct===null?"#6b7280":revGrowthPct>=0?"#16a34a":"#dc2626"}
          onClick={() => router.push("/dashboard/finance")} />
        <KpiCard label="Pending Fees"     value={totalPendingFees===0?"All Clear":`₹${(totalPendingFees/1000).toFixed(1)}k`}
          sub={totalPendingFees===0?"Collected":`${pendingFeeStudents} students`}
          color={totalPendingFees===0?"#16a34a":"#f59e0b"}
          onClick={() => router.push("/dashboard/finance?tab=students&filter=pending")} />
      </div>

      {/* ── MONTH-OVER-MONTH COMPARISON (Super Admin only) ── */}
      <MonthComparisonWidget attendance={attendance} completedTx={completedTx} />

      {/* ── CLASSES FOR [DATE] ── */}
      <ClassesForDateWidget sectionStyle={s.section} headerStyle={s.sectionHeader} titleStyle={s.sectionTitle} subStyle={s.sectionSub} />

      {/* ── MONTHLY ATTENDANCE TOTALS ── */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Attendance This Month</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{monthLabel(thisMonth)} · all student records</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
          {[
            { label: "Present",   value: monthlyTotals.present,   color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
            { label: "Absent",    value: monthlyTotals.absent,     color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
            { label: "Break",     value: monthlyTotals.break,      color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
            { label: "Cancelled", value: monthlyTotals.cancelled,  color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
            { label: "Total",     value: monthlyTotals.total,      color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
          ].map(({ label, value, color, bg, border }) => (
            <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: "12px 20px", minWidth: 100, textAlign: "center" as const }}>
              <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginTop: 4, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── WEEKLY ATTENDANCE BREAKDOWN (Class-1 vs Class-2) ── */}
      <WeeklyClassBreakdown />

      {/* ── 3. TRENDS ROW ── */}
      <div style={s.twoCol}>
        <ChartCard title="Revenue Trend" sub="6 months">
          <LineChart data={revMonthlyTrend.map(d=>({ label:d.label, value:d.amt }))} color="#4f46e5" formatValue={v=>`₹${(v/1000).toFixed(1)}k`} />
        </ChartCard>
        <ChartCard title="Attendance Trend" sub="7 days">
          <LineChart data={attWeeklyTrend.map(d=>({ label:d.label, value:d.pct??0 }))} color="#16a34a" formatValue={v=>`${v}%`} />
        </ChartCard>
      </div>

      {/* ── 4. TOP CENTRES ── */}
      <div style={s.twoCol}>
        <ChartCard title="Top 5 Centres by Revenue" sub="30 days">
          <BarChart data={top5Rev.map(r=>({ label:r.center.name, value:r.revenue30d }))} color="#4f46e5" formatValue={v=>`₹${(v/1000).toFixed(1)}k`} />
        </ChartCard>
        <ChartCard title="Top 5 Centres by Students" sub="active">
          <BarChart data={top5Students.map(r=>({ label:r.center.name, value:r.studentCount }))} color="#0891b2" formatValue={v=>String(v)} />
        </ChartCard>
      </div>

      {/* ── 5. ATTENDANCE BREAKDOWN ── */}
      <ChartCard title="Attendance Breakdown" sub="present / absent / cancelled — top 5 centres">
        <StackedBarChart data={attBreakdown} />
      </ChartCard>

      {/* ── 6. FINANCE ROW ── */}
      <div style={s.twoCol}>
        <ChartCard title="Fee Status" sub="collected vs pending">
          <PieChart paid={feePaid} pending={feePending} />
        </ChartCard>
        <ChartCard title="Revenue vs Goal" sub={`Target ₹${(revGoal/1000).toFixed(1)}k this month`}>
          <GaugeChart value={revThisMonth} goal={revGoal} />
        </ChartCard>
      </div>

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONTH-OVER-MONTH COMPARISON — Super Admin only
// Lets the Super Admin step back through recent months and compare revenue +
// attendance rate against the month immediately before it.
// ═══════════════════════════════════════════════════════════════════════════════

function MonthComparisonWidget({ attendance, completedTx }: {
  attendance: AttendanceDoc[]; completedTx: TransactionDoc[];
}) {
  const { user } = useAuthContext();
  const [offset, setOffset] = useState(0);

  // Explicit role gate — this widget must never render for non-Super-Admin
  // users even if it's ever reused outside CommandCenter.
  if (user?.role !== ROLES.SUPER_ADMIN) return null;

  const currentYm  = isoMonthStart(offset);
  const previousYm = isoMonthStart(offset + 1);

  const revenueFor = (ym: string) =>
    completedTx.filter(t => t.date?.startsWith(ym)).reduce((sum, t) => sum + t.amount, 0);

  const attendanceRateFor = (ym: string): number | null => {
    const recs = attendance.filter(a => a.date?.startsWith(ym));
    if (recs.length === 0) return null;
    return Math.round((recs.filter(a => a.status === "present").length / recs.length) * 100);
  };

  const revCurrent  = revenueFor(currentYm);
  const revPrevious = revenueFor(previousYm);
  const revDeltaPct = revPrevious > 0 ? Math.round(((revCurrent - revPrevious) / revPrevious) * 100) : null;

  const attCurrent  = attendanceRateFor(currentYm);
  const attPrevious = attendanceRateFor(previousYm);
  const attDeltaPts = attCurrent !== null && attPrevious !== null ? attCurrent - attPrevious : null;

  return (
    <div style={s.section}>
      <div style={mom.header}>
        <div>
          <div style={s.sectionTitle}>Month-over-Month Comparison</div>
          <div style={s.sectionSub}>{monthLabel(currentYm)} vs {monthLabel(previousYm)}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={{ ...mom.navBtn, opacity: offset >= MOM_MAX_OFFSET ? 0.4 : 1 }}
            disabled={offset >= MOM_MAX_OFFSET}
            onClick={() => setOffset(o => Math.min(o + 1, MOM_MAX_OFFSET))}
          >
            ← Older
          </button>
          <button
            style={{ ...mom.navBtn, opacity: offset <= 0 ? 0.4 : 1 }}
            disabled={offset <= 0}
            onClick={() => setOffset(o => Math.max(o - 1, 0))}
          >
            Newer →
          </button>
        </div>
      </div>
      <div style={mom.grid}>
        <MomCard
          label="Revenue"
          currentLabel={monthLabel(currentYm)} previousLabel={monthLabel(previousYm)}
          currentValue={`₹${revCurrent.toLocaleString("en-IN")}`}
          previousValue={`₹${revPrevious.toLocaleString("en-IN")}`}
          deltaText={revDeltaPct !== null ? `${revDeltaPct >= 0 ? "▲" : "▼"} ${Math.abs(revDeltaPct)}%` : "no prior data"}
          deltaColor={revDeltaPct === null ? "var(--color-text-muted)" : revDeltaPct >= 0 ? "var(--color-success)" : "var(--color-danger)"}
        />
        <MomCard
          label="Attendance Rate"
          currentLabel={monthLabel(currentYm)} previousLabel={monthLabel(previousYm)}
          currentValue={attCurrent !== null ? `${attCurrent}%` : "—"}
          previousValue={attPrevious !== null ? `${attPrevious}%` : "—"}
          deltaText={attDeltaPts !== null ? `${attDeltaPts >= 0 ? "▲" : "▼"} ${Math.abs(attDeltaPts)} pts` : "no prior data"}
          deltaColor={attDeltaPts === null ? "var(--color-text-muted)" : attDeltaPts >= 0 ? "var(--color-success)" : "var(--color-danger)"}
        />
      </div>
    </div>
  );
}

function MomCard({ label, currentLabel, previousLabel, currentValue, previousValue, deltaText, deltaColor }: {
  label: string; currentLabel: string; previousLabel: string;
  currentValue: string; previousValue: string; deltaText: string; deltaColor: string;
}) {
  return (
    <div style={mom.card}>
      <div style={mom.cardLabel}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
        <div style={mom.cardValue}>{currentValue}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: deltaColor }}>{deltaText}</div>
      </div>
      <div style={mom.compareRow}>
        <span>{currentLabel}: <b style={mom.compareStrong}>{currentValue}</b></span>
        <span>{previousLabel}: <b style={mom.compareStrong}>{previousValue}</b></span>
      </div>
    </div>
  );
}

const mom: Record<string, React.CSSProperties> = {
  header:   { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap" as const, gap: 8 },
  navBtn:   { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--color-text-secondary)" },
  grid:     { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 },
  card:     { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "14px 16px" },
  cardLabel: { fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--color-text-muted)" },
  cardValue: { fontSize: 22, fontWeight: 800, color: "var(--color-text-primary)" },
  compareRow: { display: "flex", flexDirection: "column" as const, gap: 2, marginTop: 10, fontSize: 11.5, color: "var(--color-text-muted)" },
  compareStrong: { color: "var(--color-text-primary)" },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CHART PRIMITIVES  (pure SVG, no library)
// ═══════════════════════════════════════════════════════════════════════════════

function ChartCard({ title, sub, children }: { title:string; sub?:string; children:React.ReactNode }) {
  return (
    <div style={{ background:"#fff", border:"1px solid #e5e7eb", borderRadius:12, padding:"18px 20px", marginBottom:0 }}>
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:13, fontWeight:700, color:"#111" }}>{title}</div>
        {sub && <div style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function KpiCard({ label, value, sub, color, onClick }: { label:string; value:string; sub:string; color:string; onClick?:() => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }) : undefined}
      style={{
        background:"#fff", border:`1px solid ${hover && onClick ? color : "#e5e7eb"}`, borderRadius:12, padding:"16px 18px",
        borderTop:`3px solid ${color}`, flex:1, minWidth:140,
        cursor: onClick ? "pointer" : "default",
        boxShadow: hover && onClick ? "0 4px 16px rgba(0,0,0,0.08)" : "0 1px 3px rgba(0,0,0,0.04)",
        transform: hover && onClick ? "translateY(-2px)" : "translateY(0)",
        transition: "box-shadow 0.15s, border-color 0.15s, transform 0.15s",
        outline: "none",
      }}
    >
      <div style={{ fontSize:11, fontWeight:600, color:"#9ca3af", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:11, color:"#6b7280", marginTop:4 }}>{sub}</div>
    </div>
  );
}

// ── Line Chart ────────────────────────────────────────────────────────────────
function LineChart({ data, color, formatValue }: {
  data: { label:string; value:number }[];
  color: string;
  formatValue: (v:number) => string;
}) {
  const W=440, H=110, PL=10, PR=10, PT=20, PB=28;
  const vals   = data.map(d=>d.value);
  const maxV   = Math.max(...vals, 1);
  const minV   = Math.min(...vals, 0);
  const range  = maxV - minV || 1;
  const xStep  = (W-PL-PR) / Math.max(data.length-1, 1);
  const y      = (v:number) => PT + ((maxV - v) / range) * (H - PT - PB);
  const x      = (i:number) => PL + i * xStep;
  const pts    = data.map((_,i)=>`${x(i)},${y(vals[i])}`).join(" ");
  const fill   = data.map((_,i)=>`${x(i)},${y(vals[i])}`).join(" ") + ` ${x(data.length-1)},${H-PB} ${PL},${H-PB}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
      {/* gradient area */}
      <defs>
        <linearGradient id={`lg-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0.01} />
        </linearGradient>
      </defs>
      <polygon points={fill} fill={`url(#lg-${color.replace("#","")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {/* dots + labels */}
      {data.map((d,i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(vals[i])} r={3} fill={color} />
          <text x={x(i)} y={H-PB+13} textAnchor="middle" fontSize={9} fill="#9ca3af">{d.label}</text>
          {(i===0||i===data.length-1) && (
            <text x={x(i)} y={y(vals[i])-7} textAnchor="middle" fontSize={9} fill={color} fontWeight="600">{formatValue(vals[i])}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ── Bar Chart ─────────────────────────────────────────────────────────────────
function BarChart({ data, color, formatValue }: {
  data: { label:string; value:number }[];
  color: string;
  formatValue: (v:number) => string;
}) {
  const W=440, H=120, PL=4, PR=4, PT=20, PB=28;
  const maxV   = Math.max(...data.map(d=>d.value), 1);
  const bW     = (W-PL-PR)/data.length;
  const gap    = bW*0.22;
  const bW2    = bW - gap;
  const bH     = (v:number) => Math.max(4, ((v/maxV)*(H-PT-PB)));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
      <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#e5e7eb" strokeWidth={1} />
      {data.map((d,i) => {
        const barH = bH(d.value);
        const bx   = PL + i*bW + gap/2;
        const by   = H - PB - barH;
        const short = d.label.length>8 ? d.label.slice(0,8)+"…" : d.label;
        return (
          <g key={i}>
            <rect x={bx} y={by} width={bW2} height={barH} rx={3} fill={color} opacity={0.85} />
            <text x={bx+bW2/2} y={by-5} textAnchor="middle" fontSize={9} fill={color} fontWeight="600">{formatValue(d.value)}</text>
            <text x={bx+bW2/2} y={H-PB+13} textAnchor="middle" fontSize={9} fill="#9ca3af">{short}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Stacked Bar Chart ─────────────────────────────────────────────────────────
function StackedBarChart({ data }: {
  data: { name:string; present:number; absent:number; cancelled:number }[];
}) {
  const W=880, H=130, PL=4, PR=4, PT=20, PB=28;
  const totals = data.map(d=>d.present+d.absent+d.cancelled);
  const maxT   = Math.max(...totals, 1);
  const bW     = (W-PL-PR)/data.length;
  const gap    = bW*0.22;
  const bW2    = bW-gap;
  const maxBarH = H-PT-PB;
  const SEG = [
    { key:"present"  as const, color:"#16a34a" },
    { key:"absent"   as const, color:"#dc2626" },
    { key:"cancelled"as const, color:"#9ca3af" },
  ];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
        {data.map((d,i)=>{
          const bx    = PL + i*bW + gap/2;
          const total = totals[i];
          let yOff = H-PB;
          return (
            <g key={i}>
              {SEG.map(seg=>{
                const segH = total>0 ? Math.max(total>0?1:0, Math.round((d[seg.key]/maxT)*maxBarH)) : 0;
                yOff -= segH;
                return <rect key={seg.key} x={bx} y={yOff} width={bW2} height={segH} fill={seg.color} opacity={0.88} />;
              })}
              <text x={bx+bW2/2} y={H-PB+13} textAnchor="middle" fontSize={9} fill="#9ca3af">{d.name}</text>
              {total>0 && <text x={bx+bW2/2} y={H-PB - Math.round((total/maxT)*maxBarH) - 4} textAnchor="middle" fontSize={9} fill="#374151" fontWeight="600">{total}</text>}
            </g>
          );
        })}
        <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#e5e7eb" />
      </svg>
      <div style={{ display:"flex", gap:14, marginTop:6, flexWrap:"wrap" }}>
        {[["#16a34a","Present"],["#dc2626","Absent"],["#9ca3af","Cancelled"]].map(([c,l])=>(
          <div key={l} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, color:"#6b7280" }}>
            <div style={{ width:10, height:10, borderRadius:2, background:c }} />
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Pie Chart ─────────────────────────────────────────────────────────────────
function PieChart({ paid, pending }: { paid:number; pending:number }) {
  const total = paid + pending || 1;
  const paidPct = paid / total;
  const R=60, CX=80, CY=80;
  const arc = (pct:number, r:number) => {
    const angle = pct * 2 * Math.PI - 0.001;
    const x = CX + r * Math.sin(angle);
    const y = CY - r * Math.cos(angle);
    return `M ${CX} ${CY-r} A ${r} ${r} 0 ${angle>Math.PI?1:0} 1 ${x} ${y} Z`;
  };

  return (
    <div style={{ display:"flex", alignItems:"center", gap:24 }}>
      <svg viewBox="0 0 160 160" style={{ width:130, height:130, flexShrink:0 }}>
        <circle cx={CX} cy={CY} r={R} fill="#fee2e2" />
        <path d={arc(paidPct, R)} fill="#16a34a" opacity={0.9} />
        <circle cx={CX} cy={CY} r={R*0.55} fill="#fff" />
        <text x={CX} y={CY+3} textAnchor="middle" fontSize={11} fontWeight="700" fill="#111">
          {Math.round(paidPct*100)}%
        </text>
        <text x={CX} y={CY+15} textAnchor="middle" fontSize={9} fill="#6b7280">Paid</text>
      </svg>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12 }}>
            <div style={{ width:10,height:10,borderRadius:2,background:"#16a34a" }} />
            <span style={{ color:"#374151", fontWeight:600 }}>Collected</span>
          </div>
          <div style={{ fontSize:15, fontWeight:800, color:"#16a34a", marginTop:2 }}>₹{paid.toLocaleString("en-IN")}</div>
        </div>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12 }}>
            <div style={{ width:10,height:10,borderRadius:2,background:"#dc2626" }} />
            <span style={{ color:"#374151", fontWeight:600 }}>Pending</span>
          </div>
          <div style={{ fontSize:15, fontWeight:800, color:"#dc2626", marginTop:2 }}>₹{pending.toLocaleString("en-IN")}</div>
        </div>
      </div>
    </div>
  );
}

// ── Gauge Chart ───────────────────────────────────────────────────────────────
function GaugeChart({ value, goal }: { value:number; goal:number }) {
  const pct   = Math.min(value / goal, 1);
  const R=64, CX=100, CY=90;
  const startAngle = -Math.PI * 0.85;
  const endAngle   =  Math.PI * 0.85;
  const toXY = (angle:number) => ({
    x: CX + R * Math.cos(angle),
    y: CY + R * Math.sin(angle),
  });
  const trackStart = toXY(startAngle);
  const trackEnd   = toXY(endAngle);
  const fillEnd    = toXY(startAngle + (endAngle - startAngle) * pct);
  const arcFlag    = (endAngle - startAngle) * pct > Math.PI ? 1 : 0;
  const fillFlag   = (endAngle - startAngle) > Math.PI ? 1 : 0;
  const color      = pct >= 1 ? "#16a34a" : pct >= 0.6 ? "#f59e0b" : "#dc2626";

  return (
    <svg viewBox="0 0 200 115" style={{ width:"100%", height:115, display:"block" }}>
      {/* track */}
      <path d={`M ${trackStart.x} ${trackStart.y} A ${R} ${R} 0 ${fillFlag} 1 ${trackEnd.x} ${trackEnd.y}`}
        fill="none" stroke="#e5e7eb" strokeWidth={14} strokeLinecap="round" />
      {/* fill */}
      {pct > 0 && (
        <path d={`M ${trackStart.x} ${trackStart.y} A ${R} ${R} 0 ${arcFlag} 1 ${fillEnd.x} ${fillEnd.y}`}
          fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
      )}
      {/* labels */}
      <text x={CX} y={CY-8}  textAnchor="middle" fontSize={20} fontWeight="800" fill={color}>
        {Math.round(pct*100)}%
      </text>
      <text x={CX} y={CY+10} textAnchor="middle" fontSize={10} fill="#6b7280">of target</text>
      <text x={CX} y={CY+24} textAnchor="middle" fontSize={11} fontWeight="700" fill="#374151">
        ₹{(value/1000).toFixed(1)}k / ₹{(goal/1000).toFixed(1)}k
      </text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSES FOR [DATE] — date-navigable widget shared by CommandCenter & AdminDashboard
// Lets an admin step through days (‹ Prev / date picker / Today / Next ›) and see
// each scheduled centre's attendance status for that specific day.
// ═══════════════════════════════════════════════════════════════════════════════

// "scheduled" = the class's day/time hasn't fully elapsed yet (whether that's
// later today or some future date) — its badge shows the actual time slot
// instead of a static label. "pending" = the day/time has passed with no
// attendance recorded.
type ClassDayStatus = "scheduled" | "pending" | "recorded" | "completed";

const CLASS_STATUS_STYLE: Record<ClassDayStatus, { bg: string; border: string; fg: string; label: string | null }> = {
  scheduled: { bg: "var(--color-info-dim)",    border: "var(--color-info)",           fg: "var(--color-info)",    label: null },
  pending:   { bg: "var(--color-danger-dim)",  border: "var(--color-danger-border)",  fg: "var(--color-danger)",  label: "! Pending" },
  recorded:  { bg: "var(--color-warning-dim)", border: "var(--color-warning-border)", fg: "var(--color-warning)", label: "◐ Recorded" },
  completed: { bg: "var(--color-success-dim)", border: "var(--color-success-border)", fg: "var(--color-success)", label: "✓ Completed" },
};

function ClassesForDateWidget({ sectionStyle, headerStyle, titleStyle, subStyle }: {
  sectionStyle: React.CSSProperties;
  headerStyle:  React.CSSProperties;
  titleStyle:   React.CSSProperties;
  subStyle:     React.CSSProperties;
}) {
  const router = useRouter();
  const { wing } = useWing();
  const todayISO = useMemo(() => isoToday(), []);
  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [centers, setCenters] = useState<Center[]>([]);
  const [activeCountByCenter, setActiveCountByCenter] = useState<Record<string, number>>({});
  const [dateAttRecs, setDateAttRecs] = useState<{ centerId: string; status: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [centersData, studentsSnap, attSnap] = await Promise.all([
          getCenters(wing),
          getDocs(query(collection(db, "users"), where("role", "==", "student"), where("status", "==", "active"))),
          getDocs(query(collection(db, "attendance"), where("date", "==", selectedDate))),
        ]);
        if (cancelled) return;
        const cidSet = new Set(centersData.map(c => c.id));
        setCenters(centersData);
        const counts: Record<string, number> = {};
        studentsSnap.docs.forEach(d => {
          const cid = (d.data().centerId ?? "") as string;
          if (cid && cidSet.has(cid)) counts[cid] = (counts[cid] ?? 0) + 1;
        });
        setActiveCountByCenter(counts);
        setDateAttRecs(attSnap.docs
          .map(d => ({
            centerId: (d.data().centerId ?? "") as string,
            status:   (d.data().status   ?? "") as string,
          }))
          .filter(r => cidSet.has(r.centerId)));
      } catch (err) {
        console.error("[ClassesForDateWidget] load error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedDate, wing]);

  const dow = useMemo(() => DAY_ABBR[new Date(selectedDate + "T00:00:00").getDay()], [selectedDate]);
  const dateCentres = useMemo(
    () => centers.filter(c => ((c as Center & { daysOfWeek?: string[] }).daysOfWeek ?? []).includes(dow)),
    [centers, dow]
  );

  const attByCenter = useMemo(() => {
    const m = new Map<string, { centerId: string; status: string }[]>();
    dateAttRecs.forEach(r => {
      if (!r.centerId) return;
      if (!m.has(r.centerId)) m.set(r.centerId, []);
      m.get(r.centerId)!.push(r);
    });
    return m;
  }, [dateAttRecs]);

  // Compares the card's scheduled classDate (and, for today, the class's own
  // end time) against the current moment: only once that has fully elapsed
  // with no attendance recorded does the badge switch to "Pending". Before
  // that — later today, or any future date — it reads as "scheduled" and
  // shows the actual time slot instead of a generic label.
  function statusFor(centerId: string, timeSlot: string): ClassDayStatus {
    const recs = attByCenter.get(centerId) ?? [];
    if (recs.length === 0) {
      const isPastDay        = selectedDate < todayISO;
      const isTodayAndEnded  = selectedDate === todayISO && classHasEnded(timeSlot);
      if (isPastDay || isTodayAndEnded) return "pending";
      return "scheduled";
    }
    const expected = activeCountByCenter[centerId] ?? 0;
    if (expected > 0 && recs.length >= expected) return "completed";
    return "recorded";
  }

  const isToday    = selectedDate === todayISO;
  const dateObj     = new Date(selectedDate + "T00:00:00");
  const dateLabel   = dateObj.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const sectionTitle = isToday ? "Today's Classes" : `Classes for ${dateObj.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;

  const pendingCount = useMemo(
    () => dateCentres.filter(c => statusFor(c.id, c.timeSlot ?? "") === "pending").length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dateCentres, attByCenter, activeCountByCenter, selectedDate]
  );

  const navBtn: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "var(--color-text-primary)", background: "var(--color-surface-2)",
    border: "1px solid var(--color-border)", borderRadius: 8, padding: "6px 12px", cursor: "pointer", lineHeight: 1,
  };

  if (dateCentres.length === 0 && !loading) return null;

  return (
    <div style={{ ...sectionStyle, marginBottom: 16 }}>
      <div style={{ ...headerStyle, marginBottom: 14, flexWrap: "wrap" as const, gap: 10 }}>
        <div>
          <span style={titleStyle}>{sectionTitle}</span>
          <div style={{ ...subStyle, marginTop: 2 }}>
            {dateLabel}{pendingCount > 0 ? ` · ${pendingCount} pending` : ""}{loading ? " · loading…" : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button style={navBtn} onClick={() => setSelectedDate(d => addDaysISO(d, -1))}>‹ Prev</button>
          <input
            type="date"
            value={selectedDate}
            onChange={e => e.target.value && setSelectedDate(e.target.value)}
            style={{ ...navBtn, cursor: "pointer" }}
          />
          <button
            style={{ ...navBtn, ...(isToday ? { opacity: 0.5, cursor: "default" } : {}) }}
            disabled={isToday}
            onClick={() => setSelectedDate(todayISO)}
          >
            Today
          </button>
          <button style={navBtn} onClick={() => setSelectedDate(d => addDaysISO(d, 1))}>Next ›</button>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {dateCentres.map(c => {
          const status = statusFor(c.id, c.timeSlot ?? "");
          const st = CLASS_STATUS_STYLE[status];
          const badgeText = st.label ?? fmtTimeSlotRange(c.timeSlot ?? "");
          return (
            <button
              key={c.id}
              onClick={() => router.push("/dashboard/attendance")}
              style={{
                background: st.bg, border: `1px solid ${st.border}`,
                borderRadius: 10, padding: "12px 16px",
                textAlign: "left", cursor: "pointer",
                display: "flex", flexDirection: "column", gap: 5, minWidth: 130,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: st.fg }}>{badgeText}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.3 }}>{c.name}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY ATTENDANCE BREAKDOWN — Class-1 vs Class-2
// Groups each active student's scheduled classes for a Mon–Sun week; their
// chronologically-first scheduled class = Class-1, second = Class-2.
// ═══════════════════════════════════════════════════════════════════════════════

interface WeeklyStudentDoc {
  uid:       string;
  name:      string;
  centerId:  string;
  status:    string;
  classType: string;
  classDays: string[];
}

interface WeeklyAttendanceDoc {
  studentUid: string;
  date:       string;
  status:     string;
}

interface ClassBucket {
  present:        number;
  absent:         number;
  pending:        number;
  cancelledBreak: number;
  total:          number;
}

function emptyBucket(): ClassBucket {
  return { present: 0, absent: 0, pending: 0, cancelledBreak: 0, total: 0 };
}

// A status bucket, minus "total" (which has no single matching attendance record).
type BucketKey = "present" | "absent" | "pending" | "cancelledBreak";

const BUCKET_LABEL: Record<BucketKey, string> = {
  present: "Present", absent: "Absent", pending: "Pending", cancelledBreak: "Cancelled/Break",
};
const BUCKET_COLOR: Record<BucketKey, { bg: string; fg: string; border: string }> = {
  present:        { bg: "#f0fdf4", fg: "#16a34a", border: "#bbf7d0" },
  absent:         { bg: "#fef2f2", fg: "#dc2626", border: "#fecaca" },
  pending:        { bg: "#fffbeb", fg: "#f59e0b", border: "#fde68a" },
  cancelledBreak: { bg: "#f9fafb", fg: "#6b7280", border: "#e5e7eb" },
};

// One scheduled class-slot occurrence for one student in the selected week.
interface WeeklyEntry {
  studentUid:   string;
  studentName:  string;
  centerName:   string;
  date:         string;
  classSlot:    1 | 2;
  bucket:       BucketKey;
}

function WeeklyClassBreakdown() {
  const { wing } = useWing();
  const [weekOffset, setWeekOffset] = useState(0);
  const [centers,  setCenters]  = useState<Center[]>([]);
  const [students, setStudents] = useState<WeeklyStudentDoc[]>([]);
  const [records,  setRecords]  = useState<WeeklyAttendanceDoc[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [drill,    setDrill]    = useState<{ classSlot: 1 | 2; bucket: BucketKey } | null>(null);

  const weekStart = useMemo(() => addDaysISO(mondayOf(isoToday()), weekOffset * 7), [weekOffset]);
  const weekEnd   = useMemo(() => addDaysISO(weekStart, 6), [weekStart]);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i)), [weekStart]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [centersData, studentsSnap, attSnap] = await Promise.all([
          getCenters(wing),
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "attendance"), where("date", ">=", weekStart), where("date", "<=", weekEnd))),
        ]);
        if (cancelled) return;
        const cidSet = new Set(centersData.map(c => c.id));
        setCenters(centersData);
        setStudents(studentsSnap.docs
          .filter(d => { const cid = (d.data().centerId ?? "") as string; return cid && cidSet.has(cid); })
          .map(d => {
          const data = d.data();
          return {
            uid:       d.id,
            name:      (data.displayName ?? data.name ?? "—") as string,
            centerId:  (data.centerId ?? "") as string,
            status:    (data.status ?? data.studentStatus ?? "active") as string,
            classType: (data.classType ?? "group") as string,
            classDays: Array.isArray(data.classDays) ? (data.classDays as string[]) : [],
          };
        }));
        setRecords(attSnap.docs.map(d => {
          const data = d.data();
          return {
            studentUid: (data.studentUid ?? "") as string,
            date:       (data.date ?? "") as string,
            status:     (data.status ?? "") as string,
          };
        }));
      } catch (err) {
        console.error("[WeeklyClassBreakdown] load error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [weekStart, weekEnd, wing]);

  const centerDaysMap = useMemo(() => {
    const m = new Map<string, string[]>();
    centers.forEach(c => m.set(c.id, ((c as Center & { daysOfWeek?: string[] }).daysOfWeek) ?? []));
    return m;
  }, [centers]);

  const centerNameMap = useMemo(() => {
    const m = new Map<string, string>();
    centers.forEach(c => m.set(c.id, c.name));
    return m;
  }, [centers]);

  const attMap = useMemo(() => {
    const m = new Map<string, string>();
    records.forEach(r => m.set(`${r.studentUid}|${r.date}`, r.status));
    return m;
  }, [records]);

  const { class1, class2, entries } = useMemo(() => {
    const class1 = emptyBucket();
    const class2 = emptyBucket();
    const entries: WeeklyEntry[] = [];

    const activeStudents = students.filter(s => s.status !== "inactive" && s.status !== "deactivation_requested");

    activeStudents.forEach(st => {
      const scheduleDays = st.classType === "personal" && st.classDays.length > 0
        ? st.classDays
        : (centerDaysMap.get(st.centerId) ?? []);
      if (scheduleDays.length === 0) return;

      const scheduledDates = weekDates.filter(d => scheduleDays.includes(DAY_ABBR[new Date(d + "T00:00:00").getDay()]));

      scheduledDates.slice(0, 2).forEach((date, idx) => {
        const classSlot: 1 | 2 = idx === 0 ? 1 : 2;
        const bucketObj = idx === 0 ? class1 : class2;
        const status = attMap.get(`${st.uid}|${date}`);
        let bucket: BucketKey;
        if (status === "present") bucket = "present";
        else if (status === "absent") bucket = "absent";
        else if (status === "break" || status?.startsWith("cancelled")) bucket = "cancelledBreak";
        else bucket = "pending";

        bucketObj.total++;
        bucketObj[bucket]++;
        entries.push({
          studentUid:  st.uid,
          studentName: st.name,
          centerName:  centerNameMap.get(st.centerId) ?? "—",
          date,
          classSlot,
          bucket,
        });
      });
    });

    return { class1, class2, entries };
  }, [students, centerDaysMap, centerNameMap, attMap, weekDates]);

  const weekLabel = `${new Date(weekStart + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${new Date(weekEnd + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
  const isCurrentWeek = weekOffset === 0;
  const weekBtn: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };

  const tiles = (m: ClassBucket) => [
    { label: "Present",         value: m.present,        color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", bucket: "present"        as BucketKey | null },
    { label: "Absent",          value: m.absent,          color: "#dc2626", bg: "#fef2f2", border: "#fecaca", bucket: "absent"         as BucketKey | null },
    { label: "Pending",         value: m.pending,         color: "#f59e0b", bg: "#fffbeb", border: "#fde68a", bucket: "pending"        as BucketKey | null },
    { label: "Cancelled/Break", value: m.cancelledBreak,  color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", bucket: "cancelledBreak" as BucketKey | null },
    { label: "Total",           value: m.total,           color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe", bucket: null },
  ];

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap" as const, gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Weekly Attendance Breakdown</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
            {weekLabel} · Class-1 vs Class-2 · all active students{loading ? " · loading…" : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={weekBtn} onClick={() => setWeekOffset(o => o - 1)}>‹ Prev</button>
          <button style={{ ...weekBtn, ...(isCurrentWeek ? { opacity: 0.5, cursor: "default" } : {}) }} disabled={isCurrentWeek} onClick={() => setWeekOffset(0)}>This Week</button>
          <button style={weekBtn} onClick={() => setWeekOffset(o => o + 1)}>Next ›</button>
        </div>
      </div>

      {[{ title: "Class-1", data: class1, classSlot: 1 as const }, { title: "Class-2", data: class2, classSlot: 2 as const }].map(({ title, data, classSlot }, i) => (
        <div key={title} style={{ marginTop: i === 0 ? 0 : 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 8 }}>{title}</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
            {tiles(data).map(({ label, value, color, bg, border, bucket }) => {
              const clickable = bucket !== null;
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!clickable}
                  onClick={clickable ? () => setDrill({ classSlot, bucket }) : undefined}
                  title={clickable ? `View students — ${title} · ${label}` : undefined}
                  style={{
                    background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: "12px 20px", minWidth: 100,
                    textAlign: "center" as const, font: "inherit", cursor: clickable ? "pointer" : "default",
                  }}
                >
                  <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginTop: 4, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>{label}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {drill && (
        <WeeklyDrillDownModal
          classSlot={drill.classSlot}
          bucket={drill.bucket}
          entries={entries}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ── Drill-down: student list for one Class-1/Class-2 × status combination ──────
function WeeklyDrillDownModal({ classSlot, bucket, entries, onClose }: {
  classSlot: 1 | 2; bucket: BucketKey; entries: WeeklyEntry[]; onClose: () => void;
}) {
  const rows = useMemo(
    () => entries
      .filter(e => e.classSlot === classSlot && e.bucket === bucket)
      .sort((a, b) => a.studentName.localeCompare(b.studentName)),
    [entries, classSlot, bucket]
  );
  const color = BUCKET_COLOR[bucket];

  return (
    <div style={dmodal.overlay} onClick={onClose}>
      <div style={dmodal.box} onClick={e => e.stopPropagation()}>
        <div style={dmodal.header}>
          <div>
            <div style={dmodal.title}>Class-{classSlot} · {BUCKET_LABEL[bucket]}</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>{rows.length} student{rows.length === 1 ? "" : "s"}</div>
          </div>
          <button onClick={onClose} style={dmodal.closeBtn}>✕</button>
        </div>
        <div style={dmodal.body}>
          {rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "#9ca3af", textAlign: "center" as const, padding: "30px 0" }}>No students in this category.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
              {rows.map(r => (
                <div key={`${r.studentUid}|${r.date}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", border: "1px solid #f3f4f6", borderRadius: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{r.studentName}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{r.centerName}</div>
                  </div>
                  <div style={{ textAlign: "right" as const }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: color.fg, background: color.bg, border: `1px solid ${color.border}`, borderRadius: 99, padding: "3px 10px" }}>
                      {BUCKET_LABEL[bucket]}
                    </span>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                      {new Date(r.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const dmodal: Record<string, React.CSSProperties> = {
  overlay:  { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  box:      { background: "#fff", borderRadius: 16, width: "100%", maxWidth: 480, maxHeight: "80vh", display: "flex", flexDirection: "column" as const, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", overflow: "hidden" },
  header:   { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  title:    { fontSize: 15, fontWeight: 700, color: "#111827" },
  closeBtn: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 },
  body:     { padding: "16px 20px", overflowY: "auto" as const, flex: 1 },
};

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
  const { wing } = useWing();
  const router   = useRouter();

  const today     = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const thisMonth = useMemo(() => today.slice(0, 7), [today]);
  // Last 3 months including current
  const months3   = useMemo(() => [thisMonth, isoMonthStart(1), isoMonthStart(2)], [thisMonth]);

  const [students,  setStudents]  = useState<AdminStudentDoc[]>([]);
  const [teachers,  setTeachers]  = useState<AdminTeacherDoc[]>([]);
  const [centers,   setCenters]   = useState<Center[]>([]);
  const [txList,    setTxList]    = useState<{ month: string; amount: number; studentUid: string; status: string; type: string; method: string; billingMonth: string }[]>([]);
  const [billing,   setBilling]   = useState<Record<string, BillingMonthStatus>>({});
  const [monthAttRecs, setMonthAttRecs] = useState<{ centerId: string; status: string; markedBy: string; markedAt: string; date: string }[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [completing,      setCompleting]      = useState<string | null>(null); // month being marked complete
  const [showPending,       setShowPending]       = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    async function load() {
      try {
        const [studSnap, teachSnap, centersData, txSnap, ...billingSnaps] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getCenters(wing),
          getDocs(query(collection(db, "transactions"), where("date", ">=", isoMonthStart(2)))),
          ...months3.map(m => getDoc(doc(db, "billing_months", m))),
        ]);

        const wingCenterIds = new Set(centersData.map(c => c.id));

        const studs: AdminStudentDoc[] = studSnap.docs
          .filter(d => inWing(d.data(), wing))
          .map(d => ({
          uid:            d.id,
          centerId:       (d.data().centerId   ?? "") as string,
          status:         (d.data().status ?? d.data().studentStatus ?? "active") as string,
          classType:      (d.data().classType  ?? "group") as string,
          currentBalance: Number(d.data().currentBalance ?? 0),
          createdAt:      (d.data().createdAt  ?? "") as string,
          lastBilledMonth:(d.data().lastBilledMonth ?? null) as string | null,
        }));
        setStudents(studs);

        setTeachers(teachSnap.docs
          .filter(d => inWing(d.data(), wing))
          .map(d => ({
            uid:         d.id,
            displayName: (d.data().displayName ?? d.data().name ?? "—") as string,
            centerIds:   (d.data().centerIds   ?? []) as string[],
            status:      (d.data().status      ?? "active") as string,
          })));

        setCenters(centersData);

        const txs = txSnap.docs
          .filter(d => {
            const cid = (d.data().centerId ?? "") as string;
            return !cid || wingCenterIds.has(cid);
          })
          .map(d => ({
            month:        ((d.data().date as string | undefined) ?? "").slice(0, 7),
            amount:       Number(d.data().amount ?? 0),
            studentUid:   (d.data().studentUid   ?? "") as string,
            status:       (d.data().status        ?? "") as string,
            type:         (d.data().type          ?? "") as string,
            method:       (d.data().method        ?? "") as string,
            billingMonth: (d.data().billingMonth  ?? "") as string,
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
  }, [user?.uid, today, wing]);

  // ── Real-time attendance listener — covers the full current month ─────────
  useEffect(() => {
    if (!user) return;
    const monthStart = thisMonth + "-01";
    const q = query(collection(db, "attendance"), where("date", ">=", monthStart));
    const unsub = onSnapshot(q, snap => {
      setMonthAttRecs(snap.docs
        .filter(d => ((d.data().date as string | undefined) ?? "").startsWith(thisMonth))
        .map(d => ({
          centerId: (d.data().centerId ?? "") as string,
          status:   (d.data().status   ?? "") as string,
          markedBy: (d.data().markedBy ?? "") as string,
          markedAt: (d.data().markedAt ?? "") as string,
          date:     (d.data().date     ?? "") as string,
        })));
    });
    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, thisMonth]);

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
  const feeDueMap = useMemo(() => {
    const m = new Map<string, number>();
    txList.forEach(tx => {
      if (!tx.studentUid || tx.type !== "fee_due") return;
      const bm = tx.billingMonth || tx.month;
      if (bm === thisMonth) m.set(tx.studentUid, tx.amount);
    });
    return m;
  }, [txList, thisMonth]);

  const paidSet = useMemo(() => {
    const s = new Set<string>();
    txList.forEach(tx => {
      if (!tx.studentUid || tx.status !== "completed" || tx.month !== thisMonth) return;
      if (tx.type === "fee_due" || tx.type === "charge" || tx.method === "auto" || tx.method === "auto-monthly") return;
      s.add(tx.studentUid);
    });
    return s;
  }, [txList, thisMonth]);

  const pendingFeeAmt = useMemo(() => {
    let amt = 0;
    feeDueMap.forEach((fee, uid) => { if (!paidSet.has(uid)) amt += fee; });
    return amt;
  }, [feeDueMap, paidSet]);

  const pendingFeeCount = useMemo(() => {
    let n = 0;
    feeDueMap.forEach((_, uid) => { if (!paidSet.has(uid)) n++; });
    return n;
  }, [feeDueMap, paidSet]);
  // Today's records derived from the month listener
  const todayAttRecs = useMemo(() => monthAttRecs.filter(r => r.date === today), [monthAttRecs, today]);

  const attStats = useMemo(() =>
    todayAttRecs.length > 0
      ? { present: todayAttRecs.filter(r => r.status === "present").length, total: todayAttRecs.length }
      : null,
  [todayAttRecs]);
  const attPct          = attStats && attStats.total > 0 ? Math.round((attStats.present / attStats.total) * 100) : null;
  const attBad          = attPct !== null && attPct < 60;

  // Monthly attendance totals — every student remark counts
  const monthlyTotals = useMemo(() => ({
    present:   monthAttRecs.filter(r => r.status === "present").length,
    absent:    monthAttRecs.filter(r => r.status === "absent").length,
    break:     monthAttRecs.filter(r => r.status === "break").length,
    cancelled: monthAttRecs.filter(r => r.status?.startsWith("cancelled")).length,
    total:     monthAttRecs.length,
  }), [monthAttRecs]);

  // This month billing
  const thisMonthBilling = billing[thisMonth];
  const activeCount      = students.filter(s => s.status === "active").length;
  const billedThisMonth  = thisMonthBilling?.billedCount ?? 0;
  const paidThisMonth    = thisMonthBilling?.paidCount ?? 0;
  const collectedThisMonth = thisMonthBilling?.collectedAmt ?? 0;
  const unbilledCount    = activeCount - billedThisMonth;
  const unpaidCount      = billedThisMonth - paidThisMonth;

  // Teacher name lookup
  const adminTeacherMap = useMemo(() => {
    const m: Record<string, string> = {};
    teachers.forEach(t => { m[t.uid] = t.displayName; });
    return m;
  }, [teachers]);

  // Any attendance record for a centre today = marked (regardless of status or count)
  const markedCentreIds = useMemo(() => {
    const s = new Set<string>();
    todayAttRecs.forEach(r => { if (r.centerId) s.add(r.centerId); });
    return s;
  }, [todayAttRecs]);

  // Info for the notification panel — one entry per marked centre
  const markedCentresInfo = useMemo(() => Array.from(markedCentreIds).map(cid => {
    const centre = centers.find(c => c.id === cid);
    const recs   = todayAttRecs.filter(r => r.centerId === cid);
    const first  = [...recs].sort((a, b) => a.markedAt.localeCompare(b.markedAt))[0];
    const markedTime  = first?.markedAt
      ? new Date(first.markedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
      : "";
    const teacherName = adminTeacherMap[first?.markedBy ?? ""] ?? "";
    const p  = recs.filter(r => r.status === "present").length;
    const a  = recs.filter(r => r.status === "absent").length;
    const br = recs.filter(r => r.status === "break").length;
    const ca = recs.filter(r => r.status?.startsWith("cancelled")).length;
    const parts: string[] = [];
    if (p  > 0) parts.push(`${p} present`);
    if (a  > 0) parts.push(`${a} absent`);
    if (br > 0) parts.push(`${br} break`);
    if (ca > 0) parts.push("cancelled");
    return {
      cid, name: centre?.name ?? "Centre", markedTime, teacherName,
      summary: parts.join(" · ") || `${recs.length} marked`,
    };
  }), [markedCentreIds, todayAttRecs, centers, adminTeacherMap]);

  // Today's classes
  const todayDow    = useMemo(() => DAY_ABBR[new Date(today + "T00:00:00").getDay()], [today]);
  const todayCentres = useMemo(() =>
    centers.filter(c => ((c as Center & { daysOfWeek?: string[] }).daysOfWeek ?? []).includes(todayDow)),
    [centers, todayDow]
  );

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
      {(() => {
        const pendingCentres = todayCentres.filter(c => !markedCentreIds.has(c.id) && classHasEnded(c.timeSlot ?? ""));
        const pendingCount   = pendingCentres.length;
        return (
          <>
            <div style={adm.header}>
              <div>
                <div style={adm.eyebrow}>Center Suite</div>
                <div style={adm.date}>
                  {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </div>
                <div style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
                  Welcome back, {user?.displayName}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                {/* Notification icon */}
                <button
                  title="Notifications"
                  onClick={() => { setShowNotifications(v => !v); setShowPending(false); }}
                  style={{
                    position: "relative", width: 38, height: 38, borderRadius: "50%", border: "1px solid var(--color-border)",
                    background: showNotifications ? "var(--color-accent-dim,#ede9fe)" : "var(--color-surface-2)",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
                  }}>
                  🔔
                  {markedCentreIds.size > 0 && (
                    <span style={{
                      position: "absolute", top: 1, right: 1, background: "#16a34a", color: "#fff",
                      borderRadius: "50%", width: 15, height: 15, fontSize: 8, fontWeight: 800,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {markedCentreIds.size}
                    </span>
                  )}
                </button>
                {/* Pending icon */}
                <button
                  title="Pending tasks"
                  onClick={() => { setShowPending(v => !v); setShowNotifications(false); }}
                  style={{
                    position: "relative", width: 38, height: 38, borderRadius: "50%", border: "1px solid var(--color-border)",
                    background: showPending ? "var(--color-accent-dim,#ede9fe)" : "var(--color-surface-2)",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
                  }}>
                  ⏳
                  {pendingCount > 0 && (
                    <span style={{
                      position: "absolute", top: 1, right: 1, background: "#ef4444", color: "#fff",
                      borderRadius: "50%", width: 15, height: 15, fontSize: 8, fontWeight: 800,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {pendingCount}
                    </span>
                  )}
                </button>
                <div style={{ width: 1, height: 28, background: "var(--color-border)", margin: "0 2px" }} />
                <div style={adm.quickActions}>
                  <button style={adm.qaBtn} onClick={() => router.push("/dashboard/students")}>+ Student</button>
                  <button style={adm.qaBtn} onClick={() => router.push("/dashboard/teachers")}>+ Teacher</button>
                  <button style={adm.qaBtn} onClick={() => router.push("/dashboard/centers")}>+ Centre</button>
                  <button style={{ ...adm.qaBtn, ...adm.qaBtnPrimary }} onClick={() => router.push("/dashboard/finance")}>Finance →</button>
                </div>
              </div>
            </div>

            {/* Notification panel */}
            {showNotifications && (
              <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, marginBottom: 16, overflow: "hidden", boxShadow: "var(--shadow-sm)" }}>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)" }}>🔔 Attendance — Today</span>
                  <button onClick={() => setShowNotifications(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: 16 }}>✕</button>
                </div>
                {markedCentresInfo.length === 0 ? (
                  <div style={{ padding: "28px 20px", textAlign: "center", fontSize: 13, color: "var(--color-text-muted)" }}>
                    No attendance marked yet today
                  </div>
                ) : (
                  <div style={{ padding: "0 20px 8px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", padding: "12px 0 6px" }}>
                      Marked today
                    </div>
                    {markedCentresInfo.map((info, i) => (
                      <div key={info.cid} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--color-border)" }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-success)" }}>✓ {info.name}</div>
                          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 3 }}>
                            {info.summary}{info.teacherName ? ` · by ${info.teacherName}` : ""}
                          </div>
                        </div>
                        {info.markedTime && (
                          <span style={{ fontSize: 11, fontWeight: 700, background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 99, padding: "3px 10px", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 2 }}>
                            {info.markedTime}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Pending panel */}
            {showPending && (() => {
              const unmarked = todayCentres.filter(c => !markedCentreIds.has(c.id) && classHasEnded(c.timeSlot ?? ""));
              // Group by teacher
              const byTeacher: Record<string, { teacherName: string; centres: string[] }> = {};
              unmarked.forEach(c => {
                const tUid  = (c as Center & { teacherUid?: string }).teacherUid ?? "";
                const tName = adminTeacherMap[tUid] ?? "Unassigned";
                if (!byTeacher[tUid]) byTeacher[tUid] = { teacherName: tName, centres: [] };
                byTeacher[tUid].centres.push(c.name);
              });
              const rows = Object.values(byTeacher);
              return (
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, marginBottom: 16, overflow: "hidden", boxShadow: "var(--shadow-sm)" }}>
                  <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)" }}>⏳ Pending Tasks</span>
                    <button onClick={() => setShowPending(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: 16 }}>✕</button>
                  </div>
                  {rows.length === 0 ? (
                    <div style={{ padding: "24px 20px", textAlign: "center", fontSize: 13, color: "var(--color-success)", fontWeight: 600 }}>
                      ✅ All caught up — every centre has attendance marked today!
                    </div>
                  ) : (
                    <div style={{ padding: "0 20px 8px" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", padding: "12px 0 6px" }}>
                        Teachers who haven't marked attendance today
                      </div>
                      {rows.map((row, i) => (
                        <div key={row.teacherName} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--color-border)" }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" }}>{row.teacherName}</div>
                            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 3 }}>
                              {row.centres.join(" · ")}
                            </div>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 99, padding: "3px 10px", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 2 }}>
                            {row.centres.length} centre{row.centres.length > 1 ? "s" : ""} pending
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        );
      })()}

      {/* ── KPI STRIP ── */}
      <div style={adm.kpiStrip}>
        <KpiTile label="Students" value={loading ? "…" : String(students.length)} sub={loading ? "" : isSchoolOfMusic(wing) ? `${activeStudents} active` : `${activeStudents} active · ${groupStudents} group · ${personalStudents} personal`} />
        <div style={adm.kpiDiv} />
        <KpiTile label="Centres" value={loading ? "…" : String(centers.length)} sub={`${centers.filter(c => c.status === "active").length} active`} />
        <div style={adm.kpiDiv} />
        <KpiTile label="Teachers" value={loading ? "…" : String(teachers.length)} sub={`${teachers.filter(t => t.status === "active").length} active`} />
        <div style={adm.kpiDiv} />
        <KpiTile
          label="Attendance Today"
          value={loading ? "…" : !attStats ? "—" : `${attPct ?? 0}%`}
          sub={loading ? "" : !attStats ? "No records yet" : `${attStats.present} / ${attStats.total} present`}
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

      {/* ── CLASSES FOR [DATE] ── */}
      <ClassesForDateWidget sectionStyle={adm.section} headerStyle={adm.secHeader} titleStyle={adm.secTitle} subStyle={adm.secSub} />

      {/* ── MONTHLY ATTENDANCE TOTALS ── */}
      <div style={adm.section}>
        <div style={adm.secHeader}>
          <span style={adm.secTitle}>Attendance This Month</span>
          <span style={adm.secSub}>{monthLabel(thisMonth)} · all student records</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
          {[
            { label: "Present",   value: monthlyTotals.present,   color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
            { label: "Absent",    value: monthlyTotals.absent,     color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
            { label: "Break",     value: monthlyTotals.break,      color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
            { label: "Cancelled", value: monthlyTotals.cancelled,  color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
            { label: "Total",     value: monthlyTotals.total,      color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
          ].map(({ label, value, color, bg, border }) => (
            <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: "12px 20px", minWidth: 100, textAlign: "center" as const }}>
              <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginTop: 4, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── WEEKLY ATTENDANCE BREAKDOWN (Class-1 vs Class-2) ── */}
      <WeeklyClassBreakdown />

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
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },

  // Table
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:    { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)", whiteSpace: "nowrap" as const },
  tr:    { borderBottom: "1px solid var(--color-border-subtle)" },
  td:    { padding: "12px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },
  rank:       { fontSize: 11, color: "var(--color-text-muted)", marginRight: 6, minWidth: 24 },
  viewAllBtn: { background: "none", border: "none", color: "var(--color-accent,#4f46e5)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 },
  centreRow:  { display: "flex", alignItems: "center", padding: "11px 16px", borderBottom: "1px solid var(--color-border,#f3f4f6)", cursor: "pointer", gap: 8 },

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
