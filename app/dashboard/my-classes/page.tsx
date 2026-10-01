"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, CENTER_STATUS } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import { isTeacher } from "@/types";
import { courseLabel } from "@/lib/course";
import { isCurrentlyActiveStudent } from "@/lib/activeStudents";
import { normAdmNo } from "@/lib/dedup";
import { centreTeacherUids } from "@/services/center/center.service";
import { useWing } from "@/hooks/useWing";
import { teachingWings, wingOf, WING_SHORT } from "@/lib/wing";
import {
  getAttendanceByCentreDate,
  saveCentreAttendance,
  type AttendanceStatus,
} from "@/services/attendance/attendance.service";
import {
  getLessonsForStudent,
  getProgressByStudent,
  calcOverallPercent,
  calcLessonPercent,
  addAttempt,
  markItemCompleted,
  isItemUnlocked,
} from "@/services/lesson/lesson.service";
import type { Center, Role } from "@/types";
import type { Lesson, LessonItem, StudentLessonProgress } from "@/types/lesson";

const todayStr = new Date().toISOString().slice(0, 10);

// Day name → JS getDay() number
const DAY_NUM: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Returns scheduled class dates for a centre in descending order (most recent first). */
function scheduledDatesForCentre(centre: Center, weeksBack = 5): string[] {
  const slot = centre.timeSlot ?? "";
  const tokens = slot.toLowerCase().split(/[\s/,–\-]+/);
  const scheduledDays = new Set(tokens.map(t => DAY_NUM[t]).filter(n => n !== undefined));

  // Also support a daysOfWeek array on the doc
  const dowArr = (centre as Center & { daysOfWeek?: string[] }).daysOfWeek ?? [];
  dowArr.forEach(d => {
    const n = DAY_NUM[d.toLowerCase().slice(0, 3)];
    if (n !== undefined) scheduledDays.add(n);
  });

  if (scheduledDays.size === 0) return [];

  const dates: string[] = [];
  const today = new Date();
  const limit = weeksBack * 7;
  for (let i = 0; i <= limit; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    if (scheduledDays.has(d.getDay())) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  return dates; // most recent first
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StudentRow {
  uid:        string;
  name:       string;
  instrument: string;
  status:     string;
}

type LessonWithItems = Lesson & { items: LessonItem[] };

interface StudentData {
  lessons:     LessonWithItems[];
  progressMap: Record<string, StudentLessonProgress>;
  unlockedMap: Record<string, boolean>;
  loading:     boolean;
  error:       string | null;
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function MyClassesPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.TEACHER, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]}>
      <Suspense fallback={<div style={s.state}>Loading…</div>}>
        <MyClassesContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// ─── Centre boxes ─────────────────────────────────────────────────────────────
// Every assigned centre as a card (name, code, schedule) — the look of the old
// Faculty Suite "My Centres" grid. Tapping one selects it; its roster and
// attendance load below.

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ScheduleSlot { name: string; days: string; time: string }

/** The centre's weekly schedule — a teacher sees only their own batches (if any). */
function centreSlots(c: Center, uid: string | null): ScheduleSlot[] {
  const batches = c.batches ?? [];
  if (batches.length === 0) return c.timeSlot ? [{ name: "", days: "", time: c.timeSlot }] : [];
  const mine = uid ? batches.filter(b => (b.teacherUid || c.teacherUid) === uid) : [];
  return (mine.length > 0 ? mine : batches).map(b => ({
    name: batches.length > 1 ? b.name : "",
    days: [...(b.daysOfWeek ?? [])]
      .sort((x, y) => DAY_ABBR.indexOf(x.slice(0, 3)) - DAY_ABBR.indexOf(y.slice(0, 3))).join(" · "),
    time: b.startTime && b.endTime ? `${b.startTime} – ${b.endTime}` : "",
  }));
}

function CentreBoxes({ centers, selectedId, onSelect, uid, showWing = false, studentCounts }: {
  centers: Center[]; selectedId: string; onSelect: (id: string) => void; uid: string | null;
  /** Active students per centre id (lib/activeStudents rule); null while loading. */
  studentCounts: Record<string, number> | null;
  /** Tag each box with its wing (a teacher teaching in both wings). */
  showWing?: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <section style={{ marginBottom: 16 }}>
      <div style={s.boxHead}>
        <div>
          <div style={s.boxTitle}>My Centres</div>
          <div style={s.boxSub}>Pick a centre to see its students and attendance below.</div>
        </div>
        <span style={s.boxCount}>{centers.length} centre{centers.length !== 1 ? "s" : ""}</span>
      </div>
      <div role="tablist" aria-label="Centres" style={s.boxGrid}>
        {centers.map(c => {
          const active = c.id === selectedId;
          const lifted = !active && hover === c.id;
          const slots  = centreSlots(c, uid);
          return (
            <button key={c.id} type="button" role="tab" aria-selected={active}
              onClick={() => onSelect(c.id)}
              onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(h => (h === c.id ? null : h))}
              style={{ ...s.box, ...(active ? s.boxActive : {}), ...(lifted ? s.boxHover : {}) }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span aria-hidden style={{ ...s.boxIcon, ...(active ? s.boxIconActive : {}) }}>🏫</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ ...s.boxName, color: active ? "#fff" : "#111827" }} title={c.name}>{c.name}</div>
                  <span style={{ ...s.boxCount2, ...(active ? { color: "rgba(255,255,255,0.9)" } : {}) }}>
                    {studentCounts === null ? "…" : (() => { const n = studentCounts[c.id] ?? 0; return `${n} student${n !== 1 ? "s" : ""}`; })()}
                  </span>
                  {showWing && (
                    <span style={{ ...s.boxCode, marginLeft: 6, ...(active
                      ? { background: "rgba(255,255,255,0.18)", color: "#fff" }
                      : wingOf(c) === "school_of_music" ? { background: "#fef3c7", color: "#92400e" } : { background: "#e0f2fe", color: "#0369a1" }) }}>
                      {WING_SHORT[wingOf(c)]}
                    </span>
                  )}
                </div>
                {active && <span style={s.boxTick}>✓ Selected</span>}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                {slots.length === 0 ? (
                  <span style={{ fontSize: 11, color: active ? "rgba(255,255,255,0.8)" : "#9ca3af" }}>No schedule set</span>
                ) : slots.map((sl, i) => (
                  <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    {sl.name && <span style={{ fontSize: 11.5, fontWeight: 700, color: active ? "#fff" : "#374151", marginRight: 2 }}>{sl.name}</span>}
                    {sl.days && <span style={{ ...s.boxChip, ...(active ? s.boxChipActive : {}) }}>📅 {sl.days}</span>}
                    {sl.time && <span style={{ ...s.boxChip, ...(active ? s.boxChipActive : {}) }}>⏰ {sl.time}</span>}
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function MyClassesContent() {
  const { user } = useAuthContext();

  const centerIds: string[] = user && isTeacher(user) ? user.centerIds ?? [] : [];
  const { isTeacherRole } = useCentreAccess();
  const { wing } = useWing();
  const router       = useRouter();
  const searchParams = useSearchParams();
  const centreParam  = searchParams.get("centerId") ?? "";

  const [centers,          setCenters]          = useState<Center[]>([]);
  const [selectedCenterId, setSelectedCenterId] = useState<string>("");
  const [students,         setStudents]         = useState<StudentRow[]>([]);
  const [centersLoading,   setCentersLoading]   = useState(true);
  const [studentsLoading,  setStudentsLoading]  = useState(false);
  const [studentsError,    setStudentsError]    = useState<string | null>(null);

  // Students view state
  const [view,         setView]         = useState<"students" | "attendance">("students");
  const [expandedUid,  setExpandedUid]  = useState<string | null>(null);
  const [studentData,  setStudentData]  = useState<Record<string, StudentData>>({});
  const [busy,         setBusy]         = useState<string | null>(null);
  const [actionErr,    setActionErr]    = useState<string | null>(null);

  // Attendance view state
  const [attDate,      setAttDate]      = useState<string>(todayStr);
  const [attMap,       setAttMap]       = useState<Record<string, AttendanceStatus>>({});
  const [attPickerUid, setAttPickerUid] = useState<string | null>(null);
  const [savingAtt,    setSavingAtt]    = useState<string | null>(null);
  const [attLoading,   setAttLoading]   = useState(false);

  // ── Load centres (live) ─────────────────────────────────────────────────────
  // Same matching as the teacher dashboard: a teacher's centres are the active
  // ones where they are the centre teacher, any batch's teacher, or listed in
  // their centerIds (which can lag behind the centre docs). A teacher sees every
  // wing they teach in (each box tagged); other roles only the active wing.
  const wingsKey = (isTeacherRole ? teachingWings(user, wing) : [wing]).join(",");

  // Active-student count for every card (same rule + de-dup as the roster below).
  const [studentCounts, setStudentCounts] = useState<Record<string, number> | null>(null);
  const centreIdsKey = centers.map(c => c.id).sort().join(",");
  useEffect(() => {
    const ids = centreIdsKey ? centreIdsKey.split(",") : [];
    if (ids.length === 0) { setStudentCounts({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
        const snaps = await Promise.all(chunks.map(ch => getDocs(query(collection(db, "users"), where("centerId", "in", ch)))));
        const seen: Record<string, Set<string>> = {};
        for (const snap of snaps) for (const d of snap.docs) {
          const u = d.data();
          if (u.role !== "student" || !isCurrentlyActiveStudent(u)) continue;
          (seen[u.centerId] ??= new Set()).add(normAdmNo(u.admissionNo ?? u.admissionNumber));
        }
        if (!cancelled) setStudentCounts(Object.fromEntries(ids.map(id => [id, seen[id]?.size ?? 0])));
      } catch (err) {
        console.error("Failed to count students:", err);
        if (!cancelled) setStudentCounts({});
      }
    })();
    return () => { cancelled = true; };
  }, [centreIdsKey]);
  useEffect(() => {
    if (!user) return;
    setCentersLoading(true);
    setCenters([]);
    const uid = user.uid;
    const wings = wingsKey.split(",");
    const unsub = onSnapshot(collection(db, "centers"), snap => {
      const active = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as Center))
        .filter(c => wings.includes(wingOf(c)))
        .filter(c => String(c.status ?? CENTER_STATUS.ACTIVE).toLowerCase() === CENTER_STATUS.ACTIVE);
      const list = isTeacherRole
        ? active.filter(c => centreTeacherUids(c.teacherUid, c.batches).has(uid) || centerIds.includes(c.id))
        : active;
      list.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      setCenters(list);
      setSelectedCenterId(prev => {
        if (list.some(c => c.id === prev)) return prev;
        const fromUrl = new URLSearchParams(window.location.search).get("centerId");
        return list.some(c => c.id === fromUrl) ? fromUrl! : list[0]?.id ?? "";
      });
      setCentersLoading(false);
    }, err => {
      console.error("Failed to load centres:", err);
      setCentersLoading(false);
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, centerIds.join(","), isTeacherRole, wingsKey]);

  // ── Keep the selected centre in the URL (?centerId=…) ───────────────────────
  // Back/forward or a shared link changes the param → follow it.
  useEffect(() => {
    if (centreParam && centreParam !== selectedCenterId && centers.some(c => c.id === centreParam)) {
      setSelectedCenterId(centreParam);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreParam]);

  // A ?centerId= from another wing (e.g. after switching wings) is out of scope —
  // point the URL at the centre actually shown for this wing.
  useEffect(() => {
    if (centersLoading || !centreParam || centers.some(c => c.id === centreParam)) return;
    router.replace(selectedCenterId ? `/dashboard/my-classes?centerId=${selectedCenterId}` : "/dashboard/my-classes", { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centersLoading, centreParam, centers, selectedCenterId]);

  const selectCentre = useCallback((id: string) => {
    setSelectedCenterId(id);
    router.replace(`/dashboard/my-classes?centerId=${id}`, { scroll: false });
  }, [router]);

  // ── Load students when centre changes ────────────────────────────────────────
  useEffect(() => {
    setStudents([]);
    setStudentsError(null);
    setExpandedUid(null);
    setView("students");
    // No centre in this wing → empty roster, never the previous wing's students.
    if (!selectedCenterId) { setStudentsLoading(false); return; }
    let cancelled = false;
    setStudentsLoading(true);
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, "users"),
          where("role",     "==", "student"),
          where("centerId", "==", selectedCenterId),
        ));
        if (cancelled) return;
        // Same active rule as the centre roster / Faculty Suite / Attendance
        // (lib/activeStudents): "active" or the Registry's "confirm", with an
        // admission number. Was `status === "active"` only, which dropped every
        // Registry-confirmed student and left whole centres empty.
        const centreScope = new Set([selectedCenterId]);
        const seen = new Set<string>();
        setStudents(
          snap.docs
            .filter(d => isCurrentlyActiveStudent(d.data(), centreScope))
            .filter(d => {
              // Duplicate records of one person (same adm. no.) list once.
              const key = normAdmNo(d.data().admissionNo ?? d.data().admissionNumber);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map(d => {
              const u = d.data();
              return {
                uid:        d.id,
                name:       (u.displayName ?? u.name ?? "—") as string,
                instrument: courseLabel(u) || "—",   // course title, else instrument
                status:     (u.status ?? u.studentStatus ?? "") as string,
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name))
        );
      } catch (err) {
        console.error("Failed to load students:", err);
        if (!cancelled) setStudentsError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setStudentsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCenterId]);

  // ── Load attendance when view/centre/date changes ────────────────────────────
  useEffect(() => {
    if (view !== "attendance" || !selectedCenterId) return;
    setAttMap({});
    setAttPickerUid(null);
    setAttLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const recs = await getAttendanceByCentreDate(selectedCenterId, attDate);
        if (cancelled) return;
        const map: Record<string, AttendanceStatus> = {};
        recs.forEach(r => { if (r.studentUid) map[r.studentUid] = r.status as AttendanceStatus; });
        setAttMap(map);
      } catch (err) {
        console.error("Failed to load attendance:", err);
      } finally {
        if (!cancelled) setAttLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCenterId, attDate]);

  // ── Switch to attendance view, default to most recent class date ─────────────
  function openAttendance() {
    const centre = centers.find(c => c.id === selectedCenterId);
    if (centre) {
      const dates = scheduledDatesForCentre(centre);
      setAttDate(dates[0] ?? todayStr);
    }
    setView("attendance");
  }

  // ── Syllabus helpers ─────────────────────────────────────────────────────────
  async function loadStudentData(uid: string) {
    if (studentData[uid]?.lessons?.length > 0 || studentData[uid]?.loading) return;
    setStudentData(prev => ({
      ...prev,
      [uid]: { lessons: [], progressMap: {}, unlockedMap: {}, loading: true, error: null },
    }));
    try {
      const [{ lessons }, progress] = await Promise.all([
        getLessonsForStudent(uid),
        getProgressByStudent(uid),
      ]);
      const pm: Record<string, StudentLessonProgress> = {};
      progress.forEach(p => { pm[p.itemId] = p; });
      const um: Record<string, boolean> = {};
      for (const lesson of lessons)
        for (const item of lesson.items)
          um[item.id] = await isItemUnlocked(uid, lesson, item, lessons, lesson.items);
      setStudentData(prev => ({ ...prev, [uid]: { lessons, progressMap: pm, unlockedMap: um, loading: false, error: null } }));
    } catch {
      setStudentData(prev => ({ ...prev, [uid]: { lessons: [], progressMap: {}, unlockedMap: {}, loading: false, error: "Failed to load syllabus." } }));
    }
  }

  function handleExpand(uid: string) {
    if (expandedUid === uid) { setExpandedUid(null); }
    else { setExpandedUid(uid); loadStudentData(uid); }
  }

  async function refreshProgress(studentUid: string) {
    const progress = await getProgressByStudent(studentUid);
    const pm: Record<string, StudentLessonProgress> = {};
    progress.forEach(p => { pm[p.itemId] = p; });
    setStudentData(prev => ({ ...prev, [studentUid]: { ...prev[studentUid], progressMap: pm } }));
  }

  async function handleAddAttempt(studentUid: string, lesson: LessonWithItems, item: LessonItem) {
    const key = `${studentUid}|${item.id}`;
    setActionErr(null); setBusy(key);
    try {
      await addAttempt(studentUid, lesson.id, item.id, user?.uid ?? "", (user?.role ?? ROLES.TEACHER) as Role, null);
      await refreshProgress(studentUid);
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to add attempt.");
    } finally { setBusy(null); }
  }

  async function handleMarkComplete(studentUid: string, lesson: LessonWithItems, item: LessonItem) {
    const key = `${studentUid}|${item.id}`;
    setActionErr(null); setBusy(key);
    try {
      await markItemCompleted(studentUid, lesson.id, item.id, user?.uid ?? "", (user?.role ?? ROLES.TEACHER) as Role);
      await refreshProgress(studentUid);
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to mark complete.");
    } finally { setBusy(null); }
  }

  // ── Attendance save ──────────────────────────────────────────────────────────
  async function handleSetAttendance(studentUid: string, status: AttendanceStatus) {
    setSavingAtt(studentUid);
    try {
      await saveCentreAttendance({ studentUid, centerId: selectedCenterId, date: attDate, status, markedBy: user?.uid ?? "" });
      setAttMap(prev => ({ ...prev, [studentUid]: status }));
      setAttPickerUid(null);
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to save attendance.");
    } finally { setSavingAtt(null); }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  if (centersLoading) return <div style={s.state}>Loading…</div>;

  const selectedCentre  = centers.find(c => c.id === selectedCenterId);
  const scheduledDates  = selectedCentre ? scheduledDatesForCentre(selectedCentre) : [];

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={s.page}>

      {/* Centre selector */}
      {centers.length === 0 ? (
        <div style={s.emptyState}>No centres assigned. Contact your administrator.</div>
      ) : centers.length === 1 ? (
        <div style={s.centreHeader}>
          <div style={s.centreAvatar}>🏫</div>
          <div>
            <div style={s.centreName}>{centers[0].name}</div>
            {centers[0].timeSlot && <div style={s.centreSlot}>{centers[0].timeSlot}</div>}
          </div>
        </div>
      ) : (
        <CentreBoxes centers={centers} selectedId={selectedCenterId} onSelect={selectCentre}
          uid={isTeacherRole ? (user?.uid ?? null) : null} showWing={wingsKey.includes(",")} studentCounts={studentCounts} />
      )}

      {/* Error banner */}
      {actionErr && (
        <div style={s.errBanner}>
          {actionErr}
          <button onClick={() => setActionErr(null)} style={s.errClose}>✕</button>
        </div>
      )}

      {selectedCenterId && (
        studentsLoading ? (
          <div style={s.state}>Loading students…</div>
        ) : studentsError ? (
          <div style={s.errBanner} role="alert">
            Couldn&apos;t load this centre&apos;s students — check your connection or access and try again.
            <span style={{ display: "block", fontSize: 11, opacity: 0.75, marginTop: 4 }}>{studentsError}</span>
          </div>
        ) : students.length === 0 ? (
          <div style={s.emptyState}>No active students enrolled in this centre yet.</div>
        ) : (
          <>
            {/* View toggle */}
            <div style={s.viewToggle}>
              <button
                style={{ ...s.viewBtn, ...(view === "students" ? s.viewBtnActive : {}) }}
                onClick={() => setView("students")}>
                👥 Students
              </button>
              <button
                style={{ ...s.viewBtn, ...(view === "attendance" ? s.viewBtnActiveAtt : {}) }}
                onClick={openAttendance}>
                ✓ Attendance
              </button>
            </div>

            {/* ── Students view ── */}
            {view === "students" && (
              <>
                <div style={s.listHeader}>
                  <span style={s.countLabel}>{students.length} student{students.length !== 1 ? "s" : ""}</span>
                  <span style={s.hintLabel}>Tap to view & mark syllabus</span>
                </div>

                {students.map(st => {
                  const data       = studentData[st.uid];
                  const isOpen     = expandedUid === st.uid;
                  const allItems   = data?.lessons.flatMap(l => l.items) ?? [];
                  const overallPct = allItems.length > 0 ? calcOverallPercent(allItems, data?.progressMap ?? {}) : null;

                  return (
                    <div key={st.uid} style={{ ...s.studentCard, borderColor: isOpen ? "#c4b5fd" : "#e5e7eb" }}>
                      <div style={s.studentRow} onClick={() => handleExpand(st.uid)}>
                        <div style={s.avatar}>{st.name.charAt(0).toUpperCase()}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={s.studentName}>{st.name}</div>
                          <div style={s.studentInst}>{st.instrument}</div>
                          {overallPct !== null && (
                            <div style={s.miniTrack}>
                              <div style={{ ...s.miniFill, width: `${overallPct}%`, background: overallPct >= 80 ? "#16a34a" : overallPct >= 40 ? "#f59e0b" : "#dc2626" }} />
                            </div>
                          )}
                        </div>
                        {overallPct !== null && <span style={s.pctPill}>{overallPct}%</span>}
                        <Link href={`/dashboard/student-syllabus/${st.uid}`} onClick={e => e.stopPropagation()} style={s.questBtn}>
                          📚 Quest
                        </Link>
                        <span style={{ ...s.chevron, transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
                      </div>

                      {isOpen && (
                        <div style={s.lessonArea}>
                          {!data || data.loading ? (
                            <div style={s.miniState}>Loading syllabus…</div>
                          ) : data.error ? (
                            <div style={s.miniErr}>{data.error}</div>
                          ) : data.lessons.length === 0 ? (
                            <div style={s.miniState}>No lessons assigned yet.</div>
                          ) : (
                            data.lessons.map(lesson => {
                              const lessonPct = calcLessonPercent(lesson.items, data.progressMap);
                              return (
                                <div key={lesson.id} style={s.lessonBlock}>
                                  <div style={s.lessonHeader}>
                                    <span style={s.lessonTitle}>{lesson.title}</span>
                                    <span style={s.lessonPct}>{lessonPct}%</span>
                                  </div>
                                  <LessonProgressBar pct={lessonPct} />
                                  <div style={s.itemList}>
                                    {lesson.items.map(item => {
                                      const prog     = data.progressMap[item.id];
                                      const attempts = prog?.totalAttempts ?? 0;
                                      const done     = prog?.completed ?? false;
                                      const unlocked = data.unlockedMap[item.id] ?? false;
                                      const isBusy   = busy === `${st.uid}|${item.id}`;
                                      return (
                                        <div key={item.id} style={{ ...s.itemRow, opacity: unlocked ? 1 : 0.4 }}>
                                          <div style={s.itemLeft}>
                                            <TypeBadge type={item.type} />
                                            <span style={s.itemTitle}>{item.title}</span>
                                            {!unlocked && <span style={s.lockIcon}>🔒</span>}
                                          </div>
                                          <div style={s.itemRight}>
                                            {done ? (
                                              <span style={s.doneBadge}>✔ Done</span>
                                            ) : (
                                              <>
                                                <span style={s.attemptCount}>{attempts}/{item.maxAttempts}</span>
                                                <button
                                                  disabled={!unlocked || isBusy || attempts >= item.maxAttempts}
                                                  onClick={e => { e.stopPropagation(); handleAddAttempt(st.uid, lesson, item); }}
                                                  style={{ ...s.btnTry, opacity: (!unlocked || isBusy || attempts >= item.maxAttempts) ? 0.4 : 1 }}>
                                                  {isBusy ? "…" : "+ Try"}
                                                </button>
                                                {attempts > 0 && (
                                                  <button
                                                    disabled={!unlocked || isBusy}
                                                    onClick={e => { e.stopPropagation(); handleMarkComplete(st.uid, lesson, item); }}
                                                    style={{ ...s.btnDone, opacity: (!unlocked || isBusy) ? 0.4 : 1 }}>
                                                    {isBusy ? "…" : "✔ Done"}
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
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {/* ── Attendance view ── */}
            {view === "attendance" && (
              <div>
                {/* Class date strip — only scheduled dates */}
                {scheduledDates.length === 0 ? (
                  <div style={s.miniState}>No schedule found for this centre. Check the time slot settings.</div>
                ) : (
                  <div style={s.dateStrip}>
                    {scheduledDates.map(date => {
                      const d      = new Date(date + "T00:00:00");
                      const isToday = date === todayStr;
                      return (
                        <button
                          key={date}
                          onClick={() => setAttDate(date)}
                          style={{ ...s.datePill, ...(attDate === date ? s.datePillActive : {}) }}>
                          <span style={{ fontSize: 10, opacity: 0.75 }}>
                            {d.toLocaleDateString("en-IN", { weekday: "short" })}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>
                            {d.getDate()} {d.toLocaleDateString("en-IN", { month: "short" })}
                          </span>
                          {isToday && <span style={{ fontSize: 9, fontWeight: 700, opacity: 0.8 }}>TODAY</span>}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Selected date label */}
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12, fontWeight: 600 }}>
                  {new Date(attDate + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </div>

                {/* Students with attendance status */}
                {attLoading ? (
                  <div style={s.state}>Loading attendance…</div>
                ) : (
                  students.map((st, i) => {
                    const status     = attMap[st.uid] ?? null;
                    const pickerOpen = attPickerUid === st.uid;
                    const isSaving   = savingAtt === st.uid;
                    return (
                      <div key={st.uid} style={{ ...s.attRow, borderTop: i === 0 ? "none" : "1px solid #f3f4f6" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                          <div style={s.attAvatar}>{st.name.charAt(0).toUpperCase()}</div>
                          <div style={{ minWidth: 0 }}>
                            <div style={s.studentName}>{st.name}</div>
                            <div style={s.studentInst}>{st.instrument}</div>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                          <button
                            disabled={isSaving}
                            onClick={() => setAttPickerUid(pickerOpen ? null : st.uid)}
                            style={{ ...s.attStatusBtn, ...ATT_STYLE[status ?? "none"] }}>
                            {isSaving ? "Saving…" : ATT_LABEL[status ?? "none"]}
                          </button>
                          {pickerOpen && (
                            <div style={s.attOptions}>
                              {(["present","absent","break","cancelled_teacher","cancelled_student"] as AttendanceStatus[]).map(opt => (
                                <button
                                  key={opt}
                                  onClick={() => handleSetAttendance(st.uid, opt)}
                                  style={{ ...s.attOpt, ...ATT_STYLE[opt], ...(status === opt ? { outline: "2px solid currentColor", outlineOffset: 1 } : {}) }}>
                                  {ATT_LABEL[opt]}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                {/* Summary footer */}
                {!attLoading && students.length > 0 && (() => {
                  const marked   = students.filter(st => attMap[st.uid]).length;
                  const present  = students.filter(st => attMap[st.uid] === "present").length;
                  const unmarked = students.length - marked;
                  return (
                    <div style={s.attSummary}>
                      <span>✔ {present} present</span>
                      <span style={{ color: "#9ca3af" }}>·</span>
                      <span style={{ color: "#dc2626" }}>{unmarked} unmarked</span>
                      <span style={{ color: "#9ca3af" }}>·</span>
                      <span>{marked}/{students.length} recorded</span>
                    </div>
                  );
                })()}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LessonProgressBar({ pct }: { pct: number }) {
  const color = pct >= 80 ? "#16a34a" : pct >= 40 ? "#f59e0b" : "#dc2626";
  return (
    <div style={{ height: 5, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", marginTop: 6 }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 99, transition: "width 0.3s ease" }} />
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
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: c.bg, color: c.color, flexShrink: 0, whiteSpace: "nowrap" }}>
      {type.charAt(0).toUpperCase() + type.slice(1)}
    </span>
  );
}

// ─── Attendance labels & colours ──────────────────────────────────────────────

const ATT_LABEL: Record<string, string> = {
  none:              "Mark",
  present:           "✔ Present",
  absent:            "✗ Absent",
  break:             "☕ Break",
  cancelled_teacher: "CT Cancel",
  // Stored value stays "cancelled_student" for compatibility with existing
  // records; it now means the student had no class scheduled that day.
  cancelled_student: "Not Assigned",
};

const ATT_STYLE: Record<string, React.CSSProperties> = {
  none:              { background: "#f3f4f6", color: "#6b7280",  border: "1px solid #e5e7eb" },
  present:           { background: "#dcfce7", color: "#16a34a",  border: "1px solid #bbf7d0" },
  absent:            { background: "#fee2e2", color: "#dc2626",  border: "1px solid #fecaca" },
  break:             { background: "#fef9c3", color: "#92400e",  border: "1px solid #fde68a" },
  cancelled_teacher: { background: "#ede9fe", color: "#5b21b6",  border: "1px solid #c4b5fd" },
  cancelled_student: { background: "#e5e7eb", color: "#374151",  border: "1px solid #d1d5db" },
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:  { maxWidth: 820, margin: "0 auto", paddingBottom: 40 },
  state: { padding: "60px 0", textAlign: "center", fontSize: 14, color: "#9ca3af" },

  // Centre boxes (see CentreBoxes).
  // Compact: ~18px title, 14px card names, 32px icons, 12px gaps — more centres per screen.
  boxHead:   { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" },
  boxTitle:  { fontSize: 18, fontWeight: 800, color: "#111827", letterSpacing: "-0.01em" },
  boxSub:    { fontSize: 12, color: "#6b7280", marginTop: 1 },
  boxCount:  { fontSize: 11.5, fontWeight: 700, color: "#4f46e5", background: "#ede9fe", borderRadius: 999, padding: "2px 9px" },
  boxGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))", gap: 12 },
  box:       { textAlign: "left", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", cursor: "pointer", fontFamily: "inherit", transition: "transform 0.15s, box-shadow 0.15s, border-color 0.15s", minWidth: 0, boxShadow: "0 1px 2px rgba(17,24,39,0.05)" },
  boxHover:  { transform: "translateY(-2px)", borderColor: "#c7d2fe", boxShadow: "0 10px 24px rgba(79,70,229,0.14)" },
  boxActive: { border: "1px solid #4f46e5", background: "#4f46e5", backgroundImage: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)", boxShadow: "0 12px 28px rgba(79,70,229,0.35)", color: "#fff" },
  boxIcon:   { width: 32, height: 32, borderRadius: 9, background: "#eef2ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 },
  boxIconActive: { background: "rgba(255,255,255,0.2)" },
  boxName:   { fontSize: 14, fontWeight: 700, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  boxCount2: { display: "inline-block", marginTop: 2, fontSize: 11, fontWeight: 600, color: "#4f46e5" },
  boxCode:   { display: "inline-block", marginTop: 3, fontSize: 11, fontWeight: 700, background: "#ede9fe", color: "#4f46e5", borderRadius: 5, padding: "1px 6px" },
  boxTick:   { fontSize: 10.5, fontWeight: 800, color: "#4f46e5", background: "rgba(255,255,255,0.95)", borderRadius: 999, padding: "2px 8px", flexShrink: 0, whiteSpace: "nowrap" },
  boxChip:   { fontSize: 11, fontWeight: 600, color: "#374151", background: "#f3f4f6", borderRadius: 6, padding: "2px 7px" },
  boxChipActive: { color: "#fff", background: "rgba(255,255,255,0.18)" },

  centreHeader:  { display: "flex", alignItems: "center", gap: 12, marginBottom: 20, padding: "16px 20px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 },
  centreAvatar:  { fontSize: 22, flexShrink: 0 },
  centreName:    { fontSize: 16, fontWeight: 700, color: "#111" },
  centreSlot:    { fontSize: 12, color: "#9ca3af", marginTop: 2 },

  emptyState: { padding: "48px 24px", textAlign: "center", fontSize: 14, color: "#9ca3af", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 },
  errBanner:  { display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 14 },
  errClose:   { background: "none", border: "none", cursor: "pointer", color: "#dc2626", fontWeight: 700, fontSize: 14, padding: "0 2px" },

  // View toggle
  viewToggle:      { display: "flex", gap: 0, marginBottom: 16, background: "#f3f4f6", borderRadius: 10, padding: 3 },
  viewBtn:         { flex: 1, padding: "8px 0", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "transparent", color: "#6b7280" },
  viewBtnActive:   { background: "#fff", color: "#4f46e5", boxShadow: "0 1px 4px rgba(0,0,0,0.08)" },
  viewBtnActiveAtt:{ background: "#fff", color: "#16a34a", boxShadow: "0 1px 4px rgba(0,0,0,0.08)" },

  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  countLabel: { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  hintLabel:  { fontSize: 11, color: "#9ca3af" },

  // Student cards (syllabus view)
  studentCard: { background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 10, transition: "border-color 0.15s" },
  studentRow:  { display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", userSelect: "none" as const },
  avatar:      { width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  studentName: { fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 1 },
  studentInst: { fontSize: 12, color: "#9ca3af" },
  miniTrack:   { height: 4, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", marginTop: 6 },
  miniFill:    { height: "100%", borderRadius: 99, transition: "width 0.3s ease" },
  pctPill:     { background: "#ede9fe", color: "#4f46e5", borderRadius: 99, padding: "3px 10px", fontSize: 12, fontWeight: 700, flexShrink: 0 },
  questBtn:    { background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 600, textDecoration: "none", flexShrink: 0 },
  chevron:     { fontSize: 14, color: "#9ca3af", transition: "transform 0.2s", flexShrink: 0 },

  // Lesson / item styles
  lessonArea:   { borderTop: "1.5px solid #f3f4f6", padding: "16px 18px", display: "flex", flexDirection: "column" as const, gap: 12 },
  miniState:    { textAlign: "center", fontSize: 13, color: "#9ca3af", padding: "16px 0" },
  miniErr:      { textAlign: "center", fontSize: 13, color: "#dc2626", padding: "12px 0" },
  lessonBlock:  { border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px", background: "#fafafa" },
  lessonHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  lessonTitle:  { fontSize: 13, fontWeight: 700, color: "#111" },
  lessonPct:    { fontSize: 12, fontWeight: 700, color: "#4f46e5" },
  itemList:     { display: "flex", flexDirection: "column" as const, gap: 6, marginTop: 12 },
  itemRow:      { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0", borderTop: "1px solid #f3f4f6", flexWrap: "wrap" as const },
  itemLeft:     { display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
  itemRight:    { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  itemTitle:    { fontSize: 12, color: "#374151", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  lockIcon:     { fontSize: 11, color: "#d1d5db", flexShrink: 0 },
  attemptCount: { fontSize: 11, color: "#9ca3af", minWidth: 32, textAlign: "center" as const },
  doneBadge:    { padding: "3px 12px", background: "#dcfce7", color: "#16a34a", borderRadius: 99, fontSize: 11, fontWeight: 700 },
  btnTry:       { background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  btnDone:      { background: "#dcfce7", color: "#16a34a", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" },

  // Attendance view
  dateStrip:     { display: "flex", gap: 8, overflowX: "auto" as const, paddingBottom: 8, marginBottom: 12, scrollbarWidth: "none" as const },
  datePill:      { display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 1, padding: "8px 12px", border: "1.5px solid #e5e7eb", borderRadius: 10, background: "#fff", cursor: "pointer", flexShrink: 0, minWidth: 64, color: "#374151" },
  datePillActive:{ background: "#4f46e5", border: "1.5px solid #4f46e5", color: "#fff" },

  attRow:      { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "12px 0", flexWrap: "wrap" as const },
  attAvatar:   { width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  attStatusBtn:{ borderRadius: 99, padding: "5px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const },
  attOptions:  { display: "flex", gap: 6, flexWrap: "wrap" as const, justifyContent: "flex-end" },
  attOpt:      { borderRadius: 99, padding: "4px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const },
  attSummary:  { display: "flex", gap: 10, alignItems: "center", padding: "12px 0", marginTop: 8, borderTop: "1px solid #f3f4f6", fontSize: 12, fontWeight: 600, color: "#374151" },
};
