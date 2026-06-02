"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
import type { AttendanceStatus, ExtraClass } from "@/services/attendance/attendance.service";
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
import type { Role, ScreeningResult } from "@/types";
import { getScreeningByStudent } from "@/services/screening/screening.service";
import { DiagnosticCard } from "@/components/DiagnosticCard";

// ─── Local types ──────────────────────────────────────────────────────────────

interface StudentRow {
  uid:          string;
  name:         string;
  instrument:   string;
  status:       string;
  centerId:     string;
  classType?:   string;  // "group" | "personal" — present on personal student rows
  hasScreening: boolean;
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
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <TeacherDashboardContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function TeacherDashboardContent() {
  const { user } = useAuthContext();
  const { isTeacherRole, filterCentres } = useCentreAccess();
  const router       = useRouter();
  const searchParams = useSearchParams();

  const centreIdParam = searchParams.get("centerId") ?? "";
  const tabParam      = (searchParams.get("tab") ?? "attendance") as "attendance" | "students" | "progress";

  const centerIdsKey: string = user && isTeacher(user) ? user.centerIds.join(",") : "";
  const centerIds: string[]  = useMemo(
    () => centerIdsKey ? centerIdsKey.split(",") : [],
    [centerIdsKey],
  );

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── State ─────────────────────────────────────────────────────────────────
  const [centers,          setCenters]          = useState<Center[]>([]);
  const [centreLoading,    setCentreLoading]    = useState(true);
  const [markedCentreIds,  setMarkedCentreIds]  = useState<Set<string>>(new Set());

  // Centre-workspace state (loaded when centreIdParam is set)
  const [students,         setStudents]         = useState<StudentRow[]>([]);
  const [attendancePct,    setAttendancePct]    = useState<number | null>(null);
  const [lowProgressCount, setLowProgressCount] = useState<number | null>(null);
  const [centerDataLoading,setCenterDataLoading]= useState(false);
  const [insights,         setInsights]         = useState<DashboardInsights | null>(null);

  // Progress detail
  const [progressStudent, setProgressStudent]   = useState<StudentRow | null>(null);
  const [progressFrom,    setProgressFrom]      = useState<"students" | "overview">("overview");

  // Panel toggles
  const [showPending,       setShowPending]       = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  // Overview stats
  interface OverviewStats {
    totalStudents:    number;
    attendedThisWeek: number;
    noSyllabus:       number;
    avgPerCentre:     number;
    centreBreakdown:  { id: string; name: string; count: number }[];
  }
  const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null);
  const [statsLoading,  setStatsLoading]  = useState(false);

  // ── Load assigned centres ────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    if (isTeacherRole && centerIds.length === 0) { setCentreLoading(false); return; }
    setCentreLoading(true);
    (async () => {
      try {
        let mine: Center[];
        if (centerIds.length > 0) {
          const results = await Promise.allSettled(centerIds.map(id => getCenterById(id)));
          mine = results
            .filter((r): r is PromiseFulfilledResult<Center> => r.status === "fulfilled")
            .map(r => r.value);
        } else {
          const snap = await getDocs(collection(db, "centers"));
          mine = snap.docs.map(d => ({ id: d.id, ...d.data() } as Center));
        }
        const filtered = filterCentres(mine);
        setCenters(filtered);
        const cIds = filtered.map(c => c.id).filter(Boolean);
        if (cIds.length > 0) {
          try {
            const attSnap = await getDocs(query(
              collection(db, "attendance"),
              where("date", "==", today),
              where("centerId", "in", cIds),
            ));
            const marked = new Set<string>();
            attSnap.docs.forEach(d => {
              const centerId = d.data().centerId as string | undefined;
              if (centerId) marked.add(centerId);
            });
            setMarkedCentreIds(marked);
          } catch (err) {
            console.error("Failed to load today attendance:", err);
          }
        }
      } catch (err) {
        console.error("Failed to load centers:", err);
      } finally {
        setCentreLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, centerIdsKey]);

  // ── Load centre workspace data when centreIdParam changes ────────────────
  const loadCenterData = useCallback(async (centerId: string) => {
    if (!centerId || !user) return;
    setStudents([]);
    setAttendancePct(null);
    setLowProgressCount(null);
    setInsights(null);
    setCenterDataLoading(true);
    try {
      const studentSnap = await getDocs(query(
        collection(db, "users"),
        where("role",     "==", "student"),
        where("centerId", "==", centerId),
      ));
      const rows: StudentRow[] = studentSnap.docs
        .filter(d => {
          const u = d.data();
          if (u.centerId && u.centerId !== centerId) return false;
          const status = (u.status ?? u.studentStatus ?? "active") as string;
          return u.role === "student" && status === "active";
        })
        .map(d => {
          const u = d.data();
          return {
            uid:          d.id,
            name:         (u.displayName ?? u.name ?? "—") as string,
            instrument:   (u.instrument ?? "—") as string,
            status:       ((u.status ?? u.studentStatus ?? "active") as string),
            centerId:     (u.centerId ?? "") as string,
            hasScreening: !!u.screening,
          };
        });
      setStudents(rows);

      const allTodayRecs = await getAttendanceByCentreDate(centerId, today);
      const todayRecs    = allTodayRecs.filter(r =>
        (r as unknown as Record<string,unknown>).centerId === centerId
      );
      const presentCnt = todayRecs.filter(r => r.status === "present").length;
      const absentCnt  = todayRecs.filter(r => r.status === "absent").length;
      const todayPct   = rows.length > 0 ? Math.round((presentCnt / rows.length) * 100) : null;
      setAttendancePct(todayPct);

      const progressList: StudentProgress[] = await Promise.all(
        rows.map(async st => {
          try {
            const [prog, { lessons }, txSnap] = await Promise.all([
              getProgressByStudent(st.uid),
              getLessonsForStudent(st.uid),
              getDocs(query(collection(db, "transactions"), where("studentUid", "==", st.uid))),
            ]);
            const allItems = lessons.flatMap(l => l.items);
            const pm: Record<string, StudentLessonProgress> = {};
            prog.forEach(p => { pm[p.itemId] = p; });
            const pct = calcOverallPercent(allItems, pm);
            let balance = 0;
            txSnap.docs.forEach(d => {
              const tx = d.data() as Record<string, unknown>;
              if (tx.method === "auto-monthly" || tx.method === "auto") return;
              const type = (tx.type as string) ?? "";
              balance += (type === "fee_due" || type === "charge") ? Number(tx.amount ?? 0) : -Number(tx.amount ?? 0);
            });
            return { uid: st.uid, name: st.name, instrument: st.instrument, pct, balance, status: st.status };
          } catch {
            return { uid: st.uid, name: st.name, instrument: st.instrument, pct: 0, balance: 0, status: st.status };
          }
        }),
      );
      setLowProgressCount(progressList.filter(p => p.pct < 40).length);

      const allAttSnap = await getDocs(
        query(collection(db, "attendance"), where("centerId", "==", centerId)),
      );
      const allAttRecs = allAttSnap.docs.map(d => d.data() as { date?: string; status?: string });
      const weekDays: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (6 - i));
        const iso = d.toISOString().slice(0, 10);
        const recs = allAttRecs.filter(r => r.date === iso);
        const prs  = recs.filter(r => r.status === "present").length;
        return { date: iso, label: d.toLocaleDateString("en-IN", { weekday: "short" }), pct: recs.length > 0 ? Math.round((prs / recs.length) * 100) : null };
      });

      const pendingFeeCount    = progressList.filter(p => p.balance > 0).length;
      const deactivationCount  = studentSnap.docs.filter(d => {
        const st = (d.data().status ?? d.data().studentStatus ?? "") as string;
        return st === "deactivation_requested";
      }).length;

      const attScore    = todayPct ?? 0;
      const avgPct      = progressList.length > 0 ? progressList.reduce((s, p) => s + p.pct, 0) / progressList.length : 0;
      const consistency = Math.round((weekDays.filter(d => d.pct !== null).length / 7) * 100);
      const teacherScore = Math.round(attScore * 0.4 + avgPct * 0.4 + consistency * 0.2);
      const prevAvg      = weekDays.slice(0, 6).reduce((s, d) => s + (d.pct ?? 0), 0) / 6;

      setInsights({
        teacherScore, scoreChange: Math.round(attScore - prevAvg), weeklyTrend: weekDays,
        studentProgress: progressList, presentCount: presentCnt, absentCount: absentCnt,
        pendingFeeCount, deactivationCount,
      });
    } catch (err) {
      console.error("loadCenterData error:", err);
    } finally {
      setCenterDataLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, today]);

  useEffect(() => {
    if (centreIdParam) loadCenterData(centreIdParam);
  }, [centreIdParam, loadCenterData]);

  // Re-fetch markedCentreIds when navigating back to the overview
  useEffect(() => {
    if (centreIdParam || centers.length === 0) return;
    const cIds = centers.map(c => c.id).filter(Boolean);
    if (cIds.length === 0) return;
    (async () => {
      try {
        const attSnap = await getDocs(query(
          collection(db, "attendance"),
          where("date", "==", today),
          where("centerId", "in", cIds),
        ));
        const marked = new Set<string>();
        attSnap.docs.forEach(d => {
          const centerId = d.data().centerId as string | undefined;
          if (centerId) marked.add(centerId);
        });
        setMarkedCentreIds(marked);
      } catch (err) {
        console.error("Failed to refresh today attendance:", err);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreIdParam]);

  // ── Overview stats (total students, attended this week, no syllabus) ────────
  useEffect(() => {
    if (centreIdParam || centers.length === 0) return;
    const cIds = centers.map(c => c.id).filter(Boolean);
    if (cIds.length === 0) return;
    setStatsLoading(true);
    setOverviewStats(null);
    (async () => {
      try {
        // 1. All active students across all centres
        const studentSnaps = await Promise.all(
          cIds.map(cId => getDocs(query(
            collection(db, "users"),
            where("role",     "==", "student"),
            where("centerId", "==", cId),
          )))
        );
        const allStudents: { uid: string; centerId: string }[] = [];
        studentSnaps.forEach(snap =>
          snap.docs.forEach(d => {
            const u      = d.data();
            const status = (u.status ?? u.studentStatus ?? "active") as string;
            if (status === "active") allStudents.push({ uid: d.id, centerId: u.centerId as string });
          })
        );

        // 2. This week's dates (last 7 days including today)
        const weekDates: string[] = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - (6 - i));
          return d.toISOString().slice(0, 10);
        });

        // 3. Distinct students marked present this week (per centre)
        const presentUids = new Set<string>();
        await Promise.all(
          cIds.map(async cId => {
            const snap = await getDocs(query(
              collection(db, "attendance"),
              where("centerId", "==", cId),
              where("date",     "in",  weekDates),
            ));
            snap.docs.forEach(d => {
              if (d.data().status === "present") presentUids.add(d.data().studentUid as string);
            });
          })
        );

        // 4. Centres that have at least one centre-wide lesson → students there have a syllabus
        const centersWithLessons = new Set<string>();
        for (let i = 0; i < cIds.length; i += 10) {
          const batch   = cIds.slice(i, i + 10);
          const lesSnap = await getDocs(query(
            collection(db, "lessons"),
            where("centerId", "in", batch),
          ));
          lesSnap.docs.forEach(d => {
            const cid = d.data().centerId as string | undefined;
            if (cid) centersWithLessons.add(cid);
          });
        }

        // Students in centres without centre-level lessons: check student-specific lessons
        const possiblyNoSyllabus = allStudents.filter(st => !centersWithLessons.has(st.centerId));
        const studentSpecificIds = new Set<string>();
        for (let i = 0; i < possiblyNoSyllabus.length; i += 10) {
          const batch   = possiblyNoSyllabus.slice(i, i + 10).map(s => s.uid);
          const lesSnap = await getDocs(query(
            collection(db, "lessons"),
            where("studentId", "in", batch),
          ));
          lesSnap.docs.forEach(d => {
            const sid = d.data().studentId as string | undefined;
            if (sid) studentSpecificIds.add(sid);
          });
        }
        const noSyllabus = possiblyNoSyllabus.filter(st => !studentSpecificIds.has(st.uid)).length;

        // 5. Per-centre student counts and average
        const centreCountMap: Record<string, number> = {};
        allStudents.forEach(st => { centreCountMap[st.centerId] = (centreCountMap[st.centerId] ?? 0) + 1; });
        const centreBreakdown = centers.map(c => ({ id: c.id, name: c.name, count: centreCountMap[c.id] ?? 0 }));
        const avgPerCentre = centers.length > 0
          ? Math.round(centreBreakdown.reduce((sum, c) => sum + c.count, 0) / centers.length)
          : 0;

        setOverviewStats({ totalStudents: allStudents.length, attendedThisWeek: presentUids.size, noSyllabus, avgPerCentre, centreBreakdown });
      } catch (err) {
        console.error("Failed to load overview stats:", err);
      } finally {
        setStatsLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreIdParam, centers]);

  // ── Navigation helpers ────────────────────────────────────────────────────
  function goToCentre(id: string, tab: "attendance" | "students" | "progress" = "attendance") {
    router.push(`/dashboard/teacher?centerId=${id}&tab=${tab}`);
  }
  function goToTab(tab: "attendance" | "students" | "progress") {
    router.push(`/dashboard/teacher?centerId=${centreIdParam}&tab=${tab}`);
  }
  function goToFacultySuite() {
    router.push("/dashboard/teacher");
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (centreLoading) return <div style={s.center}>Loading Faculty Suite…</div>;

  // ── Derive selected centre object ─────────────────────────────────────────
  const selectedCentreObj = centers.find(c => c.id === centreIdParam) ?? null;

  // ── Centre Workspace (centreIdParam present + valid) ──────────────────────
  if (centreIdParam && selectedCentreObj) {
    const daysOfWeek = parseDaysOfWeek(selectedCentreObj.timeSlot ?? "");

    return (
      <div style={s.page}>
        {/* Breadcrumb back */}
        <button style={s.backBtn} onClick={goToFacultySuite}>← Faculty Suite</button>

        {/* Centre header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:8 }}>
          <div>
            <div style={{ fontSize:20, fontWeight:800, color:"#111" }}>{selectedCentreObj.name}</div>
            <div style={{ fontSize:12, color:"#9ca3af", marginTop:2 }}>{selectedCentreObj.timeSlot}</div>
          </div>
          <span style={{ fontSize:12, color:"#6b7280", background:"#f3f4f6", borderRadius:8, padding:"4px 12px" }}>
            {today}
          </span>
        </div>

        {/* Tab bar */}
        <div style={s.tabBar}>
          {(["attendance","students","progress"] as const).map(tab => (
            <button key={tab} style={{ ...s.tab, ...(tabParam === tab ? s.tabActive : {}) }}
              onClick={() => { if (tab !== "progress") { setProgressStudent(null); goToTab(tab); } else goToTab(tab); }}>
              {tab === "attendance" ? "✓ Attendance" : tab === "students" ? "👥 Students" : "📊 Progress"}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {centerDataLoading ? (
          <div style={s.center}>Loading…</div>
        ) : tabParam === "attendance" ? (
          <AttendanceGridView
            centreId={centreIdParam}
            daysOfWeek={daysOfWeek}
            students={students}
            markedBy={user?.uid ?? ""}
            onDone={() => loadCenterData(centreIdParam)}
          />
        ) : tabParam === "students" ? (
          progressStudent ? (
            <>
              <button style={s.backBtn} onClick={() => { setProgressStudent(null); goToTab("students"); }}>← Back to Students</button>
              <ProgressView student={progressStudent} teacherUid={user?.uid ?? ""} teacherRole={(user?.role ?? ROLES.TEACHER) as Role} />
            </>
          ) : (
            <StudentsView
              students={students}
              teacherUid={user?.uid ?? ""}
              onViewProgress={st => { setProgressStudent(st); setProgressFrom("students"); goToTab("progress"); }}
            />
          )
        ) : tabParam === "progress" ? (
          progressStudent ? (
            <>
              <button style={s.backBtn} onClick={() => { setProgressStudent(null); goToTab(progressFrom === "students" ? "students" : "students"); }}>← Back to Students</button>
              <ProgressView student={progressStudent} teacherUid={user?.uid ?? ""} teacherRole={(user?.role ?? ROLES.TEACHER) as Role} />
            </>
          ) : (
            <StudentsView
              students={students}
              teacherUid={user?.uid ?? ""}
              onViewProgress={st => { setProgressStudent(st); setProgressFrom("overview"); }}
            />
          )
        ) : null}
      </div>
    );
  }

  // ── Faculty Suite Overview (no centreIdParam) ─────────────────────────────
  return (
    <div style={s.page}>
      {/* Hero */}
      {(() => {
        const todayDayNum  = new Date().getDay();
        const todayCentres = centers.filter(c => parseDaysOfWeek(c.timeSlot ?? "").some(d => DAY_MAP[d] === todayDayNum));
        const pendingCount = todayCentres.filter(c => !markedCentreIds.has(c.id)).length;
        return (
          <div style={{
            background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
            borderRadius: 14, padding: "20px 24px", marginBottom: 16,
            color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
          }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 2 }}>
                Welcome, {user?.displayName ?? "Teacher"} 👋
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Notifications */}
              <button
                onClick={() => { setShowNotifications(v => !v); setShowPending(false); }}
                title="Notifications"
                style={{
                  position: "relative", width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
                  background: showNotifications ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.18)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0,
                }}>
                🔔
              </button>
              {/* Pending */}
              <button
                onClick={() => { setShowPending(v => !v); setShowNotifications(false); }}
                title="Pending tasks"
                style={{
                  position: "relative", width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
                  background: showPending ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.18)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0,
                }}>
                ⏳
                {pendingCount > 0 && (
                  <span style={{
                    position: "absolute", top: 1, right: 1,
                    background: "#ef4444", color: "#fff", borderRadius: "50%",
                    width: 16, height: 16, fontSize: 9, fontWeight: 800,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {pendingCount}
                  </span>
                )}
              </button>
              {/* Classes today */}
              <span style={{ background: "rgba(255,255,255,0.15)", borderRadius: 99, padding: "6px 14px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                🏫 {todayCentres.length} {todayCentres.length === 1 ? "Class" : "Classes"} Today
              </span>
            </div>
          </div>
        );
      })()}

      {/* Notifications panel */}
      {showNotifications && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 16, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.07)" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>🔔 Notifications</span>
            <button onClick={() => setShowNotifications(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}>✕</button>
          </div>
          <div style={{ padding: "32px 20px", textAlign: "center", fontSize: 13, color: "#9ca3af" }}>
            No new notifications
          </div>
        </div>
      )}

      {/* Pending panel */}
      {showPending && (() => {
        const todayDayNum  = new Date().getDay();
        const todayCentres = centers.filter(c => parseDaysOfWeek(c.timeSlot ?? "").some(d => DAY_MAP[d] === todayDayNum));
        const unmarked     = todayCentres.filter(c => !markedCentreIds.has(c.id));
        return (
          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 16, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.07)" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>⏳ Pending Tasks</span>
              <button onClick={() => setShowPending(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}>✕</button>
            </div>
            {unmarked.length === 0 ? (
              <div style={{ padding: "24px 20px", textAlign: "center", fontSize: 13, color: "#16a34a", fontWeight: 600 }}>
                ✅ All caught up — no pending tasks today!
              </div>
            ) : (
              <div style={{ padding: "0 20px 8px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", padding: "12px 0 6px" }}>
                  Attendance not marked today
                </div>
                {unmarked.map((c, i) => (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid #f3f4f6" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#111" }}>{c.name}</div>
                      {c.timeSlot && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{c.timeSlot}</div>}
                    </div>
                    <button
                      onClick={() => { setShowPending(false); goToCentre(c.id, "attendance"); }}
                      style={{ background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                      Mark Now →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Overview stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 16 }}>
        {[
          {
            label: "Total Students",
            value: statsLoading ? "…" : overviewStats ? String(overviewStats.totalStudents) : "—",
            icon: "👥", color: "#4f46e5", bg: "#ede9fe",
          },
          {
            label: "Attended This Week",
            value: statsLoading ? "…" : overviewStats ? String(overviewStats.attendedThisWeek) : "—",
            icon: "✅", color: "#16a34a", bg: "#dcfce7",
          },
          {
            label: "No Syllabus Yet",
            value: statsLoading ? "…" : overviewStats ? String(overviewStats.noSyllabus) : "—",
            icon: "📋", color: overviewStats?.noSyllabus ? "#dc2626" : "#16a34a",
            bg:   overviewStats?.noSyllabus ? "#fef2f2" : "#f0fdf4",
          },
          {
            label: "Avg / Centre",
            value: statsLoading ? "…" : overviewStats ? String(overviewStats.avgPerCentre) : "—",
            icon: "📊", color: "#f59e0b", bg: "#fef3c7",
          },
        ].map(card => (
          <div key={card.label} style={{
            background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
            padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                {card.label}
              </span>
              <span style={{ background: card.bg, borderRadius: 8, padding: "3px 7px", fontSize: 13 }}>{card.icon}</span>
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: card.color, lineHeight: 1 }}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* Per-centre student distribution */}
      {overviewStats && overviewStats.centreBreakdown.length > 1 && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14 }}>
            📊 Student Distribution by Centre
          </div>
          {(() => {
            const max = Math.max(...overviewStats.centreBreakdown.map(c => c.count), 1);
            const avg = overviewStats.avgPerCentre;
            return overviewStats.centreBreakdown.map(c => {
              const pct        = Math.round((c.count / max) * 100);
              const aboveAvg   = c.count >= avg;
              const barColor   = aboveAvg ? "#4f46e5" : "#f59e0b";
              return (
                <div key={c.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#111" }}>{c.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
                        background: aboveAvg ? "#ede9fe" : "#fef3c7",
                        color:      aboveAvg ? "#4f46e5" : "#b45309",
                      }}>
                        {aboveAvg ? "▲ Above avg" : "▼ Below avg"}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#374151", minWidth: 24, textAlign: "right" as const }}>
                        {c.count}
                      </span>
                    </div>
                  </div>
                  <div style={{ height: 8, background: "#f3f4f6", borderRadius: 99, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 99, transition: "width 0.4s ease" }} />
                  </div>
                </div>
              );
            });
          })()}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>Average across all centres:</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#f59e0b" }}>{overviewStats.avgPerCentre} students</span>
          </div>
        </div>
      )}

      {/* Empty state */}
      {centers.length === 0 ? (
        <div style={s.emptyState}>
          {isTeacherRole
            ? "You have not been assigned to any centre yet. Contact your administrator."
            : "No centres found."}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
            Today's Classes
          </div>
          {(() => {
            const todayDayNum = new Date().getDay();
            const todayCentres = centers.filter(c => {
              const days = parseDaysOfWeek(c.timeSlot ?? "");
              return days.some(d => DAY_MAP[d] === todayDayNum);
            });
            if (todayCentres.length === 0) {
              return (
                <div style={s.emptyState}>No classes scheduled for today.</div>
              );
            }
            return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
            {todayCentres.map(c => (
              <div key={c.id}
                onClick={() => goToCentre(c.id, "attendance")}
                style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
                  padding: "18px 20px", cursor: "pointer", transition: "box-shadow 0.15s",
                  display: "flex", flexDirection: "column", gap: 10,
                }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 4px 16px rgba(79,70,229,0.12)")}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111" }}>{c.name}</div>
                  <span style={{ fontSize: 11, background: "#ede9fe", color: "#4f46e5", borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>
                    {c.centerCode}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280" }}>{c.timeSlot || "—"}</div>
                {(() => {
                  const done = markedCentreIds.has(c.id);
                  return (
                    <div style={{
                      borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 600,
                      textAlign: "center",
                      background: done ? "#dcfce7" : "#fee2e2",
                      color: done ? "#15803d" : "#dc2626",
                    }}>
                      {done ? "✓ Attendance Done" : "Attendance Pending"}
                    </div>
                  );
                })()}
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {(["attendance","students","progress"] as const).map(tab => (
                    <button key={tab}
                      onClick={e => { e.stopPropagation(); goToCentre(c.id, tab); }}
                      style={{ flex: 1, padding: "6px 4px", borderRadius: 7, border: "1px solid #e5e7eb",
                               background: "#f9fafb", color: "#374151", fontSize: 11, fontWeight: 600,
                               cursor: "pointer" }}>
                      {tab === "attendance" ? "✓ Att." : tab === "students" ? "👥 Students" : "📊 Progress"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDANCE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MAP: Record<string, number> = {
  sun:0, sunday:0, mon:1, monday:1, tue:2, tuesday:2,
  wed:3, wednesday:3, thu:4, thursday:4, fri:5, friday:5, sat:6, saturday:6,
};

/** Parse day abbreviations / names from a timeSlot string like "Mon/Wed/Fri 17:00–18:30" */
function parseDaysOfWeek(timeSlot: string): string[] {
  const tokens = timeSlot.toLowerCase().split(/[\s/,]+/);
  return tokens.filter(t => t in DAY_MAP);
}

/** Return all YYYY-MM-DD dates in a month (1-indexed mo) where dayOfWeek matches. */
function scheduledDatesInMonth(year: number, mo: number, days: string[]): string[] {
  const nums = new Set(days.map(d => DAY_MAP[d]).filter(n => n !== undefined));
  const result: string[] = [];
  const daysInMonth = new Date(year, mo, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, mo - 1, d);
    if (nums.has(dt.getDay())) {
      result.push(
        `${year}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`
      );
    }
  }
  return result;
}

// ─── Status colours ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present:            "✔ Present",
  absent:             "✗ Absent",
  break:              "☕ Break",
  cancelled_teacher:  "CT Cancel",
  cancelled_student:  "CS Cancel",
};
const STATUS_BG: Record<AttendanceStatus, string> = {
  present:           "#dcfce7",
  absent:            "#fee2e2",
  break:             "#fef9c3",
  cancelled_teacher: "#ede9fe",
  cancelled_student: "#fce7f3",
};
const STATUS_COLOR: Record<AttendanceStatus, string> = {
  present:           "#166534",
  absent:            "#991b1b",
  break:             "#92400e",
  cancelled_teacher: "#5b21b6",
  cancelled_student: "#9d174d",
};

// ─── Status picker modal ───────────────────────────────────────────────────────

function StatusModal({
  current, onSelect, onClose,
}: { current: AttendanceStatus | null; onSelect:(s:AttendanceStatus)=>void; onClose:()=>void }) {
  const statuses: AttendanceStatus[] = ["present","absent","break","cancelled_teacher","cancelled_student"];
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:999,
                  display:"flex", alignItems:"center", justifyContent:"center" }}
         onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:12, padding:20, minWidth:220,
                    boxShadow:"0 8px 32px rgba(0,0,0,0.18)" }}
           onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight:700, fontSize:14, marginBottom:12, color:"#111" }}>Mark Status</div>
        {statuses.map(st => (
          <button key={st} onClick={() => onSelect(st)}
            style={{ display:"block", width:"100%", textAlign:"left", padding:"9px 14px",
                     marginBottom:6, borderRadius:8, border:"none", cursor:"pointer",
                     background: current===st ? STATUS_BG[st] : "#f3f4f6",
                     color: current===st ? STATUS_COLOR[st] : "#374151",
                     fontWeight: current===st ? 700 : 400, fontSize:13 }}>
            {STATUS_LABEL[st]}
          </button>
        ))}
        <button onClick={onClose}
          style={{ marginTop:4, width:"100%", padding:"8px 0", borderRadius:8, border:"none",
                   background:"#f3f4f6", color:"#6b7280", fontSize:13, cursor:"pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Extra class date picker modal ────────────────────────────────────────────

function ExtraClassModal({
  month, existing, onAdd, onClose,
}: { month:string; existing:Set<string>; onAdd:(date:string)=>void; onClose:()=>void }) {
  const [date, setDate] = useState("");
  const [err,  setErr]  = useState("");
  const min = `${month}-01`;
  const [yr,mo] = month.split("-").map(Number);
  const max = `${month}-${String(new Date(yr,mo,0).getDate()).padStart(2,"0")}`;

  function submit() {
    if (!date) { setErr("Select a date."); return; }
    if (existing.has(date)) { setErr("Already a class on this date."); return; }
    onAdd(date);
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:999,
                  display:"flex", alignItems:"center", justifyContent:"center" }}
         onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:12, padding:24, minWidth:260,
                    boxShadow:"0 8px 32px rgba(0,0,0,0.18)" }}
           onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight:700, fontSize:14, marginBottom:12, color:"#111" }}>Add Extra Class</div>
        <input type="date" min={min} max={max} value={date}
          onChange={e => { setDate(e.target.value); setErr(""); }}
          style={{ width:"100%", padding:"9px 12px", borderRadius:8,
                   border:"1px solid #d1d5db", fontSize:14, marginBottom:8 }} />
        {err && <div style={{ fontSize:12, color:"#dc2626", marginBottom:8 }}>{err}</div>}
        <div style={{ display:"flex", gap:8, marginTop:4 }}>
          <button onClick={submit}
            style={{ flex:1, padding:"9px 0", borderRadius:8, border:"none",
                     background:"#4f46e5", color:"#fff", fontWeight:600, fontSize:13, cursor:"pointer" }}>
            Add
          </button>
          <button onClick={onClose}
            style={{ flex:1, padding:"9px 0", borderRadius:8, border:"none",
                     background:"#f3f4f6", color:"#374151", fontSize:13, cursor:"pointer" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDANCE GRID VIEW  — monthly calendar grid
// ═══════════════════════════════════════════════════════════════════════════════

type GridMarks = Record<string, Record<string, AttendanceStatus>>; // [date][studentUid]

function AttendanceGridView({ centreId, daysOfWeek, students, markedBy, onDone }: {
  centreId:   string;
  daysOfWeek: string[];
  students:   StudentRow[];
  markedBy:   string;
  onDone:     () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [month,   setMonth]   = useState(() => todayStr.slice(0,7));          // "YYYY-MM"
  const [marks,   setMarks]   = useState<GridMarks>({});
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState<string|null>(null);  // "date|uid" being saved
  const [err,     setErr]     = useState<string|null>(null);

  // Extra class state
  const [extraDates,     setExtraDates]     = useState<Set<string>>(new Set());
  const [showExtraModal, setShowExtraModal] = useState(false);
  const [addingExtra,    setAddingExtra]    = useState(false);

  // Status modal
  const [modal, setModal] = useState<{ date:string; uid:string } | null>(null);

  // Derive scheduled dates from daysOfWeek + extra dates
  const [yr, mo] = month.split("-").map(Number);
  const scheduledDates: string[] = useMemo(() => {
    const base = scheduledDatesInMonth(yr, mo, daysOfWeek);
    const extra = Array.from(extraDates).filter(d => d.startsWith(month)).sort();
    return [...new Set([...base, ...extra])].sort();
  }, [yr, mo, daysOfWeek, extraDates, month]);

  // Load attendance records for the whole month
  useEffect(() => {
    if (!centreId || scheduledDates.length === 0) return;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        // Fetch records for each scheduled date in parallel
        const results = await Promise.all(
          scheduledDates.map(date => getAttendanceByCentreDate(centreId, date))
        );
        const grid: GridMarks = {};
        scheduledDates.forEach((date, i) => {
          grid[date] = {};
          results[i].forEach(r => {
            const status = r.status as string;
            if (["present","absent","break","cancelled_teacher","cancelled_student"].includes(status)) {
              grid[date][r.studentUid] = status as AttendanceStatus;
            }
          });
        });
        setMarks(grid);
      } catch(e) {
        setErr(e instanceof Error ? e.message : "Failed to load attendance.");
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId, month, extraDates]);

  // Load extra classes
  useEffect(() => {
    getExtraClassesByCentre(centreId, month)
      .then(list => setExtraDates(new Set(list.map(e => e.date))))
      .catch(console.error);
  }, [centreId, month]);

  function isFuture(date: string) { return date > todayStr; }

  function openModal(date: string, uid: string) {
    if (isFuture(date)) return;
    setModal({ date, uid });
  }

  async function handleSelect(status: AttendanceStatus) {
    if (!modal) return;
    const { date, uid } = modal;
    setModal(null);

    // Optimistic update
    setMarks(prev => ({
      ...prev,
      [date]: { ...prev[date], [uid]: status },
    }));

    const key = `${date}|${uid}`;
    setSaving(key);
    try {
      await saveCentreAttendance({ studentUid: uid, centerId: centreId, date, status, markedBy });
    } catch(e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
      // Revert optimistic update on error
      setMarks(prev => {
        const next = { ...prev, [date]: { ...prev[date] } };
        delete next[date][uid];
        return next;
      });
    } finally {
      setSaving(null);
    }
  }

  async function handleAddExtra(date: string) {
    setShowExtraModal(false);
    setAddingExtra(true);
    try {
      await saveExtraClass(centreId, date, markedBy);
      setExtraDates(prev => new Set([...prev, date]));
    } catch(e) {
      setErr(e instanceof Error ? e.message : "Failed to add extra class.");
    } finally {
      setAddingExtra(false);
    }
  }

  // Summary per student
  function summary(uid: string) {
    let p = 0, a = 0, total = 0;
    scheduledDates.forEach(date => {
      if (isFuture(date)) return;
      total++;
      const st = marks[date]?.[uid];
      if (st === "present") p++;
      else if (st === "absent") a++;
    });
    const pct = total > 0 ? Math.round((p/total)*100) : null;
    return { p, a, pct };
  }

  const prevMonth = () => {
    const d = new Date(yr, mo - 2, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
  };
  const nextMonth = () => {
    const d = new Date(yr, mo, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
  };

  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return (
    <div style={{ paddingBottom: 32 }}>
      {modal && (
        <StatusModal
          current={marks[modal.date]?.[modal.uid] ?? null}
          onSelect={handleSelect}
          onClose={() => setModal(null)}
        />
      )}
      {showExtraModal && (
        <ExtraClassModal
          month={month}
          existing={new Set(scheduledDates)}
          onAdd={handleAddExtra}
          onClose={() => setShowExtraModal(false)}
        />
      )}

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16, flexWrap:"wrap" }}>
        <div style={{ fontWeight:700, fontSize:17, color:"#111" }}>Monthly Attendance</div>
        <div style={{ display:"flex", alignItems:"center", gap:6, marginLeft:"auto" }}>
          <button onClick={prevMonth}
            style={{ padding:"4px 10px", borderRadius:6, border:"1px solid #d1d5db",
                     background:"#fff", cursor:"pointer", fontSize:14 }}>‹</button>
          <span style={{ fontSize:14, fontWeight:600, color:"#374151", minWidth:80, textAlign:"center" }}>
            {MONTH_NAMES[mo-1]} {yr}
          </span>
          <button onClick={nextMonth}
            style={{ padding:"4px 10px", borderRadius:6, border:"1px solid #d1d5db",
                     background:"#fff", cursor:"pointer", fontSize:14 }}>›</button>
        </div>
        <button
          onClick={() => setShowExtraModal(true)}
          disabled={addingExtra}
          style={{ padding:"6px 14px", borderRadius:8, border:"none", background:"#4f46e5",
                   color:"#fff", fontWeight:600, fontSize:13, cursor:"pointer",
                   opacity: addingExtra ? 0.5 : 1 }}>
          + Extra Class
        </button>
      </div>

      {err && <div style={s.errBanner}>{err}</div>}

      {loading ? (
        <div style={s.center}>Loading…</div>
      ) : students.length === 0 ? (
        <div style={s.emptyCard}>No students enrolled in this centre.</div>
      ) : scheduledDates.length === 0 ? (
        <div style={s.emptyCard}>No scheduled classes this month. Add an extra class to begin.</div>
      ) : (
        <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
          <table style={{ borderCollapse:"collapse", minWidth: 320 + scheduledDates.length * 60, fontSize:12 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, minWidth:130, textAlign:"left", position:"sticky", left:0,
                              background:"#f9fafb", zIndex:2 }}>
                  Student
                </th>
                {scheduledDates.map(date => {
                  const isExtra = extraDates.has(date);
                  const isTod   = date === todayStr;
                  return (
                    <th key={date} style={{ ...thStyle, minWidth:54,
                        background: isTod ? "#eff6ff" : isExtra ? "#fdf4ff" : "#f9fafb",
                        color: isTod ? "#1d4ed8" : isExtra ? "#7c3aed" : "#374151" }}>
                      <div>{new Date(date+"T00:00:00").toLocaleDateString("en-IN",{day:"2-digit"})}</div>
                      <div style={{ fontWeight:400, fontSize:10, color:"#9ca3af" }}>
                        {new Date(date+"T00:00:00").toLocaleDateString("en-IN",{weekday:"short"})}
                      </div>
                      {isExtra && <div style={{ fontSize:9, color:"#7c3aed" }}>extra</div>}
                    </th>
                  );
                })}
                <th style={{ ...thStyle, minWidth:36 }}>P</th>
                <th style={{ ...thStyle, minWidth:36 }}>A</th>
                <th style={{ ...thStyle, minWidth:46 }}>%</th>
              </tr>
            </thead>
            <tbody>
              {students.map((st, idx) => {
                const { p, a, pct } = summary(st.uid);
                return (
                  <tr key={st.uid} style={{ background: idx%2===0 ? "#fff" : "#f9fafb" }}>
                    <td style={{ ...tdStyle, position:"sticky", left:0,
                                 background: idx%2===0 ? "#fff" : "#f9fafb", zIndex:1,
                                 fontWeight:500, color:"#111" }}>
                      <div>{st.name}</div>
                      <div style={{ fontSize:10, color:"#9ca3af" }}>{st.instrument}</div>
                    </td>
                    {scheduledDates.map(date => {
                      const future  = isFuture(date);
                      const status  = marks[date]?.[st.uid] ?? null;
                      const isSaving= saving === `${date}|${st.uid}`;
                      return (
                        <td key={date}
                          onClick={() => openModal(date, st.uid)}
                          style={{ ...tdStyle, textAlign:"center", cursor: future ? "default" : "pointer",
                                   background: future ? "#f3f4f6"
                                     : status ? STATUS_BG[status] : "#fff",
                                   color: status ? STATUS_COLOR[status] : "#9ca3af",
                                   opacity: isSaving ? 0.5 : 1,
                                   transition:"background 0.15s" }}>
                          {isSaving ? "…"
                            : future ? <span style={{ color:"#d1d5db" }}>–</span>
                            : status ? STATUS_LABEL[status].split(" ")[0]
                            : "·"}
                        </td>
                      );
                    })}
                    <td style={{ ...tdStyle, textAlign:"center", fontWeight:600, color:"#166534" }}>{p}</td>
                    <td style={{ ...tdStyle, textAlign:"center", fontWeight:600, color:"#991b1b" }}>{a}</td>
                    <td style={{ ...tdStyle, textAlign:"center", fontWeight:700,
                                 color: pct===null?"#9ca3af":pct>=75?"#166534":pct>=50?"#92400e":"#991b1b" }}>
                      {pct===null ? "–" : `${pct}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "8px 6px", borderBottom: "2px solid #e5e7eb",
  fontWeight: 600, fontSize: 11, color: "#374151", whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "7px 5px", borderBottom: "1px solid #f3f4f6",
  fontSize: 11, whiteSpace: "nowrap",
};

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENTS VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function StudentsView({ students, teacherUid, onViewProgress }: {
  students:       StudentRow[];
  teacherUid:     string;
  onViewProgress: (s: StudentRow) => void;
}) {
  const [progressMap,     setProgressMap]     = useState<Record<string, number>>({});
  const [breakTarget,     setBreakTarget]     = useState<StudentRow | null>(null);
  const [breakReason,     setBreakReason]     = useState("");
  const [breakSaving,     setBreakSaving]     = useState(false);
  const [breakError,      setBreakError]      = useState("");
  const [successMsg,      setSuccessMsg]      = useState("");
  const [diagStudent,     setDiagStudent]     = useState<StudentRow | null>(null);
  const [diagResult,      setDiagResult]      = useState<ScreeningResult | null>(null);
  const [diagLoading,     setDiagLoading]     = useState(false);

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

  async function openDiagnostic(st: StudentRow) {
    setDiagStudent(st);
    setDiagResult(null);
    setDiagLoading(true);
    try {
      const result = await getScreeningByStudent(st.uid);
      setDiagResult(result);
    } catch { /* show empty */ }
    finally { setDiagLoading(false); }
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
                    <Link href={`/dashboard/student-syllabus/${st.uid}`}
                      style={{ background: "#ede9fe", color: "#4f46e5", border: "1px solid #c4b5fd", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
                      📚 Quest
                    </Link>
                    {st.hasScreening && (
                      <button
                        onClick={() => openDiagnostic(st)}
                        style={{ background: "#ede9fe", color: "#4f46e5", border: "1px solid #c4b5fd", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        🎹 Diagnostic
                      </button>
                    )}
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

      {/* Diagnostic Modal */}
      {diagStudent && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: "100%", maxWidth: 480, boxShadow: "0 20px 60px rgba(0,0,0,0.18)", maxHeight: "90dvh", overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>🎹 Screening Diagnostic</div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>{diagStudent.name}</div>
              </div>
              <button onClick={() => { setDiagStudent(null); setDiagResult(null); }} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#9ca3af", padding: 4 }}>✕</button>
            </div>
            {diagLoading ? (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>Loading diagnostic…</div>
            ) : diagResult ? (
              <DiagnosticCard result={diagResult} compact />
            ) : (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>No screening record found for this student.</div>
            )}
          </div>
        </div>
      )}

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
