"use client";

import { useState, useEffect, useCallback } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getAlerts,
  resolveAlert,
  detectGhostClass,
  detectDormancy,
  type AlertFilters,
} from "@/services/alert/alert.service";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { Alert, AlertType, AlertSeverity, AlertStatus } from "@/types/alert";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function AlertsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <AlertsContent />
    </ProtectedRoute>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

function AlertsContent() {
  const { user, role }                  = useAuth();
  const [alerts, setAlerts]             = useState<Alert[]>([]);
  const [loading, setLoading]           = useState(true);
  const [resolvingId, setResolvingId]   = useState<string | null>(null);
  const [runningDetect, setRunningDetect] = useState(false);

  // Filters
  const [fType,     setFType]     = useState<AlertType | "">("");
  const [fSeverity, setFSeverity] = useState<AlertSeverity | "">("");
  const [fCenter,   setFCenter]   = useState("");
  const [fStatus,   setFStatus]   = useState<AlertStatus | "">("active");

  const { toasts, toast, remove } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters: AlertFilters = {};
      if (fType)     filters.type     = fType;
      if (fSeverity) filters.severity = fSeverity;
      if (fCenter)   filters.centerId = fCenter.trim();
      if (fStatus)   filters.status   = fStatus;

      const data = await getAlerts(filters, 100);
      setAlerts(data);
    } catch (err) {
      toast("Failed to load alerts.", "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [fType, fSeverity, fCenter, fStatus]);

  useEffect(() => { load(); }, [load]);

  async function handleResolve(alertId: string) {
    if (!user || !role) return;
    setResolvingId(alertId);
    try {
      await resolveAlert(alertId, user.uid, role);
      toast("Alert resolved.", "success");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to resolve: ${msg}`, "error");
    } finally {
      setResolvingId(null);
    }
  }

  async function handleRunDetection() {
    setRunningDetect(true);
    try {
      const [ghosts, dormant] = await Promise.all([
        detectGhostClass(),
        detectDormancy(),
      ]);
      toast(
        `Detection complete. Ghost classes: ${ghosts}, Dormant students: ${dormant}.`,
        "success"
      );
      await load();
    } catch (err) {
      toast("Detection run failed.", "error");
      console.error(err);
    } finally {
      setRunningDetect(false);
    }
  }

  const activeCount   = alerts.filter(a => a.status === "active").length;
  const redCount      = alerts.filter(a => a.severity === "red" && a.status === "active").length;

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Alerts</h1>
          {activeCount > 0 && (
            <div style={s.countRow}>
              <span style={s.redCount}>{redCount} critical</span>
              <span style={s.activeCount}>{activeCount} active total</span>
            </div>
          )}
        </div>
        <button
          onClick={handleRunDetection}
          disabled={runningDetect}
          style={{ ...s.detectBtn, opacity: runningDetect ? 0.6 : 1 }}
        >
          {runningDetect ? "Running…" : "Run Detection Now"}
        </button>
      </div>

      {/* Filters */}
      <div style={s.filterCard}>
        <div style={s.filterTitle}>Filters</div>
        <div style={s.filterRow}>
          <div style={s.filterGroup}>
            <label style={s.label}>Status</label>
            <select value={fStatus} onChange={e => setFStatus(e.target.value as AlertStatus | "")} style={s.select}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
          <div style={s.filterGroup}>
            <label style={s.label}>Type</label>
            <select value={fType} onChange={e => setFType(e.target.value as AlertType | "")} style={s.select}>
              <option value="">All types</option>
              <option value="ghost_class">Ghost Class</option>
              <option value="revenue_leakage">Revenue Leakage</option>
              <option value="dormancy">Dormancy</option>
            </select>
          </div>
          <div style={s.filterGroup}>
            <label style={s.label}>Severity</label>
            <select value={fSeverity} onChange={e => setFSeverity(e.target.value as AlertSeverity | "")} style={s.select}>
              <option value="">All</option>
              <option value="red">Red (Critical)</option>
              <option value="yellow">Yellow (Warning)</option>
            </select>
          </div>
          <div style={s.filterGroup}>
            <label style={s.label}>Center ID</label>
            <input
              value={fCenter}
              onChange={e => setFCenter(e.target.value)}
              placeholder="Filter by center…"
              style={s.input}
            />
          </div>
          <button onClick={load} style={s.applyBtn}>Apply</button>
        </div>
      </div>

      {/* Alert list */}
      {loading ? (
        <div style={s.stateRow}>Loading alerts…</div>
      ) : alerts.length === 0 ? (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>✓</div>
          <div style={s.emptyText}>No alerts found for the selected filters.</div>
        </div>
      ) : (
        <div style={s.alertList}>
          {alerts.map(alert => (
            <AlertCard
              key={alert.id}
              alert={alert}
              resolving={resolvingId === alert.id}
              onResolve={() => handleResolve(alert.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Alert Card ───────────────────────────────────────────────────────────────

function AlertCard({
  alert,
  resolving,
  onResolve,
}: {
  alert:     Alert;
  resolving: boolean;
  onResolve: () => void;
}) {
  const ts = alert.createdAt
    ? (() => {
        try {
          const d = typeof alert.createdAt === "string"
            ? new Date(alert.createdAt)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            : (alert.createdAt as any).toDate?.() ?? new Date();
          return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
        } catch { return "—"; }
      })()
    : "—";

  const resolvedTs = alert.resolvedAt
    ? (() => {
        try {
          return new Date(alert.resolvedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
        } catch { return "—"; }
      })()
    : null;

  const severityStyle = alert.severity === "red"
    ? s.severityRed
    : s.severityYellow;

  const typeStyle = TYPE_STYLES[alert.type] ?? TYPE_STYLES.ghost_class;
  const isResolved = alert.status === "resolved";

  return (
    <div style={{ ...s.card, ...(isResolved ? s.cardResolved : {}), ...(alert.severity === "red" && !isResolved ? s.cardRed : {}) }}>
      {/* Left stripe */}
      <div style={{ ...s.stripe, background: alert.severity === "red" ? "#dc2626" : "#ca8a04" }} />

      <div style={s.cardBody}>
        {/* Top row */}
        <div style={s.cardTop}>
          <div style={s.badgeRow}>
            <span style={{ ...s.typeBadge, ...typeStyle }}>{TYPE_LABELS[alert.type]}</span>
            <span style={{ ...s.severityBadge, ...severityStyle }}>
              {alert.severity === "red" ? "● Critical" : "◐ Warning"}
            </span>
            {isResolved && <span style={s.resolvedBadge}>✓ Resolved</span>}
          </div>
          <span style={s.timestamp}>{ts}</span>
        </div>

        {/* Message */}
        <div style={s.message}>{alert.message}</div>

        {/* Meta */}
        <div style={s.metaRow}>
          {alert.centerId && (
            <span style={s.metaChip}>Center: {alert.centerId.slice(0, 10)}…</span>
          )}
          {alert.studentId && (
            <span style={s.metaChip}>Student: {alert.studentId.slice(0, 10)}…</span>
          )}
          {alert.classId && (
            <span style={s.metaChip}>Class: {alert.classId.slice(0, 10)}…</span>
          )}
        </div>

        {/* Resolution info */}
        {isResolved && resolvedTs && (
          <div style={s.resolvedInfo}>
            Resolved {resolvedTs}{alert.resolvedBy ? ` by ${alert.resolvedBy.slice(0, 8)}…` : ""}
          </div>
        )}
      </div>

      {/* Resolve button */}
      {!isResolved && (
        <div style={s.cardAction}>
          <button
            onClick={onResolve}
            disabled={resolving}
            style={{ ...s.resolveBtn, opacity: resolving ? 0.6 : 1 }}
          >
            {resolving ? "…" : "Resolve"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Label + style maps ───────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  ghost_class:      "Ghost Class",
  revenue_leakage:  "Revenue Leakage",
  dormancy:         "Dormancy",
};

const TYPE_STYLES: Record<string, React.CSSProperties> = {
  ghost_class:     { background: "#fee2e2", color: "#991b1b" },
  revenue_leakage: { background: "#fef3c7", color: "#92400e" },
  dormancy:        { background: "#e0e7ff", color: "#3730a3" },
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header:       { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 },
  heading:      { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 },
  countRow:     { display: "flex", gap: 12, marginTop: 4 },
  redCount:     { fontSize: 12, fontWeight: 700, color: "#dc2626" },
  activeCount:  { fontSize: 12, color: "#6b7280" },
  detectBtn:    { background: "#111827", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const },

  filterCard:   { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "14px 18px", marginBottom: 20 },
  filterTitle:  { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 },
  filterRow:    { display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" as const },
  filterGroup:  { display: "flex", flexDirection: "column" as const, gap: 4 },
  label:        { fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.03em" },
  select:       { padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, color: "#111827", background: "#fff", outline: "none", minWidth: 140 },
  input:        { padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, color: "#111827", background: "#fff", outline: "none", minWidth: 160 },
  applyBtn:     { background: "#4f46e5", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },

  stateRow:     { padding: "40px 16px", textAlign: "center" as const, fontSize: 13, color: "var(--color-text-secondary)" },
  emptyState:   { padding: "48px 16px", textAlign: "center" as const },
  emptyIcon:    { fontSize: 36, color: "#16a34a", marginBottom: 8 },
  emptyText:    { fontSize: 14, color: "var(--color-text-secondary)" },

  alertList:    { display: "flex", flexDirection: "column" as const, gap: 10 },

  card:         { display: "flex", alignItems: "stretch", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  cardRed:      { borderColor: "#fca5a5", background: "#fff5f5" },
  cardResolved: { opacity: 0.7 },
  stripe:       { width: 4, flexShrink: 0 },
  cardBody:     { flex: 1, padding: "14px 16px" },
  cardTop:      { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  badgeRow:     { display: "flex", gap: 8, alignItems: "center" },
  typeBadge:    { padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700 },
  severityBadge:{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700 },
  severityRed:  { background: "#fee2e2", color: "#b91c1c" },
  severityYellow: { background: "#fef9c3", color: "#92400e" },
  resolvedBadge:{ background: "#dcfce7", color: "#15803d", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700 },
  timestamp:    { fontSize: 11, color: "#9ca3af", fontFamily: "monospace" },
  message:      { fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.5, marginBottom: 10 },
  metaRow:      { display: "flex", gap: 6, flexWrap: "wrap" as const },
  metaChip:     { background: "#f3f4f6", color: "#374151", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontFamily: "monospace" },
  resolvedInfo: { marginTop: 8, fontSize: 11, color: "#6b7280", fontStyle: "italic" as const },
  cardAction:   { display: "flex", alignItems: "center", padding: "0 16px", flexShrink: 0 },
  resolveBtn:   { background: "#16a34a", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const },
};
