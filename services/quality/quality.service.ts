/**
 * Teacher Quality Score Engine
 *
 * updateTeacherQualityScores() — call daily
 * updateLeaderboards()         — call daily (after scores are updated)
 *
 * Both functions are idempotent — safe to call multiple times per day.
 * Missing data defaults to NEUTRAL_SCORE (50), never zero, per spec.
 *
 * Factor weights: equal thirds (33.33% each).
 */

import {
  collection,
  doc,
  setDoc,
  getDocs,
  getDocFromServer,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type {
  TeacherQuality,
  QualityFactors,
  RankEntry,
  Leaderboard,
  TeacherScoreInput,
} from "@/types/quality";
import type { Class } from "@/types/attendance";

// ─── Collection names ─────────────────────────────────────────────────────────

const TEACHER_QUALITY = "teacher_quality";
const LEADERBOARDS    = "leaderboards";
const CLASSES         = "classes";
const ATTENDANCE      = "attendance";
const USERS           = "users";
const STUDENT_PROG    = "student_lesson_progress";

// ─── Constants ────────────────────────────────────────────────────────────────

const NEUTRAL_SCORE       = 50;   // default when data is missing
const LATE_THRESHOLD_MINS = 15;   // clock-in minutes after class start = late
const STAGNATION_DAYS     = 14;   // no lesson progress = stagnation penalty
const SCORE_WEIGHTS       = { attendanceDiscipline: 1/3, syllabusProgress: 1/3, studentRetention: 1/3 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

function weightedAverage(factors: QualityFactors): number {
  return clamp(
    factors.attendanceDiscipline * SCORE_WEIGHTS.attendanceDiscipline +
    factors.syllabusProgress     * SCORE_WEIGHTS.syllabusProgress     +
    factors.studentRetention     * SCORE_WEIGHTS.studentRetention
  );
}

/** ISO date string YYYY-MM-DD for the current month window start (first of month). */
function thisMonthStart(): string {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/** ISO date string 30 days ago */
function thirtyDaysAgo(): string {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ─── Factor A: Attendance Discipline ─────────────────────────────────────────

/**
 * Score based on teacher clock-in behaviour across all their classes.
 * - On-time clock-in  → full points
 * - Late clock-in     → partial points
 * - No clock-in (ghost or missed) → penalty
 * Returns NEUTRAL_SCORE when no class data is available.
 */
async function computeAttendanceDiscipline(
  teacherUid: string,
  centerIds:  string[],
): Promise<number> {
  if (centerIds.length === 0) return NEUTRAL_SCORE;

  try {
    const cutoff = thirtyDaysAgo();
    let onTime = 0, late = 0, missed = 0;

    for (const centerId of centerIds) {
      const snap = await getDocs(
        query(
          collection(db, CLASSES),
          where("centerId",   "==", centerId),
          where("teacherUid", "==", teacherUid),
        )
      );

      for (const classDoc of snap.docs) {
        const cls = classDoc.data() as Class;
        if (cls.date < cutoff) continue;  // only last 30 days

        if (!cls.teacherClockIn) {
          // No clock-in at all
          if (cls.status === "ghost") missed += 2;  // ghost = heavier penalty
          else missed++;
          continue;
        }

        // Compare clock-in time against scheduled start
        const scheduled = new Date(`${cls.date}T${cls.startTime}:00`).getTime();
        const actual    = new Date(cls.teacherClockIn).getTime();
        const diffMins  = (actual - scheduled) / 60000;

        if (diffMins <= LATE_THRESHOLD_MINS) onTime++;
        else                                 late++;
      }
    }

    const total = onTime + late + missed;
    if (total === 0) return NEUTRAL_SCORE;

    // Score: on-time = 100pts, late = 60pts, missed = 0pts
    const rawScore = ((onTime * 100) + (late * 60)) / total;
    return clamp(rawScore);
  } catch (err) {
    console.error("computeAttendanceDiscipline error:", err);
    return NEUTRAL_SCORE;
  }
}

// ─── Factor B: Syllabus Progress ──────────────────────────────────────────────

/**
 * Measures how consistently students assigned to this teacher are progressing
 * through lessons within the last 30 days.
 *
 * - For each student in teacher's centers: check if any lesson progress was
 *   updated within the last STAGNATION_DAYS.
 * - Progress rate = (students with recent progress) / (total students)
 * - Penalise if stagnation rate > 50%
 * Returns NEUTRAL_SCORE when no students are assigned.
 */
async function computeSyllabusProgress(
  centerIds: string[],
): Promise<number> {
  if (centerIds.length === 0) return NEUTRAL_SCORE;

  try {
    const cutoffDate = new Date(Date.now() - STAGNATION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Get all students in teacher's centers
    const studentUids: string[] = [];
    for (const centerId of centerIds) {
      const snap = await getDocs(
        query(
          collection(db, USERS),
          where("role",     "==", "student"),
          where("centerId", "==", centerId),
        )
      );
      snap.docs.forEach(d => studentUids.push(d.id));
    }

    if (studentUids.length === 0) return NEUTRAL_SCORE;

    // For each student: check if any progress record was updated recently
    let activeCount = 0;
    for (const studentUid of studentUids) {
      const progSnap = await getDocs(
        query(
          collection(db, STUDENT_PROG),
          where("studentId", "==", studentUid),
          orderBy("updatedAt", "desc"),
        )
      );
      if (progSnap.empty) continue;

      // Check if most recent progress is within window
      const latestData = progSnap.docs[0].data();
      let latestIso: string;
      try {
        // updatedAt may be Timestamp or ISO string
        const raw = latestData.updatedAt;
        latestIso = raw?.toDate ? raw.toDate().toISOString().slice(0, 10) : String(raw).slice(0, 10);
      } catch {
        continue;
      }
      if (latestIso >= cutoffDate) activeCount++;
    }

    const progressRate = activeCount / studentUids.length;
    // Scale: 100% active = 100, 0% active = 20 (floor, not zero — data may be new)
    return clamp(20 + progressRate * 80);
  } catch (err) {
    console.error("computeSyllabusProgress error:", err);
    return NEUTRAL_SCORE;
  }
}

// ─── Factor C: Student Retention ─────────────────────────────────────────────

/**
 * Measures what fraction of students assigned to teacher's centers are still
 * active (status = "active").
 * Returns NEUTRAL_SCORE when no students are found.
 */
async function computeStudentRetention(centerIds: string[]): Promise<number> {
  if (centerIds.length === 0) return NEUTRAL_SCORE;

  try {
    let total = 0, active = 0;

    for (const centerId of centerIds) {
      const snap = await getDocs(
        query(
          collection(db, USERS),
          where("role",     "==", "student"),
          where("centerId", "==", centerId),
        )
      );
      for (const d of snap.docs) {
        total++;
        const status = d.data().status ?? d.data().studentStatus ?? "active";
        if (status === "active") active++;
      }
    }

    if (total === 0) return NEUTRAL_SCORE;

    const retentionRate = active / total;
    // Scale: 100% retained = 100, 0% = 10 (floor)
    return clamp(10 + retentionRate * 90);
  } catch (err) {
    console.error("computeStudentRetention error:", err);
    return NEUTRAL_SCORE;
  }
}

// ─── Main: Update all teacher quality scores ──────────────────────────────────

/**
 * Recomputes quality scores for every teacher and writes to teacher_quality.
 * Idempotent — overwrites the doc on each run (setDoc with merge: false).
 * Runs daily.
 */
export async function updateTeacherQualityScores(): Promise<number> {
  let updated = 0;
  try {
    const teachersSnap = await getDocs(
      query(collection(db, USERS), where("role", "==", "teacher"))
    );

    for (const teacherDoc of teachersSnap.docs) {
      const data      = teacherDoc.data();
      const teacherId = teacherDoc.id;
      const centerIds: string[] = data.centerIds ?? [];

      const [attendanceDiscipline, syllabusProgress, studentRetention] = await Promise.all([
        computeAttendanceDiscipline(teacherId, centerIds),
        computeSyllabusProgress(centerIds),
        computeStudentRetention(centerIds),
      ]);

      const factors: QualityFactors = { attendanceDiscipline, syllabusProgress, studentRetention };
      const score = weightedAverage(factors);

      await setDoc(doc(db, TEACHER_QUALITY, teacherId), {
        teacherId,
        score,
        factors,
        lastUpdated: serverTimestamp(),
      });

      updated++;
    }

    logAction({
      action:        "QUALITY_SCORES_UPDATED",
      initiatorId:   "system",
      initiatorRole: "admin",
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { updatedCount: updated },
    });
  } catch (err) {
    console.error("updateTeacherQualityScores error:", err);
  }
  return updated;
}

// ─── Leaderboard update ───────────────────────────────────────────────────────

/**
 * Ranks teachers within each center by score.
 * Writes one leaderboard doc per center containing monthlyRankings + lifetimeRankings.
 *
 * Monthly = teachers whose quality was updated this month.
 * Lifetime = all teachers ranked by current score.
 *
 * Runs daily after updateTeacherQualityScores().
 */
export async function updateLeaderboards(): Promise<void> {
  try {
    const monthStart = thisMonthStart();

    // Fetch all quality scores
    const qualitySnap = await getDocs(collection(db, TEACHER_QUALITY));
    const allScores   = qualitySnap.docs.map(d => ({ id: d.id, ...d.data() }) as TeacherQuality);

    // Build teacherId → displayName map
    const teachersSnap = await getDocs(
      query(collection(db, USERS), where("role", "==", "teacher"))
    );
    const nameMap: Record<string, string>      = {};
    const centerMap: Record<string, string[]>  = {};  // teacherId → centerIds
    for (const t of teachersSnap.docs) {
      nameMap[t.id]   = t.data().displayName ?? t.data().name ?? t.id;
      centerMap[t.id] = t.data().centerIds ?? [];
    }

    // Collect all centerIds across all teachers
    const allCenterIds = new Set<string>();
    for (const ids of Object.values(centerMap)) ids.forEach(id => allCenterIds.add(id));

    for (const centerId of allCenterIds) {
      // Teachers who have this center
      const teachersInCenter = Object.entries(centerMap)
        .filter(([, ids]) => ids.includes(centerId))
        .map(([tid]) => tid);

      if (teachersInCenter.length === 0) continue;

      // Lifetime rankings — all teachers in center sorted by current score
      const lifetimeEntries: RankEntry[] = teachersInCenter
        .map(tid => {
          const q = allScores.find(s => s.teacherId === tid);
          return {
            teacherId:   tid,
            displayName: nameMap[tid] ?? tid,
            score:       q?.score ?? NEUTRAL_SCORE,
            rank:        0,
          };
        })
        .sort((a, b) => b.score - a.score)
        .map((e, i) => ({ ...e, rank: i + 1 }));

      // Monthly rankings — teachers updated this month
      const monthlyEntries: RankEntry[] = teachersInCenter
        .map(tid => {
          const q = allScores.find(s => s.teacherId === tid);
          // Only include if quality was updated this month
          let updatedAt = "";
          try {
            const raw = q?.lastUpdated;
            updatedAt = raw
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? (raw as any).toDate
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ? (raw as any).toDate().toISOString().slice(0, 10)
                : String(raw).slice(0, 10)
              : "";
          } catch { /* empty */ }
          if (!updatedAt || updatedAt < monthStart) return null;
          return {
            teacherId:   tid,
            displayName: nameMap[tid] ?? tid,
            score:       q?.score ?? NEUTRAL_SCORE,
            rank:        0,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => b.score - a.score)
        .map((e, i) => ({ ...e, rank: i + 1 }));

      await setDoc(doc(db, LEADERBOARDS, centerId), {
        centerId,
        monthlyRankings:  monthlyEntries,
        lifetimeRankings: lifetimeEntries,
        lastUpdated:      serverTimestamp(),
      });
    }

    logAction({
      action:        "LEADERBOARDS_UPDATED",
      initiatorId:   "system",
      initiatorRole: "admin",
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { centerCount: allCenterIds.size },
    });
  } catch (err) {
    console.error("updateLeaderboards error:", err);
  }
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export async function getTeacherQuality(
  teacherId: string,
): Promise<TeacherQuality | null> {
  try {
    const snap = await getDocFromServer(doc(db, TEACHER_QUALITY, teacherId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as TeacherQuality;
  } catch (err) {
    console.error("getTeacherQuality error:", err);
    return null;
  }
}

export async function getLeaderboardByCenter(
  centerId: string,
): Promise<Leaderboard | null> {
  try {
    const snap = await getDocFromServer(doc(db, LEADERBOARDS, centerId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as Leaderboard;
  } catch (err) {
    console.error("getLeaderboardByCenter error:", err);
    return null;
  }
}

export async function getAllLeaderboards(): Promise<Leaderboard[]> {
  try {
    const snap = await getDocs(collection(db, LEADERBOARDS));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Leaderboard);
  } catch (err) {
    console.error("getAllLeaderboards error:", err);
    return [];
  }
}

/** Get all quality scores, sorted by score descending. */
export async function getAllTeacherQuality(): Promise<TeacherQuality[]> {
  try {
    const snap = await getDocs(collection(db, TEACHER_QUALITY));
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }) as TeacherQuality)
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    console.error("getAllTeacherQuality error:", err);
    return [];
  }
}
