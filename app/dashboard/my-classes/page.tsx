"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { isTeacher } from "@/types";
import { getCenterById } from "@/services/center/center.service";
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
    <ProtectedRoute allowedRoles={[ROLES.TEACHER, ROLES.ADMIN, ROLES.SUPER_ADMIN]}>
      <MyClassesContent />
    </ProtectedRoute>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function MyClassesContent() {
  const { user } = useAuthContext();

  const centerIds: string[] = user && isTeacher(user) ? user.centerIds : [];

  const [centers,          setCenters]          = useState<Center[]>([]);
  const [selectedCenterId, setSelectedCenterId] = useState<string>("");
  const [students,         setStudents]         = useState<StudentRow[]>([]);
  const [centersLoading,   setCentersLoading]   = useState(true);
  const [studentsLoading,  setStudentsLoading]  = useState(false);

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

  // ── Load centres ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    setCentersLoading(true);
    (async () => {
      try {
        let list: Center[];
        if (centerIds.length > 0) {
          const results = await Promise.allSettled(centerIds.map(id => getCenterById(id)));
          list = results
            .filter((r): r is PromiseFulfilledResult<Center> => r.status === "fulfilled")
            .map(r => r.value);
        } else {
          const snap = await getDocs(collection(db, "centers"));
          list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Center));
        }
        setCenters(list);
        if (list.length > 0) setSelectedCenterId(list[0].id);
      } catch (err) {
        console.error("Failed to load centres:", err);
      } finally {
        setCentersLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // ── Load students when centre changes ────────────────────────────────────────
  useEffect(() => {
    if (!selectedCenterId) return;
    setStudents([]);
    setExpandedUid(null);
    setView("students");
    setStudentsLoading(true);
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, "users"),
          where("role",     "==", "student"),
          where("centerId", "==", selectedCenterId),
        ));
        setStudents(
          snap.docs
            .filter(d => {
              const status = (d.data().status ?? d.data().studentStatus ?? "active") as string;
              return status === "active";
            })
            .map(d => {
              const u = d.data();
              return {
                uid:        d.id,
                name:       (u.displayName ?? u.name ?? "—") as string,
                instrument: (u.instrument ?? "—") as string,
                status:     (u.status ?? u.studentStatus ?? "active") as string,
              };
            })
        );
      } catch (err) {
        console.error("Failed to load students:", err);
      } finally {
        setStudentsLoading(false);
      }
    })();
  }, [selectedCenterId]);

  // ── Load attendance when view/centre/date changes ────────────────────────────
  useEffect(() => {
    if (view !== "attendance" || !selectedCenterId) return;
    setAttMap({});
    setAttPickerUid(null);
    setAttLoading(true);
    (async () => {
      try {
        const recs = await getAttendanceByCentreDate(selectedCenterId, attDate);
        const map: Record<string, AttendanceStatus> = {};
        recs.forEach(r => { if (r.studentUid) map[r.studentUid] = r.status as AttendanceStatus; });
        setAttMap(map);
      } catch (err) {
        console.error("Failed to load attendance:", err);
      } finally {
        setAttLoading(false);
      }
    })();
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
        <div style={s.tabStrip}>
          {centers.map(c => (
            <button key={c.id} onClick={() => setSelectedCenterId(c.id)}
              style={{ ...s.tab, ...(selectedCenterId === c.id ? s.tabActive : {}) }}>
              🏫 {c.name}
            </button>
          ))}
        </div>
      )}

      {centers.length > 1 && selectedCentre?.timeSlot && (
        <div style={s.centreSlotBar}>{selectedCentre.timeSlot}</div>
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
        ) : students.length === 0 ? (
          <div style={s.emptyState}>No active students in this centre.</div>
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

  tabStrip:  { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2, marginBottom: 16, scrollbarWidth: "none" },
  tab:       { padding: "8px 18px", borderRadius: 99, border: "1px solid #e5e7eb", background: "#f9fafb", color: "#6b7280", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },
  tabActive: { background: "#4f46e5", border: "1px solid #4f46e5", color: "#fff" },

  centreHeader:  { display: "flex", alignItems: "center", gap: 12, marginBottom: 20, padding: "16px 20px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 },
  centreAvatar:  { fontSize: 22, flexShrink: 0 },
  centreName:    { fontSize: 16, fontWeight: 700, color: "#111" },
  centreSlot:    { fontSize: 12, color: "#9ca3af", marginTop: 2 },
  centreSlotBar: { fontSize: 12, color: "#9ca3af", marginBottom: 8, paddingLeft: 4 },

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
