"use client";

import { useState, useEffect, useCallback } from "react";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  Timestamp,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { AuditLog } from "@/types/audit";

// ─── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE      = 25;
const MONTHS_BACK    = 3;
const AUDIT_LOGS_COL = "audit_logs";

/** Returns the Firestore Timestamp for 3 months ago (start of that month). */
function threeMonthsAgo(): Timestamp {
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS_BACK);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Timestamp.fromDate(d);
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function AuditLogsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <AuditLogsContent />
    </ProtectedRoute>
  );
}

// ─── Filter state ─────────────────────────────────────────────────────────────

interface Filters {
  userId:    string;
  role:      string;
  action:    string;
  dateFrom:  string;   // ISO date string "YYYY-MM-DD"
  dateTo:    string;
}

const EMPTY_FILTERS: Filters = {
  userId:   "",
  role:     "",
  action:   "",
  dateFrom: "",
  dateTo:   "",
};

// ─── Content ──────────────────────────────────────────────────────────────────

function AuditLogsContent() {
  const [logs, setLogs]                 = useState<AuditLog[]>([]);
  const [loading, setLoading]           = useState(true);
  const [filters, setFilters]           = useState<Filters>({ ...EMPTY_FILTERS });
  const [appliedFilters, setAppliedFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [lastDoc, setLastDoc]           = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore]           = useState(false);
  const [totalFetched, setTotalFetched] = useState(0);
  const { toasts, toast, remove }       = useToast();

  const fetchLogs = useCallback(async (
    f: Filters,
    after: QueryDocumentSnapshot | null,
    reset: boolean,
  ) => {
    setLoading(true);
    try {
      const cutoff = threeMonthsAgo();

      // Build constraints
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const constraints: any[] = [
        where("timestamp", ">=", cutoff),
        orderBy("timestamp", "desc"),
      ];

      if (f.userId)   constraints.unshift(where("initiatorId", "==", f.userId));
      if (f.role)     constraints.unshift(where("initiatorRole", "==", f.role));
      if (f.action)   constraints.unshift(where("action", "==", f.action));
      if (f.dateFrom) {
        const from = Timestamp.fromDate(new Date(f.dateFrom + "T00:00:00"));
        constraints.unshift(where("timestamp", ">=", from));
      }
      if (f.dateTo) {
        const to = Timestamp.fromDate(new Date(f.dateTo + "T23:59:59"));
        constraints.push(where("timestamp", "<=", to));
      }

      if (after) constraints.push(startAfter(after));
      constraints.push(limit(PAGE_SIZE + 1)); // fetch one extra to detect hasMore

      const q    = query(collection(db, AUDIT_LOGS_COL), ...constraints);
      const snap = await getDocs(q);
      const docs = snap.docs;

      const more    = docs.length > PAGE_SIZE;
      const visible = (more ? docs.slice(0, PAGE_SIZE) : docs) as QueryDocumentSnapshot[];
      const mapped  = visible.map(d => ({ id: d.id, ...d.data() }) as AuditLog);

      setLogs(prev => reset ? mapped : [...prev, ...mapped]);
      setTotalFetched(prev => reset ? mapped.length : prev + mapped.length);
      setLastDoc(visible[visible.length - 1] ?? null);
      setHasMore(more);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to load audit logs: ${msg}`, "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs(appliedFilters, null, true);
  }, [appliedFilters]);

  function handleApply() {
    setAppliedFilters({ ...filters });
  }

  function handleReset() {
    setFilters({ ...EMPTY_FILTERS });
    setAppliedFilters({ ...EMPTY_FILTERS });
  }

  function handleLoadMore() {
    if (lastDoc) fetchLogs(appliedFilters, lastDoc, false);
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <h1 style={s.heading}>Audit Logs</h1>
        <span style={s.windowNote}>Last {MONTHS_BACK} months · read-only</span>
      </div>

      {/* Filter panel */}
      <div style={s.filterCard}>
        <div style={s.filterTitle}>Filters</div>
        <div style={s.filterGrid}>
          <div style={s.filterField}>
            <label style={s.label}>User ID</label>
            <input
              value={filters.userId}
              onChange={e => setFilters(p => ({ ...p, userId: e.target.value }))}
              placeholder="UID"
              style={s.input}
            />
          </div>
          <div style={s.filterField}>
            <label style={s.label}>Role</label>
            <select
              value={filters.role}
              onChange={e => setFilters(p => ({ ...p, role: e.target.value }))}
              style={s.input}
            >
              <option value="">All roles</option>
              <option value="super_admin">Super Admin</option>
              <option value="admin">Admin</option>
              <option value="teacher">Teacher</option>
              <option value="student">Student</option>
            </select>
          </div>
          <div style={s.filterField}>
            <label style={s.label}>Action</label>
            <select
              value={filters.action}
              onChange={e => setFilters(p => ({ ...p, action: e.target.value }))}
              style={s.input}
            >
              <option value="">All actions</option>
              {ACTION_OPTIONS.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div style={s.filterField}>
            <label style={s.label}>From date</label>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={e => setFilters(p => ({ ...p, dateFrom: e.target.value }))}
              style={s.input}
            />
          </div>
          <div style={s.filterField}>
            <label style={s.label}>To date</label>
            <input
              type="date"
              value={filters.dateTo}
              onChange={e => setFilters(p => ({ ...p, dateTo: e.target.value }))}
              style={s.input}
            />
          </div>
        </div>
        <div style={s.filterActions}>
          <button onClick={handleApply} style={s.applyBtn}>Apply Filters</button>
          <button onClick={handleReset} style={s.resetBtn}>Reset</button>
        </div>
      </div>

      {/* Table */}
      <div style={s.tableWrapper}>
        <div style={s.tableHeader}>
          <span style={s.tableTitle}>
            {loading ? "Loading…" : `${totalFetched} log${totalFetched !== 1 ? "s" : ""}`}
          </span>
        </div>

        {loading && logs.length === 0 ? (
          <div style={s.stateRow}>Loading audit logs…</div>
        ) : logs.length === 0 ? (
          <div style={s.stateRow}>No audit logs found for the selected filters.</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {["Timestamp", "Action", "Initiator", "Role", "Approver", "Reason", "Details"].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <LogRow key={log.id} log={log} even={i % 2 === 0} />
              ))}
            </tbody>
          </table>
        )}

        {hasMore && (
          <div style={s.loadMoreRow}>
            <button
              onClick={handleLoadMore}
              disabled={loading}
              style={s.loadMoreBtn}
            >
              {loading ? "Loading…" : `Load next ${PAGE_SIZE}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Log Row ─────────────────────────────────────────────────────────────────

function LogRow({ log, even }: { log: AuditLog; even: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const ts = log.timestamp instanceof Timestamp
    ? log.timestamp.toDate()
    : log.timestamp
      ? new Date(log.timestamp as string)
      : null;

  const tsStr = ts
    ? ts.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—";

  const actionStyle = ACTION_COLORS[log.action] ?? ACTION_COLORS._default;

  return (
    <>
      <tr style={even ? s.rowEven : s.rowOdd}>
        <td style={{ ...s.td, ...s.mono, whiteSpace: "nowrap" as const }}>{tsStr}</td>
        <td style={s.td}>
          <span style={{ ...s.actionBadge, ...actionStyle }}>{log.action}</span>
        </td>
        <td style={{ ...s.td, ...s.mono }}>{log.initiatorId?.slice(0, 12)}…</td>
        <td style={s.td}>
          <span style={{ ...s.roleBadge, ...ROLE_COLORS[log.initiatorRole] }}>{log.initiatorRole}</span>
        </td>
        <td style={{ ...s.td, ...s.mono, color: "#9ca3af" }}>
          {log.approverId ? `${log.approverId.slice(0, 8)}…` : "—"}
        </td>
        <td style={{ ...s.td, fontStyle: "italic" as const, color: "#6b7280" }}>
          {log.reason ?? "—"}
        </td>
        <td style={s.td}>
          {Object.keys(log.metadata ?? {}).length > 0 && (
            <button
              onClick={() => setExpanded(v => !v)}
              style={s.detailsBtn}
            >
              {expanded ? "▲ Hide" : "▼ Show"}
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr style={even ? s.rowEven : s.rowOdd}>
          <td colSpan={7} style={s.metadataCell}>
            <pre style={s.metadataPre}>
              {JSON.stringify(log.metadata, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Action options (all possible logAction values) ───────────────────────────

const ACTION_OPTIONS = [
  "STUDENT_CREATED",
  "ATTENDANCE_MARKED",
  "TRANSACTION_CREATED",
  "MONTHLY_FEE_APPLIED",
  "PER_CLASS_FEE_APPLIED",
  "SYLLABUS_ASSIGNED",
  "SYLLABUS_PROGRESS_UPDATED",
  "SYLLABUS_PROGRESS_OVERRIDE",
  "SYLLABUS_BULK_IMPORTED",
  "LESSON_CREATED",
  "LESSON_ITEM_CREATED",
  "ATTEMPT_LOGGED",
  "ATTEMPT_LOGGED_OVERRIDE",
  "ITEM_COMPLETED",
  "ITEM_COMPLETED_OVERRIDE",
];

const ACTION_COLORS: Record<string, React.CSSProperties> = {
  STUDENT_CREATED:           { background: "#dcfce7", color: "#15803d" },
  ATTENDANCE_MARKED:         { background: "#dbeafe", color: "#1d4ed8" },
  TRANSACTION_CREATED:       { background: "#fef9c3", color: "#92400e" },
  MONTHLY_FEE_APPLIED:       { background: "#fef3c7", color: "#b45309" },
  PER_CLASS_FEE_APPLIED:     { background: "#fef3c7", color: "#b45309" },
  SYLLABUS_ASSIGNED:         { background: "#ede9fe", color: "#5b21b6" },
  SYLLABUS_PROGRESS_UPDATED: { background: "#e0e7ff", color: "#3730a3" },
  SYLLABUS_PROGRESS_OVERRIDE:{ background: "#fee2e2", color: "#b91c1c" },
  SYLLABUS_BULK_IMPORTED:    { background: "#ede9fe", color: "#5b21b6" },
  LESSON_CREATED:            { background: "#e0e7ff", color: "#3730a3" },
  LESSON_ITEM_CREATED:       { background: "#e0e7ff", color: "#3730a3" },
  ATTEMPT_LOGGED:            { background: "#dcfce7", color: "#15803d" },
  ATTEMPT_LOGGED_OVERRIDE:   { background: "#fee2e2", color: "#b91c1c" },
  ITEM_COMPLETED:            { background: "#dcfce7", color: "#15803d" },
  ITEM_COMPLETED_OVERRIDE:   { background: "#fee2e2", color: "#b91c1c" },
  _default:                  { background: "#f3f4f6", color: "#374151" },
};

const ROLE_COLORS: Record<string, React.CSSProperties> = {
  super_admin: { background: "#7c3aed", color: "#fff" },
  admin:       { background: "#1d4ed8", color: "#fff" },
  teacher:     { background: "#065f46", color: "#fff" },
  student:     { background: "#374151", color: "#fff" },
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header:       { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  heading:      { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  windowNote:   { fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 },

  filterCard:   { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 20px", marginBottom: 20 },
  filterTitle:  { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 12 },
  filterGrid:   { display: "flex", gap: 12, flexWrap: "wrap" as const, marginBottom: 12 },
  filterField:  { display: "flex", flexDirection: "column" as const, gap: 4, minWidth: 160 },
  label:        { fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.03em" },
  input:        { padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, color: "#111827", background: "#fff", outline: "none" },
  filterActions:{ display: "flex", gap: 8 },
  applyBtn:     { background: "#111827", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  resetBtn:     { background: "transparent", color: "#6b7280", border: "1px solid #d1d5db", padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },

  tableWrapper: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  tableHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--color-border)" },
  tableTitle:   { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em" },
  table:        { width: "100%", borderCollapse: "collapse" as const },
  th:           { padding: "10px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", background: "#f9fafb", borderBottom: "1px solid var(--color-border)" },
  td:           { padding: "10px 14px", fontSize: 12, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)", verticalAlign: "top" as const },
  rowEven:      { background: "var(--color-surface)" },
  rowOdd:       { background: "#fafafa" },
  mono:         { fontFamily: "monospace", fontSize: 11 },
  stateRow:     { padding: "32px 16px", textAlign: "center" as const, fontSize: 13, color: "var(--color-text-secondary)" },

  actionBadge:  { padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" as const },
  roleBadge:    { padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, textTransform: "capitalize" as const },
  detailsBtn:   { background: "none", border: "none", color: "#4f46e5", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 },

  metadataCell: { padding: "0 14px 10px 48px", borderBottom: "1px solid var(--color-border)" },
  metadataPre:  { margin: 0, padding: "10px 14px", background: "#f1f5f9", borderRadius: 6, fontSize: 11, color: "#374151", overflow: "auto" as const, maxHeight: 200 },

  loadMoreRow:  { padding: "14px 16px", textAlign: "center" as const, borderTop: "1px solid var(--color-border)" },
  loadMoreBtn:  { background: "#f9fafb", border: "1px solid #d1d5db", color: "#374151", padding: "8px 20px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
};
