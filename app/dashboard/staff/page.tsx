"use client";

import { useState, useEffect, useMemo, type FormEvent } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { useWing } from "@/hooks/useWing";
import { inWing } from "@/lib/wing";
import { createStaffUser, getStaffUsers, setParentChildren, type StaffRole } from "@/services/staff/staff.service";
import { createTeacher } from "@/services/teacher/teacher.service";
import { TeachersContent } from "@/app/dashboard/teachers/manager";
import { AdminsContent } from "@/app/dashboard/admins/manager";
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
      <StaffShell />
    </ProtectedRoute>
  );
}

type StaffTab = "staff" | "teachers" | "admins";

function StaffShell() {
  const { user } = useAuth();
  const [tab, setTab] = useState<StaffTab>("staff");
  const showAdmins = user?.role === ROLES.FOUNDER;

  const tabs: { key: StaffTab; label: string; icon: string }[] = [
    { key: "staff", label: "Staff", icon: "🪪" },
    { key: "teachers", label: "Teachers", icon: "👥" },
    ...(showAdmins ? [{ key: "admins" as StaffTab, label: "Admins", icon: "👤" }] : []),
  ];

  return (
    <div>
      <div style={s.shellTabs}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{ ...s.shellTab, ...(t.key === tab ? s.shellTabActive : {}) }}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === "staff" && <StaffContent />}
      {tab === "teachers" && <TeachersContent />}
      {tab === "admins" && showAdmins && <AdminsContent />}
    </div>
  );
}

interface StudentOpt { uid: string; label: string }

function StaffContent() {
  const { user, can } = useAuth();
  const { wing } = useWing();

  const [rows, setRows] = useState<User[]>([]);
  const [students, setStudents] = useState<StudentOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<StaffRole | typeof ROLES.TEACHER | "">("");
  const [childUids, setChildUids] = useState<string[]>([]);

  // which roles this user may create
  const creatable = useMemo(() => {
    const list: Array<{ value: StaffRole | typeof ROLES.TEACHER; label: string }> = [];
    if (can(CAPABILITIES.STAFF_CREATE_DIRECTOR)) list.push({ value: ROLES.DIRECTOR, label: "Director" });
    if (can(CAPABILITIES.STAFF_CREATE_CHIEF_TEACHER)) list.push({ value: ROLES.CHIEF_TEACHER, label: "Chief Teacher" });
    if (can(CAPABILITIES.STAFF_CREATE_TEACHER)) list.push({ value: ROLES.TEACHER, label: "Teacher" });
    if (can(CAPABILITIES.STAFF_CREATE_PARENT)) list.push({ value: ROLES.PARENT, label: "Parent" });
    return list;
  }, [can]);

  async function load() {
    setLoading(true);
    try {
      const [staff, studentSnap] = await Promise.all([
        getStaffUsers(wing),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
      ]);
      setRows(staff);
      setStudents(
        studentSnap.docs
          .filter(d => inWing(d.data(), wing))
          .map(d => {
            const s = d.data();
            return {
              uid: d.id,
              label: `${(s.displayName ?? s.name ?? "—") as string}${s.studentID ? ` · ${s.studentID}` : ""}`,
            };
          }),
      );
    } catch (err) {
      console.error("Staff load failed:", err);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [wing]);

  function resetForm() {
    setName(""); setEmail(""); setPassword(""); setRole(""); setChildUids([]);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!name.trim()) return setMsg({ kind: "err", text: "Name is required." });
    if (!email.trim()) return setMsg({ kind: "err", text: "Email is required." });
    if (password.length < 6) return setMsg({ kind: "err", text: "Password must be at least 6 characters." });
    if (!role) return setMsg({ kind: "err", text: "Pick a role." });

    setBusy(true);
    try {
      if (role === ROLES.TEACHER) {
        await createTeacher(
          { displayName: name.trim(), email: email.trim(), password, centerIds: [], wing },
          user?.uid ?? "unknown",
          user?.role ?? ROLES.FOUNDER,
        );
      } else {
        await createStaffUser(
          {
            displayName: name.trim(),
            email: email.trim(),
            password,
            role: role as StaffRole,
            wing,
            childUids: role === ROLES.PARENT ? childUids : undefined,
          },
          user?.uid ?? "unknown",
          user?.role ?? ROLES.FOUNDER,
        );
      }
      setMsg({ kind: "ok", text: `${ROLE_LABEL[role]} account created.` });
      resetForm();
      setShowForm(false);
      load();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Creation failed." });
    } finally {
      setBusy(false);
    }
  }

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
        {creatable.length > 0 && (
          <button style={showForm ? s.btnGhost : s.btnPrimary} onClick={() => { setShowForm(v => !v); setMsg(null); }}>
            {showForm ? "✕ Cancel" : "+ Add Staff"}
          </button>
        )}
      </div>

      {msg && <div style={msg.kind === "ok" ? s.bannerOk : s.bannerErr}>{msg.text}</div>}

      {showForm && (
        <form style={s.card} onSubmit={handleSubmit}>
          <div style={s.grid2}>
            <Field label="Full Name">
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Priya Nair" />
            </Field>
            <Field label="Role">
              <select style={s.input} value={role} onChange={e => setRole(e.target.value as StaffRole)}>
                <option value="">— Select —</option>
                {creatable.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Email">
              <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
            </Field>
            <Field label="Password">
              <input style={s.input} type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 6 characters" />
            </Field>
          </div>

          {role === ROLES.PARENT && (
            <Field label="Linked children">
              <ChildPicker options={students} value={childUids} onChange={setChildUids} />
            </Field>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
            <button type="button" style={s.btnGhost} onClick={() => { setShowForm(false); resetForm(); }}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Creating…" : "Create Account"}
            </button>
          </div>
        </form>
      )}

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      {children}
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
  shellTabs: { display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" },
  shellTab: { display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  shellTabActive: { background: "#ede9fe", borderColor: "#4f46e5", color: "#4338ca" },
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  title: { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle: { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },
  btnPrimary: { padding: "9px 18px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnGhost: { padding: "9px 18px", background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },
  bannerOk: { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
  bannerErr: { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },
  card: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24, marginBottom: 24 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 20, marginTop: 0 },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px", marginBottom: 16 },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" },
  input: { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 12px", fontSize: 14, color: "var(--color-text-primary)", outline: "none", width: "100%", boxSizing: "border-box" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr: { borderBottom: "1px solid var(--color-border)" },
  td: { padding: "12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },
  roleChip: { fontFamily: "monospace", fontSize: 12, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4 },
  empty: { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },
};
