"use client";

import { useState, useEffect } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  getLessonsForStudent,
  getProgressByStudent,
  calcLessonPercent,
} from "@/services/lesson/lesson.service";
import type { Lesson, LessonItem, StudentLessonProgress } from "@/types/lesson";
import type { AttendanceRecord } from "@/types/attendance";

export default function MyAchievementsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.STUDENT]}>
      <MyAchievementsContent />
    </ProtectedRoute>
  );
}

interface LessonWithItems extends Lesson { items: LessonItem[] }

function MyAchievementsContent() {
  const { user }                       = useAuthContext();
  const [lessons, setLessons]          = useState<LessonWithItems[]>([]);
  const [progressMap, setProgressMap]  = useState<Record<string, StudentLessonProgress>>({});
  const [totalPresent, setPresent]     = useState(0);
  const [totalAbsent, setAbsent]       = useState(0);
  const [studentName, setStudentName]  = useState("");
  const [loading, setLoading]          = useState(true);
  const [error, setError]              = useState<string | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    load(user.uid);
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(uid: string) {
    setLoading(true);
    setError(null);
    try {
      const [{ lessons: ls }, allProgress, userSnap, attSnap] = await Promise.all([
        getLessonsForStudent(uid),
        getProgressByStudent(uid),
        getDoc(doc(db, "users", uid)),
        getDocs(query(collection(db, "attendance"), where("studentUid", "==", uid))),
      ]);

      setLessons(ls);

      const pMap: Record<string, StudentLessonProgress> = {};
      allProgress.forEach(p => { pMap[p.itemId] = p; });
      setProgressMap(pMap);

      if (userSnap.exists()) {
        setStudentName((userSnap.data().displayName as string) ?? "Student");
      }

      const recs = attSnap.docs.map(d => ({ ...d.data() }) as AttendanceRecord);
      setPresent(recs.filter(r => r.status === "present").length);
      setAbsent(recs.filter(r => r.status === "absent").length);
    } catch {
      setError("Failed to load achievements. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={s.state}>Loading achievements…</div>;
  if (error)   return <div style={{ ...s.state, color: "#dc2626" }}>{error}</div>;

  const allItems       = lessons.flatMap(l => l.items);
  const completedItems = allItems.filter(i => progressMap[i.id]?.completed).length;
  const totalItems     = allItems.length;
  const overallPct     = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  const completedLessons = lessons.filter(l =>
    l.items.length > 0 && l.items.every(i => progressMap[i.id]?.completed)
  ).length;

  const totalConcepts   = allItems.filter(i => i.type === "concept").length;
  const totalExercises  = allItems.filter(i => i.type === "exercise").length;
  const totalSongsheets = allItems.filter(i => i.type === "songsheet").length;

  const doneConcepts    = allItems.filter(i => i.type === "concept"   && progressMap[i.id]?.completed).length;
  const doneExercises   = allItems.filter(i => i.type === "exercise"  && progressMap[i.id]?.completed).length;
  const doneSongsheets  = allItems.filter(i => i.type === "songsheet" && progressMap[i.id]?.completed).length;

  const attTotal = totalPresent + totalAbsent;
  const attPct   = attTotal > 0 ? Math.round((totalPresent / attTotal) * 100) : null;

  // Milestones
  const milestones: { icon: string; label: string; sub: string; earned: boolean }[] = [
    { icon: "🎵", label: "First Step",       sub: "Complete your first activity",       earned: completedItems >= 1 },
    { icon: "📖", label: "First Lesson",      sub: "Complete an entire lesson",          earned: completedLessons >= 1 },
    { icon: "🎸", label: "Halfway There",     sub: "Reach 50% overall progress",         earned: overallPct >= 50 },
    { icon: "⭐", label: "Concept Master",    sub: "Complete 5 concepts",                earned: doneConcepts >= 5 },
    { icon: "🥁", label: "Exercise Streak",   sub: "Complete 5 exercises",               earned: doneExercises >= 5 },
    { icon: "🎼", label: "Songsheet Pro",     sub: "Complete 3 songsheets",              earned: doneSongsheets >= 3 },
    { icon: "🏆", label: "Gold Standard",     sub: "Reach 80% overall progress",         earned: overallPct >= 80 },
    { icon: "🎓", label: "Course Complete",   sub: "Complete all lessons",               earned: completedLessons >= lessons.length && lessons.length > 0 },
    { icon: "📅", label: "Consistent",        sub: "90%+ attendance",                    earned: attPct !== null && attPct >= 90 },
  ];

  const earned = milestones.filter(m => m.earned).length;

  return (
    <div style={s.page}>

      {/* Hero banner */}
      <div style={s.hero}>
        <div style={s.heroAvatar}>{studentName.charAt(0).toUpperCase()}</div>
        <div style={s.heroInfo}>
          <div style={s.heroName}>{studentName}</div>
          <div style={s.heroSub}>{earned} of {milestones.length} milestones earned</div>
          <div style={s.milestoneBar}>
            <div style={{ ...s.milestoneBarFill, width: `${Math.round((earned / milestones.length) * 100)}%` }} />
          </div>
        </div>
        <div style={s.heroTrophy}>🏆</div>
      </div>

      {/* Stats grid */}
      <div style={s.statsGrid}>
        <StatCard label="Overall Progress" value={`${overallPct}%`} color="#4f46e5" sub={`${completedItems}/${totalItems} items`} />
        <StatCard label="Lessons Completed" value={String(completedLessons)} color="#16a34a" sub={`of ${lessons.length} total`} />
        <StatCard label="Attendance Rate" value={attPct !== null ? `${attPct}%` : "—"} color="#f59e0b" sub={attTotal > 0 ? `${totalPresent} present, ${totalAbsent} absent` : "No records yet"} />
        <StatCard label="Activities Done" value={String(completedItems)} color="#7c3aed" sub={`${totalItems - completedItems} remaining`} />
      </div>

      {/* Type breakdown */}
      <div style={s.sectionTitle}>Activity Breakdown</div>
      <div style={s.breakdown}>
        <TypeBar icon="💡" label="Concepts"   done={doneConcepts}   total={totalConcepts}   color="#1d4ed8" bg="#dbeafe" />
        <TypeBar icon="🏋️" label="Exercises"  done={doneExercises}  total={totalExercises}  color="#b45309" bg="#fef3c7" />
        <TypeBar icon="🎼" label="Songsheets" done={doneSongsheets} total={totalSongsheets} color="#7c3aed" bg="#f3e8ff" />
      </div>

      {/* Lessons progress */}
      {lessons.length > 0 && (
        <>
          <div style={s.sectionTitle}>Lesson Progress</div>
          <div style={s.lessonList}>
            {lessons.map(lesson => {
              const pct     = calcLessonPercent(lesson.items, progressMap);
              const allDone = lesson.items.length > 0 && lesson.items.every(i => progressMap[i.id]?.completed);
              return (
                <div key={lesson.id} style={s.lessonRow}>
                  <span style={s.lessonIcon}>{allDone ? "✅" : pct > 0 ? "🔄" : "🔒"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.lessonName}>{lesson.title}</div>
                    <div style={s.lessonTrack}>
                      <div style={{ ...s.lessonFill, width: `${pct}%`, background: allDone ? "#16a34a" : pct > 0 ? "#f59e0b" : "#d1d5db" }} />
                    </div>
                  </div>
                  <div style={{ ...s.lessonPct, color: allDone ? "#16a34a" : "#4f46e5" }}>{pct}%</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Milestones */}
      <div style={s.sectionTitle}>Milestones</div>
      <div style={s.milestoneGrid}>
        {milestones.map(m => (
          <div key={m.label} style={{ ...s.milestoneCard, opacity: m.earned ? 1 : 0.45, border: m.earned ? "1.5px solid #a5f3fc" : "1px solid #e5e7eb", background: m.earned ? "#f0fdff" : "#f9fafb" }}>
            <div style={s.milestoneIconWrap}>
              <span style={s.milestoneIcon}>{m.icon}</span>
              {m.earned && <span style={s.earnedBadge}>✓</span>}
            </div>
            <div style={s.milestoneLabel}>{m.label}</div>
            <div style={s.milestoneSub}>{m.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: string; color: string; sub: string }) {
  return (
    <div style={s.statCard}>
      <div style={s.statLabel}>{label}</div>
      <div style={{ ...s.statValue, color }}>{value}</div>
      <div style={s.statSub}>{sub}</div>
    </div>
  );
}

function TypeBar({ icon, label, done, total, color, bg }: { icon: string; label: string; done: number; total: number; color: string; bg: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={s.typeBar}>
      <div style={s.typeBarLeft}>
        <span style={{ ...s.typeBadge, background: bg, color }}>{icon} {label}</span>
        <span style={s.typeCount}>{done}/{total}</span>
      </div>
      <div style={s.typeTrack}>
        <div style={{ ...s.typeFill, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 820, margin: "0 auto", padding: "0 0 40px" },
  state:   { padding: "60px 0", textAlign: "center", fontSize: 14, color: "#6b7280" },
  heading: { fontSize: 24, fontWeight: 700, color: "#111111", marginBottom: 24 },

  hero: {
    background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
    borderRadius: 14, padding: "24px 28px", marginBottom: 24,
    display: "flex", alignItems: "center", gap: 18,
  },
  heroAvatar: {
    width: 52, height: 52, borderRadius: "50%",
    background: "rgba(255,255,255,0.25)", color: "#fff",
    fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  } as React.CSSProperties,
  heroInfo:   { flex: 1 },
  heroName:   { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 4 },
  heroSub:    { fontSize: 12, color: "rgba(255,255,255,0.75)", marginBottom: 8 },
  milestoneBar: { height: 5, background: "rgba(255,255,255,0.25)", borderRadius: 99, overflow: "hidden" },
  milestoneBarFill: { height: "100%", background: "#fff", borderRadius: 99, transition: "width 0.4s ease" },
  heroTrophy: { fontSize: 36, flexShrink: 0 },

  statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginBottom: 28 },
  statCard:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px" },
  statLabel: { fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 },
  statValue: { fontSize: 28, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 },
  statSub:   { fontSize: 11, color: "#9ca3af" },

  sectionTitle: {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 12, marginTop: 28,
  },

  breakdown: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 22px", display: "flex", flexDirection: "column" as const, gap: 14 },
  typeBar:     { display: "flex", alignItems: "center", gap: 14 },
  typeBarLeft: { display: "flex", alignItems: "center", gap: 10, width: 180, flexShrink: 0 },
  typeBadge:   { fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 99 },
  typeCount:   { fontSize: 12, color: "#6b7280", fontWeight: 600 },
  typeTrack:   { flex: 1, height: 7, background: "#f3f4f6", borderRadius: 99, overflow: "hidden" },
  typeFill:    { height: "100%", borderRadius: 99, transition: "width 0.4s ease" },

  lessonList: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" },
  lessonRow: { display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: "1px solid #f3f4f6" },
  lessonIcon: { fontSize: 16, flexShrink: 0 },
  lessonName: { fontSize: 13, fontWeight: 600, color: "#111111", marginBottom: 6 },
  lessonTrack:{ height: 5, background: "#f3f4f6", borderRadius: 99, overflow: "hidden" },
  lessonFill: { height: "100%", borderRadius: 99, transition: "width 0.4s ease" },
  lessonPct:  { fontSize: 13, fontWeight: 700, minWidth: 36, textAlign: "right" as const, flexShrink: 0 },

  milestoneGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 },
  milestoneCard: { borderRadius: 12, padding: "16px 14px", textAlign: "center" as const, transition: "opacity 0.2s" },
  milestoneIconWrap: { position: "relative" as const, display: "inline-block", marginBottom: 8 },
  milestoneIcon: { fontSize: 28 },
  earnedBadge: {
    position: "absolute" as const, top: -4, right: -10,
    background: "#16a34a", color: "#fff", borderRadius: "50%",
    fontSize: 9, fontWeight: 700, width: 16, height: 16,
    display: "flex", alignItems: "center", justifyContent: "center",
  } as React.CSSProperties,
  milestoneLabel: { fontSize: 12, fontWeight: 700, color: "#111111", marginBottom: 4 },
  milestoneSub:   { fontSize: 10, color: "#9ca3af", lineHeight: 1.4 },
};
