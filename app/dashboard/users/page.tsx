"use client";

import { useState, useEffect, useMemo, type FormEvent } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS, SOM_LOGIN_DOMAIN } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { useWing } from "@/hooks/useWing";
import { wingOf } from "@/lib/wing";
import {
  createMember, getAllUsers, setMemberStatus, isValidLoginId, normalizeLoginId,
} from "@/services/member/member.service";
import type { User } from "@/types";

const ROLE_LABEL: Record<string, string> = {
  [ROLES.FOUNDER]: "Founder",
  [ROLES.ADMIN]: "Admin",
  [ROLES.DIRECTOR]: "Director",
  [ROLES.CHIEF_TEACHER]: "Chief Teacher",
  [ROLES.TEACHER]: "Teacher",
  [ROLES.STUDENT]: "Student",
  [ROLES.PARENT]: "Parent",
  [ROLES.MEMBER]: "Member",
  pending: "Pending",
};

// Top-level sections, and the two sub-pages inside "Staff".
type Section = "staff" | "students";
type StaffView = "teachers" | "admins";
type Group = "teacher" | "student" | "admin";

/** Which group a role belongs to. */
function groupOf(role: string): Group {
  if (role === ROLES.TEACHER) return "teacher";
  if (role === ROLES.STUDENT) return "student";
  return "admin"; // founder / admin / director / chief_teacher / member / parent / pending
}

/** Soft-deleted users are hidden from this page entirely. */
function isDeleted(u: { status?: unknown }): boolean {
  return u.status === "deleted";
}

/** Anything other than a live "active" account counts as inactive here. */
function isActiveUser(u: { status?: unknown }): boolean {
  return u.status === "active";
}

const ADMIN_ROLE_ORDER = [
  ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.MEMBER, ROLES.PARENT,
];

export default function UsersPage() {
  return (
    <ProtectedRoute
      allowedRoles={[ROLES.FOUNDER]}
      requiredCapability={CAPABILITIES.USERS_MANAGE}
    >
      <UsersContent />
    </ProtectedRoute>
  );
}

function UsersContent() {
  const { user } = useAuth();
  const { wing } = useWing();
  const isSom = wing === WINGS.SCHOOL_OF_MUSIC;

  const [section, setSection] = useState<Section>("staff");
  const [staffView, setStaffView] = useState<StaffView>("teachers");
  const [rows, setRows] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [wingFilter, setWingFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRows(await getAllUsers());
    } catch (err) {
      console.error("Users load failed:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const inWingFilter = (r: User) =>
    wingFilter === "all" || wingOf(r as { wing?: unknown }) === wingFilter;

  const counts = useMemo(() => {
    const c: Record<Group, number> = { teacher: 0, student: 0, admin: 0 };
    for (const r of rows) {
      if (isDeleted(r) || !inWingFilter(r)) continue;
      c[groupOf(r.role)]++;
    }
    return c;
  }, [rows, wingFilter]);

  // The group currently on screen.
  const currentGroup: Group =
    section === "students" ? "student" : staffView === "teachers" ? "teacher" : "admin";

  const visible = useMemo(() => {
    const list = rows.filter(
      r => groupOf(r.role) === currentGroup && inWingFilter(r) && !isDeleted(r),
    );
    return [...list].sort((a, b) => {
      if (currentGroup === "admin") {
        const ra = ADMIN_ROLE_ORDER.indexOf(a.role as never);
        const rb = ADMIN_ROLE_ORDER.indexOf(b.role as never);
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      }
      return (a.displayName ?? "").localeCompare(b.displayName ?? "");
    });
  }, [rows, currentGroup, wingFilter]);

  const activeRows = useMemo(() => visible.filter(isActiveUser), [visible]);
  const inactiveRows = useMemo(() => visible.filter(r => !isActiveUser(r)), [visible]);

  const showAddButton = section === "staff" && staffView === "admins" && isSom;

  function reset() {
    setName(""); setEmail(""); setLoginId(""); setPassword("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!name.trim()) return setMsg({ kind: "err", text: "Name is required." });
    if (!isValidLoginId(loginId)) return setMsg({ kind: "err", text: "Login ID: 3–32 chars — letters, numbers, . _ - , starting and ending with a letter or number." });
    if (password.length < 6) return setMsg({ kind: "err", text: "Password must be at least 6 characters." });

    setBusy(true);
    try {
      await createMember(
        {
          displayName: name.trim(),
          email: email.trim(),
          loginId: normalizeLoginId(loginId),
          password,
          wing: WINGS.SCHOOL_OF_MUSIC,
        },
        user?.uid ?? "unknown",
        user?.role ?? ROLES.FOUNDER,
      );
      setMsg({ kind: "ok", text: `User "${normalizeLoginId(loginId)}" created. They sign in with their Login ID and password.` });
      reset();
      setShowForm(false);
      load();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Creation failed.";
      const text = raw.startsWith("LOGIN_ID_IN_USE") ? "That Login ID is already taken."
        : raw.includes("email-already-in-use") ? "That Login ID is already registered."
        : raw;
      setMsg({ kind: "err", text });
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(m: User) {
    if (m.role !== ROLES.MEMBER) return;
    const next = m.status === "active" ? "inactive" : "active";
    try {
      await setMemberStatus(m.uid, next);
      setRows(prev => prev.map(r => (r.uid === m.uid ? ({ ...r, status: next } as User) : r)));
    } catch (err) {
      console.error("Status toggle failed:", err);
    }
  }

  const groupLabel: Record<Group, string> = { teacher: "Teachers", student: "Students", admin: "Admins" };
  const title = groupLabel[currentGroup];

  return (
    <div>
      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>Users</h1>
          <p style={s.subtitle}>Staff (teachers &amp; admins) and students</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={wingFilter} onChange={e => setWingFilter(e.target.value)} style={s.select}>
            <option value="all">All wings</option>
            <option value={WINGS.ROL_PLUS}>{WING_LABELS[WINGS.ROL_PLUS]}</option>
            <option value={WINGS.SCHOOL_OF_MUSIC}>{WING_LABELS[WINGS.SCHOOL_OF_MUSIC]}</option>
          </select>
          {showAddButton && (
            <button style={showForm ? s.btnGhost : s.btnPrimary} onClick={() => { setShowForm(v => !v); setMsg(null); }}>
              {showForm ? "✕ Cancel" : "+ Add User"}
            </button>
          )}
        </div>
      </div>

      {/* Top-level sections */}
      <div style={s.tabs}>
        <button
          onClick={() => { setSection("staff"); setShowForm(false); setMsg(null); }}
          style={{ ...s.tab, ...(section === "staff" ? s.tabActive : {}) }}
        >
          <span>🪪</span><span>Staff</span>
          <span style={s.tabCount}>{counts.teacher + counts.admin}</span>
        </button>
        <button
          onClick={() => { setSection("students"); setShowForm(false); setMsg(null); }}
          style={{ ...s.tab, ...(section === "students" ? s.tabActive : {}) }}
        >
          <span>🎒</span><span>Students</span>
          <span style={s.tabCount}>{counts.student}</span>
        </button>
      </div>

      {/* Staff sub-pages */}
      {section === "staff" && (
        <div style={s.subTabs}>
          <button
            onClick={() => { setStaffView("teachers"); setShowForm(false); setMsg(null); }}
            style={{ ...s.subTab, ...(staffView === "teachers" ? s.subTabActive : {}) }}
          >
            🎓 Teachers <span style={s.tabCount}>{counts.teacher}</span>
          </button>
          <button
            onClick={() => { setStaffView("admins"); setShowForm(false); setMsg(null); }}
            style={{ ...s.subTab, ...(staffView === "admins" ? s.subTabActive : {}) }}
          >
            🪪 Admins <span style={s.tabCount}>{counts.admin}</span>
          </button>
        </div>
      )}

      {msg && <div style={msg.kind === "ok" ? s.bannerOk : s.bannerErr}>{msg.text}</div>}

      {showAddButton && showForm && (
        <form style={s.card} onSubmit={handleSubmit}>
          <p style={s.cardTitle}>New login-id user (School of Music)</p>
          <div style={s.grid2}>
            <Field label="Name">
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Anil Kumar" />
            </Field>
            <Field label="Email ID">
              <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="anil@example.com (contact only)" />
            </Field>
            <Field label="Login ID">
              <input
                style={{ ...s.input, fontFamily: "monospace" }}
                value={loginId}
                onChange={e => setLoginId(e.target.value.replace(/\s/g, ""))}
                placeholder="anilkumar"
                autoCapitalize="none"
                spellCheck={false}
              />
              <span style={s.hint}>
                Signs in as <strong>{normalizeLoginId(loginId) || "loginid"}</strong>
                <span style={{ color: "var(--color-text-muted)" }}> · stored as {normalizeLoginId(loginId) || "loginid"}@{SOM_LOGIN_DOMAIN}</span>
              </span>
            </Field>
            <Field label="Password">
              <div style={{ position: "relative" }}>
                <input
                  style={{ ...s.input, paddingRight: 52 }}
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 6 characters"
                />
                <button type="button" tabIndex={-1} onClick={() => setShowPw(v => !v)} style={s.showHide}>
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
            <button type="button" style={s.btnGhost} onClick={() => { setShowForm(false); reset(); }}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Creating…" : "Create User"}
            </button>
          </div>
        </form>
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : currentGroup === "admin" ? (
          <SectionTable
            title={title}
            group={currentGroup}
            rows={visible}
            emptyText={`No ${title.toLowerCase()} found.`}
            onToggle={toggleStatus}
          />
        ) : (
          <>
            <SectionTable
              title={`Active ${title}`}
              group={currentGroup}
              rows={activeRows}
              emptyText={`No active ${title.toLowerCase()}.`}
              onToggle={toggleStatus}
            />
            <SectionTable
              title={`Inactive ${title}`}
              group={currentGroup}
              rows={inactiveRows}
              emptyText={`No inactive ${title.toLowerCase()}.`}
              onToggle={toggleStatus}
            />
          </>
        )}

        <p style={s.foot}>
          {currentGroup === "teacher" && <>Teachers are created and assigned to centres on the <strong>Teachers</strong> and <strong>Staff</strong> screens.</>}
          {currentGroup === "student" && <>Students are enrolled through <strong>Admissions</strong> (School of Music) or the <strong>Students</strong> screen (ROL+).</>}
          {currentGroup === "admin" && <>Leadership roles are managed on the <strong>Staff</strong> screen; only login-id users are created and deactivated here.</>}
        </p>
      </div>
    </div>
  );
}

function SectionTable({ title, group, rows, emptyText, onToggle }: {
  title: string;
  group: Group;
  rows: User[];
  emptyText: string;
  onToggle: (u: User) => void;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <p style={s.cardTitle}>
        {title} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({rows.length})</span>
      </p>
      {rows.length === 0 ? (
        <div style={s.emptySmall}>{emptyText}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={s.table}>
            <thead>
              <tr>{headersFor(group).map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((m, i) => <Row key={m.uid} sl={i + 1} u={m} group={group} onToggle={() => onToggle(m)} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function headersFor(group: Group): string[] {
  if (group === "student") return ["Sl No", "Name", "Login ID", "Password", "Wing", "Status"];
  if (group === "teacher") return ["Sl No", "Name", "Login ID", "Password", "Wing", "Status"];
  return ["Sl No", "Name", "Login ID", "Password", "Role", "Wing", "Status", ""];
}

/** A trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function Row({ sl, u, group, onToggle }: { sl: number; u: User; group: Group; onToggle: () => void }) {
  const rec = u as unknown as Record<string, unknown>;
  const loginId = str(rec.loginId);
  const studentID = str(rec.studentID);
  const admissionNo = str(rec.admissionNumber) ?? str(rec.admissionNo);
  const plainPassword = str(rec.plainPassword);

  const loginCell =
    group === "student"
      ? (studentID ?? admissionNo ?? str(rec.email))
      : (loginId ?? str(rec.email));
  const passwordCell =
    group === "student" ? (admissionNo ?? studentID) : plainPassword;

  return (
    <tr style={s.tr}>
      <td style={{ ...s.td, color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>{sl}</td>
      <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>{u.displayName || "—"}</td>
      <td style={s.td}>{loginCell ? <span style={s.code}>{loginCell}</span> : "—"}</td>
      <td style={s.td}>
        {passwordCell
          ? <span style={s.code}>{passwordCell}</span>
          : <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>not stored</span>}
      </td>
      {group === "admin" && (
        <td style={s.td}><span style={s.roleChip}>{ROLE_LABEL[u.role] ?? u.role}</span></td>
      )}
      <td style={s.td}>{WING_LABELS[wingOf(u as { wing?: unknown })] ?? "—"}</td>
      <td style={s.td}>
        <span style={u.status === "active" ? s.badgeOk : s.badgeOff}>{u.status ?? "inactive"}</span>
      </td>
      {group === "admin" && (
        <td style={{ ...s.td, textAlign: "right" }}>
          {u.role === ROLES.MEMBER
            ? <button style={s.linkBtn} onClick={onToggle}>{u.status === "active" ? "Deactivate" : "Reactivate"}</button>
            : <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>—</span>}
        </td>
      )}
    </tr>
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

const s: Record<string, React.CSSProperties> = {
  headerRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 12, flexWrap: "wrap" },
  title: { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle: { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },
  btnPrimary: { padding: "9px 18px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnGhost: { padding: "9px 18px", background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },
  tabs: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  tab: { display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  tabActive: { background: "#ede9fe", borderColor: "#4f46e5", color: "#4338ca" },
  tabCount: { fontSize: 11, fontWeight: 700, background: "rgba(0,0,0,0.06)", borderRadius: 99, padding: "1px 7px" },
  subTabs: { display: "flex", gap: 6, marginBottom: 20, marginLeft: 4, borderLeft: "2px solid var(--color-border)", paddingLeft: 12 },
  subTab: { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", background: "transparent", color: "var(--color-text-secondary)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  subTabActive: { background: "var(--color-surface-2)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" },
  bannerOk: { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
  bannerErr: { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },
  card: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24, marginBottom: 24 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 20, marginTop: 0 },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" },
  input: { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 12px", fontSize: 14, color: "var(--color-text-primary)", outline: "none", width: "100%", boxSizing: "border-box" },
  select: { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "var(--color-text-primary)", cursor: "pointer" },
  hint: { fontSize: 11, color: "var(--color-text-secondary)" },
  showHide: { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer", padding: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr: { borderBottom: "1px solid var(--color-border)" },
  td: { padding: "12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },
  code: { fontFamily: "monospace", fontSize: 12, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4 },
  roleChip: { fontSize: 11, fontWeight: 600, background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", padding: "2px 8px", borderRadius: 99 },
  badgeOk: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f0fdf4", color: "#166534" },
  badgeOff: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f3f4f6", color: "#6b7280" },
  linkBtn: { padding: "5px 12px", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  empty: { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },
  emptySmall: { padding: "14px 0 20px", color: "var(--color-text-muted)", fontSize: 13 },
  foot: { fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 14, marginBottom: 0, lineHeight: 1.5 },
};
