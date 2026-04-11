"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import { getCenterById } from "@/services/center/center.service";
import {
  getAttendanceByCentreDate,
  saveCentreAttendance,
  saveExtraClass,
  getExtraClassesByCentre,
} from "@/services/attendance/attendance.service";
import type { AttendanceStatus } from "@/services/attendance/attendance.service";
import {
  getLessonsForStudent,
  getProgressByStudent,
  calcOverallPercent,
  calcLessonPercent,
  addAttempt,
  markItemCompleted,
  isItemUnlocked,
} from "@/services/lesson/lesson.service";
import type { Center } from "@/types";
import type { StudentUser } from "@/types";
import { isTeacher } from "@/types";
import type { Lesson, LessonItem, StudentLessonProgress } from "@/types/lesson";
import type { Role } from "@/types";

// ─── Local types ──────────────────────────────────────────────────────────────

interface StudentRow {
  uid:        string;
  name:       string;
  instrument: string;
  status:     string;
  centerId:   string;
  classType?: string;  // "group" | "personal" — present on personal student rows
}

// Sentinel value used as selectedCenter when the teacher is viewing personal students
const PERSONAL_TAB_ID = "__personal__";

interface AttendanceState {
  [studentUid: string]: AttendanceStatus;
}

interface StudentProgress {
  uid:        string;
  name:       string;
  instrument: string;
  pct:        number;
  balance:    number;
  status:     string;
}

interface WeekDay {
  date:    string;   // YYYY-MM-DD
  label:   string;   // "Mon"
  pct:     number | null;
}

interface DashboardInsights {
  teacherScore:      number;
  scoreChange:       number;   // vs last week average
  weeklyTrend:       WeekDay[];
  studentProgress:   StudentProgress[];
  presentCount:      number;
  absentCount:       number;
  pendingFeeCount:   number;
  deactivationCount: number;
}

type View =
  | { type: "overview" }
  | { type: "attendance"; centreId: string; daysOfWeek: string[] }
  | { type: "students" }
  | { type: "progress"; student: StudentRow; from: "overview" | "students" };

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function TeacherDashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.TEACHER, ROLES.ADMIN, ROLES.SUPER_ADMIN]}>
      <TeacherDashboardContent />
    </ProtectedRoute>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function TeacherDashboardContent() {
  const { user } = useAuthContext();
  const { isAllowed, isTeacherRole } = useCentreAccess(); // isAllowed guards per-centre access

  // Safely extract centerIds using the type guard — TeacherUser has centerIds: string[]
  // AdminUser has centerIds?: never so we must not access it without narrowing first
  // Serialised as a string so effects re-run when the list actually changes
  const centerIdsKey: string = user && isTeacher(user) ? user.centerIds.join(",") : "";
  const centerIds: string[]  = useMemo(
    () => centerIdsKey ? centerIdsKey.split(",") : [],
    [centerIdsKey],
  );

  const [centers, setCenters]               = useState<Center[]>([]);
  const [selectedCenter, setSelectedCenter] = useState<string>("");
  const [view, setView]                     = useState<View>({ type: "overview" });
  const [loading, setLoading]               = useState(true);

  // Loaded per-center
  const [students, setStudents]             = useState<StudentRow[]>([]);
  const [attendancePct, setAttendancePct]   = useState<number | null>(null);
  const [lowProgressCount, setLowProgressCount] = useState<number | null>(null);
  const [centerDataLoading, setCenterDataLoading] = useState(false);
  const [insights, setInsights]             = useState<DashboardInsights | null>(null);

  // Personal students assigned directly to this teacher (classType === "personal")
  const [personalStudents, setPersonalStudents] = useState<StudentRow[]>([]);
  const [personalLoading, setPersonalLoading]   = useState(false);

  // Stable date string — computed once on mount, never changes reference
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── Load centers the teacher/admin is assigned to ─────────────────────────

  useEffect(() => {
    if (!user) return;

    // Teacher with no assigned centres yet — show empty state
    if (isTeacherRole && centerIds.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);

    async function loadCenters() {
      try {
        let mine: Center[];
        if (centerIds.length > 0) {
          // Fetch each assigned centre by ID — respects teacher.centerIds exactly
          const results = await Promise.allSettled(centerIds.map(id => getCenterById(id)));
          mine = results
            .filter((r): r is PromiseFulfilledResult<Center> => r.status === "fulfilled")
            .map(r => r.value);
        } else {
          // Admin with no specific centres — fetch all centres
          const snap = await getDocs(collection(db, "centers"));
          mine = snap.docs.map(d => ({ id: d.id, ...d.data() } as Center));
        }
        setCenters(mine);
        // Select first centre by default (teacher.centerIds[0])
        if (mine.length > 0) {
          setSelectedCenter(prev => prev && mine.some(c => c.id === prev) ? prev : mine[0].id);
        }
      } catch (err) {
        console.error("Failed to load centers:", err);
      } finally {
        setLoading(false);
      }
    }
    loadCenters();
  // Re-run when uid changes OR when centerIds list changes (firebase may populate later)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, centerIdsKey]);

  // ── Load data for the selected center ────────────────────────────────────

  const loadCenterData = useCallback(async (centerId: string) => {
    if (!centerId || !user) return;

    // Clear stale data immediately so previous centre never bleeds through
    setStudents([]);
    setAttendancePct(null);
    setLowProgressCount(null);
    setInsights(null);
    setCenterDataLoading(true);

    try {
      // ── 1. Students for this centre ─────────────────────────────────────
      // Two-field equality query — uses the deployed composite index
      // (role ASC + centerId ASC). Same pattern used in the attendance page.
      const studentSnap = await getDocs(query(
        collection(db, "users"),
        where("role",     "==", "student"),
        where("centerId", "==", centerId),
      ));

      // Client-side filter: role === "student" AND status active.
      // Fallback: old docs may only have studentStatus (written before dual-write fix).
      // Mirror the same fallback chain used in admin students page fetchData.
      const rows: StudentRow[] = studentSnap.docs
        .filter(d => {
          const u = d.data();
          const effectiveStatus = (u.status ?? u.studentStatus ?? "active") as string;

          // Safety check: warn and skip if student.centerId does not match queried centerId.
          // This catches data inconsistencies (e.g. student assigned to wrong centre in Firestore).
          if (u.centerId && u.centerId !== centerId) {
            console.warn(
              `[Faculty Suite] Student ${d.id} has centerId "${u.centerId}"` +
              ` but was returned in query for centerId "${centerId}" — skipping.`
            );
            return false;
          }

          return u.role === "student" && effectiveStatus === "active";
        })
        .map(d => {
          const u = d.data();
          return {
            uid:        d.id,
            name:       (u.displayName ?? u.name ?? "—") as string,
            instrument: (u.instrument ?? "—") as string,
            status:     ((u.status ?? u.studentStatus ?? "active") as string),
            centerId:   (u.centerId ?? "") as string,
          };
        });
      setStudents(rows);

      // ── 2. Today's attendance (centre-based) ────────────────────────────
      // Use rows.length (enrolled students) as denominator, not todayRecs.length.
      // todayRecs only contains students already marked — using it as denominator
      // inflates the percentage (5 marked present out of 5 marked = 100%, not 5/10).
      // Same logic as attendance page summary: total = students.length.
      const allTodayRecs = await getAttendanceByCentreDate(centerId, today);
      // Safety: skip attendance records whose centerId doesn't match — these are stale
      // records from a previous centre assignment before data was corrected.
      const todayRecs = allTodayRecs.filter(r => {
        if ((r as unknown as Record<string, unknown>).centerId !== centerId) {
          console.warn(
            `[Faculty Suite] Attendance record ${r.id} has centerId mismatch — skipping.`
          );
          return false;
        }
        return true;
      });
      const presentCnt = todayRecs.filter(r => r.status === "present").length;
      const absentCnt  = todayRecs.filter(r => r.status === "absent").length;
      const attTotal   = rows.length;   // enrolled students, not marked records
      const todayPct   = attTotal > 0 ? Math.round((presentCnt / attTotal) * 100) : null;
      setAttendancePct(todayPct);

      // ── 3. Per-student progress (parallel, best-effort) ─────────────────
      const progressList: StudentProgress[] = await Promise.all(
        rows.map(async st => {
          try {
            const [prog, { lessons }] = await Promise.all([
              getProgressByStudent(st.uid),
              getLessonsForStudent(st.uid),
            ]);
            const allItems = lessons.flatMap(l => l.items);
            const pm: Record<string, StudentLessonProgress> = {};
            prog.forEach(p => { pm[p.itemId] = p; });
            const pct = calcOverallPercent(allItems, pm);
            const raw = studentSnap.docs.find(d => d.id === st.uid)?.data();
            return {
              uid: st.uid, name: st.name, instrument: st.instrument,
              pct, balance: Number(raw?.currentBalance ?? 0), status: st.status,
            };
          } catch {
            return { uid: st.uid, name: st.name, instrument: st.instrument, pct: 0, balance: 0, status: st.status };
          }
        }),
      );

      const lowCount = progressList.filter(p => p.pct < 40).length;
      setLowProgressCount(lowCount);

      // ── 4. Weekly attendance trend (last 7 days) ────────────────────────
      // Query all attendance for this centre, filter by date client-side
      const allAttSnap = await getDocs(
        query(collection(db, "attendance"), where("centerId", "==", centerId)),
      );
      const allAttRecs = allAttSnap.docs.map(d => d.data() as { date?: string; status?: string });

      const weekDays: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
        const d    = new Date();
        d.setDate(d.getDate() - (6 - i));
        const iso  = d.toISOString().slice(0, 10);
        const label = d.toLocaleDateString("en-IN", { weekday: "short" });
        const recs  = allAttRecs.filter(r => r.date === iso);
        const prs   = recs.filter(r => r.status === "present").length;
        const pct   = recs.length > 0 ? Math.round((prs / recs.length) * 100) : null;
        return { date: iso, label, pct };
      });

      // ── 5. Alerts: pending fees + deactivation requests ─────────────────
      const pendingFeeCount = progressList.filter(p => p.balance > 0).length;
      // Count deactivation requests from THIS centre's students only.
      // studentSnap is already scoped to centerId so this is correct.
      // Admin writes status: "deactivation_requested" (not a separate field).
      const deactivationCount = studentSnap.docs.filter(d => {
        const data = d.data();
        const effectiveStatus = (data.status ?? data.studentStatus ?? "") as string;
        return effectiveStatus === "deactivation_requested";
      }).length;

      // ── 6. Teacher score (0–100) ────────────────────────────────────────
      // Weighted: attendance(40%) + avg progress(40%) + consistency(20%)
      const attScore   = todayPct ?? 0;                              // 0–100
      const avgPct     = progressList.length > 0
        ? progressList.reduce((s, p) => s + p.pct, 0) / progressList.length
        : 0;                                                         // 0–100
      const markedDays = weekDays.filter(d => d.pct !== null).length;
      const consistency = Math.round((markedDays / 7) * 100);       // 0–100
      const teacherScore = Math.round(attScore * 0.4 + avgPct * 0.4 + consistency * 0.2);

      // Score change: compare today's score vs the average of the previous 6 days
      const prevDayScores = weekDays.slice(0, 6).map(d => d.pct ?? 0);
      const prevAvg = prevDayScores.length > 0
        ? prevDayScores.reduce((a, b) => a + b, 0) / prevDayScores.length
        : 0;
      const scoreChange = Math.round(attScore - prevAvg);

      setInsights({
        teacherScore, scoreChange, weeklyTrend: weekDays,
        studentProgress: progressList,
        presentCount: presentCnt, absentCount: absentCnt,
        pendingFeeCount, deactivationCount,
      });
    } catch (err) {
      console.error("loadCenterData error:", err);
    } finally {
      setCenterDataLoading(false);
    }
  // today is stable (useMemo []); user.uid is the meaningful identity dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, today]);

  useEffect(() => {
    if (selectedCenter && selectedCenter !== PERSONAL_TAB_ID) loadCenterData(selectedCenter);
  }, [selectedCenter, loadCenterData]);

  // ── Load personal students assigned to this teacher ───────────────────────
  useEffect(() => {
    if (!user?.uid || !isTeacherRole) return;
    setPersonalLoading(true);
    getDocs(query(
      collection(db, "users"),
      where("role",               "==", "student"),
      where("assignedTeacherUid", "==", user.uid),
    )).then(snap => {
      const rows: StudentRow[] = snap.docs
        .filter(d => {
          const u = d.data();
          const status = (u.status ?? u.studentStatus ?? "active") as string;
          return status === "active";
        })
        .map(d => {
          const u = d.data();
          return {
            uid:        d.id,
            name:       (u.displayName ?? u.name ?? "—") as string,
            instrument: (u.instrument ?? "—") as string,
            status:     ((u.status ?? u.studentStatus ?? "active") as string),
            centerId:   (u.centerId ?? "") as string,
            classType:  "personal",
          };
        });
      setPersonalStudents(rows);
    }).catch(err => {
      console.error("[Faculty Suite] Failed to load personal students:", err);
    }).finally(() => {
      setPersonalLoading(false);
    });
  }, [user?.uid, isTeacherRole]);

  // ── Guards ────────────────────────────────────────────────────────────────

  if (loading) return <div style={s.center}>Loading Faculty Suite…</div>;

  if (centers.length === 0) {
    return (
      <div style={s.emptyState}>
        {isTeacherRole
          ? "You have not been assigned to any centre yet. Contact your administrator."
          : "No centres found."}
      </div>
    );
  }

  // Hard block: teacher somehow navigated to a centre outside their list
  if (selectedCenter && isTeacherRole && !isAllowed(selectedCenter)) {
    return (
      <div style={{ ...s.emptyState, color: "#dc2626" }}>
        🚫 Access Denied — you are not assigned to this centre.
      </div>
    );
  }

  const selectedCentreObj = centers.find(c => c.id === selectedCenter);
  const centerName = selectedCentreObj?.name ?? selectedCenter;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>

      {/* ── Centre Tab Bar (shown for all counts; tabs only clickable when > 1) ── */}
      <div style={s.tabBar}>
        {centers.map(c => (
          <button
            key={c.id}
            style={{
              ...s.tab,
              ...(c.id === selectedCenter ? s.tabActive : {}),
            }}
            onClick={() => {
              if (c.id !== selectedCenter) {
                setSelectedCenter(c.id);
                setView({ type: "overview" });
              }
            }}
          >
            {c.name}
            {c.id === selectedCenter && centerDataLoading && (
              <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>…</span>
            )}
          </button>
        ))}
        {/* Personal students tab — always shown for teachers */}
        {isTeacherRole && (
          <button
            style={{
              ...s.tab,
              ...(selectedCenter === PERSONAL_TAB_ID ? s.tabActive : {}),
            }}
            onClick={() => {
              if (selectedCenter !== PERSONAL_TAB_ID) {
                setSelectedCenter(PERSONAL_TAB_ID);
                setView({ type: "students" });
              }
            }}
          >
            👤 Personal
            {personalLoading
              ? <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>…</span>
              : personalStudents.length > 0
                ? <span style={{ marginLeft: 6, fontSize: 11, background: "var(--color-accent,#6366f1)", color: "#fff", borderRadius: 10, padding: "1px 6px" }}>{personalStudents.length}</span>
                : null}
          </button>
        )}
      </div>

      {/* ── Back button ── */}
      {view.type !== "overview" && selectedCenter !== PERSONAL_TAB_ID && (
        <button style={s.backBtn} onClick={() => {
          if (view.type === "progress" && view.from === "students") setView({ type: "students" });
          else setView({ type: "overview" });
        }}>
          {view.type === "progress" && view.from === "students" ? "← Back to Students" : "← Back to Overview"}
        </button>
      )}
      {view.type === "progress" && selectedCenter === PERSONAL_TAB_ID && (
        <button style={s.backBtn} onClick={() => setView({ type: "students" })}>
          ← Back to Personal Students
        </button>
      )}

      {/* ── Personal Tab: show personal students list or progress ── */}
      {selectedCenter === PERSONAL_TAB_ID && (
        personalLoading
          ? <div style={{ ...s.center, paddingTop: 64 }}>Loading personal students…</div>
          : view.type === "progress"
            ? <ProgressView
                student={view.student}
                teacherUid={user?.uid ?? ""}
                teacherRole={(user?.role ?? ROLES.TEACHER) as Role}
              />
            : personalStudents.length === 0
              ? <div style={s.emptyState}>No personal students assigned to you yet.</div>
              : <StudentsView
                  students={personalStudents}
                  teacherUid={user?.uid ?? ""}
                  onViewProgress={st => setView({ type: "progress", student: st, from: "students" })}
                />
      )}

      {/* ── Centre Views ── */}
      {selectedCenter !== PERSONAL_TAB_ID && view.type === "overview" && (
        centerDataLoading
          ? <div style={{ ...s.center, paddingTop: 64 }}>Loading centre data…</div>
          : <OverviewView
              teacherName={user?.displayName ?? "Teacher"}
              centerId={selectedCenter}
              centerName={centerName}
              today={today}
              students={students}
              attendancePct={attendancePct}
              lowProgressCount={lowProgressCount}
              insights={insights}
              onMarkAttendance={() => setView({ type: "attendance", centreId: selectedCenter, daysOfWeek: (selectedCentreObj as (typeof selectedCentreObj) & { daysOfWeek?: string[] })?.daysOfWeek ?? [] })}
              onViewStudents={() => setView({ type: "students" })}
              onViewProgress={st => setView({ type: "progress", student: st, from: "overview" })}
              onRefresh={() => loadCenterData(selectedCenter)}
            />
      )}

      {selectedCenter !== PERSONAL_TAB_ID && view.type === "attendance" && (
        <AttendanceGridView
          centreId={view.centreId}
          daysOfWeek={view.daysOfWeek}
          students={students}
          markedBy={user?.uid ?? ""}
          onDone={() => { setView({ type: "overview" }); loadCenterData(selectedCenter); }}
        />
      )}

      {selectedCenter !== PERSONAL_TAB_ID && view.type === "students" && (
        <StudentsView
          students={students}
          teacherUid={user?.uid ?? ""}
          onViewProgress={st => setView({ type: "progress", student: st, from: "students" })}
        />
      )}

      {selectedCenter !== PERSONAL_TAB_ID && view.type === "progress" && (
        <ProgressView
          student={view.student}
          teacherUid={user?.uid ?? ""}
          teacherRole={(user?.role ?? ROLES.TEACHER) as Role}
        />
      )}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════════

function OverviewView({
  teacherName, centerId, centerName, today,
  students, attendancePct, lowProgressCount, insights,
  onMarkAttendance, onViewStudents, onViewProgress, onRefresh,
}: {
  teacherName:      string;
  centerId:         string;
  centerName:       string;
  today:            string;
  students:         StudentRow[];
  attendancePct:    number | null;
  lowProgressCount: number | null;
  insights:         DashboardInsights | null;
  onMarkAttendance: () => void;
  onViewStudents:   () => void;
  onViewProgress:   (st: StudentRow) => void;
  onRefresh:        () => void;
}) {
  void centerId; void onRefresh; // kept for future use

  const score       = insights?.teacherScore ?? null;
  const scoreChange = insights?.scoreChange  ?? 0;
  const trend       = insights?.weeklyTrend  ?? [];

  // Top / bottom 3 students by progress
  const sorted      = [...(insights?.studentProgress ?? [])].sort((a,b) => b.pct - a.pct);
  const top3        = sorted.slice(0, 3);
  const bottom3     = sorted.slice(-3).reverse();

  // Alert list
  const alerts: { icon: string; msg: string; color: string }[] = [];
  if (attendancePct === null)
    alerts.push({ icon: "📋", msg: "Attendance not marked today.", color: "#b45309" });
  if ((lowProgressCount ?? 0) > 0)
    alerts.push({ icon: "📉", msg: `${lowProgressCount} student(s) below 40% progress.`, color: "#dc2626" });
  if ((insights?.pendingFeeCount ?? 0) > 0)
    alerts.push({ icon: "💰", msg: `${insights!.pendingFeeCount} student(s) have pending fees.`, color: "#7c3aed" });
  if ((insights?.deactivationCount ?? 0) > 0)
    alerts.push({ icon: "⚠️", msg: `${insights!.deactivationCount} deactivation request(s) pending.`, color: "#dc2626" });

  return (
    <div>

      {/* ── HERO ── */}
      <div style={{
        background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
        borderRadius: 12, padding: "20px 24px", marginBottom: 20,
        color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16,
      }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 2 }}>
            {teacherName}
          </div>
          <div style={{ fontSize: 13, opacity: 0.75 }}>
            {centerName} · {new Date(today + "T12:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {score !== null && (
            <div style={{ textAlign: "center", background: "rgba(255,255,255,0.15)", borderRadius: 10, padding: "10px 20px" }}>
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{score}</div>
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                {scoreChange >= 0 ? "▲" : "▼"} {Math.abs(scoreChange)}% vs last week
              </div>
            </div>
          )}
          <button style={{ ...s.btnPrimary, background: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.4)", color: "#fff" }} onClick={onMarkAttendance}>
            ✓ Attendance
          </button>
          <button style={{ ...s.btnGhost, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff" }} onClick={onViewStudents}>
            👥 Students
          </button>
        </div>
      </div>

      {/* ── STATS ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 12, marginBottom: 20 }}>
        <InsightCard label="Students"    value={String(students.length)}                                              color="#4f46e5" />
        <InsightCard label="Att. Today"  value={attendancePct !== null ? `${attendancePct}%` : "—"}                   color="#16a34a" />
        <InsightCard label="Present"     value={insights?.presentCount != null ? String(insights.presentCount) : "—"} color="#0891b2" />
        <InsightCard label="Low Progress" value={lowProgressCount !== null ? String(lowProgressCount) : "—"}          color="#dc2626" />
      </div>

      {/* ── ALERTS ── */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={s.sectionTitle}>⚠️ Alerts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {alerts.map((a, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 10,
                background: "#fff", border: `1px solid #e5e7eb`, borderLeft: `4px solid ${a.color}`,
                borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#374151",
              }}>
                <span>{a.icon}</span>
                <span style={{ flex: 1 }}>{a.msg}</span>
                {i === 0 && attendancePct === null && (
                  <button style={s.btnSm} onClick={onMarkAttendance}>Mark now</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ATTENDANCE SUMMARY ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "16px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#16a34a" }}>{insights?.presentCount ?? "—"}</div>
          <div style={{ fontSize: 12, color: "#15803d", fontWeight: 600, marginTop: 4 }}>Present Today</div>
        </div>
        <div style={{ background: "#fff1f2", border: "1px solid #fecaca", borderRadius: 10, padding: "16px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#dc2626" }}>{insights?.absentCount ?? "—"}</div>
          <div style={{ fontSize: 12, color: "#b91c1c", fontWeight: 600, marginTop: 4 }}>Absent Today</div>
        </div>
      </div>

      {/* ── STUDENT PERFORMANCE SNAPSHOT ── */}
      {sorted.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
            {/* Top 3 */}
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", background: "#f0fdf4", fontSize: 12, fontWeight: 700, color: "#15803d", borderBottom: "1px solid #bbf7d0" }}>
                🏆 Top Students
              </div>
              {top3.map((st, i) => (
                <div key={st.uid} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: i < top3.length-1 ? "1px solid #f3f4f6" : "none", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#9ca3af", minWidth: 16 }}>{i+1}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#111" }}>{st.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#16a34a" }}>{st.pct}%</span>
                  <button style={s.linkBtn} onClick={() => { const row = students.find(s=>s.uid===st.uid); if(row) onViewProgress(row); }}>→</button>
                </div>
              ))}
            </div>
            {/* Bottom 3 */}
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", background: "#fff1f2", fontSize: 12, fontWeight: 700, color: "#b91c1c", borderBottom: "1px solid #fecaca" }}>
                📉 Need Attention
              </div>
              {bottom3.map((st, i) => (
                <div key={st.uid} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: i < bottom3.length-1 ? "1px solid #f3f4f6" : "none", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#9ca3af", minWidth: 16 }}>{sorted.length - (bottom3.length - 1 - i)}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#111" }}>{st.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#dc2626" }}>{st.pct}%</span>
                  <button style={s.linkBtn} onClick={() => { const row = students.find(s=>s.uid===st.uid); if(row) onViewProgress(row); }}>→</button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── WEEKLY PERFORMANCE TREND ── */}
      {trend.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 18px", marginBottom: 20 }}>
          <div style={{ ...s.sectionTitle, marginBottom: 14 }}>📈 Weekly Attendance Trend</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 80 }}>
            {trend.map(d => {
              const h   = d.pct !== null ? Math.max(8, Math.round(d.pct * 0.72)) : 8;
              const bg  = d.date === today ? "#4f46e5" : d.pct !== null ? "#a5b4fc" : "#e5e7eb";
              const col = d.date === today ? "#4f46e5" : "#9ca3af";
              return (
                <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: col }}>
                    {d.pct !== null ? `${d.pct}%` : "—"}
                  </span>
                  <div style={{ width: "100%", height: h, background: bg, borderRadius: 4 }} />
                  <span style={{ fontSize: 10, color: col, fontWeight: d.date === today ? 800 : 400 }}>{d.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDANCE GRID VIEW (monthly calendar)
// ═══════════════════════════════════════════════════════════════════════════════

const ATT_STATUSES: AttendanceStatus[] = [
  "present","absent","break","cancelled_teacher","cancelled_student",
];
const ATT_LABEL: Record<AttendanceStatus, string> = {
  present:           "Present",
  absent:            "Absent",
  break:             "Break",
  cancelled_teacher: "Cancelled (Teacher)",
  cancelled_student: "Cancelled (Student)",
};
const ATT_SHORT: Record<AttendanceStatus, string> = {
  present:           "P",
  absent:            "A",
  break:             "☕",
  cancelled_teacher: "CT",
  cancelled_student: "CS",
};
const ATT_COLOR: Record<AttendanceStatus, { bg: string; fg: string }> = {
  present:           { bg: "#dcfce7", fg: "#16a34a" },
  absent:            { bg: "#fee2e2", fg: "#dc2626" },
  break:             { bg: "#e0f2fe", fg: "#0369a1" },
  cancelled_teacher: { bg: "#fef3c7", fg: "#92400e" },
  cancelled_student: { bg: "#ede9fe", fg: "#6d28d9" },
};

const DAY_ABBR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function minMonthStr(): string {
  const d = new Date(); d.setFullYear(d.getFullYear() - 3);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function datesInMonth(month: string): string[] {
  const [yr, mo] = month.split("-").map(Number);
  return Array.from({ length: new Date(yr, mo, 0).getDate() }, (_, i) =>
    `${month}-${String(i+1).padStart(2,"0")}`);
}
function dowOf(iso: string): string {
  return DAY_ABBR[new Date(iso + "T00:00:00").getDay()];
}

function AttendanceGridView({ centreId, daysOfWeek, students, markedBy, onDone }: {
  centreId:   string;
  daysOfWeek: string[];
  students:   StudentRow[];
  markedBy:   string;
  onDone:     () => void;
}) {
  const today = useMemo(() => todayStr(), []);
  const [month,        setMonth]        = useState(currentMonthStr());
  const [attMap,       setAttMap]       = useState<Map<string, AttendanceStatus>>(new Map());
  const [extraDates,   setExtraDates]   = useState<Set<string>>(new Set());
  const [loading,      setLoading]      = useState(true);
  const [modal,        setModal]        = useState<{ uid: string; name: string; date: string; current: AttendanceStatus | null } | null>(null);
  const [saving,       setSaving]       = useState(false);
  const [showExtra,    setShowExtra]    = useState(false);
  const [extraDate,    setExtraDate]    = useState(currentMonthStr() + "-01");
  const [savingExtra,  setSavingExtra]  = useState(false);

  // Load attendance + extra classes for centre + month
  useEffect(() => {
    setLoading(true);
    const [yr, mo] = month.split("-").map(Number);
    const mStart = `${month}-01`;
    const mEnd   = `${month}-${String(new Date(yr, mo, 0).getDate()).padStart(2,"0")}`;
    Promise.all([
      getDocs(query(collection(db, "attendance"), where("centerId","==",centreId))),
      getExtraClassesByCentre(centreId, month),
    ]).then(([attSnap, extras]) => {
      const m = new Map<string, AttendanceStatus>();
      attSnap.docs.forEach(d => {
        const r = d.data() as Record<string, unknown>;
        const date = r.date as string;
        if (date >= mStart && date <= mEnd) {
          m.set(`${r.studentUid as string}|${date}`, r.status as AttendanceStatus);
        }
      });
      setAttMap(m);
      setExtraDates(new Set(extras.map(e => e.date)));
    }).catch(console.error).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId, month]);

  // Scheduled dates = centre daysOfWeek + extra dates
  const scheduledDates = useMemo(() => {
    const all = datesInMonth(month);
    return all.filter(d =>
      extraDates.has(d) ||
      (daysOfWeek.length > 0 && daysOfWeek.includes(dowOf(d)))
    );
  }, [month, daysOfWeek, extraDates]);

  // Save a single cell
  async function handleSave(status: AttendanceStatus) {
    if (!modal) return;
    setSaving(true);
    try {
      await saveCentreAttendance({ studentUid: modal.uid, centerId: centreId, date: modal.date, status, markedBy });
      setAttMap(prev => {
        const next = new Map(prev);
        next.set(`${modal.uid}|${modal.date}`, status);
        return next;
      });
      setModal(null);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  }

  // Add extra class
  async function handleAddExtra() {
    if (!extraDate) return;
    setSavingExtra(true);
    try {
      await saveExtraClass(centreId, extraDate, markedBy);
      setExtraDates(prev => new Set([...prev, extraDate]));
      setShowExtra(false);
    } catch (e) { console.error(e); }
    finally { setSavingExtra(false); }
  }

  if (loading) return <div style={s.center}>Loading…</div>;

  const [yr, mo] = month.split("-").map(Number);
  const maxDate  = `${month}-${String(new Date(yr, mo, 0).getDate()).padStart(2,"0")}`;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div style={s.sectionTitle}>Attendance</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="month" value={month} min={minMonthStr()} max={currentMonthStr()}
            onChange={e => setMonth(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 7, fontSize: 13, cursor: "pointer" }} />
          {month !== currentMonthStr() && (
            <button onClick={() => setMonth(currentMonthStr())} style={s.btnSm}>← Today</button>
          )}
          <button onClick={() => { setExtraDate(`${month}-01`); setShowExtra(true); }} style={s.btnSm}>+ Extra Class</button>
        </div>
      </div>

      {/* Extra class modal */}
      {showExtra && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setShowExtra(false); }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 24, width: 300, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Add Extra Class</div>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 600, color: "#6b7280" }}>
              DATE
              <input type="date" value={extraDate} min={`${month}-01`} max={maxDate}
                onChange={e => setExtraDate(e.target.value)}
                style={{ padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 7, fontSize: 13 }} />
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => setShowExtra(false)} style={s.btnGhost} disabled={savingExtra}>Cancel</button>
              <button onClick={handleAddExtra} disabled={savingExtra || !extraDate}
                style={{ ...s.btnPrimary, flex: 1, opacity: savingExtra ? 0.5 : 1 }}>
                {savingExtra ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cell modal */}
      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 24, width: 320, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{modal.name}</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>
              {new Date(modal.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {ATT_STATUSES.map(st => {
                const { bg, fg } = ATT_COLOR[st];
                const active = (modal.current ?? "present") === st;
                return (
                  <button key={st} onClick={() => handleSave(st)} disabled={saving}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 7, cursor: "pointer",
                      border: active ? `2px solid ${fg}` : "2px solid transparent",
                      background: active ? bg : "#f9fafb", color: active ? fg : "#374151",
                      fontWeight: active ? 700 : 500, fontSize: 13, opacity: saving ? 0.6 : 1 }}>
                    <span style={{ minWidth: 22, textAlign: "center" }}>{ATT_SHORT[st]}</span>
                    {ATT_LABEL[st]}
                    {modal.current === st && <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ca3af" }}>current</span>}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setModal(null)} style={{ ...s.btnGhost, width: "100%", marginTop: 14 }}>Cancel</button>
          </div>
        </div>
      )}

      {students.length === 0 ? (
        <div style={s.emptyCard}>No active students enrolled in this centre.</div>
      ) : scheduledDates.length === 0 ? (
        <div style={s.emptyCard}>No scheduled classes in this month.{daysOfWeek.length === 0 ? " Configure class days in Centre settings." : ""}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
            <thead>
              <tr>
                <th style={gTh}>Student</th>
                {scheduledDates.map(date => {
                  const isExtra = extraDates.has(date) && !daysOfWeek.includes(dowOf(date));
                  const isToday = date === today;
                  const d = new Date(date + "T00:00:00");
                  return (
                    <th key={date} style={{ ...gTh, textAlign: "center", minWidth: 36, padding: "4px 2px", borderLeft: "1px solid #e5e7eb",
                      background: isToday ? "#fef3c7" : isExtra ? "#f0fdf4" : "#f9fafb",
                      color: isToday ? "#92400e" : isExtra ? "#166534" : "#6b7280" }}>
                      <div style={{ fontWeight: 700 }}>{d.getDate()}</div>
                      <div style={{ fontSize: 9 }}>{DAY_ABBR[d.getDay()]}</div>
                      {isExtra && <div style={{ fontSize: 8, color: "#16a34a" }}>+</div>}
                    </th>
                  );
                })}
                <th style={{ ...gTh, textAlign: "center", background: "#dcfce7", color: "#166534", minWidth: 34 }}>P</th>
                <th style={{ ...gTh, textAlign: "center", background: "#fee2e2", color: "#991b1b", minWidth: 34 }}>A</th>
                <th style={{ ...gTh, textAlign: "center", minWidth: 34 }}>%</th>
              </tr>
            </thead>
            <tbody>
              {students.map((st, i) => {
                let p = 0, a = 0;
                const cells = scheduledDates.map(date => {
                  const isFuture   = date > today;
                  const onBreak    = !!(st as StudentRow & { breakStartDate?: string | null }).breakStartDate &&
                                     date >= ((st as StudentRow & { breakStartDate?: string | null }).breakStartDate!);
                  const status     = attMap.get(`${st.uid}|${date}`) ?? null;
                  if (status === "present") p++;
                  else if (status === "absent") a++;

                  if (isFuture) return (
                    <td key={date} style={{ ...gTd, textAlign: "center", minWidth: 36, padding: "4px 2px", borderLeft: "1px solid #f3f4f6", color: "#e5e7eb" }}>·</td>
                  );

                  const effective = status ?? (onBreak ? "break" : null);
                  const sc = effective ? ATT_COLOR[effective] : { bg: "#f9fafb", fg: "#d1d5db" };
                  return (
                    <td key={date}
                      onClick={() => setModal({ uid: st.uid, name: st.name, date, current: effective })}
                      style={{ ...gTd, textAlign: "center", minWidth: 36, padding: "4px 2px", cursor: "pointer",
                        borderLeft: "1px solid #f3f4f6", background: sc.bg, color: sc.fg }}
                      title={effective ? ATT_LABEL[effective] : "Click to mark"}>
                      {effective ? ATT_SHORT[effective] : <span style={{ color: "#d1d5db" }}>·</span>}
                    </td>
                  );
                });
                return (
                  <tr key={st.uid} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={{ ...gTd, minWidth: 140, whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 600, color: "#111827" }}>{st.name}</div>
                      {st.instrument && <div style={{ fontSize: 10, color: "#9ca3af" }}>{st.instrument}</div>}
                    </td>
                    {cells}
                    <td style={{ ...gTd, textAlign: "center", fontWeight: 700, color: "#16a34a", minWidth: 34 }}>{p}</td>
                    <td style={{ ...gTd, textAlign: "center", fontWeight: 700, color: "#dc2626", minWidth: 34 }}>{a}</td>
                    <td style={{ ...gTd, textAlign: "center", fontWeight: 700, fontSize: 12, minWidth: 34,
                      color: p+a > 0 ? (p/(p+a) >= 0.75 ? "#16a34a" : p/(p+a) >= 0.5 ? "#d97706" : "#dc2626") : "#9ca3af" }}>
                      {p+a > 0 ? `${Math.round(p/(p+a)*100)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button style={s.btnGhost} onClick={onDone}>← Back to Overview</button>
      </div>
    </div>
  );
}

const gTh: React.CSSProperties = {
  padding: "7px 10px", textAlign: "left", fontSize: 11, fontWeight: 700,
  color: "#6b7280", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb",
};
const gTd: React.CSSProperties = {
  padding: "8px 10px", verticalAlign: "middle", borderBottom: "1px solid #f3f4f6",
};

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENTS VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function StudentsView({ students, teacherUid, onViewProgress }: {
  students:       StudentRow[];
  teacherUid:     string;
  onViewProgress: (s: StudentRow) => void;
}) {
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [breakTarget, setBreakTarget] = useState<StudentRow | null>(null);
  const [breakReason, setBreakReason] = useState("");
  const [breakSaving, setBreakSaving] = useState(false);
  const [breakError, setBreakError]   = useState("");
  const [successMsg, setSuccessMsg]   = useState("");

  useEffect(() => {
    (async () => {
      const map: Record<string, number> = {};
      await Promise.all(students.map(async st => {
        try {
          const [progress, { lessons }] = await Promise.all([
            getProgressByStudent(st.uid),
            getLessonsForStudent(st.uid),
          ]);
          const allItems = lessons.flatMap(l => l.items);
          const pm: Record<string, StudentLessonProgress> = {};
          progress.forEach(p => { pm[p.itemId] = p; });
          map[st.uid] = calcOverallPercent(allItems, pm);
        } catch {
          map[st.uid] = 0;
        }
      }));
      setProgressMap(map);
    })();
  }, [students]);

  async function submitBreakRequest() {
    if (!breakTarget || !breakReason.trim()) { setBreakError("Please provide a reason."); return; }
    setBreakError("");
    setBreakSaving(true);
    try {
      const { updateDoc: ud, doc: fd, serverTimestamp: sts } = await import("firebase/firestore");
      const { db: fdb } = await import("@/services/firebase/firebase");
      const { logAction: la } = await import("@/services/audit/audit.service");

      await ud(fd(fdb, "users", breakTarget.uid), {
        status:              "break_requested",
        studentStatus:       "break_requested",
        breakApprovalStatus: "pending",
        breakRequestedBy:    teacherUid,
        breakRequestedAt:    new Date().toISOString(),
        breakReason:         breakReason.trim(),
        updatedAt:           sts(),
      });

      la({
        action: "BREAK_REQUESTED", initiatorId: teacherUid, initiatorRole: "teacher",
        approverId: null, approverRole: null, reason: breakReason.trim(),
        metadata: { studentId: breakTarget.uid, studentName: breakTarget.name },
      });

      setSuccessMsg(`Break request submitted for ${breakTarget.name}. Awaiting admin approval.`);
      setBreakTarget(null);
      setBreakReason("");
    } catch (err) {
      setBreakError(err instanceof Error ? err.message : "Failed to submit.");
    } finally {
      setBreakSaving(false);
    }
  }

  if (students.length === 0) {
    return <div style={s.emptyCard}>No students enrolled in this centre.</div>;
  }

  return (
    <div>
      {successMsg && (
        <div style={{ background: "#f0f9ff", border: "1px solid #7dd3fc", borderRadius: 8, padding: "10px 16px", fontSize: 13, color: "#0369a1", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          {successMsg}
          <button onClick={() => setSuccessMsg("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#0369a1", fontWeight: 700 }}>✕</button>
        </div>
      )}
      <div style={s.sectionTitle}>Students ({students.length})</div>
      <div style={s.card}>
        <table style={s.table}>
          <thead>
            <tr>
              {["Name", "Instrument", "Progress", "Status", ""].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students.map(st => {
              const pct = progressMap[st.uid] ?? null;
              return (
                <tr key={st.uid} style={s.tr}>
                  <td style={{ ...s.td, fontWeight: 600, color: "#111" }}>{st.name}</td>
                  <td style={s.td}>{st.instrument}</td>
                  <td style={{ ...s.td, minWidth: 140 }}>
                    {pct === null ? <span style={{ color: "#9ca3af" }}>—</span> : <ProgressBar pct={pct} />}
                  </td>
                  <td style={s.td}><StatusBadge status={st.status} /></td>
                  <td style={{ ...s.td, display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                    <button style={s.linkBtn} onClick={() => onViewProgress(st)}>
                      View Progress →
                    </button>
                    {st.status === "active" && (
                      <button
                        onClick={() => { setBreakTarget(st); setBreakReason(""); setBreakError(""); }}
                        style={{ background: "#e0f2fe", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        ☕ Break
                      </button>
                    )}
                    {st.status === "break_requested" && (
                      <span style={{ background: "#e0f2fe", color: "#0369a1", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600 }}>
                        ⏳ Break Pending
                      </span>
                    )}
                    {st.status === "on_break" && (
                      <span style={{ background: "#f0f9ff", color: "#0284c7", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600 }}>
                        ☕ On Break
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Break Request Modal */}
      {breakTarget && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 28, width: "100%", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
            <div style={{ fontWeight: 700, fontSize: 17, color: "#111827", marginBottom: 4 }}>☕ Request Break</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>
              Submitting break request for <strong>{breakTarget.name}</strong>. An admin will confirm.
            </div>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Reason *</label>
            <textarea
              value={breakReason}
              onChange={e => setBreakReason(e.target.value)}
              rows={3}
              placeholder="e.g. Medical leave, travelling, personal reasons…"
              style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "9px 12px", fontSize: 14, resize: "vertical", outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
            />
            {breakError && <div style={{ fontSize: 13, color: "#dc2626", marginTop: 8 }}>{breakError}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button type="button" onClick={() => setBreakTarget(null)}
                style={{ padding: "8px 18px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 14, cursor: "pointer", color: "#374151" }}>
                Cancel
              </button>
              <button type="button" disabled={breakSaving} onClick={submitBreakRequest}
                style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: breakSaving ? "#93c5fd" : "#0369a1", color: "#fff", fontSize: 14, fontWeight: 600, cursor: breakSaving ? "not-allowed" : "pointer" }}>
                {breakSaving ? "Submitting…" : "Submit Request"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRESS VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function ProgressView({ student, teacherUid, teacherRole }: {
  student:     StudentRow;
  teacherUid:  string;
  teacherRole: Role;
}) {
  type LessonWithItems = Lesson & { items: LessonItem[] };

  const [lessons, setLessons]         = useState<LessonWithItems[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, StudentLessonProgress>>({});
  const [unlockedMap, setUnlockedMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading]         = useState(true);
  const [actionErr, setActionErr]     = useState<string | null>(null);
  const [busy, setBusy]               = useState<string | null>(null);

  async function load() {
    try {
      const [{ lessons: ls }, progress] = await Promise.all([
        getLessonsForStudent(student.uid),
        getProgressByStudent(student.uid),
      ]);
      const pm: Record<string, StudentLessonProgress> = {};
      progress.forEach(p => { pm[p.itemId] = p; });
      setProgressMap(pm);
      setLessons(ls);

      // Unlock state per item
      const um: Record<string, boolean> = {};
      for (const lesson of ls) {
        for (const item of lesson.items) {
          um[item.id] = await isItemUnlocked(student.uid, lesson, item, ls, lesson.items);
        }
      }
      setUnlockedMap(um);
    } catch (err) {
      console.error("ProgressView load error:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [student.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAddAttempt(lesson: LessonWithItems, item: LessonItem) {
    setActionErr(null);
    setBusy(item.id);
    try {
      await addAttempt(student.uid, lesson.id, item.id, teacherUid, teacherRole, null);
      await load();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to add attempt.");
    } finally {
      setBusy(null);
    }
  }

  async function handleMarkComplete(lesson: LessonWithItems, item: LessonItem) {
    setActionErr(null);
    setBusy(item.id);
    try {
      await markItemCompleted(student.uid, lesson.id, item.id, teacherUid, teacherRole);
      await load();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to mark complete.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div style={s.center}>Loading progress…</div>;

  const allItems   = lessons.flatMap(l => l.items);
  const overallPct = calcOverallPercent(allItems, progressMap);

  return (
    <div>
      <div style={s.sectionHeader}>
        <div style={s.sectionTitle}>{student.name} — Lesson Progress</div>
        <span style={s.overallBadge}>{overallPct}% overall</span>
      </div>

      {actionErr && <div style={s.errBanner}>{actionErr}</div>}

      {lessons.length === 0 ? (
        <div style={s.emptyCard}>No lessons available for this student.</div>
      ) : (
        lessons.map(lesson => {
          const lessonPct = calcLessonPercent(lesson.items, progressMap);
          return (
            <div key={lesson.id} style={s.lessonBlock}>
              <div style={s.lessonHeader}>
                <span style={s.lessonTitle}>{lesson.title}</span>
                <span style={s.lessonPct}>{lessonPct}%</span>
              </div>
              <ProgressBar pct={lessonPct} />
              <div style={s.itemList}>
                {lesson.items.map(item => {
                  const prog     = progressMap[item.id];
                  const attempts = prog?.totalAttempts ?? 0;
                  const done     = prog?.completed ?? false;
                  const unlocked = unlockedMap[item.id] ?? false;
                  const isBusy   = busy === item.id;

                  return (
                    <div key={item.id} style={{ ...s.itemRow, opacity: unlocked ? 1 : 0.45 }}>
                      <div style={s.itemLeft}>
                        <TypeBadge type={item.type} />
                        <span style={s.itemTitle}>{item.title}</span>
                        {!unlocked && <span style={s.lockedHint}>🔒 locked</span>}
                      </div>
                      <div style={s.itemRight}>
                        {done ? (
                          <span style={s.doneBadge}>✔ Done</span>
                        ) : (
                          <>
                            <span style={s.attemptCount}>{attempts}/{item.maxAttempts}</span>
                            <button
                              style={{
                                ...s.btnSm,
                                opacity: (!unlocked || isBusy || attempts >= item.maxAttempts) ? 0.4 : 1,
                              }}
                              disabled={!unlocked || isBusy || attempts >= item.maxAttempts}
                              onClick={() => handleAddAttempt(lesson, item)}
                            >
                              {isBusy ? "…" : "+ Attempt"}
                            </button>
                            {attempts > 0 && (
                              <button
                                style={{ ...s.btnSuccess, opacity: (!unlocked || isBusy) ? 0.4 : 1 }}
                                disabled={!unlocked || isBusy}
                                onClick={() => handleMarkComplete(lesson, item)}
                              >
                                {isBusy ? "…" : "Mark Done"}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function InsightCard({ label, value, color, small }: {
  label: string; value: string; color: string; small?: boolean;
}) {
  return (
    <div style={s.insightCard}>
      <div style={{ ...s.insightAccent, background: color }} />
      <div style={s.insightBody}>
        <div style={s.insightLabel}>{label}</div>
        <div style={{ ...s.insightValue, color, fontSize: small ? 15 : 26 }}>{value}</div>
      </div>
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const color = pct >= 80 ? "#16a34a" : pct >= 40 ? "#f59e0b" : "#dc2626";
  return (
    <div style={{ position: "relative", paddingTop: 10 }}>
      <div style={s.barTrack}>
        <div style={{ ...s.barFill, width: `${pct}%`, background: color }} />
      </div>
      <span style={s.barLabel}>{pct}%</span>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    concept:   { bg: "#dbeafe", color: "#1d4ed8" },
    exercise:  { bg: "#fef3c7", color: "#b45309" },
    songsheet: { bg: "#f3e8ff", color: "#7c3aed" },
  };
  const c = map[type] ?? { bg: "#f3f4f6", color: "#374151" };
  return (
    <span style={{ ...s.typeBadge, background: c.bg, color: c.color }}>
      {type.charAt(0).toUpperCase() + type.slice(1)}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, React.CSSProperties> = {
    active:                 { background: "#dcfce7", color: "#16a34a" },
    scheduled:              { background: "#dbeafe", color: "#1d4ed8" },
    completed:              { background: "#f3f4f6", color: "#6b7280" },
    ghost:                  { background: "#fef2f2", color: "#dc2626" },
    inactive:               { background: "#f3f4f6", color: "#6b7280" },
    deactivation_requested: { background: "#fef9c3", color: "#b45309" },
    break_requested:        { background: "#e0f2fe", color: "#0369a1" },
    on_break:               { background: "#f0f9ff", color: "#0284c7" },
  };
  return (
    <span style={{ ...s.badge, ...(map[status] ?? map.inactive) }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 860, margin: "0 auto", paddingBottom: 40 },
  center:     { padding: "60px 0", textAlign: "center", fontSize: 14, color: "#9ca3af" },
  emptyState: { padding: "48px 24px", textAlign: "center", fontSize: 14, color: "#9ca3af", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginTop: 24 },

  // Top bar
  topBar:      { display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "16px 20px", marginBottom: 12 },
  topBarLeft:  { display: "flex", flexDirection: "column", gap: 2 },
  topBarRight: { display: "flex", alignItems: "center" },
  teacherName: { fontSize: 18, fontWeight: 700, color: "#111" },
  todayDate:   { fontSize: 12, color: "#9ca3af" },
  centerBadge: { padding: "6px 14px", background: "#ede9fe", color: "#4f46e5", borderRadius: 99, fontSize: 12, fontWeight: 600 },
  backBtn:     { background: "none", border: "none", color: "#4f46e5", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "0 0 16px", display: "block" },

  // Centre tab bar
  tabBar:    { display: "flex", gap: 4, marginBottom: 20, overflowX: "auto", paddingBottom: 2 },
  tab:       { background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 500, color: "#6b7280", cursor: "pointer", whiteSpace: "nowrap" as const, transition: "all 0.12s" },
  tabActive: { background: "#ede9fe", border: "1px solid #c4b5fd", color: "#4f46e5", fontWeight: 700 },

  // Insights
  insightRow:   { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 28 },
  insightCard:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" },
  insightAccent:{ height: 4 },
  insightBody:  { padding: "14px 18px" },
  insightLabel: { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", marginBottom: 6 },
  insightValue: { fontWeight: 700, lineHeight: 1.2 },

  // Section
  sectionHeader:{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, marginTop: 28 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" },

  // Classes
  classGrid:    { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 14, marginBottom: 8 },
  classCard:    { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 },
  classTime:    { fontSize: 18, fontWeight: 700, color: "#111" },
  classInfo:    { display: "flex", alignItems: "center", gap: 8 },
  classStudents:{ fontSize: 12, color: "#6b7280" },

  createClassCard: { display: "flex", alignItems: "center", gap: 10, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 16px", marginBottom: 14, flexWrap: "wrap" },
  fieldLabel:   { fontSize: 12, fontWeight: 500, color: "#6b7280" },
  timeInput:    { padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, color: "#111" },

  emptyCard:    { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "24px", textAlign: "center", fontSize: 13, color: "#9ca3af" },

  // Student preview
  previewList:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" },
  previewRow:   { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid #f3f4f6" },
  previewName:  { flex: 1, fontSize: 13, fontWeight: 600, color: "#111" },
  previewInst:  { fontSize: 12, color: "#6b7280", minWidth: 80 },
  moreRow:      { padding: "10px 18px", fontSize: 12, color: "#9ca3af" },

  // Attendance
  attActions:   { display: "flex", alignItems: "center", gap: 8, marginBottom: 14 },
  attCount:     { marginLeft: "auto", fontSize: 13, fontWeight: 600, color: "#4f46e5" },
  attList:      { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 16 },
  attRow:       { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid #f3f4f6" },
  attName:      { flex: 1, fontSize: 13, fontWeight: 600, color: "#111" },
  attInst:      { fontSize: 12, color: "#6b7280", minWidth: 80 },
  attToggle:    { border: "none", borderRadius: 20, padding: "5px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  attPresent:   { background: "#dcfce7", color: "#16a34a" },
  attAbsent:    { background: "#fef2f2", color: "#dc2626" },
  attFooter:    { display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: 8 },

  // Table
  card:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 16 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:    { textAlign: "left", padding: "9px 16px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" },
  tr:    { borderBottom: "1px solid #f3f4f6" },
  td:    { padding: "12px 16px", color: "#6b7280", verticalAlign: "middle" },

  // Progress / lessons
  overallBadge: { padding: "4px 14px", background: "#ede9fe", color: "#4f46e5", borderRadius: 99, fontSize: 13, fontWeight: 600 },
  lessonBlock:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "16px 18px", marginBottom: 14 },
  lessonHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  lessonTitle:  { fontSize: 14, fontWeight: 700, color: "#111" },
  lessonPct:    { fontSize: 13, fontWeight: 700, color: "#4f46e5" },
  itemList:     { display: "flex", flexDirection: "column", gap: 8, marginTop: 12 },
  itemRow:      { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f3f4f6", gap: 12, flexWrap: "wrap" },
  itemLeft:     { display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
  itemRight:    { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  itemTitle:    { fontSize: 13, color: "#111", fontWeight: 500 },
  lockedHint:   { fontSize: 11, color: "#9ca3af" },
  attemptCount: { fontSize: 12, color: "#6b7280", minWidth: 40, textAlign: "center" },
  doneBadge:    { padding: "3px 12px", background: "#dcfce7", color: "#16a34a", borderRadius: 99, fontSize: 12, fontWeight: 600 },

  // Progress bar
  barTrack: { height: 8, background: "#e5e7eb", borderRadius: 99, overflow: "hidden" },
  barFill:  { height: "100%", borderRadius: 99, transition: "width 0.3s ease" },
  barLabel: { position: "absolute", right: 0, top: 0, fontSize: 11, fontWeight: 600, color: "#6b7280" },

  // Badges + buttons
  typeBadge: { display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, flexShrink: 0 },
  badge:     { display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600 },
  btnPrimary:{ background: "#4f46e5", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnGhost:  { background: "transparent", color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer" },
  btnSm:     { background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  btnSuccess:{ background: "#dcfce7", color: "#16a34a", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  btnWarning:{ background: "#fef9c3", color: "#b45309", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  linkBtn:   { background: "none", border: "none", color: "#4f46e5", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 },

  errBanner:     { background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 14 },
  successBanner: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 14 },
  errText:       { fontSize: 12, color: "#dc2626", marginLeft: 8 },
};
