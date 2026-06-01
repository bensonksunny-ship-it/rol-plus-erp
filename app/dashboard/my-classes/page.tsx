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

export default function MyClassesPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.TEACHER, ROLES.ADMIN, ROLES.SUPER_ADMIN]}>
      <MyClassesContent />
    </ProtectedRoute>
  );
}

function MyClassesContent() {
  const { user } = useAuthContext();

  const centerIds: string[] = user && isTeacher(user) ? user.centerIds : [];

  const [centers,          setCenters]          = useState<Center[]>([]);
  const [selectedCenterId, setSelectedCenterId] = useState<string>("");
  const [students,         setStudents]         = useState<StudentRow[]>([]);
  const [centersLoading,   setCentersLoading]   = useState(true);
  const [studentsLoading,  setStudentsLoading]  = useState(false);
  const [expandedUid,      setExpandedUid]      = useState<string | null>(null);
  const [studentData,      setStudentData]      = useState<Record<string, StudentData>>({});
  const [actionErr,        setActionErr]        = useState<string | null>(null);
  const [busy,             setBusy]             = useState<string | null>(null); // "uid|itemId"

  // Load teacher's assigned centres
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

  // Load students when selected centre changes
  useEffect(() => {
    if (!selectedCenterId) return;
    setStudents([]);
    setExpandedUid(null);
    setStudentsLoading(true);
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, "users"),
          where("role",     "==", "student"),
          where("centerId", "==", selectedCenterId),
        ));
        const rows: StudentRow[] = snap.docs
          .filter(d => {
            const status = ((d.data().status ?? d.data().studentStatus ?? "active") as string);
            return status === "active";
          })
          .map(d => {
            const u = d.data();
            return {
              uid:        d.id,
              name:       (u.displayName ?? u.name ?? "—") as string,
              instrument: (u.instrument ?? "—") as string,
              status:     ((u.status ?? u.studentStatus ?? "active") as string),
            };
          });
        setStudents(rows);
      } catch (err) {
        console.error("Failed to load students:", err);
      } finally {
        setStudentsLoading(false);
      }
    })();
  }, [selectedCenterId]);

  // Lazy-load lesson data for a student when expanded
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
      for (const lesson of lessons) {
        for (const item of lesson.items) {
          um[item.id] = await isItemUnlocked(uid, lesson, item, lessons, lesson.items);
        }
      }
      setStudentData(prev => ({
        ...prev,
        [uid]: { lessons, progressMap: pm, unlockedMap: um, loading: false, error: null },
      }));
    } catch {
      setStudentData(prev => ({
        ...prev,
        [uid]: { lessons: [], progressMap: {}, unlockedMap: {}, loading: false, error: "Failed to load syllabus." },
      }));
    }
  }

  function handleExpand(uid: string) {
    if (expandedUid === uid) {
      setExpandedUid(null);
    } else {
      setExpandedUid(uid);
      loadStudentData(uid);
    }
  }

  async function refreshProgress(studentUid: string) {
    const progress = await getProgressByStudent(studentUid);
    const pm: Record<string, StudentLessonProgress> = {};
    progress.forEach(p => { pm[p.itemId] = p; });
    setStudentData(prev => ({
      ...prev,
      [studentUid]: { ...prev[studentUid], progressMap: pm },
    }));
  }

  async function handleAddAttempt(studentUid: string, lesson: LessonWithItems, item: LessonItem) {
    const key = `${studentUid}|${item.id}`;
    setActionErr(null);
    setBusy(key);
    try {
      await addAttempt(
        studentUid, lesson.id, item.id,
        user?.uid ?? "", (user?.role ?? ROLES.TEACHER) as Role,
        null,
      );
      await refreshProgress(studentUid);
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to add attempt.");
    } finally {
      setBusy(null);
    }
  }

  async function handleMarkComplete(studentUid: string, lesson: LessonWithItems, item: LessonItem) {
    const key = `${studentUid}|${item.id}`;
    setActionErr(null);
    setBusy(key);
    try {
      await markItemCompleted(
        studentUid, lesson.id, item.id,
        user?.uid ?? "", (user?.role ?? ROLES.TEACHER) as Role,
      );
      await refreshProgress(studentUid);
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Failed to mark complete.");
    } finally {
      setBusy(null);
    }
  }

  if (centersLoading) return <div style={s.state}>Loading…</div>;

  const selectedCentre = centers.find(c => c.id === selectedCenterId);

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

      {/* Centre subtitle for multi-centre view */}
      {centers.length > 1 && selectedCentre?.timeSlot && (
        <div style={s.centreSlotBar}>{selectedCentre.timeSlot}</div>
      )}

      {/* Student list */}
      {selectedCenterId && (
        studentsLoading ? (
          <div style={s.state}>Loading students…</div>
        ) : students.length === 0 ? (
          <div style={s.emptyState}>No active students in this centre.</div>
        ) : (
          <>
            {actionErr && (
              <div style={s.errBanner}>
                {actionErr}
                <button onClick={() => setActionErr(null)} style={s.errClose}>✕</button>
              </div>
            )}

            <div style={s.listHeader}>
              <span style={s.countLabel}>{students.length} student{students.length !== 1 ? "s" : ""}</span>
              <span style={s.hintLabel}>Tap a student to view & mark their syllabus</span>
            </div>

            {students.map(st => {
              const data       = studentData[st.uid];
              const isOpen     = expandedUid === st.uid;
              const allItems   = data?.lessons.flatMap(l => l.items) ?? [];
              const overallPct = allItems.length > 0
                ? calcOverallPercent(allItems, data?.progressMap ?? {})
                : null;

              return (
                <div key={st.uid} style={{ ...s.studentCard, borderColor: isOpen ? "#c4b5fd" : "#e5e7eb" }}>
                  {/* Row header — click to expand */}
                  <div style={s.studentRow} onClick={() => handleExpand(st.uid)}>
                    <div style={s.avatar}>{st.name.charAt(0).toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={s.studentName}>{st.name}</div>
                      <div style={s.studentInst}>{st.instrument}</div>
                      {/* Mini progress bar when data loaded */}
                      {overallPct !== null && (
                        <div style={s.miniTrack}>
                          <div style={{ ...s.miniFill, width: `${overallPct}%`, background: overallPct >= 80 ? "#16a34a" : overallPct >= 40 ? "#f59e0b" : "#dc2626" }} />
                        </div>
                      )}
                    </div>
                    {overallPct !== null && (
                      <span style={s.pctPill}>{overallPct}%</span>
                    )}
                    <Link
                      href={`/dashboard/student-syllabus/${st.uid}`}
                      onClick={e => e.stopPropagation()}
                      style={s.questBtn}>
                      📚 Quest
                    </Link>
                    <span style={{ ...s.chevron, transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
                  </div>

                  {/* Expanded syllabus */}
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
                                    <div key={item.id}
                                      style={{ ...s.itemRow, opacity: unlocked ? 1 : 0.4 }}>
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
        )
      )}
    </div>
  );
}

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

const s: Record<string, React.CSSProperties> = {
  page:  { maxWidth: 820, margin: "0 auto", paddingBottom: 40 },
  state: { padding: "60px 0", textAlign: "center", fontSize: 14, color: "#9ca3af" },

  tabStrip: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2, marginBottom: 16, scrollbarWidth: "none" },
  tab:       { padding: "8px 18px", borderRadius: 99, border: "1px solid #e5e7eb", background: "#f9fafb", color: "#6b7280", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },
  tabActive: { background: "#4f46e5", border: "1px solid #4f46e5", color: "#fff" },

  centreHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20, padding: "16px 20px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 },
  centreAvatar: { fontSize: 22, flexShrink: 0 },
  centreName:   { fontSize: 16, fontWeight: 700, color: "#111" },
  centreSlot:   { fontSize: 12, color: "#9ca3af", marginTop: 2 },
  centreSlotBar:{ fontSize: 12, color: "#9ca3af", marginBottom: 14, paddingLeft: 4 },

  emptyState: { padding: "48px 24px", textAlign: "center", fontSize: 14, color: "#9ca3af", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 },

  errBanner: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 14 },
  errClose:  { background: "none", border: "none", cursor: "pointer", color: "#dc2626", fontWeight: 700, fontSize: 14, padding: "0 2px" },

  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  countLabel: { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  hintLabel:  { fontSize: 11, color: "#9ca3af" },

  studentCard: { background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 10, transition: "border-color 0.15s" },
  studentRow:  { display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", userSelect: "none" as const },

  avatar:      { width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  studentName: { fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 1 },
  studentInst: { fontSize: 12, color: "#9ca3af" },

  miniTrack: { height: 4, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", marginTop: 6 },
  miniFill:  { height: "100%", borderRadius: 99, transition: "width 0.3s ease" },

  pctPill:  { background: "#ede9fe", color: "#4f46e5", borderRadius: 99, padding: "3px 10px", fontSize: 12, fontWeight: 700, flexShrink: 0 },
  questBtn: { background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 600, textDecoration: "none", flexShrink: 0 },
  chevron:  { fontSize: 14, color: "#9ca3af", transition: "transform 0.2s", flexShrink: 0 },

  lessonArea: { borderTop: "1.5px solid #f3f4f6", padding: "16px 18px", display: "flex", flexDirection: "column" as const, gap: 12 },
  miniState:  { textAlign: "center", fontSize: 13, color: "#9ca3af", padding: "16px 0" },
  miniErr:    { textAlign: "center", fontSize: 13, color: "#dc2626", padding: "12px 0" },

  lessonBlock:  { border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px", background: "#fafafa" },
  lessonHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  lessonTitle:  { fontSize: 13, fontWeight: 700, color: "#111" },
  lessonPct:    { fontSize: 12, fontWeight: 700, color: "#4f46e5" },

  itemList: { display: "flex", flexDirection: "column" as const, gap: 6, marginTop: 12 },
  itemRow:  { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0", borderTop: "1px solid #f3f4f6", flexWrap: "wrap" as const },
  itemLeft: { display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
  itemRight:{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },

  itemTitle:    { fontSize: 12, color: "#374151", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  lockIcon:     { fontSize: 11, color: "#d1d5db", flexShrink: 0 },
  attemptCount: { fontSize: 11, color: "#9ca3af", minWidth: 32, textAlign: "center" as const },
  doneBadge:    { padding: "3px 12px", background: "#dcfce7", color: "#16a34a", borderRadius: 99, fontSize: 11, fontWeight: 700 },
  btnTry:  { background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  btnDone: { background: "#dcfce7", color: "#16a34a", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" },
};
