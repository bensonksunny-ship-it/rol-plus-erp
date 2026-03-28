"use client";

import { useAuth } from "@/hooks/useAuth";
import { ROLES } from "@/config/constants";
import ProtectedRoute from "@/components/layout/ProtectedRoute";

export default function DashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <DashboardContent />
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div>
      <h1 style={styles.heading}>Welcome, {user.displayName}</h1>
      <p style={styles.subheading}>
        {new Date().toLocaleDateString("en-IN", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })}
      </p>

      <div style={styles.grid}>
        <StatCard label="Your role"    value={user.role.replace("_", " ")} />
        <StatCard label="Account"      value={user.status} />
        <StatCard label="Last activity" value={user.lastActivity
          ? new Date(user.lastActivity).toLocaleDateString("en-IN")
          : "—"} />
      </div>

      <div style={styles.notice}>
        <strong>Phase 1 — Step 4</strong> complete. Firebase auth is wired.
        Fill in <code>.env.local</code> with your Firebase project keys to connect to a live project.
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardLabel}>{label}</div>
      <div style={styles.cardValue}>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: {
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 6,
    color: "var(--color-text-primary)",
  },
  subheading: {
    fontSize: 13,
    color: "var(--color-text-secondary)",
    marginBottom: 28,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 14,
    marginBottom: 28,
  },
  card: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    padding: "16px 18px",
  },
  cardLabel: {
    fontSize: 12,
    color: "var(--color-text-secondary)",
    marginBottom: 6,
    textTransform: "capitalize",
  },
  cardValue: {
    fontSize: 18,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    textTransform: "capitalize",
  },
  notice: {
    fontSize: 13,
    color: "var(--color-text-secondary)",
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: 8,
    padding: "12px 16px",
    lineHeight: 1.6,
  },
};