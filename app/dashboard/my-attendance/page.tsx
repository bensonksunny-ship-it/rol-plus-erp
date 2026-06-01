"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import type { AttendanceRecord } from "@/types/attendance";

export default function MyAttendancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.STUDENT]}>
      <MyAttendanceContent />
    </ProtectedRoute>
  );
}

// saveCentreAttendance writes a `date` field (the class date the admin selects).
// The base AttendanceRecord type only has markedAt — extend it here.
type AttendanceRow = AttendanceRecord & { date?: string };

function classDate(rec: AttendanceRow): string {
  // Prefer `date` (set by admin/teacher via saveCentreAttendance).
  // Fall back to markedAt slice for QR / class-based records.
  return rec.date ?? (rec.markedAt ?? "").slice(0, 10);
}

function formatDate(iso: string): string {
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y}`;
}

const STATUS_LABELS: Record<string, string> = {
  present:            "Present",
  absent:             "Absent",
  break:              "Break",
  cancelled_teacher:  "Cancelled",
  cancelled_student:  "Cancelled",
};

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string; rowBg: string; rowBorder: string }> = {
  present:           { bg: "#dcfce7", text: "#15803d", dot: "#16a34a", rowBg: "#f0fdf4", rowBorder: "#16a34a" },
  absent:            { bg: "#fee2e2", text: "#b91c1c", dot: "#dc2626", rowBg: "#fef2f2", rowBorder: "#dc2626" },
  break:             { bg: "#e0e7ff", text: "#3730a3", dot: "#4f46e5", rowBg: "#eef2ff", rowBorder: "#6366f1" },
  cancelled_teacher: { bg: "#f3f4f6", text: "#6b7280", dot: "#9ca3af", rowBg: "#f9fafb", rowBorder: "#d1d5db" },
  cancelled_student: { bg: "#f3f4f6", text: "#6b7280", dot: "#9ca3af", rowBg: "#f9fafb", rowBorder: "#d1d5db" },
};

function MyAttendanceContent() {
  const { user }                      = useAuthContext();
  const [records, setRecords]         = useState<AttendanceRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [filterMonth, setFilterMonth] = useState<string>("");

  useEffect(() => {
    if (!user?.uid) return;
    load(user.uid);
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(uid: string) {
    setLoading(true);
    setError(null);
    try {
      const snap = await getDocs(
        query(collection(db, "attendance"), where("studentUid", "==", uid))
      );
      const recs = snap.docs
        .map(d => ({ id: d.id, ...d.data() }) as AttendanceRow)
        .sort((a, b) => classDate(b).localeCompare(classDate(a)));
      setRecords(recs);
    } catch {
      setError("Failed to load attendance. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={s.state}>Loading attendance…</div>;
  if (error)   return <div style={{ ...s.state, color: "#dc2626" }}>{error}</div>;

  // Only present + absent count toward the rate; break/cancelled are excluded
  const countable    = records.filter(r => r.status === "present" || r.status === "absent");
  const totalPresent = records.filter(r => r.status === "present").length;
  const totalAbsent  = records.filter(r => r.status === "absent").length;
  const rate         = countable.length > 0 ? Math.round((totalPresent / countable.length) * 100) : null;

  const months = Array.from(
    new Set(records.map(r => classDate(r).slice(0, 7)).filter(Boolean))
  ).sort((a, b) => b.localeCompare(a));

  const displayed = filterMonth
    ? records.filter(r => classDate(r).startsWith(filterMonth))
    : records;

  const dispPresent = displayed.filter(r => r.status === "present").length;
  const dispAbsent  = displayed.filter(r => r.status === "absent").length;

  return (
    <div style={s.page}>

      {/* Summary cards */}
      <div style={s.statsGrid}>
        <div style={s.statCard}>
          <div style={s.statLabel}>Attendance Rate</div>
          <div style={{ ...s.statValue, color: rate !== null && rate >= 75 ? "#16a34a" : "#dc2626" }}>
            {rate !== null ? `${rate}%` : "—"}
          </div>
          <div style={s.statSub}>{countable.length} classes counted</div>
        </div>
        <div style={s.statCard}>
          <div style={s.statLabel}>Present</div>
          <div style={{ ...s.statValue, color: "#16a34a" }}>{totalPresent}</div>
          <div style={s.statSub}>of {countable.length} classes</div>
        </div>
        <div style={s.statCard}>
          <div style={s.statLabel}>Absent</div>
          <div style={{ ...s.statValue, color: "#dc2626" }}>{totalAbsent}</div>
          <div style={s.statSub}>of {countable.length} classes</div>
        </div>
      </div>

      {/* Attendance bar */}
      {countable.length > 0 && (
        <div style={s.barWrap}>
          <div style={{ ...s.barFill, width: `${rate}%`, background: rate !== null && rate >= 75 ? "#16a34a" : "#f59e0b" }} />
        </div>
      )}

      {/* Month filter */}
      {months.length > 0 && (
        <div style={s.filterRow}>
          <label style={s.filterLabel}>Filter by month</label>
          <select
            value={filterMonth}
            onChange={e => setFilterMonth(e.target.value)}
            style={s.select}
          >
            <option value="">All months</option>
            {months.map(m => (
              <option key={m} value={m}>{fmtMonth(m)}</option>
            ))}
          </select>
          {filterMonth && (
            <span style={s.filterSummary}>
              {dispPresent} present · {dispAbsent} absent
            </span>
          )}
        </div>
      )}

      {/* Records list */}
      {displayed.length === 0 ? (
        <div style={s.empty}>No attendance records{filterMonth ? ` for ${fmtMonth(filterMonth)}` : " yet"}.</div>
      ) : (
        <div style={s.list}>
          {displayed.map(rec => {
            const status = rec.status as string;
            const color  = STATUS_COLORS[status] ?? STATUS_COLORS.absent;
            const date   = classDate(rec);
            return (
              <div key={rec.id} style={{
                ...s.row,
                borderLeft: `3px solid ${color.rowBorder}`,
                background: color.rowBg,
              }}>
                <span style={{ ...s.statusDot, background: color.dot }} />
                <span style={s.rowDate}>{date ? formatDate(date) : "—"}</span>
                <span style={{ ...s.statusBadge, background: color.bg, color: color.text }}>
                  {STATUS_LABELS[status] ?? status}
                </span>
                <span style={s.methodBadge}>{rec.method === "qr" ? "QR" : "Manual"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:    { maxWidth: 700, margin: "0 auto", padding: "0 0 40px" },
  state:   { padding: "60px 0", textAlign: "center", fontSize: 14, color: "#6b7280" },
  heading: { fontSize: 24, fontWeight: 700, color: "#111111", marginBottom: 24 },

  statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 20 },
  statCard:  { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px" },
  statLabel: { fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 },
  statValue: { fontSize: 28, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 },
  statSub:   { fontSize: 11, color: "#9ca3af" },

  barWrap: { height: 8, background: "#f3f4f6", borderRadius: 99, overflow: "hidden", marginBottom: 24 },
  barFill: { height: "100%", borderRadius: 99, transition: "width 0.4s ease" },

  filterRow:     { display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" as const },
  filterLabel:   { fontSize: 12, fontWeight: 600, color: "#6b7280" },
  select:        { fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 8px", color: "#111827" },
  filterSummary: { fontSize: 12, color: "#9ca3af", fontStyle: "italic" as const },

  empty: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
    padding: 28, textAlign: "center" as const, fontSize: 13, color: "#9ca3af",
  },
  list: { display: "flex", flexDirection: "column" as const, gap: 6 },
  row:  { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 8, fontSize: 13 },
  statusDot:   { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  rowDate:     { fontWeight: 700, color: "#111827", minWidth: 90 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99 },
  methodBadge: {
    fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
    background: "#e0e7ff", color: "#3730a3", marginLeft: "auto",
  },
};
