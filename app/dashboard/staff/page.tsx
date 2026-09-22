"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useWing } from "@/hooks/useWing";
import { inWing } from "@/lib/wing";
import { getCached, setCached } from "@/lib/dataCache";
import { getStaffUsers, setParentChildren } from "@/services/staff/staff.service";
import type { User } from "@/types";

const ROLE_LABEL: Record<string, string> = {
  [ROLES.FOUNDER]: "Founder",
  [ROLES.ADMIN]: "Admin",
  [ROLES.DIRECTOR]: "Director",
  [ROLES.CHIEF_TEACHER]: "Chief Teacher",
  [ROLES.TEACHER]: "Teacher",
  [ROLES.PARENT]: "Parent",
};

export default function StaffPage() {
  return (
    <ProtectedRoute
      allowedRoles={[ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]}
      requiredCapability={CAPABILITIES.STAFF_VIEW}
    >
      <StaffContent />
    </ProtectedRoute>
  );
}

interface StudentOpt { uid: string; label: string }

function StaffContent() {
  const { wing } = useWing();

  // Seed from the last visit's cache so revisiting this page via the sidebar
  // renders instantly instead of a blank loading state — load() below still
  // always re-fetches to stay fresh.
  const [rows, setRows] = useState<User[]>(() => getCached<User[]>(`staff:${wing}:rows`) ?? []);
  const [students, setStudents] = useState<StudentOpt[]>(() => getCached(`staff:${wing}:students`) ?? []);
  const [loading, setLoading] = useState(() => !getCached<User[]>(`staff:${wing}:rows`));

  async function load() {
    const cachedRows = getCached<User[]>(`staff:${wing}:rows`);
    const cachedStudents = getCached<StudentOpt[]>(`staff:${wing}:students`);
    if (cachedRows) setRows(cachedRows);
    if (cachedStudents) setStudents(cachedStudents);
    setLoading(!cachedRows);
    try {
      const [staff, studentSnap] = await Promise.all([
        getStaffUsers(wing),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
      ]);
      setRows(staff);
      setCached(`staff:${wing}:rows`, staff);
      const studentOpts = studentSnap.docs
        .filter(d => inWing(d.data(), wing))
        .map(d => {
          const s = d.data();
          return {
            uid: d.id,
            label: `${(s.displayName ?? s.name ?? "—") as string}${s.studentID ? ` · ${s.studentID}` : ""}`,
          };
        });
      setStudents(studentOpts);
      setCached(`staff:${wing}:students`, studentOpts);
    } catch (err) {
      console.error("Staff load failed:", err);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [wing]);

  async function handleChildChange(parentUid: string, uids: string[]) {
    try {
      await setParentChildren(parentUid, uids);
      setRows(prev => prev.map(r => (r.uid === parentUid ? ({ ...r, childUids: uids } as User) : r)));
    } catch (err) {
      console.error("Failed to update children:", err);
    }
  }

  return (
    <div>
      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>Staff</h1>
          <p style={s.subtitle}>{WING_LABELS[wing] ?? "—"} · accounts &amp; roles</p>
        </div>
      </div>

      <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: -12, marginBottom: 20 }}>
        Leadership and parent accounts are created from the <strong>Users</strong> page. Centre assignment and
        performance tracking for teachers live on <strong>Enrollments → Teachers</strong>.
      </p>

      <div style={s.card}>
        <p style={s.cardTitle}>All staff <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({rows.length})</span></p>
        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={s.empty}>No staff accounts in this wing yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>{["Name", "Email", "Role", "Status", "Linked children"].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.uid} style={s.tr}>
                    <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>{r.displayName}</td>
                    <td style={s.td}>{r.email}</td>
                    <td style={s.td}><span style={s.roleChip}>{ROLE_LABEL[r.role] ?? r.role}</span></td>
                    <td style={s.td}>{r.status}</td>
                    <td style={s.td}>
                      {r.role === ROLES.PARENT ? (
                        <ChildPicker
                          compact
                          options={students}
                          value={("childUids" in r && Array.isArray(r.childUids) ? r.childUids : []) as string[]}
                          onChange={(uids) => handleChildChange(r.uid, uids)}
                        />
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ChildPicker({ options, value, onChange, compact }: {
  options: StudentOpt[]; value: string[]; onChange: (v: string[]) => void; compact?: boolean;
}) {
  function toggle(uid: string) {
    onChange(value.includes(uid) ? value.filter(u => u !== uid) : [...value, uid]);
  }
  if (options.length === 0) return <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No students in wing</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: compact ? 320 : undefined }}>
      {options.map(o => {
        const on = value.includes(o.uid);
        return (
          <button
            key={o.uid} type="button" onClick={() => toggle(o.uid)}
            style={{
              fontSize: 11, padding: "3px 9px", borderRadius: 99, cursor: "pointer",
              border: `1px solid ${on ? "#4f46e5" : "var(--color-border)"}`,
              background: on ? "#ede9fe" : "var(--color-surface-2)",
              color: on ? "#4338ca" : "var(--color-text-secondary)",
              fontWeight: on ? 700 : 500,
            }}
          >
            {on ? "✓ " : ""}{o.label}
          </button>
        );
      })}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  title: { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle: { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },
  card: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24, marginBottom: 24 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 20, marginTop: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr: { borderBottom: "1px solid var(--color-border)" },
  td: { padding: "12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },
  roleChip: { fontFamily: "monospace", fontSize: 12, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4 },
  empty: { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },
};
