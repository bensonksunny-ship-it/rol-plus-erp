"use client";

import { useState, useEffect } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getTeacherQuality,
  getAllLeaderboards,
} from "@/services/quality/quality.service";
import type { TeacherQuality, Leaderboard } from "@/types/quality";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TeacherScorePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <TeacherScoreContent />
    </ProtectedRoute>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

interface CenterRank {
  centerId:  string;
  rank:      number;
  total:     number;
  period:    "lifetime" | "monthly";
}

function TeacherScoreContent() {
  const { user }                        = useAuth();
  const [quality, setQuality]           = useState<TeacherQuality | null>(null);
  const [ranks, setRanks]               = useState<CenterRank[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [q, boards] = await Promise.all([
          getTeacherQuality(user!.uid),
          getAllLeaderboards(),
        ]);

        setQuality(q);

        // Compute this teacher's rank in each center they appear in
        const computed: CenterRank[] = [];
        for (const board of boards as Leaderboard[]) {
          const ltEntry = board.lifetimeRankings.find(e => e.teacherId === user!.uid);
          if (ltEntry) {
            computed.push({
              centerId: board.centerId,
              rank:     ltEntry.rank,
              total:    board.lifetimeRankings.length,
              period:   "lifetime",
            });
          }
        }
        setRanks(computed);
      } catch {
        setError("Failed to load your quality score.");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [user]);

  if (loading) return <div style={s.state}>Loading your score…</div>;
  if (error)   return <div style={{ ...s.state, color: "#dc2626" }}>{error}</div>;
  if (!quality) {
    return (
      <div style={s.noData}>
        <div style={s.noDataIcon}>📊</div>
        <div style={s.noDataTitle}>No score yet</div>
        <div style={s.noDataSub}>
          Your quality score hasn't been calculated yet. Ask an admin to run the score update.
        </div>
      </div>
    );
  }

  const { score, factors } = quality;
  const lastUpdatedStr = (() => {
    try {
      const raw = quality.lastUpdated;
      const d = (raw as { toDate?: () => Date }).toDate?.()
        ?? new Date(String(raw));
      return d.toLocaleDateString("en-IN", { dateStyle: "medium" });
    } catch { return "—"; }
  })();

  return (
    <div>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>My Quality Score</h1>
          <div style={s.subheading}>Last updated: {lastUpdatedStr}</div>
        </div>
      </div>

      {/* Score card */}
      <div style={s.scoreCard}>
        <ScoreGauge score={score} />
        <div style={s.scoreRight}>
          <div style={s.scoreBig}>{score}</div>
          <div style={s.scoreLabel}>Overall Score</div>
          <div style={s.scoreTier}>
            <span style={{ ...s.tierBadge, background: tierColor(score).bg, color: tierColor(score).fg }}>
              {tierLabel(score)}
            </span>
          </div>
        </div>
      </div>

      {/* Factor breakdown */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Score Breakdown</div>
        <div style={s.factorList}>
          <FactorRow
            label="Attendance Discipline"
            score={factors.attendanceDiscipline}
            description="Punctuality and consistency of teacher clock-ins over the last 30 days."
          />
          <FactorRow
            label="Syllabus Progress"
            score={factors.syllabusProgress}
            description="Proportion of students with recent lesson progress in the last 14 days."
          />
          <FactorRow
            label="Student Retention"
            score={factors.studentRetention}
            description="Percentage of students in your centers who remain active."
          />
        </div>
      </div>

      {/* Rankings */}
      {ranks.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Your Rankings</div>
          <div style={s.rankList}>
            {ranks.map(r => (
              <div key={r.centerId + r.period} style={s.rankCard}>
                <div style={s.rankCenter}>{r.centerId}</div>
                <div style={s.rankPosition}>
                  <span style={s.rankNum}>
                    {r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`}
                  </span>
                  <span style={s.rankOf}>of {r.total}</span>
                </div>
                <div style={s.rankPeriod}>{r.period === "lifetime" ? "All-time" : "This month"}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Read-only notice */}
      <div style={s.notice}>
        This score is calculated automatically. Scores cannot be manually edited.
        Factors update daily based on your activity.
      </div>
    </div>
  );
}

// ─── Factor Row ───────────────────────────────────────────────────────────────

function FactorRow({
  label,
  score,
  description,
}: {
  label:       string;
  score:       number;
  description: string;
}) {
  const color = score >= 75 ? "#16a34a" : score >= 50 ? "#ca8a04" : "#dc2626";
  return (
    <div style={s.factorRow}>
      <div style={s.factorLeft}>
        <div style={s.factorLabel}>{label}</div>
        <div style={s.factorDesc}>{description}</div>
      </div>
      <div style={s.factorRight}>
        <div style={s.factorScore} data-color={color}>{score}</div>
        <div style={s.factorBarOuter}>
          <div style={{ ...s.factorBarInner, width: `${score}%`, background: color }} />
        </div>
      </div>
    </div>
  );
}

// ─── Score Gauge ──────────────────────────────────────────────────────────────

function ScoreGauge({ score }: { score: number }) {
  const radius = 54;
  const circ   = 2 * Math.PI * radius;
  const offset = circ - (score / 100) * circ;
  const color  = score >= 75 ? "#16a34a" : score >= 50 ? "#ca8a04" : "#dc2626";

  return (
    <svg width={140} height={140} viewBox="0 0 140 140">
      <circle cx={70} cy={70} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={12} />
      <circle
        cx={70} cy={70} r={radius}
        fill="none"
        stroke={color}
        strokeWidth={12}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 70 70)"
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text x={70} y={74} textAnchor="middle" fontSize={28} fontWeight={700} fill={color}>{score}</text>
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tierLabel(score: number): string {
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 50) return "Average";
  return "Needs Improvement";
}

function tierColor(score: number): { bg: string; fg: string } {
  if (score >= 85) return { bg: "#dcfce7", fg: "#15803d" };
  if (score >= 70) return { bg: "#dbeafe", fg: "#1d4ed8" };
  if (score >= 50) return { bg: "#fef9c3", fg: "#92400e" };
  return { bg: "#fee2e2", fg: "#991b1b" };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  state:        { padding: "48px 16px", textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" },

  noData:       { display: "flex", flexDirection: "column", alignItems: "center", padding: "64px 16px", textAlign: "center" },
  noDataIcon:   { fontSize: 40, marginBottom: 12 },
  noDataTitle:  { fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 8 },
  noDataSub:    { fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 360 },

  header:       { marginBottom: 24 },
  heading:      { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  subheading:   { fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 },

  scoreCard:    { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "28px 32px", display: "flex", alignItems: "center", gap: 32, marginBottom: 24 },
  scoreRight:   { display: "flex", flexDirection: "column" as const, gap: 6 },
  scoreBig:     { fontSize: 52, fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1 },
  scoreLabel:   { fontSize: 13, color: "var(--color-text-secondary)" },
  scoreTier:    { marginTop: 4 },
  tierBadge:    { padding: "3px 12px", borderRadius: 99, fontSize: 12, fontWeight: 700, display: "inline-block" },

  section:      { marginBottom: 24 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 12 },

  factorList:   { display: "flex", flexDirection: "column" as const, gap: 1, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  factorRow:    { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)" },
  factorLeft:   { flex: 1 },
  factorLabel:  { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 2 },
  factorDesc:   { fontSize: 11, color: "var(--color-text-secondary)", maxWidth: 400 },
  factorRight:  { display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: 6, minWidth: 160 },
  factorScore:  { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)" },
  factorBarOuter: { height: 8, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", width: 140 },
  factorBarInner: { height: "100%", borderRadius: 99, transition: "width 0.4s ease" },

  rankList:     { display: "flex", gap: 12, flexWrap: "wrap" as const },
  rankCard:     { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 20px", minWidth: 160 },
  rankCenter:   { fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: 200 },
  rankPosition: { display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 },
  rankNum:      { fontSize: 28, fontWeight: 700, color: "var(--color-text-primary)" },
  rankOf:       { fontSize: 13, color: "var(--color-text-secondary)" },
  rankPeriod:   { fontSize: 11, color: "var(--color-text-secondary)" },

  notice:       { fontSize: 11, color: "#9ca3af", fontStyle: "italic" as const, textAlign: "center" as const, padding: "16px 0" },
};
