"use client";

import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WING_LABELS } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { wingOf } from "@/lib/wing";

export default function AccountPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.MEMBER, ROLES.PARENT, ROLES.TEACHER]}>
      <AccountContent />
    </ProtectedRoute>
  );
}

function AccountContent() {
  const { user } = useAuth();
  if (!user) return null;

  const rows: Array<[string, string]> = [
    ["Name", user.displayName || "—"],
    ...(user.loginId ? [["Login ID", user.loginId] as [string, string]] : []),
    ["Email", user.email || "—"],
    ["Wing", WING_LABELS[wingOf(user)] ?? wingOf(user)],
    ["Role", user.role],
    ["Status", user.status],
  ];

  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      <h1 style={s.title}>My Account</h1>
      <div style={s.card}>
        {rows.map(([k, v]) => (
          <div key={k} style={s.row}>
            <span style={s.k}>{k}</span>
            <span style={s.v}>{v}</span>
          </div>
        ))}
      </div>
      <p style={s.note}>To change your password or details, contact the school office.</p>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  title: { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 16 },
  card: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "8px 20px" },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--color-border)", gap: 16 },
  k: { fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" },
  v: { fontSize: 14, color: "var(--color-text-primary)", fontWeight: 500, textAlign: "right", wordBreak: "break-all" },
  note: { fontSize: 12, color: "var(--color-text-muted)", marginTop: 16, textAlign: "center" },
};
