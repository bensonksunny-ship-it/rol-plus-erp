"use client";

import { useState, useEffect } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import {
  getAllLeaderboards,
  getLeaderboardByCenter,
  updateTeacherQualityScores,
  updateLeaderboards,
} from "@/services/quality/quality.service";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { Leaderboard, RankEntry } from "@/types/quality";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function LeaderboardsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <LeaderboardsContent />
    </ProtectedRoute>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

interface CenterOption { id: string; name: string; }

function LeaderboardsContent() {
  const [centers, setCenters]             = useState<CenterOption[]>([]);
  const [selectedCenter, setSelectedCenter] = useState<string>("");
  const [board, setBoard]                 = useState<Leaderboard | null>(null);
  const [allBoards, setAllBoards]         = useState<Leaderboard[]>([]);
  const [view, setView]                   = useState<"monthly" | "lifetime">("lifetime");
  const [loading, setLoading]             = useState(true);
  const [running, setRunning]             = useState(false);
  const { toasts, toast, remove }         = useToast();

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [centersSnap, boards] = await Promise.all([
          getDocs(collection(db, "centers")),
          getAllLeaderboards(),
        ]);
        const cs = centersSnap.docs.map(d => ({
          id:   d.id,
          name: (d.data().name as string) ?? d.id,
        }));
        setCenters(cs);
        setAllBoards(boards);

        // Auto-select first center that has a leaderboard
        const first = boards[0];
        if (first) {
          setSelectedCenter(first.centerId);
          setBoard(first);
        }
      } catch {
        toast("Failed to load leaderboards.", "error");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  async function handleCenterChange(centerId: string) {
    setSelectedCenter(centerId);
    if (!centerId) { setBoard(null); return; }
    setLoading(true);
    try {
      const b = await getLeaderboardByCenter(centerId);
      setBoard(b);
    } catch {
      toast("Failed to load leaderboard for this center.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleRunUpdate() {
    setRunning(true);
    try {
      const count = await updateTeacherQualityScores();
      await updateLeaderboards();
      toast(`Scores updated for ${count} teachers. Leaderboards refreshed.`, "success");
      // Reload current center
      if (selectedCenter) {
        const b = await getLeaderboardByCenter(selectedCenter);
        setBoard(b);
      }
      const boards = await getAllLeaderboards();
      setAllBoards(boards);
    } catch (err) {
      toast("Update failed.", "error");
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  const rankings: RankEntry[] = board
    ? (view === "monthly" ? board.monthlyRankings : board.lifetimeRankings)
    : [];

  const centerName = centers.find(c => c.id === selectedCenter)?.name ?? selectedCenter;

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Leaderboards</h1>
          <div style={s.subheading}>Teacher quality rankings by center</div>
        </div>
        <button
          onClick={handleRunUpdate}
          disabled={running}
          style={{ ...s.runBtn, opacity: running ? 0.6 : 1 }}
        >
          {running ? "Updating…" : "Recalculate Scores"}
        </button>
      </div>

      {/* Controls */}
      <div style={s.controls}>
        <div style={s.controlGroup}>
          <label style={s.label}>Center</label>
          <select
            value={selectedCenter}
            onChange={e => handleCenterChange(e.target.value)}
            style={s.select}
            disabled={loading}
          >
            <option value="">— Select center —</option>
            {centers.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div style={s.controlGroup}>
          <label style={s.label}>Period</label>
          <div style={s.toggle}>
            {(["lifetime", "monthly"] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{ ...s.toggleBtn, ...(view === v ? s.toggleActive : {}) }}
              >
                {v === "lifetime" ? "All-time" : "This month"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary chips */}
      {allBoards.length > 0 && (
        <div style={s.summaryRow}>
          {allBoards.map(b => {
            const topEntry = (view === "monthly" ? b.monthlyRankings : b.lifetimeRankings)[0];
            const cn = centers.find(c => c.id === b.centerId)?.name ?? b.centerId;
            return (
              <button
                key={b.centerId}
                onClick={() => handleCenterChange(b.centerId)}
                style={{
                  ...s.summaryChip,
                  ...(b.centerId === selectedCenter ? s.summaryChipActive : {}),
                }}
              >
                <span style={s.summaryName}>{cn}</span>
                {topEntry && (
                  <span style={s.summaryTop}>🏆 {topEntry.displayName} · {topEntry.score}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Rankings table */}
      {loading ? (
        <div style={s.stateRow}>Loading…</div>
      ) : !board ? (
        <div style={s.stateRow}>Select a center to view its leaderboard.</div>
      ) : rankings.length === 0 ? (
        <div style={s.stateRow}>
          No rankings for this period yet. Click "Recalculate Scores" to generate.
        </div>
      ) : (
        <div style={s.tableWrapper}>
          <div style={s.tableHeader}>
            <span style={s.tableTitle}>
              {view === "lifetime" ? "All-time rankings" : "This month's rankings"} — {centerName}
            </span>
            <span style={s.tableNote}>{rankings.length} teacher{rankings.length !== 1 ? "s" : ""}</span>
          </div>
          <table style={s.table}>
            <thead>
              <tr>
                {["Rank", "Teacher", "Score", "Attendance", "Syllabus", "Retention", ""].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rankings.map((entry, i) => (
                <RankRow key={entry.teacherId} entry={entry} even={i % 2 === 0} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Rank Row ─────────────────────────────────────────────────────────────────

function RankRow({ entry, even }: { entry: RankEntry; even: boolean }) {
  const rankStyle =
    entry.rank === 1 ? s.rank1 :
    entry.rank === 2 ? s.rank2 :
    entry.rank === 3 ? s.rank3 : s.rankN;

  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : null;

  // Quality doc is not re-fetched in list view — score only shown
  return (
    <tr style={even ? s.rowEven : s.rowOdd}>
      <td style={{ ...s.td, width: 60 }}>
        <span style={{ ...s.rankBadge, ...rankStyle }}>
          {medal ?? `#${entry.rank}`}
        </span>
      </td>
      <td style={{ ...s.td, fontWeight: 600, color: "var(--color-text-primary)" }}>
        {entry.displayName}
      </td>
      <td style={s.td}>
        <ScoreBar score={entry.score} />
      </td>
      {/* Breakdown columns are placeholders — full data only on teacher-score page */}
      <td style={{ ...s.td, color: "#9ca3af", fontSize: 11 }}>—</td>
      <td style={{ ...s.td, color: "#9ca3af", fontSize: 11 }}>—</td>
      <td style={{ ...s.td, color: "#9ca3af", fontSize: 11 }}>—</td>
      <td style={s.td}>
        <span style={s.scoreNum}>{entry.score}</span>
      </td>
    </tr>
  );
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const color = score >= 75 ? "#16a34a" : score >= 50 ? "#ca8a04" : "#dc2626";
  return (
    <div style={s.barOuter}>
      <div style={{ ...s.barInner, width: `${score}%`, background: color }} />
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header:         { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 },
  heading:        { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  subheading:     { fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 },
  runBtn:         { background: "#111827", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  controls:       { display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" as const },
  controlGroup:   { display: "flex", flexDirection: "column" as const, gap: 4 },
  label:          { fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.03em" },
  select:         { padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, color: "#111827", background: "#fff", outline: "none", minWidth: 200 },
  toggle:         { display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #d1d5db" },
  toggleBtn:      { background: "#f9fafb", color: "#374151", border: "none", padding: "7px 16px", fontSize: 12, fontWeight: 500, cursor: "pointer" },
  toggleActive:   { background: "#111827", color: "#fff" },

  summaryRow:     { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" as const },
  summaryChip:    { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", textAlign: "left" as const, display: "flex", flexDirection: "column" as const, gap: 2 },
  summaryChipActive: { borderColor: "#4f46e5", background: "#ede9fe" },
  summaryName:    { fontSize: 12, fontWeight: 700, color: "var(--color-text-primary)" },
  summaryTop:     { fontSize: 11, color: "var(--color-text-secondary)" },

  stateRow:       { padding: "40px 16px", textAlign: "center" as const, fontSize: 13, color: "var(--color-text-secondary)" },

  tableWrapper:   { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  tableHeader:    { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--color-border)" },
  tableTitle:     { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  tableNote:      { fontSize: 12, color: "var(--color-text-secondary)" },
  table:          { width: "100%", borderCollapse: "collapse" as const },
  th:             { padding: "10px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", background: "#f9fafb", borderBottom: "1px solid var(--color-border)" },
  td:             { padding: "12px 14px", fontSize: 13, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:        { background: "var(--color-surface)" },
  rowOdd:         { background: "#fafafa" },

  rankBadge:      { display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, width: 36, height: 28 },
  rank1:          { fontSize: 20 },
  rank2:          { fontSize: 20 },
  rank3:          { fontSize: 20 },
  rankN:          { color: "#9ca3af", fontSize: 13 },
  scoreNum:       { fontWeight: 700, fontSize: 16, color: "var(--color-text-primary)" },

  barOuter:       { height: 8, background: "#e5e7eb", borderRadius: 99, overflow: "hidden", width: 120 },
  barInner:       { height: "100%", borderRadius: 99, transition: "width 0.3s" },
};
