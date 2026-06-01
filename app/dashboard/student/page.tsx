"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  getLessonsForStudent,
  getProgressByStudent,
  isItemUnlocked,
  calcOverallPercent,
} from "@/services/lesson/lesson.service";
import type { Lesson, LessonItem, StudentLessonProgress } from "@/types/lesson";
import type { AttendanceRecord } from "@/types/attendance";

export default function StudentDashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.STUDENT]}>
      <StudentDashboardContent />
    </ProtectedRoute>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardData {
  studentName:      string;
  lessons:          (Lesson & { items: LessonItem[] })[];
  progressMap:      Record<string, StudentLessonProgress>;
  overallPercent:   number;
  nextActivity:     NextActivity | null;
  totalPresent:     number;
  totalAbsent:      number;
  currentBalance:   number;
  nextClass:        NextClassInfo | null;
  completedItems:   number;
  totalItems:       number;
  completedLessons: number;
  earnedMilestones: number;
  totalMilestones:  number;
  recentMilestone:  { icon: string; label: string } | null;
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
  date: string; startTime: string; endTime: string;
}

// ─── Milestones ───────────────────────────────────────────────────────────────

function buildMilestones(
  overallPct:       number,
  completedItems:   number,
  completedLessons: number,
  totalLessons:     number,
  lessons:          (Lesson & { items: LessonItem[] })[],
  progressMap:      Record<string, StudentLessonProgress>,
  attPct:           number | null,
) {
  const allItems       = lessons.flatMap(l => l.items);
  const doneConcepts   = allItems.filter(i => i.type === "concept"   && progressMap[i.id]?.completed).length;
  const doneExercises  = allItems.filter(i => i.type === "exercise"  && progressMap[i.id]?.completed).length;
  const doneSongsheets = allItems.filter(i => i.type === "songsheet" && progressMap[i.id]?.completed).length;
  return [
    { icon: "🎵", label: "First Step",     earned: completedItems >= 1 },
    { icon: "📖", label: "First Lesson",    earned: completedLessons >= 1 },
    { icon: "🎸", label: "Halfway There",   earned: overallPct >= 50 },
    { icon: "⭐", label: "Concept Master",  earned: doneConcepts >= 5 },
    { icon: "🥁", label: "Exercise Streak", earned: doneExercises >= 5 },
    { icon: "🎼", label: "Songsheet Pro",   earned: doneSongsheets >= 3 },
    { icon: "🏆", label: "Gold Standard",   earned: overallPct >= 80 },
    { icon: "🎓", label: "Course Complete", earned: completedLessons >= totalLessons && totalLessons > 0 },
    { icon: "📅", label: "Consistent",      earned: attPct !== null && attPct >= 90 },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function levelLabel(pct: number): string {
  if (pct === 0)   return "Just Starting 🌱";
  if (pct < 25)    return "Beginner 🎵";
  if (pct < 50)    return "Explorer 🎸";
  if (pct < 75)    return "Performer 🎶";
  if (pct < 100)   return "Rockstar 🌟";
  return "Legend 🏆";
}

// ─── Ring chart (SVG) ─────────────────────────────────────────────────────────

function Ring({ pct, size, stroke, track, fill, label, sub }: {
  pct: number; size: number; stroke: number;
  track: string; fill: string; label: string; sub?: string;
}) {
  const r    = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ display: "block" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={fill} strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - Math.min(pct, 100) / 100)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
        />
      </svg>
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontSize: size > 80 ? 20 : 15, fontWeight: 800, color: fill, lineHeight: 1 }}>{label}</span>
        {sub && <span style={{ fontSize: 9, color: "#9ca3af", marginTop: 1 }}>{sub}</span>}
      </div>
    </div>
  );
}

// ─── Highlight card wrapper ───────────────────────────────────────────────────

function HCard({ emoji, title, bg, border, accent, children }: {
  emoji: string; title: string; bg: string; border: string; accent: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: bg, border: `1.5px solid ${border}`, borderRadius: 20, padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>{emoji}</span>
        <span style={{ fontSize: 11, fontWeight: 800, color: accent, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function StudentDashboardContent() {
  const { user }              = useAuthContext();
  const router                = useRouter();
  const [data, setData]       = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const studentId             = user?.uid ?? "";

  useEffect(() => {
    if (!studentId) return;
    load(studentId);
  }, [studentId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(uid: string) {
    try {
      setLoading(true); setError(null);

      const [{ lessons }, allProgress, userSnap, attSnap, classSnap] = await Promise.all([
        getLessonsForStudent(uid),
        getProgressByStudent(uid),
        getDoc(doc(db, "users", uid)),
        getDocs(query(collection(db, "attendance"), where("studentUid", "==", uid))),
        getDocs(query(collection(db, "classes"), where("status", "==", "scheduled"))),
      ]);

      const userData       = userSnap.exists() ? userSnap.data() : {};
      const studentName    = (userData.displayName as string) || "Student";
      const currentBalance = (userData.currentBalance as number) ?? 0;

      const progressMap: Record<string, StudentLessonProgress> = {};
      allProgress.forEach(p => { progressMap[p.itemId] = p; });

      const allItems        = lessons.flatMap(l => l.items);
      const overallPercent  = calcOverallPercent(allItems, progressMap);
      const completedItems  = allItems.filter(i => progressMap[i.id]?.completed).length;
      const totalItems      = allItems.length;
      const completedLessons = lessons.filter(l =>
        l.items.length > 0 && l.items.every(i => progressMap[i.id]?.completed)
      ).length;

      // Next unlocked activity
      let nextActivity: NextActivity | null = null;
      outer:
      for (const lesson of lessons) {
        for (const item of lesson.items) {
          const prog = progressMap[item.id];
          if (prog?.completed) continue;
          const unlocked = await isItemUnlocked(uid, lesson, item, lessons, lesson.items);
          if (unlocked) {
            nextActivity = {
              lessonTitle: lesson.title, itemTitle: item.title, itemType: item.type,
              lessonId: lesson.id, itemId: item.id,
              attempts: prog?.totalAttempts ?? 0, maxAttempts: item.maxAttempts,
            };
            break outer;
          }
        }
      }

      // Attendance — exclude break / cancelled
      const attRecs     = attSnap.docs.map(d => ({ id: d.id, ...d.data() }) as AttendanceRecord);
      const countable   = attRecs.filter(r => r.status === "present" || r.status === "absent");
      const totalPresent = countable.filter(r => r.status === "present").length;
      const totalAbsent  = countable.filter(r => r.status === "absent").length;
      const attPct       = countable.length > 0 ? Math.round((totalPresent / countable.length) * 100) : null;

      // Milestones
      const milestones      = buildMilestones(overallPercent, completedItems, completedLessons, lessons.length, lessons, progressMap, attPct);
      const earnedList      = milestones.filter(m => m.earned);
      const earnedMilestones = earnedList.length;
      const totalMilestones  = milestones.length;

      // Recent activity detection (within last 7 days) for celebration banner
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const hasRecentActivity = allProgress.some(p => {
        const raw = p as unknown as Record<string, unknown>;
        if (!raw.completed) return false;
        const ts = (raw.completedAt ?? raw.updatedAt) as string | undefined;
        return ts ? new Date(ts).getTime() > cutoff : false;
      });
      const recentMilestone = hasRecentActivity && earnedList.length > 0
        ? earnedList[earnedList.length - 1]!
        : null;

      // Next class for student's center
      const centerId = (userData.centerId as string) ?? null;
      const today    = new Date().toISOString().slice(0, 10);
      const cls = classSnap.docs
        .map(d => ({ id: d.id, ...d.data() }) as { id: string; centerId: string; date: string; startTime: string; endTime: string })
        .filter(c => centerId && c.centerId === centerId && c.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
      const nextClass = cls[0] ? { date: cls[0].date, startTime: cls[0].startTime, endTime: cls[0].endTime } : null;

      setData({
        studentName, lessons, progressMap, overallPercent, nextActivity,
        totalPresent, totalAbsent, currentBalance, nextClass,
        completedItems, totalItems, completedLessons,
        earnedMilestones, totalMilestones, recentMilestone,
      });
    } catch (err) {
      console.error("Student dashboard load error:", err);
      setError("Failed to load your dashboard. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return (
    <div style={{ padding: "80px 0", textAlign: "center", fontSize: 15, color: "#6b7280" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🎵</div>
      Loading your dashboard…
    </div>
  );
  if (error) return (
    <div style={{ padding: "16px", background: "#fef2f2", borderRadius: 12, color: "#dc2626", fontSize: 14 }}>{error}</div>
  );
  if (!data) return null;

  const attTotal = data.totalPresent + data.totalAbsent;
  const attPct   = attTotal > 0 ? Math.round((data.totalPresent / attTotal) * 100) : null;
  const bal      = data.currentBalance;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 0 48px" }}>

      {/* ══════════════════════════════════════════════════════════
          ACHIEVEMENT SPOTLIGHT — shown when new badge earned this week
      ══════════════════════════════════════════════════════════ */}
      {data.recentMilestone && (
        <div style={{
          background: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)",
          borderRadius: 22, padding: "22px 28px", marginBottom: 18,
          display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" as const,
        }}>
          <div style={{ fontSize: 52, lineHeight: 1, flexShrink: 0 }}>🎉</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.8)", letterSpacing: "0.12em", textTransform: "uppercase" as const, marginBottom: 4 }}>
              New Badge Earned This Week!
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#fff", marginBottom: 4 }}>
              {data.recentMilestone.icon} {data.recentMilestone.label}
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)" }}>
              You&apos;re on fire — keep it up! 🌟
            </div>
          </div>
          <div style={{ fontSize: 52, lineHeight: 1, flexShrink: 0 }}>⭐</div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          HERO — welcome banner
      ══════════════════════════════════════════════════════════ */}
      <div style={{
        background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
        borderRadius: 22, padding: "28px 32px", marginBottom: 18,
        display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" as const,
      }}>
        {/* Avatar */}
        <div style={{
          width: 72, height: 72, borderRadius: "50%",
          background: "rgba(255,255,255,0.2)", color: "#fff",
          fontSize: 30, fontWeight: 900,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, border: "3px solid rgba(255,255,255,0.35)",
        }}>
          {data.studentName.charAt(0).toUpperCase()}
        </div>

        {/* Name + level */}
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.65)", letterSpacing: "0.14em", textTransform: "uppercase" as const, marginBottom: 4 }}>
            Learner&apos;s Suite
          </div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", lineHeight: 1.15, marginBottom: 6 }}>
            Hi, {data.studentName.split(" ")[0]}! 👋
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.15)", display: "inline-block", padding: "3px 12px", borderRadius: 99 }}>
            {levelLabel(data.overallPercent)}
          </div>
        </div>

        {/* Overall progress ring */}
        <div style={{ textAlign: "center" as const, flexShrink: 0 }}>
          <Ring pct={data.overallPercent} size={96} stroke={9}
            track="rgba(255,255,255,0.2)" fill="#fff"
            label={`${data.overallPercent}%`} sub="overall" />
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", marginTop: 6, fontWeight: 600 }}>Your Journey</div>
        </div>

        {/* Badge count bubble */}
        <div style={{
          background: "rgba(255,255,255,0.15)", borderRadius: 18,
          padding: "16px 22px", textAlign: "center" as const, flexShrink: 0,
        }}>
          <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 4 }}>🏆</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", lineHeight: 1 }}>{data.earnedMilestones}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", marginTop: 3 }}>of {data.totalMilestones} badges</div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════
          HIGHLIGHT CARDS — 2×2 grid
      ══════════════════════════════════════════════════════════ */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 18 }}>

        {/* 📚 Learning */}
        <HCard emoji="📚" title="Learning" bg="#eef2ff" border="#c7d2fe" accent="#4f46e5">
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Ring pct={data.overallPercent} size={72} stroke={7} track="#c7d2fe" fill="#4f46e5" label={`${data.overallPercent}%`} />
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#4f46e5", lineHeight: 1 }}>{data.completedItems}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>of {data.totalItems} activities</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#7c3aed", lineHeight: 1 }}>{data.completedLessons}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>of {data.lessons.length} lessons</div>
            </div>
          </div>
          {/* Mini lesson progress bars */}
          {data.lessons.slice(0, 3).map(l => {
            const done = l.items.filter(i => data.progressMap[i.id]?.completed).length;
            const tot  = l.items.length;
            const pct  = tot > 0 ? Math.round((done / tot) * 100) : 0;
            return (
              <div key={l.id} style={{ marginTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: "80%" }}>{l.title}</span>
                  <span>{pct}%</span>
                </div>
                <div style={{ height: 5, background: "#c7d2fe", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: pct === 100 ? "#16a34a" : "#4f46e5", borderRadius: 99, width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </HCard>

        {/* 📅 Attendance */}
        <HCard emoji="📅" title="Attendance" bg="#f0fdf4" border="#86efac" accent="#16a34a">
          {attPct !== null ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <Ring pct={attPct} size={72} stroke={7} track="#bbf7d0" fill={attPct >= 75 ? "#16a34a" : "#f59e0b"} label={`${attPct}%`} />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#16a34a" }}>{data.totalPresent}</span>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>present</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#dc2626", display: "inline-block" }} />
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#dc2626" }}>{data.totalAbsent}</span>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>absent</span>
                  </div>
                </div>
              </div>
              {/* Stacked bar */}
              <div style={{ marginTop: 12 }}>
                <div style={{ height: 8, background: "#fecaca", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#16a34a", borderRadius: 99, width: `${attPct}%` }} />
                </div>
                <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{attTotal} classes recorded</div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "#9ca3af", textAlign: "center" as const, padding: "12px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 6 }}>📋</div>
              No records yet
            </div>
          )}
        </HCard>

        {/* ₹ Fees */}
        <HCard
          emoji="₹" title="Fees"
          bg={bal > 0 ? "#fef2f2" : "#f0fdf4"}
          border={bal > 0 ? "#fecaca" : "#86efac"}
          accent={bal > 0 ? "#dc2626" : "#16a34a"}
        >
          <div style={{ textAlign: "center" as const, padding: "8px 0" }}>
            {bal === 0 ? (
              <>
                <div style={{ fontSize: 44, marginBottom: 6 }}>✅</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#16a34a" }}>All Clear!</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>No fees due 🎉</div>
              </>
            ) : bal > 0 ? (
              <>
                <div style={{ fontSize: 44, marginBottom: 6 }}>⚠️</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#dc2626" }}>₹{bal.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 600 }}>pending</div>
                <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>Please pay at the earliest</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 44, marginBottom: 6 }}>🎁</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#16a34a" }}>₹{Math.abs(bal).toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "#16a34a", fontWeight: 600 }}>credit on account</div>
              </>
            )}
          </div>
        </HCard>

        {/* 🏆 Achievements */}
        <HCard emoji="🏆" title="Achievements" bg="#fffbeb" border="#fde68a" accent="#b45309">
          <div style={{ textAlign: "center" as const }}>
            <div style={{ fontSize: 32, fontWeight: 900, color: "#b45309", lineHeight: 1 }}>
              {data.earnedMilestones}
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>
              of {data.totalMilestones} badges earned
            </div>
            {/* Badge progress bar */}
            <div style={{ height: 8, background: "#fde68a", borderRadius: 99, overflow: "hidden", marginBottom: 12 }}>
              <div style={{
                height: "100%", borderRadius: 99,
                background: "linear-gradient(90deg, #f59e0b, #ef4444)",
                width: `${Math.round((data.earnedMilestones / data.totalMilestones) * 100)}%`,
              }} />
            </div>
            {/* Earned badge emojis */}
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, justifyContent: "center" }}>
              {buildMilestones(data.overallPercent, data.completedItems, data.completedLessons, data.lessons.length, data.lessons, data.progressMap, attPct)
                .map((m, i) => (
                  <span key={i} style={{ fontSize: 20, opacity: m.earned ? 1 : 0.2 }} title={m.label}>
                    {m.icon}
                  </span>
                ))}
            </div>
          </div>
        </HCard>

      </div>

      {/* ══════════════════════════════════════════════════════════
          CONTINUE LEARNING — CTA
      ══════════════════════════════════════════════════════════ */}
      {data.nextActivity ? (
        <div style={{
          background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
          borderRadius: 22, padding: "22px 28px", marginBottom: 18,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 16, flexWrap: "wrap" as const,
        }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.75)", letterSpacing: "0.12em", textTransform: "uppercase" as const, marginBottom: 6 }}>
              Up Next 🚀
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginBottom: 4 }}>
              {data.nextActivity.lessonTitle}
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#fff", marginBottom: 6 }}>
              {data.nextActivity.itemTitle}
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(255,255,255,0.2)", color: "#fff", borderRadius: 99, padding: "3px 12px" }}>
              {capitalize(data.nextActivity.itemType)}
            </span>
            {data.nextActivity.maxAttempts > 0 && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", marginLeft: 10 }}>
                Attempt {data.nextActivity.attempts + 1} of {data.nextActivity.maxAttempts}
              </span>
            )}
          </div>
          <button
            onClick={() => router.push(`/dashboard/student-syllabus/${studentId}`)}
            style={{
              background: "#fff", color: "#059669", border: "none", borderRadius: 14,
              padding: "14px 30px", fontSize: 15, fontWeight: 900,
              cursor: "pointer", flexShrink: 0, boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            Let&apos;s Go! 🎮
          </button>
        </div>
      ) : (
        <div style={{
          background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
          borderRadius: 22, padding: "28px", marginBottom: 18, textAlign: "center" as const,
        }}>
          <div style={{ fontSize: 52, marginBottom: 8 }}>🎓</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", marginBottom: 4 }}>All Lessons Complete!</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)" }}>Amazing work — you&apos;ve mastered everything! 🎉</div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          NEXT CLASS
      ══════════════════════════════════════════════════════════ */}
      {data.nextClass && (
        <div style={{
          background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 18,
          padding: "18px 24px", display: "flex", alignItems: "center", gap: 18,
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, background: "#eef2ff",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, flexShrink: 0,
          }}>📆</div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 4 }}>Next Class</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#111" }}>{fmtDate(data.nextClass.date)}</div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>{data.nextClass.startTime} – {data.nextClass.endTime}</div>
          </div>
        </div>
      )}

    </div>
  );
}
