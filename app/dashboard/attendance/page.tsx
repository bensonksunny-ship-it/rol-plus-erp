"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import {
  getAttendanceByCentreDate,
  saveCentreAttendance,
} from "@/services/attendance/attendance.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CentreOption { id: string; name: string; code: string; }

interface StudentRow {
  uid:        string;
  name:       string;
  instrument: string;
  classType:  string;
}

interface AttendanceRec {
  studentUid: string;
  centerId:   string;
  date:       string;       // "YYYY-MM-DD"
  status:     "present" | "absent";
}

type MarkStatus = "present" | "absent";
type PageTab    = "mark" | "trends";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO():   string { return new Date().toISOString().slice(0, 10); }
function currentWeekKey(d = new Date()): string {
  const jan1  = new Date(d.getFullYear(), 0, 1);
  const week  = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
function isoToWeekKey(iso: string): string { return currentWeekKey(new Date(iso)); }
function isoToMonth(iso: string): string   { return iso.slice(0, 7); }
function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[parseInt(m,10)-1]} ${y}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}
function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}
function pctColor(p: number): string {
  if (p >= 75) return "#16a34a";
  if (p >= 50) return "#d97706";
  return "#dc2626";
}
function lastNDays(n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}
function lastNWeeks(n: number): string[] {
  const weeks: string[] = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d);
    t.setDate(t.getDate() - i * 7);
    weeks.push(isoToWeekKey(t.toISOString().slice(0, 10)));
  }
  return [...new Set(weeks)].slice(-n);
}
function lastNMonths(n: number): string[] {
  const months: string[] = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(t.toISOString().slice(0, 7));
  }
  return months;
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function AttendancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <AttendanceContent />
    </ProtectedRoute>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function AttendanceContent() {
  const { user, loading: authLoading } = useAuthContext();
  const { isAllowed, filterCentres, isTeacherRole } = useCentreAccess();

  const [tab,            setTab]            = useState<PageTab>("mark");
  const [centres,        setCentres]        = useState<CentreOption[]>([]);
  const [selectedCentre, setSelectedCentre] = useState<string>("");
  const [date,           setDate]           = useState<string>(todayISO());

  // ── Mark-attendance state ─────────────────────────────────────────────────
  const [students,       setStudents]       = useState<StudentRow[]>([]);
  const [marks,          setMarks]          = useState<Record<string, MarkStatus>>({});
  const [existingIds,    setExistingIds]    = useState<Record<string, string>>({});
  const [loadingStudents,setLoadingStudents]= useState(false);
  const [saving,         setSaving]         = useState(false);
  const [feedback,       setFeedback]       = useState<{ ok: boolean; msg: string } | null>(null);

  // ── Trend state ───────────────────────────────────────────────────────────
  const [allAttendance,  setAllAttendance]  = useState<AttendanceRec[]>([]);
  const [allStudents,    setAllStudents]    = useState<StudentRow[]>([]);
  const [loadingTrends,  setLoadingTrends]  = useState(false);
  const trendTimerRef                       = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load centres ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !user) return;
    async function load() {
      const snap = await getDocs(collection(db, "centers"));
      const all: CentreOption[] = snap.docs.map(d => ({
        id:   d.id,
        name: (d.data().name       as string) || d.id,
        code: (d.data().centerCode as string) || "",
      }));
      const visible = filterCentres(all);
      setCentres(visible);
      if (visible.length === 1) setSelectedCentre(visible[0].id);
    }
    load().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  // ── Load students + existing marks (Mark tab) ────────────────────────────
  useEffect(() => {
    if (!selectedCentre || !user) return;
    async function load() {
      setLoadingStudents(true);
      setStudents([]);
      setMarks({});
      setExistingIds({});
      setFeedback(null);
      try {
        const q    = query(
          collection(db, "users"),
          where("role",     "==", "student"),
          where("centerId", "==", selectedCentre),
        );
        const snap = await getDocs(q);
        const rows: StudentRow[] = snap.docs.map(d => {
          const data = d.data() as Record<string, unknown>;
          return {
            uid:        d.id,
            name:       (data.displayName as string) || (data.name as string) || d.id,
            instrument: (data.instrument  as string) || "",
            classType:  (data.classType   as string) === "personal" ? "personal" : "group",
          };
        });
        rows.sort((a, b) => {
          if (a.classType !== b.classType) return a.classType === "group" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const existing = await getAttendanceByCentreDate(selectedCentre, date);
        const existingMap: Record<string, string>     = {};
        const statusMap:   Record<string, MarkStatus> = {};
        existing.forEach(r => {
          existingMap[r.studentUid] = r.id;
          statusMap[r.studentUid]   = r.status as MarkStatus;
        });
        const defaultMarks: Record<string, MarkStatus> = {};
        rows.forEach(s => { defaultMarks[s.uid] = statusMap[s.uid] ?? "present"; });
        setStudents(rows);
        setExistingIds(existingMap);
        setMarks(defaultMarks);
      } finally {
        setLoadingStudents(false);
      }
    }
    load().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCentre, date]);

  // ── Load all attendance for trend analysis ───────────────────────────────
  const loadTrends = useCallback(async (centreId: string) => {
    setLoadingTrends(true);
    try {
      const [attSnap, stuSnap] = await Promise.all([
        getDocs(query(collection(db, "attendance"), where("centerId", "==", centreId))),
        getDocs(query(collection(db, "users"), where("role", "==", "student"), where("centerId", "==", centreId))),
      ]);
      setAllAttendance(attSnap.docs.map(d => {
        const r = d.data() as Record<string, unknown>;
        return {
          studentUid: r.studentUid as string,
          centerId:   r.centerId   as string,
          date:       (r.date      as string) ?? "",
          status:     (r.status    as "present" | "absent") ?? "absent",
        };
      }).filter(r => r.date));
      setAllStudents(stuSnap.docs.map(d => {
        const data = d.data() as Record<string, unknown>;
        return {
          uid:        d.id,
          name:       (data.displayName as string) || (data.name as string) || d.id,
          instrument: (data.instrument  as string) || "",
          classType:  (data.classType   as string) === "personal" ? "personal" : "group",
        };
      }));
    } finally {
      setLoadingTrends(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedCentre || tab !== "trends") return;
    loadTrends(selectedCentre);
    // Live refresh every 60s
    trendTimerRef.current = setInterval(() => loadTrends(selectedCentre), 60_000);
    return () => { if (trendTimerRef.current) clearInterval(trendTimerRef.current); };
  }, [selectedCentre, tab, loadTrends]);

  // ── Mark-attendance summary ───────────────────────────────────────────────
  const markSummary = useMemo(() => {
    const total   = students.length;
    const present = Object.values(marks).filter(m => m === "present").length;
    return {
      total, present, absent: total - present,
      groupCount:    students.filter(s => s.classType === "group").length,
      personalCount: students.filter(s => s.classType === "personal").length,
    };
  }, [students, marks]);

  // ── Trend computations ────────────────────────────────────────────────────
  const trends = useMemo(() => {
    if (!allAttendance.length || !allStudents.length) return null;

    const totalStudents = allStudents.length;
    const today         = todayISO();
    const thisMonth     = isoToMonth(today);
    const thisWeek      = currentWeekKey();

    // Group records by date
    const byDate = new Map<string, { present: number; absent: number }>();
    allAttendance.forEach(r => {
      const prev = byDate.get(r.date) ?? { present: 0, absent: 0 };
      if (r.status === "present") prev.present++;
      else prev.absent++;
      byDate.set(r.date, prev);
    });

    // ── Daily: last 30 days ───────────────────────────────────────────────
    const days30    = lastNDays(30);
    const dailyData = days30.map(d => {
      const rec = byDate.get(d);
      const present = rec?.present ?? 0;
      // Use actual total for days with records, otherwise allStudents total
      const total   = rec ? (rec.present + rec.absent) : 0;
      return { date: d, present, total, pct: pct(present, total || totalStudents) };
    });

    // ── Weekly: last 12 weeks ─────────────────────────────────────────────
    const weeks12    = lastNWeeks(12);
    const byWeek     = new Map<string, { present: number; total: number; days: Set<string> }>();
    allAttendance.forEach(r => {
      const wk   = isoToWeekKey(r.date);
      const prev = byWeek.get(wk) ?? { present: 0, total: 0, days: new Set() };
      if (r.status === "present") prev.present++;
      prev.total++;
      prev.days.add(r.date);
      byWeek.set(wk, prev);
    });
    const weeklyData = weeks12.map(wk => {
      const rec     = byWeek.get(wk);
      const present = rec?.present ?? 0;
      const total   = rec?.total   ?? 0;
      return { week: wk, present, total, pct: pct(present, total || 1), days: rec?.days.size ?? 0 };
    });

    // ── Monthly: last 12 months ───────────────────────────────────────────
    const months12    = lastNMonths(12);
    const byMonth     = new Map<string, { present: number; total: number }>();
    allAttendance.forEach(r => {
      const mo   = isoToMonth(r.date);
      const prev = byMonth.get(mo) ?? { present: 0, total: 0 };
      if (r.status === "present") prev.present++;
      prev.total++;
      byMonth.set(mo, prev);
    });
    const monthlyData = months12.map(mo => {
      const rec     = byMonth.get(mo);
      const present = rec?.present ?? 0;
      const total   = rec?.total   ?? 0;
      return { month: mo, present, total, pct: pct(present, total || 1) };
    });

    // ── Live summary stats ────────────────────────────────────────────────
    const todayRec    = byDate.get(today);
    const todayPct    = todayRec ? pct(todayRec.present, todayRec.present + todayRec.absent) : null;
    const todayPresent= todayRec?.present ?? null;

    const weekRec     = byWeek.get(thisWeek);
    const weekPct     = weekRec ? pct(weekRec.present, weekRec.total) : null;

    const monthRec    = byMonth.get(thisMonth);
    const monthPct    = monthRec ? pct(monthRec.present, monthRec.total) : null;

    // Best and worst day in last 30 days (only days with records)
    const daysWithRecords = dailyData.filter(d => d.total > 0);
    const bestDay  = daysWithRecords.length ? daysWithRecords.reduce((a, b) => b.pct > a.pct ? b : a) : null;
    const worstDay = daysWithRecords.length ? daysWithRecords.reduce((a, b) => b.pct < a.pct ? b : a) : null;

    // ── Per-student this month ────────────────────────────────────────────
    const monthRecs = allAttendance.filter(r => r.date.startsWith(thisMonth));
    const classDates = new Set(allAttendance.filter(r => r.date.startsWith(thisMonth)).map(r => r.date));
    const classDaysThisMonth = classDates.size;

    const studentMonthMap = new Map<string, { present: number; absent: number }>();
    monthRecs.forEach(r => {
      const prev = studentMonthMap.get(r.studentUid) ?? { present: 0, absent: 0 };
      if (r.status === "present") prev.present++;
      else prev.absent++;
      studentMonthMap.set(r.studentUid, prev);
    });

    const studentStats = allStudents.map(s => {
      const rec     = studentMonthMap.get(s.uid) ?? { present: 0, absent: 0 };
      const total   = classDaysThisMonth || (rec.present + rec.absent);
      return {
        ...s,
        present: rec.present,
        absent:  rec.absent,
        pct:     pct(rec.present, total || 1),
        total,
      };
    }).sort((a, b) => b.pct - a.pct);

    return {
      dailyData, weeklyData, monthlyData,
      todayPct, todayPresent, weekPct, monthPct,
      bestDay, worstDay, studentStats,
      classDaysThisMonth, totalStudents, thisMonth,
    };
  }, [allAttendance, allStudents]);

  // ── Mark-attendance handlers ──────────────────────────────────────────────
  function toggle(uid: string) {
    setMarks(prev => ({ ...prev, [uid]: prev[uid] === "present" ? "absent" : "present" }));
  }
  function markAllPresent() {
    const next: Record<string, MarkStatus> = {};
    students.forEach(s => { next[s.uid] = "present"; });
    setMarks(next);
  }
  function markAllAbsent() {
    const next: Record<string, MarkStatus> = {};
    students.forEach(s => { next[s.uid] = "absent"; });
    setMarks(next);
  }
  async function handleSave() {
    if (!selectedCentre || !user || students.length === 0 || saving) return;
    setSaving(true);
    setFeedback(null);
    const results = await Promise.allSettled(
      students.map(s =>
        saveCentreAttendance({
          studentUid: s.uid,
          centerId:   selectedCentre,
          date,
          status:     marks[s.uid] ?? "present",
          markedBy:   user.uid,
        }),
      ),
    );
    const failed = results.filter(r => r.status === "rejected").length;
    setSaving(false);
    if (failed === 0) {
      const fresh = await getAttendanceByCentreDate(selectedCentre, date);
      const map: Record<string, string> = {};
      fresh.forEach(r => { map[r.studentUid] = r.id; });
      setExistingIds(map);
      setFeedback({ ok: true, msg: `Saved — ${markSummary.present} present, ${markSummary.absent} absent.` });
      // Refresh trends data too so it's immediately up-to-date
      if (tab === "trends") loadTrends(selectedCentre);
    } else {
      setFeedback({ ok: false, msg: `${failed} record(s) failed to save.` });
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (authLoading) return null;
  if (selectedCentre && !isAllowed(selectedCentre)) {
    return (
      <div style={{ padding: "64px 0", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🚫</div>
        <p style={{ fontSize: 16, fontWeight: 700, color: "#dc2626" }}>Access Denied</p>
      </div>
    );
  }

  const canSave          = !!selectedCentre && students.length > 0 && !saving;
  const hideCentreDropdown = isTeacherRole && centres.length === 1;

  return (
    <div style={{ fontFamily: "inherit" }}>

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 }}>Attendance</h1>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4, margin: 0 }}>
            Mark attendance and track daily, weekly, and monthly trends.
          </p>
        </div>
        {/* Live badge */}
        {tab === "trends" && selectedCentre && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#16a34a", fontWeight: 600, background: "#dcfce7", padding: "4px 10px", borderRadius: 99 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#16a34a", display: "inline-block", animation: "pulse 2s infinite" }} />
            LIVE · refreshes every 60s
          </div>
        )}
      </div>

      {/* ── Centre selector + date ──────────────────────────────────────── */}
      <div style={s.card}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {!hideCentreDropdown && (
            <Field label="Centre">
              <select value={selectedCentre} onChange={e => setSelectedCentre(e.target.value)} style={s.input}>
                <option value="">— Select centre —</option>
                {centres.map(c => (
                  <option key={c.id} value={c.id}>{c.code ? `[${c.code}] ` : ""}{c.name}</option>
                ))}
              </select>
            </Field>
          )}
          {hideCentreDropdown && centres[0] && (
            <Field label="Centre">
              <div style={{ ...s.input, background: "#f9fafb", cursor: "default", fontWeight: 600 }}>
                {centres[0].code ? `[${centres[0].code}] ` : ""}{centres[0].name}
              </div>
            </Field>
          )}
          {tab === "mark" && (
            <Field label="Date">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={s.input} />
            </Field>
          )}
          {/* Tab switcher */}
          <div style={{ marginLeft: "auto", display: "flex", gap: 4, background: "#f3f4f6", borderRadius: 8, padding: 3 }}>
            {(["mark", "trends"] as PageTab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: "6px 18px", borderRadius: 6, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
                background: tab === t ? "#fff" : "transparent",
                color:      tab === t ? "#111827" : "#6b7280",
                boxShadow:  tab === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}>
                {t === "mark" ? "✏️ Mark" : "📊 Trends"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ══════════════════════ MARK TAB ═══════════════════════════════════ */}
      {tab === "mark" && (
        <>
          {/* Quick actions + summary */}
          {students.length > 0 && (
            <div style={{ ...s.card, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={markAllPresent} style={btn("#16a34a", "#fff")}>✓ All Present</button>
                <button onClick={markAllAbsent}  style={btn("#dc2626", "#fff")}>✗ All Absent</button>
              </div>
              <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
                <Chip label="Total"    value={markSummary.total}         color="#4f46e5" />
                <Chip label="Present"  value={markSummary.present}       color="#16a34a" />
                <Chip label="Absent"   value={markSummary.absent}        color="#dc2626" />
                <Chip label="Group"    value={markSummary.groupCount}    color="#166534" />
                <Chip label="Personal" value={markSummary.personalCount} color="#92400e" />
                <button onClick={handleSave} disabled={!canSave}
                  style={{ ...btn("#4f46e5", "#fff"), minWidth: 130, opacity: canSave ? 1 : 0.45 }}>
                  {saving ? "Saving…" : "💾 Save"}
                </button>
              </div>
            </div>
          )}

          {/* Feedback */}
          {feedback && (
            <div style={{ ...s.card, padding: "12px 16px", background: feedback.ok ? "#dcfce7" : "#fee2e2", border: `1px solid ${feedback.ok ? "#86efac" : "#fca5a5"}`, color: feedback.ok ? "#15803d" : "#dc2626", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span>{feedback.ok ? "✓" : "✗"}</span>
              <span style={{ flex: 1 }}>{feedback.msg}</span>
              <button onClick={() => setFeedback(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, opacity: 0.6 }}>×</button>
            </div>
          )}

          {/* Empty states */}
          {!selectedCentre && <EmptyHint icon="🏫" text="Select a centre to begin." />}
          {selectedCentre && loadingStudents && <div style={{ ...s.card, textAlign: "center", padding: "48px 0", color: "#6b7280" }}>Loading students…</div>}
          {selectedCentre && !loadingStudents && students.length === 0 && <EmptyHint icon="👥" text="No students found for this centre." />}

          {/* Student list */}
          {selectedCentre && !loadingStudents && students.length > 0 && (
            <div style={{ ...s.card, padding: 0, overflow: "hidden" }}>
              {students.map((st, i) => {
                const isPresent = (marks[st.uid] ?? "present") === "present";
                const hasRecord = !!existingIds[st.uid];
                return (
                  <div key={st.uid} onClick={() => toggle(st.uid)} style={{
                    display: "flex", alignItems: "center", padding: "14px 20px", cursor: "pointer",
                    borderBottom: i < students.length - 1 ? "1px solid #f3f4f6" : "none",
                    background: isPresent ? "#f0fdf4" : "#fff1f2", userSelect: "none",
                  }}>
                    <div style={{ width: 12, height: 12, borderRadius: "50%", background: isPresent ? "#22c55e" : "#ef4444", marginRight: 14, flexShrink: 0, boxShadow: isPresent ? "0 0 0 3px rgba(34,197,94,0.18)" : "0 0 0 3px rgba(239,68,68,0.18)" }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{st.name}</span>
                      {st.instrument && <span style={{ marginLeft: 8, fontSize: 12, color: "#6b7280" }}>{st.instrument}</span>}
                      <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 99, background: st.classType === "personal" ? "#fef9c3" : "#dcfce7", color: st.classType === "personal" ? "#92400e" : "#166534" }}>
                        {st.classType === "personal" ? "Personal" : "Group"}
                      </span>
                    </div>
                    {hasRecord && <span style={{ fontSize: 11, color: "#9ca3af", marginRight: 12 }}>saved</span>}
                    <span style={{ padding: "4px 14px", borderRadius: 99, fontSize: 12, fontWeight: 700, background: isPresent ? "#dcfce7" : "#fee2e2", color: isPresent ? "#15803d" : "#dc2626" }}>
                      {isPresent ? "Present" : "Absent"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Bottom save */}
          {students.length > 7 && (
            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={handleSave} disabled={!canSave}
                style={{ ...btn("#4f46e5", "#fff"), opacity: canSave ? 1 : 0.45, padding: "10px 28px", fontSize: 14 }}>
                {saving ? "Saving…" : "💾 Save Attendance"}
              </button>
            </div>
          )}
        </>
      )}

      {/* ══════════════════════ TRENDS TAB ═════════════════════════════════ */}
      {tab === "trends" && (
        <>
          {!selectedCentre && <EmptyHint icon="🏫" text="Select a centre to view trends." />}
          {selectedCentre && loadingTrends && <div style={{ ...s.card, textAlign: "center", padding: "64px 0", color: "#6b7280" }}>Loading attendance data…</div>}

          {selectedCentre && !loadingTrends && !trends && (
            <EmptyHint icon="📊" text="No attendance records found for this centre." />
          )}

          {selectedCentre && !loadingTrends && trends && (
            <>
              {/* ── Live summary cards ─────────────────────────────────── */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
                <StatCard
                  label="Today"
                  value={trends.todayPct !== null ? `${trends.todayPct}%` : "—"}
                  sub={trends.todayPresent !== null ? `${trends.todayPresent} present` : "Not marked yet"}
                  color={trends.todayPct !== null ? pctColor(trends.todayPct) : "#9ca3af"}
                  icon="📅"
                />
                <StatCard
                  label="This Week"
                  value={trends.weekPct !== null ? `${trends.weekPct}%` : "—"}
                  sub="avg attendance"
                  color={trends.weekPct !== null ? pctColor(trends.weekPct) : "#9ca3af"}
                  icon="📆"
                />
                <StatCard
                  label={`${fmtMonth(trends.thisMonth)}`}
                  value={trends.monthPct !== null ? `${trends.monthPct}%` : "—"}
                  sub={`${trends.classDaysThisMonth} class day${trends.classDaysThisMonth !== 1 ? "s" : ""}`}
                  color={trends.monthPct !== null ? pctColor(trends.monthPct) : "#9ca3af"}
                  icon="🗓"
                />
                <StatCard
                  label="Best Day (30d)"
                  value={trends.bestDay ? `${trends.bestDay.pct}%` : "—"}
                  sub={trends.bestDay ? fmtDate(trends.bestDay.date) : ""}
                  color="#16a34a"
                  icon="🌟"
                />
                <StatCard
                  label="Worst Day (30d)"
                  value={trends.worstDay ? `${trends.worstDay.pct}%` : "—"}
                  sub={trends.worstDay ? fmtDate(trends.worstDay.date) : ""}
                  color="#dc2626"
                  icon="⚠"
                />
                <StatCard
                  label="Total Students"
                  value={String(trends.totalStudents)}
                  sub="enrolled"
                  color="#4f46e5"
                  icon="🎓"
                />
              </div>

              {/* ── Daily trend (30 days) ──────────────────────────────── */}
              <div style={s.card}>
                <div style={s.chartTitle}>Daily Attendance — Last 30 Days</div>
                <BarChart
                  data={trends.dailyData.map(d => ({
                    label: fmtDate(d.date),
                    value: d.pct,
                    sub:   d.total > 0 ? `${d.present}/${d.total}` : "—",
                    empty: d.total === 0,
                    isToday: d.date === todayISO(),
                  }))}
                  height={160}
                />
                <div style={s.chartLegend}>
                  <LegendDot color="#16a34a" label="≥75%" />
                  <LegendDot color="#d97706" label="50–74%" />
                  <LegendDot color="#dc2626" label="<50%" />
                  <LegendDot color="#e5e7eb" label="No data" />
                </div>
              </div>

              {/* ── Weekly trend (12 weeks) ────────────────────────────── */}
              <div style={s.card}>
                <div style={s.chartTitle}>Weekly Attendance — Last 12 Weeks</div>
                <BarChart
                  data={trends.weeklyData.map(d => ({
                    label: d.week.replace(/\d{4}-/, ""),
                    value: d.pct,
                    sub:   d.total > 0 ? `${d.present}/${d.total}` : "—",
                    empty: d.total === 0,
                    isToday: d.week === currentWeekKey(),
                  }))}
                  height={140}
                />
              </div>

              {/* ── Monthly trend (12 months) ──────────────────────────── */}
              <div style={s.card}>
                <div style={s.chartTitle}>Monthly Attendance — Last 12 Months</div>
                <BarChart
                  data={trends.monthlyData.map(d => ({
                    label: fmtMonth(d.month).split(" ")[0], // "Apr"
                    value: d.pct,
                    sub:   d.total > 0 ? `${d.present}/${d.total}` : "—",
                    empty: d.total === 0,
                    isToday: d.month === isoToMonth(todayISO()),
                  }))}
                  height={140}
                />
                <div style={{ display: "flex", gap: 16, marginTop: 8, overflowX: "auto", paddingBottom: 4 }}>
                  {trends.monthlyData.map(d => (
                    <div key={d.month} style={{ textAlign: "center", minWidth: 48, fontSize: 11, color: "#374151" }}>
                      <div style={{ fontWeight: 700, color: d.total ? pctColor(d.pct) : "#9ca3af" }}>
                        {d.total ? `${d.pct}%` : "—"}
                      </div>
                      <div style={{ color: "#9ca3af" }}>{fmtMonth(d.month).split(" ")[0]}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Per-student this month ─────────────────────────────── */}
              <div style={s.card}>
                <div style={s.chartTitle}>
                  Student Breakdown — {fmtMonth(trends.thisMonth)}
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: "#9ca3af" }}>
                    {trends.classDaysThisMonth} class day{trends.classDaysThisMonth !== 1 ? "s" : ""}
                  </span>
                </div>
                {trends.studentStats.length === 0 ? (
                  <div style={{ color: "#9ca3af", fontSize: 13, padding: "12px 0" }}>No records yet this month.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={s.th}>Student</th>
                          <th style={s.th}>Type</th>
                          <th style={s.th}>Present</th>
                          <th style={s.th}>Absent</th>
                          <th style={s.th}>Attendance %</th>
                          <th style={s.th}>Bar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trends.studentStats.map(st => (
                          <tr key={st.uid} style={{ borderBottom: "1px solid #f3f4f6" }}>
                            <td style={s.td}>
                              <div style={{ fontWeight: 600, color: "#111827" }}>{st.name}</div>
                              {st.instrument && <div style={{ fontSize: 11, color: "#9ca3af" }}>{st.instrument}</div>}
                            </td>
                            <td style={s.td}>
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: st.classType === "personal" ? "#fef9c3" : "#dcfce7", color: st.classType === "personal" ? "#92400e" : "#166534" }}>
                                {st.classType === "personal" ? "Personal" : "Group"}
                              </span>
                            </td>
                            <td style={{ ...s.td, textAlign: "center", fontWeight: 700, color: "#16a34a" }}>{st.present}</td>
                            <td style={{ ...s.td, textAlign: "center", fontWeight: 700, color: "#dc2626" }}>{st.absent}</td>
                            <td style={{ ...s.td, textAlign: "center" }}>
                              <span style={{ fontWeight: 800, fontSize: 14, color: pctColor(st.pct) }}>{st.pct}%</span>
                            </td>
                            <td style={{ ...s.td, minWidth: 100 }}>
                              <div style={{ background: "#f3f4f6", borderRadius: 99, height: 8, width: "100%", overflow: "hidden" }}>
                                <div style={{ background: pctColor(st.pct), height: "100%", width: `${st.pct}%`, borderRadius: 99, transition: "width 0.4s ease" }} />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* Pulse animation */}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}

// ─── Bar Chart (SVG, no deps) ─────────────────────────────────────────────────

function BarChart({ data, height = 140 }: {
  data:   { label: string; value: number; sub: string; empty: boolean; isToday: boolean }[];
  height?: number;
}) {
  const barW  = Math.max(8, Math.min(32, Math.floor(560 / data.length) - 4));
  const gap   = Math.max(2, Math.floor(560 / data.length) - barW);
  const totalW = data.length * (barW + gap);
  const chartH = height - 32; // reserve 32px for labels below

  return (
    <div style={{ overflowX: "auto", paddingBottom: 4 }}>
      <svg width={Math.max(totalW, 100)} height={height} style={{ display: "block" }}>
        {/* Gridlines */}
        {[25, 50, 75, 100].map(v => {
          const y = chartH - (v / 100) * chartH;
          return (
            <g key={v}>
              <line x1={0} x2={totalW} y1={y} y2={y} stroke="#f3f4f6" strokeWidth={1} />
              <text x={0} y={y - 2} fontSize={9} fill="#d1d5db">{v}%</text>
            </g>
          );
        })}
        {/* 75% threshold line */}
        <line x1={0} x2={totalW} y1={chartH - 0.75 * chartH} y2={chartH - 0.75 * chartH}
          stroke="#86efac" strokeWidth={1} strokeDasharray="4,3" />

        {data.map((d, i) => {
          const x     = i * (barW + gap);
          const barH  = d.empty ? 0 : Math.max(2, (d.value / 100) * chartH);
          const y     = chartH - barH;
          const color = d.empty ? "#e5e7eb" : pctColor(d.value);
          return (
            <g key={i}>
              {/* Bar */}
              <rect x={x} y={y} width={barW} height={barH} rx={3} fill={color} opacity={d.isToday ? 1 : 0.82} />
              {/* Today highlight ring */}
              {d.isToday && <rect x={x - 1} y={0} width={barW + 2} height={chartH} rx={3} fill="none" stroke="#f59e0b" strokeWidth={1.5} />}
              {/* Value on top */}
              {!d.empty && barH > 16 && (
                <text x={x + barW / 2} y={y + 11} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">
                  {d.value}%
                </text>
              )}
              {/* Label below */}
              <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" fontSize={9} fill={d.isToday ? "#f59e0b" : "#9ca3af"} fontWeight={d.isToday ? 700 : 400}>
                {d.label}
              </text>
            </g>
          );
        })}
        {/* Baseline */}
        <line x1={0} x2={totalW} y1={chartH} y2={chartH} stroke="#e5e7eb" strokeWidth={1} />
      </svg>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, icon }: { label: string; value: string; sub: string; color: string; icon: string }) {
  return (
    <div style={{ ...s.card, marginBottom: 0, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ fontSize: 18 }}>{icon}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#9ca3af" }}>{sub}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#6b7280" }}>
      <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
      {label}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</label>
      {children}
    </div>
  );
}

function Chip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center", minWidth: 36 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ ...s.card, textAlign: "center", padding: "52px 0" }}>
      <div style={{ fontSize: 36, marginBottom: 10 }}>{icon}</div>
      <p style={{ fontSize: 14, color: "#6b7280", margin: 0 }}>{text}</p>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  card: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
    padding: "16px 20px", marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  } as React.CSSProperties,
  input: {
    padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 7,
    fontSize: 13, outline: "none", color: "#111827", background: "#fff",
    cursor: "pointer", minWidth: 180,
  } as React.CSSProperties,
  chartTitle: {
    fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 14,
  } as React.CSSProperties,
  chartLegend: {
    display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap",
  } as React.CSSProperties,
  th: {
    padding: "8px 12px", textAlign: "left" as const, fontSize: 11, fontWeight: 700,
    color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: 0.5,
    borderBottom: "2px solid #f3f4f6", whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  td: {
    padding: "10px 12px", verticalAlign: "middle" as const,
  } as React.CSSProperties,
};

function btn(bg: string, fg: string): React.CSSProperties {
  return { background: bg, color: fg, border: "none", padding: "8px 16px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };
}

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
