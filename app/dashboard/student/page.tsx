"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  getLessonsForStudent,
  getProgressByStudent,
  isItemUnlocked,
  calcLessonPercent,
  calcOverallPercent,
} from "@/services/lesson/lesson.service";
import type { Lesson, LessonItem, StudentLessonProgress } from "@/types/lesson";
import type { AttendanceRecord } from "@/types/attendance";
import type { Transaction } from "@/types/finance";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardData {
  studentName:    string;
  // Lesson progress
  lessons:        (Lesson & { items: LessonItem[] })[];
  progressMap:    Record<string, StudentLessonProgress>;
  overallPercent: number;
  // Next unlocked activity
  nextActivity:   NextActivity | null;
  // Attendance
  totalPresent:   number;
  totalAbsent:    number;
  // Finance — from user.currentBalance (positive = owed, negative = credit)
  currentBalance: number;
  // Next class
  nextClass:      NextClassInfo | null;
}

interface NextActivity {
  lessonTitle: string;
  itemTitle:   string;
  itemType:    string;
  lessonId:    string;
  itemId:      string;
  attempts:    number;
  maxAttempts: number;
}

interface NextClassInfo {
  date:      string;
  startTime: string;
  endTime:   string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    year:    "numeric",
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function StudentDashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.STUDENT]}>
      <StudentDashboardContent />
    </ProtectedRoute>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function StudentDashboardContent() {
  const { user }               = useAuthContext();
  const router                 = useRouter();
  const [data, setData]        = useState<DashboardData | null>(null);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState<string | null>(null);

  const studentId = user?.uid ?? "";

  useEffect(() => {
    if (!studentId) return;
    load(studentId);
  }, [studentId]);

  async function load(uid: string) {
    try {
      setLoading(true);
      setError(null);

      // ── Parallel fetch: lessons + progress + user doc + attendance + next class ──
      const [{ lessons }, allProgress, userSnap, attendanceSnap, upcomingClassSnap] =
        await Promise.all([
          getLessonsForStudent(uid),
          getProgressByStudent(uid),
          getDoc(doc(db, "users", uid)),
          getDocs(query(
            collection(db, "attendance"),
            where("studentUid", "==", uid),
          )),
          getDocs(query(
            collection(db, "classes"),
            where("status", "==", "scheduled"),
          )),
        ]);

      // ── Student name + balance ──────────────────────────────────────────────
      const userData        = userSnap.exists() ? userSnap.data() : {};
      const studentName     = (userData.displayName as string) || "Student";
      const currentBalance  = (userData.currentBalance as number) ?? 0;

      // ── Progress map ────────────────────────────────────────────────────────
      const progressMap: Record<string, StudentLessonProgress> = {};
      allProgress.forEach(p => { progressMap[p.itemId] = p; });

      // ── Overall percent ─────────────────────────────────────────────────────
      const allItems = lessons.flatMap(l => l.items);
      const overallPercent = calcOverallPercent(allItems, progressMap);

      // ── Find next unlocked activity ─────────────────────────────────────────
      let nextActivity: NextActivity | null = null;

      outer:
      for (const lesson of lessons) {
        for (const item of lesson.items) {
          const prog = progressMap[item.id];
          if (prog?.completed) continue; // already done
          const unlocked = await isItemUnlocked(uid, lesson, item, lessons, lesson.items);
          if (unlocked) {
            nextActivity = {
              lessonTitle: lesson.title,
              itemTitle:   item.title,
              itemType:    item.type,
              lessonId:    lesson.id,
              itemId:      item.id,
              attempts:    prog?.totalAttempts ?? 0,
              maxAttempts: item.maxAttempts,
            };
            break outer;
          }
        }
      }

      // ── Attendance ──────────────────────────────────────────────────────────
      const attendanceRecords = attendanceSnap.docs.map(
        d => ({ id: d.id, ...d.data() }) as AttendanceRecord,
      );
      const totalPresent = attendanceRecords.filter(r => r.status === "present").length;
      const totalAbsent  = attendanceRecords.filter(r => r.status === "absent").length;

      // ── Next class (earliest upcoming class for student's center) ───────────
      const centerId  = (userData.centerId as string) ?? null;
      const today     = new Date().toISOString().slice(0, 10);
      const allClasses = upcomingClassSnap.docs
        .map(d => ({ id: d.id, ...d.data() }) as { id: string; centerId: string; date: string; startTime: string; endTime: string })
        .filter(c => centerId ? c.centerId === centerId : false)
        .filter(c => c.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

      const nextClass = allClasses[0]
        ? { date: allClasses[0].date, startTime: allClasses[0].startTime, endTime: allClasses[0].endTime }
        : null;

      setData({
        studentName,
        lessons,
        progressMap,
        overallPercent,
        nextActivity,
        totalPresent,
        totalAbsent,
        currentBalance,
        nextClass,
      });
    } catch (err) {
      console.error("Student dashboard load error:", err);
      setError("Failed to load dashboard. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Derived values ──────────────────────────────────────────────────────────

  const currentLesson = data?.lessons.find(l => {
    const items = l.items;
    if (items.length === 0) return false;
    const allDone = items.every(i => data.progressMap[i.id]?.completed);
    const anyStarted = items.some(i => (data.progressMap[i.id]?.totalAttempts ?? 0) > 0);
    return !allDone && anyStarted;
  }) ?? data?.lessons.find(l => l.items.some(i => !data.progressMap[i.id]?.completed)) ?? null;

  const currentLessonPercent = currentLesson && data
    ? calcLessonPercent(currentLesson.items, data.progressMap)
    : 0;

  const attendancePct =
    data && data.totalPresent + data.totalAbsent > 0
      ? Math.round((data.totalPresent / (data.totalPresent + data.totalAbsent)) * 100)
      : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return <div style={s.center}>Loading your dashboard…</div>;
  }

  if (error) {
    return <div style={s.errorMsg}>{error}</div>;
  }

  if (!data) return null;

  return (
    <div style={s.page}>

      {/* ═══════════════════════════════════════════════════════════
          HERO — Welcome + headline stats
      ══════════════════════════════════════════════════════════════ */}
      <div style={s.hero}>
        <div style={s.heroLeft}>
          <div style={s.avatar}>{data.studentName.charAt(0).toUpperCase()}</div>
          <div>
            <div style={s.welcomeLabel}>Welcome back,</div>
            <div style={s.heroName}>{data.studentName}</div>
          </div>
        </div>

        <div style={s.heroStats}>
          {/* Current lesson progress */}
          <div style={s.heroStat}>
            <div style={s.heroStatValue}>{currentLessonPercent}%</div>
            <div style={s.heroStatLabel}>Current Lesson</div>
          </div>
          <div style={s.heroDivider} />
          {/* Overall progress */}
          <div style={s.heroStat}>
            <div style={{ ...s.heroStatValue, color: "#16a34a" }}>{data.overallPercent}%</div>
            <div style={s.heroStatLabel}>Overall Progress</div>
          </div>
          <div style={s.heroDivider} />
          {/* Next activity label */}
          <div style={s.heroStat}>
            <div style={{ ...s.heroStatValue, fontSize: 14, color: "#4f46e5" }}>
              {data.nextActivity
                ? `${capitalize(data.nextActivity.itemType)} – ${data.nextActivity.lessonTitle}`
                : "—"}
            </div>
            <div style={s.heroStatLabel}>Up Next</div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          CONTINUE LEARNING — primary CTA
      ══════════════════════════════════════════════════════════════ */}
      <SectionTitle>Continue Learning</SectionTitle>

      {data.nextActivity ? (
        <div style={s.continueLearningCard}>
          <div style={s.continueLeft}>
            <div style={s.continueLesson}>{data.nextActivity.lessonTitle}</div>
            <div style={s.continueActivity}>
              <TypeBadge type={data.nextActivity.itemType} />
              <span style={s.continueActivityTitle}>{data.nextActivity.itemTitle}</span>
            </div>
            <div style={s.continueAttempts}>
              Attempts: {data.nextActivity.attempts}/{data.nextActivity.maxAttempts}
            </div>
          </div>
          <button
            style={s.continueBtn}
            onClick={() => router.push(`/dashboard/student-syllabus/${studentId}`)}
          >
            Continue Learning →
          </button>
        </div>
      ) : (
        <div style={s.allDoneCard}>
          🎉 All lessons completed! Great work.
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          PROGRESS OVERVIEW — lesson list
      ══════════════════════════════════════════════════════════════ */}
      <SectionTitle>Progress Overview</SectionTitle>

      {data.lessons.length === 0 ? (
        <div style={s.emptyCard}>No lessons available yet. Check back after your teacher adds content.</div>
      ) : (
        <div style={s.lessonList}>
          {data.lessons.map(lesson => {
            const items     = lesson.items;
            const pct       = calcLessonPercent(items, data.progressMap);
            const allDone   = items.length > 0 && items.every(i => data.progressMap[i.id]?.completed);
            const anyStarted = items.some(i => (data.progressMap[i.id]?.totalAttempts ?? 0) > 0);
            const status    = allDone ? "completed" : anyStarted ? "in_progress" : "locked";

            return (
              <div key={lesson.id} style={s.lessonRow}>
                <div style={s.lessonLeft}>
                  <LessonStatusIcon status={status} />
                  <div>
                    <div style={s.lessonTitle}>{lesson.title}</div>
                    <div style={s.lessonSub}>{items.length} activities</div>
                  </div>
                </div>
                <div style={s.lessonRight}>
                  <div style={s.lessonPct}>{pct}%</div>
                  <div style={s.lessonBarTrack}>
                    <div style={{
                      ...s.lessonBarFill,
                      width:      `${pct}%`,
                      background: allDone ? "#16a34a" : anyStarted ? "#f59e0b" : "#d1d5db",
                    }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          ATTEMPTS TRACKER — current lesson breakdown
      ══════════════════════════════════════════════════════════════ */}
      {currentLesson && (
        <>
          <SectionTitle>Attempts Tracker — {currentLesson.title}</SectionTitle>
          <div style={s.attemptsCard}>
            {currentLesson.items.length === 0 ? (
              <div style={s.emptyMsg}>No activities in this lesson.</div>
            ) : (
              currentLesson.items.map(item => {
                const prog     = data.progressMap[item.id];
                const attempts = prog?.totalAttempts ?? 0;
                const done     = prog?.completed ?? false;
                return (
                  <div key={item.id} style={s.attemptRow}>
                    <div style={s.attemptLeft}>
                      <TypeBadge type={item.type} />
                      <span style={s.attemptTitle}>{item.title}</span>
                    </div>
                    <div style={s.attemptRight}>
                      {done ? (
                        <span style={s.attemptDone}>✔ Completed</span>
                      ) : (
                        <span style={s.attemptCount}>{attempts}/{item.maxAttempts} attempts</span>
                      )}
                      {/* Dot track */}
                      <div style={s.dotRow}>
                        {Array.from({ length: item.maxAttempts }).map((_, i) => (
                          <div
                            key={i}
                            style={{
                              ...s.dot,
                              background: done
                                ? "#16a34a"
                                : i < attempts
                                  ? "#4f46e5"
                                  : "#e5e7eb",
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          BOTTOM ROW — Attendance + Fees + Next Class
      ══════════════════════════════════════════════════════════════ */}
      <div style={s.bottomRow}>

        {/* Attendance */}
        <div style={s.smallCard}>
          <div style={s.smallCardTitle}>Attendance</div>
          <div style={s.attRow}>
            <div style={s.attStat}>
              <div style={{ ...s.attNum, color: "#16a34a" }}>{data.totalPresent}</div>
              <div style={s.attLabel}>Present</div>
            </div>
            <div style={s.attStat}>
              <div style={{ ...s.attNum, color: "#dc2626" }}>{data.totalAbsent}</div>
              <div style={s.attLabel}>Absent</div>
            </div>
            {attendancePct !== null && (
              <div style={s.attStat}>
                <div style={{ ...s.attNum, color: "#4f46e5" }}>{attendancePct}%</div>
                <div style={s.attLabel}>Rate</div>
              </div>
            )}
          </div>
          {attendancePct === null && (
            <div style={s.smallEmpty}>No attendance records yet.</div>
          )}
        </div>

        {/* Fees */}
        <div style={s.smallCard}>
          <div style={s.smallCardTitle}>Fees</div>
          {data.currentBalance === 0 ? (
            <div style={s.feesPaid}>✔ All fees paid</div>
          ) : data.currentBalance > 0 ? (
            <div>
              <div style={s.feesPending}>₹{data.currentBalance.toLocaleString()} pending</div>
              <div style={s.feesHint}>Please pay at the earliest.</div>
            </div>
          ) : (
            <div style={s.feesPaid}>₹{Math.abs(data.currentBalance).toLocaleString()} credit</div>
          )}
        </div>

        {/* Next class */}
        <div style={s.smallCard}>
          <div style={s.smallCardTitle}>Next Class</div>
          {data.nextClass ? (
            <div>
              <div style={s.nextClassDate}>{fmt(data.nextClass.date)}</div>
              <div style={s.nextClassTime}>
                {data.nextClass.startTime} – {data.nextClass.endTime}
              </div>
            </div>
          ) : (
            <div style={s.smallEmpty}>No upcoming class scheduled.</div>
          )}
        </div>

      </div>

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={s.sectionTitle}>{children}</div>;
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    concept:   { bg: "#dbeafe", color: "#1d4ed8" },
    exercise:  { bg: "#fef3c7", color: "#b45309" },
    songsheet: { bg: "#f3e8ff", color: "#7c3aed" },
  };
  const c = colors[type] ?? { bg: "#f3f4f6", color: "#374151" };
  return (
    <span style={{ ...s.typeBadge, background: c.bg, color: c.color }}>
      {capitalize(type)}
    </span>
  );
}

function LessonStatusIcon({ status }: { status: "completed" | "in_progress" | "locked" }) {
  if (status === "completed")  return <span style={{ ...s.statusIcon, color: "#16a34a" }}>✔</span>;
  if (status === "in_progress") return <span style={{ ...s.statusIcon, color: "#f59e0b" }}>🔄</span>;
  return <span style={{ ...s.statusIcon, color: "#9ca3af" }}>🔒</span>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {

  page: {
    maxWidth:  900,
    margin:    "0 auto",
    padding:   "0 0 40px",
  },

  center: {
    padding:   "60px 0",
    textAlign: "center",
    fontSize:  14,
    color:     "#6b7280",
  },

  errorMsg: {
    padding:      "16px 20px",
    background:   "#fef2f2",
    border:       "1px solid #fecaca",
    borderRadius: 10,
    color:        "#dc2626",
    fontSize:     14,
  },

  // ── Hero ──────────────────────────────────────────────────────────────────

  hero: {
    background:    "#fff",
    border:        "1px solid #e5e7eb",
    borderRadius:  12,
    padding:       "20px 24px",
    marginBottom:  24,
    display:       "flex",
    alignItems:    "center",
    justifyContent:"space-between",
    gap:           16,
    flexWrap:      "wrap" as const,
  },

  heroLeft: {
    display:    "flex",
    alignItems: "center",
    gap:        14,
  },

  avatar: {
    width:          46,
    height:         46,
    borderRadius:   "50%",
    background:     "#e0e7ff",
    color:          "#4f46e5",
    fontSize:       20,
    fontWeight:     700,
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    flexShrink:     0,
  } as React.CSSProperties,

  welcomeLabel: {
    fontSize:  12,
    color:     "#9ca3af",
    marginBottom: 2,
  },

  heroName: {
    fontSize:   20,
    fontWeight: 700,
    color:      "#111",
  },

  heroStats: {
    display:    "flex",
    alignItems: "center",
    gap:        20,
    flexWrap:   "wrap" as const,
  },

  heroStat: {
    textAlign: "center" as const,
    minWidth:  80,
  },

  heroStatValue: {
    fontSize:   22,
    fontWeight: 700,
    color:      "#111",
    lineHeight: 1.2,
  },

  heroStatLabel: {
    fontSize:  11,
    color:     "#9ca3af",
    marginTop: 2,
  },

  heroDivider: {
    width:      1,
    height:     36,
    background: "#e5e7eb",
    flexShrink: 0,
  },

  // ── Section title ────────────────────────────────────────────────────────

  sectionTitle: {
    fontSize:      12,
    fontWeight:    700,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    marginBottom:  10,
    marginTop:     28,
  },

  // ── Continue Learning ────────────────────────────────────────────────────

  continueLearningCard: {
    background:    "#fff",
    border:        "1px solid #e5e7eb",
    borderRadius:  12,
    padding:       "20px 24px",
    display:       "flex",
    alignItems:    "center",
    justifyContent:"space-between",
    gap:           16,
    flexWrap:      "wrap" as const,
  },

  continueLeft: {
    display:       "flex",
    flexDirection: "column" as const,
    gap:           6,
  },

  continueLesson: {
    fontSize:   13,
    fontWeight: 600,
    color:      "#6b7280",
  },

  continueActivity: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
  },

  continueActivityTitle: {
    fontSize:   16,
    fontWeight: 600,
    color:      "#111",
  },

  continueAttempts: {
    fontSize: 12,
    color:    "#6b7280",
  },

  continueBtn: {
    background:   "#4f46e5",
    color:        "#fff",
    border:       "none",
    borderRadius: 8,
    padding:      "12px 24px",
    fontSize:     14,
    fontWeight:   600,
    cursor:       "pointer",
    flexShrink:   0,
  },

  allDoneCard: {
    background:   "#f0fdf4",
    border:       "1px solid #bbf7d0",
    borderRadius: 12,
    padding:      "20px 24px",
    fontSize:     15,
    fontWeight:   600,
    color:        "#16a34a",
    textAlign:    "center" as const,
  },

  emptyCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "24px",
    fontSize:     13,
    color:        "#9ca3af",
    textAlign:    "center" as const,
  },

  // ── Lesson list ───────────────────────────────────────────────────────────

  lessonList: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    overflow:     "hidden",
  },

  lessonRow: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "14px 20px",
    borderBottom:   "1px solid #f3f4f6",
    gap:            12,
  },

  lessonLeft: {
    display:    "flex",
    alignItems: "center",
    gap:        12,
    flex:       1,
    minWidth:   0,
  },

  statusIcon: {
    fontSize:   16,
    flexShrink: 0,
  },

  lessonTitle: {
    fontSize:   13,
    fontWeight: 600,
    color:      "#111",
    whiteSpace: "nowrap" as const,
    overflow:   "hidden",
    textOverflow:"ellipsis",
  },

  lessonSub: {
    fontSize:  11,
    color:     "#9ca3af",
    marginTop: 1,
  },

  lessonRight: {
    display:    "flex",
    alignItems: "center",
    gap:        10,
    flexShrink: 0,
  },

  lessonPct: {
    fontSize:   12,
    fontWeight: 700,
    color:      "#4f46e5",
    minWidth:   32,
    textAlign:  "right" as const,
  },

  lessonBarTrack: {
    width:        100,
    height:       6,
    background:   "#e5e7eb",
    borderRadius: 99,
    overflow:     "hidden",
    flexShrink:   0,
  },

  lessonBarFill: {
    height:       "100%",
    borderRadius: 99,
    transition:   "width 0.3s ease",
  },

  // ── Attempts tracker ─────────────────────────────────────────────────────

  attemptsCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    overflow:     "hidden",
  },

  attemptRow: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "14px 20px",
    borderBottom:   "1px solid #f3f4f6",
    gap:            12,
    flexWrap:       "wrap" as const,
  },

  attemptLeft: {
    display:    "flex",
    alignItems: "center",
    gap:        10,
    flex:       1,
    minWidth:   0,
  },

  attemptTitle: {
    fontSize:  13,
    color:     "#111",
    fontWeight:500,
  },

  attemptRight: {
    display:    "flex",
    alignItems: "center",
    gap:        12,
    flexShrink: 0,
  },

  attemptDone: {
    fontSize:     12,
    fontWeight:   600,
    color:        "#16a34a",
    background:   "#dcfce7",
    borderRadius: 6,
    padding:      "2px 10px",
  },

  attemptCount: {
    fontSize:   12,
    color:      "#6b7280",
    fontWeight: 500,
    minWidth:   70,
    textAlign:  "right" as const,
  },

  dotRow: {
    display:    "flex",
    alignItems: "center",
    gap:        4,
  },

  dot: {
    width:        10,
    height:       10,
    borderRadius: "50%",
  },

  emptyMsg: {
    padding:  "20px",
    fontSize: 13,
    color:    "#9ca3af",
  },

  // ── Type badge ────────────────────────────────────────────────────────────

  typeBadge: {
    display:      "inline-block",
    padding:      "2px 10px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   600,
    flexShrink:   0,
  },

  // ── Bottom row ────────────────────────────────────────────────────────────

  bottomRow: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap:                 16,
    marginTop:           28,
  },

  smallCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "18px 20px",
  },

  smallCardTitle: {
    fontSize:      11,
    fontWeight:    700,
    color:         "#9ca3af",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    marginBottom:  14,
  },

  smallEmpty: {
    fontSize: 13,
    color:    "#9ca3af",
  },

  // Attendance
  attRow: {
    display:    "flex",
    gap:        20,
    alignItems: "flex-end",
  },

  attStat: {
    textAlign: "center" as const,
  },

  attNum: {
    fontSize:   24,
    fontWeight: 700,
    lineHeight: 1,
  },

  attLabel: {
    fontSize:  11,
    color:     "#9ca3af",
    marginTop: 4,
  },

  // Fees
  feesPaid: {
    fontSize:   16,
    fontWeight: 600,
    color:      "#16a34a",
  },

  feesPending: {
    fontSize:   18,
    fontWeight: 700,
    color:      "#dc2626",
    marginBottom: 4,
  },

  feesHint: {
    fontSize: 11,
    color:    "#9ca3af",
  },

  // Next class
  nextClassDate: {
    fontSize:   15,
    fontWeight: 600,
    color:      "#111",
    marginBottom: 4,
  },

  nextClassTime: {
    fontSize: 13,
    color:    "#6b7280",
  },
};
