"use client";

import { useState, useEffect, useMemo } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useRouter } from "next/navigation";
import { getAllTeacherQuality } from "@/services/quality/quality.service";
import type { TeacherQuality } from "@/types/quality";
import type { Center } from "@/types";

// ─── Local types ───────────────────────────────────────────────────────────────

interface StudentDoc {
  uid:            string;
  centerId:       string;
  status:         string;
  currentBalance: number;
  instrument:     string;
  course:         string;
  createdAt:      string;
}

interface TeacherDoc {
  uid:        string;
  displayName:string;
  centerIds:  string[];
  status:     string;
  lastActivity: string | null;
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
  date:       string;       // YYYY-MM-DD
  status:     string;
}

interface CenterStats {
  center:         Center;
  studentCount:   number;
  activeCount:    number;
  attendancePct:  number | null;   // last 7 days avg
  teacherName:    string;
  pendingFeeCount:number;
  revenue30d:     number;
  growthPct:      number | null;   // % change in student count vs previous 30d period
}

interface SystemData {
  students:     StudentDoc[];
  teachers:     TeacherDoc[];
  centers:      Center[];
  attendance:   AttendanceDoc[];
  transactions: TransactionDoc[];
  quality:      TeacherQuality[];
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

function isoMonthStart(offset = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  return d.toISOString().slice(0, 7);   // YYYY-MM
}

// ─── Page shell ────────────────────────────────────────────────────────────────

export default function SuperAdminPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN]}>
      <SuperAdminContent />
    </ProtectedRoute>
  );
}

// ─── Main content ──────────────────────────────────────────────────────────────

function SuperAdminContent() {
  const router = useRouter();
  const [data,    setData]    = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [
          studentSnap,
          teacherSnap,
          centerSnap,
          attendanceSnap,
          transactionSnap,
          quality,
        ] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
          getDocs(collection(db, "centers")),
          getDocs(collection(db, "attendance")),
          getDocs(collection(db, "transactions")),
          getAllTeacherQuality(),
        ]);

        const students: StudentDoc[] = studentSnap.docs.map(d => {
          const s = d.data();
          return {
            uid:            d.id,
            centerId:       (s.centerId ?? "") as string,
            status:         ((s.status ?? s.studentStatus ?? "active") as string),
            currentBalance: Number(s.currentBalance ?? 0),
            instrument:     (s.instrument ?? "") as string,
            course:         (s.course ?? "") as string,
            createdAt:      (s.createdAt?.toDate?.()?.toISOString() ?? s.createdAt ?? "") as string,
          };
        });

        const teachers: TeacherDoc[] = teacherSnap.docs.map(d => {
          const t = d.data();
          return {
            uid:          d.id,
            displayName:  (t.displayName ?? t.name ?? d.id) as string,
            centerIds:    (t.centerIds as string[]) ?? [],
            status:       (t.status ?? "active") as string,
            lastActivity: (t.lastActivity ?? null) as string | null,
          };
        });

        const centers: Center[] = centerSnap.docs.map(d => ({
          id: d.id, ...d.data(),
        }) as Center);

        const attendance: AttendanceDoc[] = attendanceSnap.docs.map(d => {
          const a = d.data();
          return {
            centerId:   (a.centerId ?? "") as string,
            studentUid: (a.studentUid ?? "") as string,
            date:       (a.date ?? "") as string,
            status:     (a.status ?? "absent") as "present" | "absent",
          };
        });

        const transactions: TransactionDoc[] = transactionSnap.docs.map(d => {
          const t = d.data();
          return {
            studentUid: (t.studentUid ?? "") as string,
            centerId:   (t.centerId ?? "") as string,
            amount:     Number(t.amount ?? 0),
            date:       (t.date ?? "") as string,
            status:     (t.status ?? "completed") as string,
          };
        });

        setData({ students, teachers, centers, attendance, transactions, quality });
      } catch (err) {
        console.error("SuperAdmin load error:", err);
        setError("Failed to load system data.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return (
    <div style={s.loadingShell}>
      <div style={s.spinner} />
      <span style={s.loadingText}>Loading system data…</span>
    </div>
  );

  if (error || !data) return (
    <div style={s.errorShell}>{error ?? "No data available."}</div>
  );

  return <Dashboard data={data} router={router} />;
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ data, router }: { data: SystemData; router: ReturnType<typeof useRouter> }) {
  const today     = isoToday();
  const days7ago  = isoDaysAgo(7);
  const days30ago = isoDaysAgo(30);
  const thisMonth = isoMonthStart(0);
  const lastMonth = isoMonthStart(1);

  // ── Build teacher name map ──────────────────────────────────────────────────
  const teacherNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    data.teachers.forEach(t => { m[t.uid] = t.displayName; });
    return m;
  }, [data.teachers]);

  // ── Global metrics ──────────────────────────────────────────────────────────
  const totalStudents   = data.students.length;
  const activeStudents  = data.students.filter(s => s.status === "active").length;
  const inactiveStudents= data.students.filter(s => s.status === "inactive").length;
  const pendingDeact    = data.students.filter(s => s.status === "deactivation_requested").length;
  const totalTeachers   = data.teachers.length;
  const activeTeachers  = data.teachers.filter(t => t.status === "active").length;
  const totalCenters    = data.centers.length;
  const activeCenters   = data.centers.filter(c => c.status === "active").length;

  // ── Attendance ──────────────────────────────────────────────────────────────
  const todayAtt     = data.attendance.filter(a => a.date === today);
  const todayPresent = todayAtt.filter(a => a.status === "present").length;
  const todayTotal   = todayAtt.length;
  const todayPct     = todayTotal > 0 ? Math.round((todayPresent / todayTotal) * 100) : null;

  // 7-day attendance trend (one bar per day)
  const weekTrend = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date  = isoDaysAgo(6 - i);
      const recs  = data.attendance.filter(a => a.date === date);
      const prs   = recs.filter(a => a.status === "present").length;
      const pct   = recs.length > 0 ? Math.round((prs / recs.length) * 100) : null;
      const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short" });
      return { date, label, pct };
    });
  }, [data.attendance]);

  const weekAvgPct = useMemo(() => {
    const days = weekTrend.filter(d => d.pct !== null);
    if (days.length === 0) return null;
    return Math.round(days.reduce((s, d) => s + (d.pct ?? 0), 0) / days.length);
  }, [weekTrend]);

  // ── Revenue ─────────────────────────────────────────────────────────────────
  const completedTx = data.transactions.filter(t => t.status === "completed");

  const revThisMonth = completedTx
    .filter(t => t.date?.startsWith(thisMonth))
    .reduce((s, t) => s + t.amount, 0);

  const revLastMonth = completedTx
    .filter(t => t.date?.startsWith(lastMonth))
    .reduce((s, t) => s + t.amount, 0);

  const revGrowthPct = revLastMonth > 0
    ? Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 100)
    : null;

  const totalPendingFees = data.students
    .filter(s => s.currentBalance > 0)
    .reduce((s, st) => s + st.currentBalance, 0);

  const rev30d = completedTx
    .filter(t => t.date >= days30ago)
    .reduce((s, t) => s + t.amount, 0);

  // 7-day revenue trend
  const revTrend = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = isoDaysAgo(6 - i);
      const amt  = completedTx
        .filter(t => t.date === date)
        .reduce((s, t) => s + t.amount, 0);
      const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short" });
      return { date, label, amt };
    });
  }, [completedTx]);

  // ── Per-center stats ─────────────────────────────────────────────────────────
  const centerStats: CenterStats[] = useMemo(() => {
    // Growth windows: current = last 30 days, previous = 31–60 days ago
    const days60ago = isoDaysAgo(60);

    return data.centers.map(center => {
      const cStudents     = data.students.filter(s => s.centerId === center.id);
      const activeCount   = cStudents.filter(s => s.status === "active").length;
      const pendingFeeCount = cStudents.filter(s => s.currentBalance > 0).length;

      // 7-day attendance % for this center
      const cAtt7d = data.attendance.filter(
        a => a.centerId === center.id && a.date >= days7ago
      );
      const prs7d  = cAtt7d.filter(a => a.status === "present").length;
      const attPct = cAtt7d.length > 0
        ? Math.round((prs7d / cAtt7d.length) * 100)
        : null;

      // Revenue last 30 days
      const rev30 = completedTx
        .filter(t => t.centerId === center.id && t.date >= days30ago)
        .reduce((s, t) => s + t.amount, 0);

      // Growth: students enrolled in current 30d vs previous 30d window
      // Uses createdAt ISO string; falls back to null if no createdAt data
      const studentsWithDate = cStudents.filter(s => !!s.createdAt);
      let growthPct: number | null = null;
      if (studentsWithDate.length > 0) {
        const newThis = studentsWithDate.filter(s => s.createdAt >= days30ago).length;
        const newPrev = studentsWithDate.filter(s => s.createdAt >= days60ago && s.createdAt < days30ago).length;
        if (newPrev > 0) {
          growthPct = Math.round(((newThis - newPrev) / newPrev) * 100);
        } else if (newThis > 0) {
          growthPct = 100; // any new students with zero previous = 100% growth
        } else {
          growthPct = 0;
        }
      }

      return {
        center,
        studentCount:    cStudents.length,
        activeCount,
        attendancePct:   attPct,
        teacherName:     teacherNameMap[center.teacherUid] ?? "—",
        pendingFeeCount,
        revenue30d:      rev30,
        growthPct,
      };
    }).sort((a, b) => (b.attendancePct ?? -1) - (a.attendancePct ?? -1));
  }, [data.centers, data.students, data.attendance, completedTx, teacherNameMap, days7ago, days30ago]);

  // ── Teacher performance ──────────────────────────────────────────────────────
  const teacherPerf = useMemo(() => {
    return data.teachers.map(t => {
      const q = data.quality.find(q => q.teacherId === t.uid);
      return {
        uid:         t.uid,
        name:        t.displayName,
        centerIds:   t.centerIds,
        score:       q?.score ?? null,
        factors:     q?.factors ?? null,
        status:      t.status,
        lastActivity:t.lastActivity,
      };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }, [data.teachers, data.quality]);

  const topTeachers    = teacherPerf.slice(0, 3);
  const bottomTeachers = [...teacherPerf].reverse().slice(0, 3);
  const inactiveTeachers = data.teachers.filter(t => t.status !== "active");

  // ── Student progress (use teacher quality factors as proxy) ──────────────────
  const avgProgress = useMemo(() => {
    const scores = data.quality.map(q => q.factors.syllabusProgress);
    if (scores.length === 0) return null;
    return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
  }, [data.quality]);

  // ── Alerts ───────────────────────────────────────────────────────────────────
  const lowAttCenters  = centerStats.filter(c => c.attendancePct !== null && c.attendancePct < 60);
  const emptycenters   = centerStats.filter(c => c.studentCount === 0);
  const pendingFeeStudents = data.students.filter(s => s.currentBalance > 0).length;

  // Students who appear stagnant: no attendance record in last 7 days
  const activeStudentUids = new Set(data.students.filter(s => s.status === "active").map(s => s.uid));
  const attendedLast7 = new Set(
    data.attendance.filter(a => a.date >= days7ago && a.status === "present").map(a => a.studentUid)
  );
  const absenteeCount = [...activeStudentUids].filter(uid => !attendedLast7.has(uid)).length;

  // Smart insights — unusual drops
  const insights: { icon: string; msg: string; severity: "critical" | "warning" | "info" }[] = [];

  if (todayPct !== null && todayPct < 50)
    insights.push({ icon: "📉", msg: `Today's attendance is critically low at ${todayPct}%.`, severity: "critical" });

  if (weekAvgPct !== null && weekAvgPct < 65)
    insights.push({ icon: "⚠️", msg: `7-day average attendance is ${weekAvgPct}% — below target.`, severity: "warning" });

  if (revGrowthPct !== null && revGrowthPct < -10)
    insights.push({ icon: "💸", msg: `Revenue dropped ${Math.abs(revGrowthPct)}% vs last month.`, severity: "critical" });

  if (pendingDeact > 0)
    insights.push({ icon: "🔔", msg: `${pendingDeact} deactivation request${pendingDeact > 1 ? "s" : ""} awaiting approval.`, severity: "warning" });

  if (inactiveTeachers.length > 0)
    insights.push({ icon: "👤", msg: `${inactiveTeachers.length} teacher${inactiveTeachers.length > 1 ? "s" : ""} marked inactive.`, severity: "warning" });

  if (emptycenters.length > 0)
    insights.push({ icon: "🏫", msg: `${emptycenters.length} centre${emptycenters.length > 1 ? "s" : ""} have no enrolled students.`, severity: "info" });

  if (absenteeCount > Math.round(activeStudents * 0.3) && activeStudents > 0)
    insights.push({ icon: "📋", msg: `${absenteeCount} active students have not attended this week.`, severity: "warning" });

  if (totalPendingFees > 0)
    insights.push({ icon: "💰", msg: `₹${totalPendingFees.toLocaleString("en-IN")} in pending fees across ${pendingFeeStudents} student${pendingFeeStudents > 1 ? "s" : ""}.`, severity: "info" });

  const maxRevTrend = Math.max(...revTrend.map(d => d.amt), 1);

  return (
    <div style={s.page}>

      {/* ── HEADER ── */}
      <div style={s.header}>
        <div>
          <div style={s.headerTitle}>Centre Suite</div>
          <div style={s.headerSub}>
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
        </div>
        <div style={s.quickActions}>
          <button style={s.qaBtn} onClick={() => router.push("/dashboard/centers")}>+ Centre</button>
          <button style={s.qaBtn} onClick={() => router.push("/dashboard/teachers")}>+ Teacher</button>
          <button style={s.qaBtn} onClick={() => router.push("/dashboard/students")}>+ Student</button>
          <button style={{ ...s.qaBtn, ...s.qaBtnPrimary }} onClick={() => router.push("/dashboard/finance")}>Finance</button>
        </div>
      </div>

      {/* ── 1. GLOBAL METRICS ── */}
      <div style={s.metricsGrid}>
        <MetricCard label="Total Students"   value={totalStudents}   sub={`${activeStudents} active · ${inactiveStudents} inactive`}       accent="#4f46e5" icon="👥" />
        <MetricCard label="Teachers"         value={totalTeachers}   sub={`${activeTeachers} active · ${totalTeachers - activeTeachers} inactive`} accent="#0891b2" icon="🎓" />
        <MetricCard label="Centres"          value={totalCenters}    sub={`${activeCenters} active`}                                        accent="#7c3aed" icon="🏫" />
        <MetricCard label="Attendance Today" value={todayPct !== null ? `${todayPct}%` : "—"} sub={`${todayPresent}/${todayTotal} present`} accent={todayPct !== null && todayPct < 60 ? "#dc2626" : "#16a34a"} icon="✓" />
        <MetricCard label="Revenue (Month)"  value={`₹${revThisMonth.toLocaleString("en-IN")}`} sub={revGrowthPct !== null ? `${revGrowthPct >= 0 ? "▲" : "▼"} ${Math.abs(revGrowthPct)}% vs last month` : "No prior data"} accent={revGrowthPct !== null && revGrowthPct < 0 ? "#dc2626" : "#16a34a"} icon="₹" />
        <MetricCard label="Pending Fees"     value={`₹${totalPendingFees.toLocaleString("en-IN")}`} sub={`${pendingFeeStudents} students`}  accent="#d97706" icon="⚠" />
      </div>

      {/* ── 2. SMART INSIGHTS ── */}
      {insights.length > 0 && (
        <Section title="🧠 Smart Insights">
          <div style={s.insightList}>
            {insights.map((ins, i) => (
              <div key={i} style={{ ...s.insightRow, borderLeftColor: ins.severity === "critical" ? "#dc2626" : ins.severity === "warning" ? "#d97706" : "#4f46e5" }}>
                <span style={{ fontSize: 16 }}>{ins.icon}</span>
                <span style={{ flex: 1, fontSize: 13, color: "#374151" }}>{ins.msg}</span>
                <Chip label={ins.severity} color={ins.severity === "critical" ? "#dc2626" : ins.severity === "warning" ? "#d97706" : "#4f46e5"} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── 3. WEEKLY TRENDS ── */}
      <div style={s.twoCol}>

        <Section title="📈 Attendance Trend (7 days)">
          <div style={s.barChart}>
            {weekTrend.map(d => {
              const h   = d.pct !== null ? Math.max(6, Math.round(d.pct * 0.72)) : 6;
              const bg  = d.date === today ? "#4f46e5" : d.pct !== null ? (d.pct < 60 ? "#ef4444" : "#a5b4fc") : "#e5e7eb";
              const col = d.date === today ? "#4f46e5" : "#9ca3af";
              return (
                <div key={d.date} style={s.barCol}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: col, marginBottom: 2 }}>
                    {d.pct !== null ? `${d.pct}%` : "—"}
                  </span>
                  <div style={{ ...s.bar, height: h, background: bg }} />
                  <span style={{ fontSize: 10, color: col, fontWeight: d.date === today ? 800 : 400 }}>{d.label}</span>
                </div>
              );
            })}
          </div>
          {weekAvgPct !== null && (
            <div style={s.chartFooter}>7-day avg: <strong>{weekAvgPct}%</strong></div>
          )}
        </Section>

        <Section title="💰 Revenue Trend (7 days)">
          <div style={s.barChart}>
            {revTrend.map(d => {
              const h   = d.amt > 0 ? Math.max(6, Math.round((d.amt / maxRevTrend) * 72)) : 6;
              const bg  = d.date === today ? "#16a34a" : d.amt > 0 ? "#86efac" : "#e5e7eb";
              const col = d.date === today ? "#16a34a" : "#9ca3af";
              return (
                <div key={d.date} style={s.barCol}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: col, marginBottom: 2 }}>
                    {d.amt > 0 ? `₹${(d.amt / 1000).toFixed(1)}k` : "—"}
                  </span>
                  <div style={{ ...s.bar, height: h, background: bg }} />
                  <span style={{ fontSize: 10, color: col, fontWeight: d.date === today ? 800 : 400 }}>{d.label}</span>
                </div>
              );
            })}
          </div>
          <div style={s.chartFooter}>Last 30 days total: <strong>₹{rev30d.toLocaleString("en-IN")}</strong></div>
        </Section>

      </div>

      {/* ── 4. CENTRE PERFORMANCE ── */}
      <Section title="🏫 Centre Performance" sub="Ranked by 7-day attendance">
        <table style={s.table}>
          <thead>
            <tr>
              {["Centre", "Teacher", "Students", "Growth", "Active", "7d Att%", "Pending Fees", "Rev (30d)", "Status"].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {centerStats.map((cs, i) => {
              const attColor = cs.attendancePct === null ? "#9ca3af"
                : cs.attendancePct < 60 ? "#dc2626"
                : cs.attendancePct < 80 ? "#d97706"
                : "#16a34a";
              return (
                <tr key={cs.center.id} style={{ ...s.tr, background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                  <td style={{ ...s.td, fontWeight: 600, color: "#111" }}>
                    <span style={{ marginRight: 6, fontSize: 12, color: "#9ca3af" }}>#{i + 1}</span>
                    {cs.center.name}
                  </td>
                  <td style={s.td}>{cs.teacherName}</td>
                  <td style={{ ...s.td, textAlign: "center" }}>{cs.studentCount}</td>
                  <td style={{ ...s.td, textAlign: "center" }}>
                    {cs.growthPct === null ? (
                      <span style={{ color: "#9ca3af" }}>—</span>
                    ) : (
                      <span style={{
                        fontWeight: 700,
                        color: cs.growthPct > 0 ? "#16a34a" : cs.growthPct < 0 ? "#dc2626" : "#9ca3af",
                      }}>
                        {cs.growthPct > 0 ? "▲" : cs.growthPct < 0 ? "▼" : ""}{Math.abs(cs.growthPct)}%
                      </span>
                    )}
                  </td>
                  <td style={{ ...s.td, textAlign: "center" }}>{cs.activeCount}</td>
                  <td style={{ ...s.td, textAlign: "center" }}>
                    <span style={{ color: attColor, fontWeight: 700 }}>
                      {cs.attendancePct !== null ? `${cs.attendancePct}%` : "—"}
                    </span>
                  </td>
                  <td style={{ ...s.td, textAlign: "center" }}>
                    <span style={{ color: cs.pendingFeeCount > 0 ? "#d97706" : "#16a34a" }}>
                      {cs.pendingFeeCount > 0 ? `${cs.pendingFeeCount} students` : "None"}
                    </span>
                  </td>
                  <td style={s.td}>₹{cs.revenue30d.toLocaleString("en-IN")}</td>
                  <td style={s.td}><Chip label={cs.center.status} color={cs.center.status === "active" ? "#16a34a" : "#6b7280"} /></td>
                </tr>
              );
            })}
            {centerStats.length === 0 && (
              <tr><td colSpan={9} style={{ ...s.td, textAlign: "center", color: "#9ca3af" }}>No centres found.</td></tr>
            )}
          </tbody>
        </table>
        {lowAttCenters.length > 0 && (
          <div style={s.alertBanner}>
            ⚠️ Low attendance: {lowAttCenters.map(c => c.center.name).join(", ")}
          </div>
        )}
      </Section>

      {/* ── 5. TEACHER PERFORMANCE ── */}
      <div style={s.twoCol}>

        <Section title="🏆 Top Performers">
          {topTeachers.length === 0
            ? <EmptyCard msg="No quality scores yet." />
            : topTeachers.map((t, i) => (
              <TeacherRow key={t.uid} rank={i + 1} name={t.name} score={t.score} factors={t.factors} top />
            ))
          }
        </Section>

        <Section title="📉 Need Attention">
          {bottomTeachers.length === 0
            ? <EmptyCard msg="No quality scores yet." />
            : bottomTeachers.map((t, i) => (
              <TeacherRow key={t.uid} rank={teacherPerf.length - i} name={t.name} score={t.score} factors={t.factors} top={false} />
            ))
          }
        </Section>

      </div>

      {/* ── 6. STUDENT ENGAGEMENT ── */}
      <Section title="👥 Student Engagement">
        <div style={s.metricsGrid}>
          <EngagementCard label="Active Students"    value={activeStudents}  total={totalStudents} color="#16a34a" />
          <EngagementCard label="Inactive Students"  value={inactiveStudents} total={totalStudents} color="#6b7280" />
          <EngagementCard label="Deactivation Queue" value={pendingDeact}    total={totalStudents} color="#d97706" />
          <EngagementCard label="No Attendance (7d)" value={absenteeCount}   total={activeStudents} color="#dc2626" />
          {avgProgress !== null && (
            <div style={s.engCard}>
              <div style={s.engLabel}>Avg Syllabus Progress</div>
              <div style={{ ...s.engValue, color: avgProgress < 40 ? "#dc2626" : avgProgress < 70 ? "#d97706" : "#16a34a" }}>
                {avgProgress}%
              </div>
              <div style={s.engSub}>across teachers</div>
            </div>
          )}
        </div>
      </Section>

      {/* ── 7. REVENUE INSIGHTS ── */}
      <Section title="₹ Revenue Insights">
        <div style={s.revenueGrid}>
          <RevCard label="This Month" amount={revThisMonth} growth={revGrowthPct} />
          <RevCard label="Last Month" amount={revLastMonth} growth={null} />
          <RevCard label="Last 30 Days" amount={rev30d} growth={null} />
          <RevCard label="Pending Fees" amount={totalPendingFees} growth={null} warn />
        </div>
      </Section>

      {/* ── 8. ALERTS ── */}
      <Section title="🔔 Alerts">
        <div style={s.alertGrid}>
          <AlertBox
            icon="📉" title="Low Attendance Centres"
            items={lowAttCenters.map(c => `${c.center.name} — ${c.attendancePct}%`)}
            empty="All centres above 60%"
            color="#dc2626"
          />
          <AlertBox
            icon="💰" title="Students with Pending Fees"
            items={data.students.filter(s => s.currentBalance > 0)
              .slice(0, 5)
              .map(s => `UID: ${s.uid.slice(0, 6)}… — ₹${s.currentBalance}`)}
            empty="No pending fees"
            color="#d97706"
          />
          <AlertBox
            icon="🔔" title="Deactivation Requests"
            items={data.students.filter(s => s.status === "deactivation_requested")
              .slice(0, 5)
              .map(s => `UID: ${s.uid.slice(0, 6)}… awaiting approval`)}
            empty="No pending requests"
            color="#7c3aed"
          />
          <AlertBox
            icon="👤" title="Inactive Teachers"
            items={inactiveTeachers.slice(0, 5).map(t => t.displayName)}
            empty="All teachers active"
            color="#6b7280"
          />
        </div>
      </Section>

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={s.section}>
      <div style={s.sectionHeader}>
        <span style={s.sectionTitle}>{title}</span>
        {sub && <span style={s.sectionSub}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function MetricCard({ label, value, sub, accent, icon }: {
  label: string; value: string | number; sub: string; accent: string; icon: string;
}) {
  return (
    <div style={s.metricCard}>
      <div style={{ ...s.metricAccent, background: accent }} />
      <div style={s.metricBody}>
        <div style={s.metricIcon}>{icon}</div>
        <div style={s.metricLabel}>{label}</div>
        <div style={{ ...s.metricValue, color: accent }}>{value}</div>
        <div style={s.metricSub}>{sub}</div>
      </div>
    </div>
  );
}

function Chip({ label, color }: { label: string; color: string }) {
  const bg = color + "18";
  return (
    <span style={{ background: bg, color, border: `1px solid ${color}40`, borderRadius: 99, padding: "2px 10px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" as const }}>
      {label}
    </span>
  );
}

function TeacherRow({ rank, name, score, factors, top }: {
  rank: number; name: string; score: number | null;
  factors: { attendanceDiscipline: number; syllabusProgress: number; studentRetention: number } | null;
  top: boolean;
}) {
  const scoreColor = score === null ? "#9ca3af"
    : score >= 75 ? "#16a34a" : score >= 50 ? "#d97706" : "#dc2626";
  return (
    <div style={s.teacherRow}>
      <span style={{ fontSize: 13, fontWeight: 800, color: top ? "#16a34a" : "#dc2626", minWidth: 22 }}>
        #{rank}
      </span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#111" }}>{name}</span>
      {score !== null ? (
        <div style={s.teacherScore}>
          <span style={{ fontSize: 18, fontWeight: 800, color: scoreColor }}>{score}</span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>/100</span>
        </div>
      ) : (
        <span style={{ fontSize: 12, color: "#9ca3af" }}>No score</span>
      )}
      {factors && (
        <div style={s.factorBar}>
          <FactorDot label="Att" value={factors.attendanceDiscipline} />
          <FactorDot label="Syl" value={factors.syllabusProgress} />
          <FactorDot label="Ret" value={factors.studentRetention} />
        </div>
      )}
    </div>
  );
}

function FactorDot({ label, value }: { label: string; value: number }) {
  const color = value >= 75 ? "#16a34a" : value >= 50 ? "#d97706" : "#dc2626";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <span style={{ fontSize: 9, color: "#9ca3af" }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function EngagementCard({ label, value, total, color }: {
  label: string; value: number; total: number; color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={s.engCard}>
      <div style={s.engLabel}>{label}</div>
      <div style={{ ...s.engValue, color }}>{value}</div>
      <div style={s.engSub}>{pct}% of {total}</div>
      <div style={s.engBarTrack}>
        <div style={{ ...s.engBarFill, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function RevCard({ label, amount, growth, warn }: {
  label: string; amount: number; growth: number | null; warn?: boolean;
}) {
  const isUp = growth !== null && growth >= 0;
  return (
    <div style={{ ...s.revCard, ...(warn ? { borderColor: "#fed7aa" } : {}) }}>
      <div style={s.revLabel}>{label}</div>
      <div style={{ ...s.revAmount, color: warn ? "#d97706" : "#111" }}>
        ₹{amount.toLocaleString("en-IN")}
      </div>
      {growth !== null && (
        <div style={{ fontSize: 12, color: isUp ? "#16a34a" : "#dc2626", fontWeight: 600, marginTop: 4 }}>
          {isUp ? "▲" : "▼"} {Math.abs(growth)}% vs last month
        </div>
      )}
    </div>
  );
}

function AlertBox({ icon, title, items, empty, color }: {
  icon: string; title: string; items: string[]; empty: string; color: string;
}) {
  return (
    <div style={{ ...s.alertBox, borderTopColor: color }}>
      <div style={s.alertBoxHeader}>{icon} {title}</div>
      {items.length === 0
        ? <div style={s.alertEmpty}>{empty}</div>
        : items.map((item, i) => (
          <div key={i} style={s.alertItem}>{item}</div>
        ))
      }
    </div>
  );
}

function EmptyCard({ msg }: { msg: string }) {
  return <div style={s.empty}>{msg}</div>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  page:         { maxWidth: 1080, margin: "0 auto", paddingBottom: 48 },

  // Loading
  loadingShell: { display: "flex", alignItems: "center", justifyContent: "center", gap: 12, height: "40vh", flexDirection: "column" },
  spinner:      { width: 28, height: 28, border: "3px solid #e5e7eb", borderTopColor: "#4f46e5", borderRadius: "50%", animation: "spin 0.7s linear infinite" },
  loadingText:  { fontSize: 13, color: "#9ca3af" },
  errorShell:   { padding: "48px 24px", textAlign: "center", color: "#dc2626", fontSize: 14 },

  // Header
  header:       { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  headerTitle:  { fontSize: 24, fontWeight: 800, color: "#111", marginBottom: 2 },
  headerSub:    { fontSize: 13, color: "#9ca3af" },
  quickActions: { display: "flex", gap: 8, flexWrap: "wrap" },
  qaBtn:        { background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" },
  qaBtnPrimary: { background: "#4f46e5", color: "#fff", border: "none" },

  // Metrics
  metricsGrid:  { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 },
  metricCard:   { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" },
  metricAccent: { height: 4 },
  metricBody:   { padding: "14px 16px" },
  metricIcon:   { fontSize: 18, marginBottom: 6 },
  metricLabel:  { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", marginBottom: 4 },
  metricValue:  { fontSize: 24, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 },
  metricSub:    { fontSize: 11, color: "#9ca3af" },

  // Section
  section:       { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", marginBottom: 16 },
  sectionHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 },
  sectionTitle:  { fontSize: 13, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" },
  sectionSub:    { fontSize: 11, color: "#9ca3af" },

  // Two col
  twoCol:        { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },

  // Bar chart
  barChart:  { display: "flex", alignItems: "flex-end", gap: 8, height: 80 },
  barCol:    { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 },
  bar:       { width: "100%", borderRadius: 4, minHeight: 4 },
  chartFooter: { marginTop: 10, fontSize: 12, color: "#9ca3af" },

  // Smart insights
  insightList: { display: "flex", flexDirection: "column", gap: 8 },
  insightRow:  { display: "flex", alignItems: "center", gap: 10, background: "#fafafa", border: "1px solid #e5e7eb", borderLeft: "4px solid #4f46e5", borderRadius: 8, padding: "10px 14px" },

  // Table
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:    { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9ca3af", borderBottom: "1px solid #e5e7eb", background: "#f9fafb", whiteSpace: "nowrap" as const },
  tr:    { borderBottom: "1px solid #f3f4f6" },
  td:    { padding: "11px 12px", color: "#6b7280", verticalAlign: "middle" },

  alertBanner: { marginTop: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 14px", fontSize: 12, color: "#dc2626", fontWeight: 500 },

  // Teacher rows
  teacherRow:   { display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f3f4f6" },
  teacherScore: { display: "flex", alignItems: "baseline", gap: 2, minWidth: 50, justifyContent: "flex-end" },
  factorBar:    { display: "flex", gap: 10, marginLeft: 6 },

  // Engagement
  engCard:      { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px" },
  engLabel:     { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", marginBottom: 4 },
  engValue:     { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  engSub:       { fontSize: 11, color: "#9ca3af", marginTop: 2, marginBottom: 6 },
  engBarTrack:  { height: 4, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", marginTop: 6 },
  engBarFill:   { height: "100%", borderRadius: 99 },

  // Revenue
  revenueGrid:  { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 },
  revCard:      { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px" },
  revLabel:     { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", marginBottom: 6 },
  revAmount:    { fontSize: 22, fontWeight: 800 },

  // Alerts
  alertGrid:    { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  alertBox:     { background: "#fff", border: "1px solid #e5e7eb", borderTop: "3px solid #4f46e5", borderRadius: 10, padding: "14px 16px" },
  alertBoxHeader:{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 },
  alertItem:    { fontSize: 12, color: "#6b7280", padding: "4px 0", borderBottom: "1px solid #f3f4f6" },
  alertEmpty:   { fontSize: 12, color: "#9ca3af", fontStyle: "italic" },

  // Misc
  empty:        { padding: "24px", textAlign: "center", fontSize: 13, color: "#9ca3af" },
};
