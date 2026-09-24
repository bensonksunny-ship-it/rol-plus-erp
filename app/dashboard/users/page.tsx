"use client";

import { useState, useEffect, useMemo, type FormEvent } from "react";
import Link from "next/link";
import { collection, getDocs, query, where, type QuerySnapshot, type DocumentData } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS, SOM_LOGIN_DOMAIN } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { getRolesForWing, getUserWings, inWing, wingOf } from "@/lib/wing";
import { cachedFetch, getCached, invalidateCache, setCached } from "@/lib/dataCache";
import {
  createMember, createLoginForUser, getAllUsers, setMemberStatus, setWingRoles,
  isValidLoginId, normalizeLoginId,
} from "@/services/member/member.service";
import { setParentChildren } from "@/services/staff/staff.service";
import { resetUserPassword } from "@/services/admin/password.service";
import type { Role, User, Wing } from "@/types";

const ASSIGNABLE_ROLES: Role[] = [
  ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.TEACHER, ROLES.PARENT, ROLES.MEMBER,
];

interface StudentOpt { uid: string; wing: Wing; label: string }

const ALL_WINGS: Wing[] = [WINGS.ROL_PLUS, WINGS.SCHOOL_OF_MUSIC];

interface WingRolePair { wing: Wing; roles: Role[] }

/** ASSIGNABLE_ROLES-privilege order, so the first entry is the most senior role held. */
function sortRoles(roles: Role[]): Role[] {
  return [...roles].sort((a, b) => ASSIGNABLE_ROLES.indexOf(a) - ASSIGNABLE_ROLES.indexOf(b));
}

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

// Top-level sections.
type Section = "staff" | "students";
// Per-role classification, used for counts and sorting.
type Group = "teacher" | "student" | "admin";
// What's rendered on screen — Staff now shows teachers and admins together.
type ViewGroup = "staff" | "student";

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

/**
 * Auto-generated placeholder from a bulk import or an enrollment/screening
 * wizard (Registry import, Admissions wizard, screening "complete admission"
 * enroll) — a business record that belongs to its own module, not a system
 * user.
 *
 * `createdVia` is authoritative when present. Records written before that
 * field existed fall back to a data-shape check: only the Registry import,
 * Admissions wizard, and screening enroll ever write an `admissionNumber`
 * field — the manual "New Student" form has only ever used `admissionNo`
 * (no "ber"). This lets legacy bulk-imported students be excluded without a
 * data migration; a manually created student is never misclassified since
 * `admissionNumber` doesn't exist on that path at all.
 */
function isImported(u: { createdVia?: unknown; admissionNumber?: unknown }): boolean {
  if (u.createdVia === "manual") return false;
  if (u.createdVia === "import") return true;
  return typeof u.admissionNumber === "string" && u.admissionNumber.trim() !== "";
}

/**
 * Whether this account has a real Firebase Auth login. `hasLogin` is
 * authoritative when present (every account created since this field existed
 * sets it explicitly). Records predating it fall back by role: every
 * teacher/admin/staff/member creation path was atomic-with-login until this
 * change, so they're treated as having one; a student is treated as having
 * one unless it's an auto-imported placeholder (which never had a login).
 */
function hasLogin(u: { role: string; hasLogin?: unknown; createdVia?: unknown; admissionNumber?: unknown }): boolean {
  if (typeof u.hasLogin === "boolean") return u.hasLogin;
  if (u.role === ROLES.STUDENT) return !isImported(u);
  return true;
}

/**
 * A role change for `wing` (via "Manage roles" or the "New user" form) can
 * add/remove someone from the Teachers/Staff lists on other pages — drop
 * those pages' cached data so their next visit re-fetches instead of
 * flashing pre-change data (see lib/dataCache.ts).
 */
function invalidateRoleCaches(wing: Wing) {
  invalidateCache(`teachers:${wing}:teachers`);
  invalidateCache(`staff:${wing}:rows`);
}

/** Anything other than a live "active" account counts as inactive here. */
function isActiveUser(u: { status?: unknown }): boolean {
  return u.status === "active";
}

// Display order for the unified Staff table — leadership first, then teaching staff.
const STAFF_ROLE_ORDER = [
  ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.TEACHER, ROLES.MEMBER, ROLES.PARENT,
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

  const [section, setSection] = useState<Section>("staff");
  const [rows, setRows] = useState<User[]>([]);
  const [students, setStudents] = useState<StudentOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [wingFilter, setWingFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loginId, setLoginId] = useState("");
  const [authMethod, setAuthMethod] = useState<"loginId" | "email">("loginId");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [newPairs, setNewPairs] = useState<WingRolePair[]>([]);
  const [newChildUids, setNewChildUids] = useState<string[]>([]);
  const [manageTarget, setManageTarget] = useState<User | null>(null);
  const [loginTarget, setLoginTarget] = useState<User | null>(null);
  const [resetPwTarget, setResetPwTarget] = useState<User | null>(null);
  const [childrenTarget, setChildrenTarget] = useState<User | null>(null);

  function mapStudentOpts(studentSnap: QuerySnapshot<DocumentData>): StudentOpt[] {
    return studentSnap.docs.map(d => {
      const s = d.data();
      return {
        uid: d.id,
        wing: wingOf(s as { wing?: unknown }),
        label: `${(s.displayName ?? s.name ?? "—") as string}${s.studentID ? ` · ${s.studentID}` : ""}`,
      };
    });
  }

  async function load() {
    // Render last-known data instantly (if any) instead of a blank loading
    // state while this re-fetches — the fetch below still always runs to
    // keep the page fresh.
    const cachedRows = getCached<User[]>("users:all");
    const cachedStudents = getCached<StudentOpt[]>("users:studentOpts");
    if (cachedRows) setRows(cachedRows);
    if (cachedStudents) setStudents(cachedStudents);
    setLoading(!cachedRows);
    try {
      const [users, studentSnap] = await Promise.all([
        cachedFetch("users:all", getAllUsers),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
      ]);
      setRows(users);
      const studentOpts = mapStudentOpts(studentSnap);
      setCached("users:studentOpts", studentOpts);
      setStudents(studentOpts);
    } catch (err) {
      console.error("Users load failed:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Roles this user holds within the current wing filter — "All wings" means
  // every wing they have a role in; a specific wing means just that wing's role
  // (which may differ from their home `role` once they've been given a second
  // wing's role via "Manage Roles").
  const rolesInFilter = (r: User): Role[] => {
    if (wingFilter === "all") {
      return getUserWings(r).flatMap(w => getRolesForWing(r, w));
    }
    return getRolesForWing(r, wingFilter as Wing);
  };

  const groupsFor = (r: User): Group[] =>
    Array.from(new Set(rolesInFilter(r).map(groupOf)));

  const inWingFilter = (r: User) =>
    wingFilter === "all" || getUserWings(r).includes(wingFilter as Wing);

  const counts = useMemo(() => {
    const c: Record<Group, number> = { teacher: 0, student: 0, admin: 0 };
    for (const r of rows) {
      if (isDeleted(r) || isImported(r) || !inWingFilter(r)) continue;
      for (const g of groupsFor(r)) c[g]++;
    }
    return c;
  }, [rows, wingFilter]);

  // The view currently on screen — Staff shows teachers and admins together.
  const currentGroup: ViewGroup = section === "students" ? "student" : "staff";

  const visible = useMemo(() => {
    const list = rows.filter(r => {
      if (isDeleted(r) || isImported(r) || !inWingFilter(r)) return false;
      const groups = groupsFor(r);
      return currentGroup === "student" ? groups.includes("student") : groups.some(g => g !== "student");
    });
    return [...list].sort((a, b) => {
      if (currentGroup === "staff") {
        const ra = STAFF_ROLE_ORDER.indexOf(rolesInFilter(a)[0] as never);
        const rb = STAFF_ROLE_ORDER.indexOf(rolesInFilter(b)[0] as never);
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      }
      return (a.displayName ?? "").localeCompare(b.displayName ?? "");
    });
  }, [rows, currentGroup, wingFilter]);

  const activeRows = useMemo(() => visible.filter(isActiveUser), [visible]);
  const inactiveRows = useMemo(() => visible.filter(r => !isActiveUser(r)), [visible]);

  const showAddButton = section === "staff"; // Teachers and Admins sub-tabs both support the login-id form below

  function reset() {
    setName(""); setEmail(""); setLoginId(""); setAuthMethod("loginId"); setPassword("");
    setNewPairs([]); setNewChildUids([]);
  }

  const newParentWing = newPairs.find(p => p.roles.includes(ROLES.PARENT))?.wing ?? null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!name.trim()) return setMsg({ kind: "err", text: "Name is required." });
    if (authMethod === "loginId") {
      if (!isValidLoginId(loginId)) return setMsg({ kind: "err", text: "Login ID: 3–32 chars — letters, numbers, . _ - , starting and ending with a letter or number." });
    } else if (!email.trim()) {
      return setMsg({ kind: "err", text: "Email is required to sign in with an email address." });
    }
    if (password.length < 6) return setMsg({ kind: "err", text: "Password must be at least 6 characters." });
    if (newPairs.length === 0) return setMsg({ kind: "err", text: "Assign at least one wing and role." });

    setBusy(true);
    try {
      const [primary, ...rest] = newPairs;
      const { uid } = await createMember(
        {
          displayName: name.trim(),
          email: email.trim(),
          authMethod,
          loginId: authMethod === "loginId" ? normalizeLoginId(loginId) : undefined,
          password,
          wing: primary.wing,
          role: primary.roles[0],
        },
        user?.uid ?? "unknown",
        user?.role ?? ROLES.FOUNDER,
      );
      await setWingRoles(uid, primary.wing, primary.roles);
      invalidateRoleCaches(primary.wing);
      for (const p of rest) { await setWingRoles(uid, p.wing, p.roles); invalidateRoleCaches(p.wing); }
      if (newParentWing && newChildUids.length > 0) await setParentChildren(uid, newChildUids);
      setMsg({
        kind: "ok",
        text: authMethod === "loginId"
          ? `User "${normalizeLoginId(loginId)}" created. They sign in with their Login ID and password.`
          : `User created. They sign in with ${email.trim()} and their password.`,
      });
      reset();
      setShowForm(false);
      load();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Creation failed.";
      const text = raw.startsWith("LOGIN_ID_IN_USE") ? "That Login ID is already taken."
        : raw.startsWith("EMAIL_IN_USE") ? "That email is already registered."
        : raw.includes("email-already-in-use") ? "That email is already registered."
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

  const groupLabel: Record<ViewGroup, string> = { staff: "Staff", student: "Students" };
  const title = groupLabel[currentGroup];

  return (
    <div className="mx-auto max-w-[950px]">
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
            <button
              style={showForm ? s.btnGhost : s.btnPrimary}
              onClick={() => {
                if (!showForm) reset(); // always open the form blank — never pre-filled
                setShowForm(v => !v);
                setMsg(null);
              }}
            >
              {showForm ? "✕ Cancel" : "+ Add User"}
            </button>
          )}
          {section === "students" && (
            <Link href="/dashboard/enrollments?view=students" style={{ textDecoration: "none" }}>
              <button type="button" style={s.btnPrimary}>+ Add Student</button>
            </Link>
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

      {msg && <div style={msg.kind === "ok" ? s.bannerOk : s.bannerErr}>{msg.text}</div>}

      {showAddButton && showForm && (
        <form style={s.card} onSubmit={handleSubmit} autoComplete="off">
          <p style={s.cardTitle}>New user</p>
          <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="radio" checked={authMethod === "loginId"} onChange={() => setAuthMethod("loginId")} />
              Sign in with a Login ID
            </label>
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="radio" checked={authMethod === "email"} onChange={() => setAuthMethod("email")} />
              Sign in with Email (e.g. Gmail)
            </label>
          </div>
          <div style={s.grid2}>
            <Field label="Name">
              <input style={s.input} name="new-user-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Anil Kumar" autoComplete="off" />
            </Field>
            <Field label={authMethod === "email" ? "Email ID (used to sign in)" : "Email ID"}>
              <input
                style={s.input}
                name="new-user-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="anil@gmail.com"
                autoComplete="off"
              />
              {authMethod === "email" && (
                <span style={s.hint}>Signs in with <strong>{email.trim() || "their email"}</strong> and their password.</span>
              )}
            </Field>
            {authMethod === "loginId" && (
              <Field label="Login ID">
                <input
                  style={{ ...s.input, fontFamily: "monospace" }}
                  name="new-user-loginid"
                  value={loginId}
                  onChange={e => setLoginId(e.target.value.replace(/\s/g, ""))}
                  placeholder="anilkumar"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span style={s.hint}>
                  Signs in as <strong>{normalizeLoginId(loginId) || "loginid"}</strong>
                  <span style={{ color: "var(--color-text-muted)" }}> · stored as {normalizeLoginId(loginId) || "loginid"}@{SOM_LOGIN_DOMAIN}</span>
                </span>
              </Field>
            )}
            <Field label="Password">
              <div style={{ position: "relative" }}>
                <input
                  style={{ ...s.input, paddingRight: 52 }}
                  name="new-user-password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 6 characters"
                  autoComplete="new-password"
                />
                <button type="button" tabIndex={-1} onClick={() => setShowPw(v => !v)} style={s.showHide}>
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
          </div>
          <div style={{ marginTop: 4 }}>
            <label style={s.label}>Wing &amp; Role *</label>
            <div style={{ marginTop: 6 }}>
              <WingRolePicker pairs={newPairs} onChange={setNewPairs} />
            </div>
          </div>
          {newParentWing && (
            <div style={{ marginTop: 12 }}>
              <label style={s.label}>Linked children</label>
              <div style={{ marginTop: 6 }}>
                <ChildPicker
                  options={students.filter(st => inWing(st, newParentWing))}
                  value={newChildUids}
                  onChange={setNewChildUids}
                />
              </div>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
            <button type="button" style={s.btnGhost} onClick={() => { setShowForm(false); reset(); }}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Creating…" : "Create User"}
            </button>
          </div>
        </form>
      )}

      {manageTarget && (
        <ManageRolesModal
          target={manageTarget}
          onClose={() => setManageTarget(null)}
          onSaved={async () => { setManageTarget(null); await load(); }}
        />
      )}

      {loginTarget && (
        <CreateLoginModal
          target={loginTarget}
          onClose={() => setLoginTarget(null)}
          onCreated={async () => { setLoginTarget(null); await load(); }}
        />
      )}

      {resetPwTarget && (
        <ResetPasswordModal
          target={resetPwTarget}
          onClose={() => setResetPwTarget(null)}
          onReset={async () => {
            const who = resetPwTarget.displayName;
            setResetPwTarget(null);
            setMsg({ kind: "ok", text: `Password updated for "${who}".` });
            // Refresh so the Password column shows the new credential.
            await load();
          }}
        />
      )}

      {childrenTarget && (
        <ManageChildrenModal
          target={childrenTarget}
          options={students.filter(st => inWing(st, wingOf(childrenTarget as { wing?: unknown })))}
          onClose={() => setChildrenTarget(null)}
          onSaved={async () => { setChildrenTarget(null); await load(); }}
        />
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : (
          <>
            <SectionTable
              title={`Active ${title}`}
              group={currentGroup}
              wingFilter={wingFilter}
              rows={activeRows}
              emptyText={`No active ${title.toLowerCase()}.`}
              onToggle={toggleStatus}
              onManage={setManageTarget}
              onCreateLogin={setLoginTarget}
              onResetPassword={setResetPwTarget}
              onManageChildren={setChildrenTarget}
            />
            <SectionTable
              title={`Inactive ${title}`}
              group={currentGroup}
              wingFilter={wingFilter}
              rows={inactiveRows}
              emptyText={`No inactive ${title.toLowerCase()}.`}
              onToggle={toggleStatus}
              onManage={setManageTarget}
              onCreateLogin={setLoginTarget}
              onResetPassword={setResetPwTarget}
              onManageChildren={setChildrenTarget}
            />
          </>
        )}

        <p style={s.foot}>
          {currentGroup === "staff" && <>Teachers are created and assigned to centres on the <strong>Teachers</strong> screen. Every other account — leadership, parents, and login-id users — is created and deactivated here; rows tinted amber hold Admin or Founder access.</>}
          {currentGroup === "student" && <>Only students added one at a time via the <strong>Students</strong> screen appear here. Students enrolled in bulk through <strong>Admissions</strong>, the <strong>Registry</strong> import, or screening are managed on those screens instead.</>}
        </p>
      </div>
    </div>
  );
}

function SectionTable({ title, group, wingFilter, rows, emptyText, onToggle, onManage, onCreateLogin, onResetPassword, onManageChildren }: {
  title: string;
  group: ViewGroup;
  wingFilter: string;
  rows: User[];
  emptyText: string;
  onToggle: (u: User) => void;
  onManage: (u: User) => void;
  onCreateLogin: (u: User) => void;
  onResetPassword: (u: User) => void;
  onManageChildren: (u: User) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpand(uid: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }
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
            <colgroup>
              <col style={{ width: "10%" }} />
              <col style={{ width: "56%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <thead>
              <tr>{HEADERS.map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <Row key={m.uid} sl={i + 1} u={m} group={group} wingFilter={wingFilter}
                  expanded={expanded.has(m.uid)} onToggleExpand={() => toggleExpand(m.uid)}
                  onToggle={() => onToggle(m)} onManage={() => onManage(m)}
                  onCreateLogin={() => onCreateLogin(m)} onResetPassword={() => onResetPassword(m)}
                  onManageChildren={() => onManageChildren(m)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const HEADERS = ["Sl No", "Name", "Status", ""];

/** A trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function Row({ sl, u, group, wingFilter, expanded, onToggleExpand, onToggle, onManage, onCreateLogin, onResetPassword, onManageChildren }: {
  sl: number; u: User; group: ViewGroup; wingFilter: string;
  expanded: boolean; onToggleExpand: () => void;
  onToggle: () => void; onManage: () => void; onCreateLogin: () => void; onResetPassword: () => void;
  onManageChildren: () => void;
}) {
  const rec = u as unknown as Record<string, unknown>;
  const loginId = str(rec.loginId);
  const studentID = str(rec.studentID);
  const admissionNo = str(rec.admissionNumber) ?? str(rec.admissionNo);
  const plainPassword = str(rec.plainPassword);
  const loggedIn = hasLogin(u);
  const isParent = getUserWings(u).some(w => getRolesForWing(u, w).includes(ROLES.PARENT));

  const loginCell =
    group === "student"
      ? (studentID ?? admissionNo ?? str(rec.email))
      : (loginId ?? str(rec.email));
  const passwordCell =
    group === "student" ? (admissionNo ?? studentID) : plainPassword;

  // Which wing(s) to show a role chip for — every wing this user holds a role
  // in, or just the one being filtered on.
  const userWings = getUserWings(u);
  const wingsShown = wingFilter === "all"
    ? userWings
    : userWings.filter(w => w === wingFilter);

  // Admin/Founder ("Super Admin") accounts get a highlighted row so
  // administrative access stands out in the combined staff list.
  const isAdminRow = group !== "student" && wingsShown.some(w =>
    getRolesForWing(u, w).some(role => role === ROLES.ADMIN || role === ROLES.FOUNDER),
  );

  return (
    <>
      <tr
        style={{ ...s.tr, cursor: "pointer" }}
        className={isAdminRow ? "row-admin" : undefined}
        onClick={onToggleExpand}
      >
        <td style={{ ...s.td, color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>{sl}</td>
        <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>{u.displayName || "—"}</td>
        <td style={s.td}>
          <span style={u.status === "active" ? s.badgeOk : s.badgeOff}>{u.status ?? "inactive"}</span>
        </td>
        <td style={{ ...s.td, textAlign: "right" as const }}>
          <span style={s.expandChevron}>{expanded ? "▲ Less" : "▾ Details"}</span>
        </td>
      </tr>
      {expanded && (
        <tr className={isAdminRow ? "row-admin" : undefined} style={s.trDetail}>
          <td colSpan={4} style={s.tdDetail} onClick={e => e.stopPropagation()}>
            <div style={s.detailGrid}>
              <div>
                <div style={s.detailLabel}>Login ID</div>
                <div>{loginCell ? <span style={s.code}>{loginCell}</span> : "—"}</div>
              </div>
              <div>
                <div style={s.detailLabel}>Password</div>
                <div>
                  {!loggedIn
                    ? <span style={s.roleChip}>no login</span>
                    : passwordCell
                      ? <span style={s.code}>{passwordCell}</span>
                      : <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>not stored</span>}
                </div>
              </div>
              <div>
                <div style={s.detailLabel}>{group === "student" ? "Wing" : "Wing & Role"}</div>
                <div>
                  {group === "student" ? (
                    WING_LABELS[wingOf(u as { wing?: unknown })] ?? "—"
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
                      {wingsShown.length === 0 ? "—" : wingsShown.map(w => {
                        const roles = getRolesForWing(u, w);
                        return (
                          <span key={w} style={s.roleChip}>
                            {WING_LABELS[w] ?? w}{roles.length ? ` · ${roles.map(r => ROLE_LABEL[r] ?? r).join(", ")}` : ""}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, marginTop: 12 }}>
              {group !== "student" && <button style={s.linkBtn} onClick={onManage}>Manage roles</button>}
              {isParent && <button style={s.linkBtn} onClick={onManageChildren}>Linked children</button>}
              {loggedIn
                ? <button style={s.linkBtn} onClick={onResetPassword}>Reset password</button>
                : <button style={s.linkBtn} onClick={onCreateLogin}>Create login</button>}
              {u.role === ROLES.MEMBER && (
                <button style={s.linkBtn} onClick={onToggle}>
                  {u.status === "active" ? "Deactivate" : "Reactivate"}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Wing/role pair picker — add, edit, or revoke wing↔role assignments ─────
// one at a time. Shared by the "Add User" form and the "Manage roles" modal.

/** Toggle-chip multi-select — the same checked style as ChildPicker below. */
function RoleCheckboxGroup({ value, onChange }: { value: Role[]; onChange: (roles: Role[]) => void }) {
  function toggle(role: Role) {
    onChange(sortRoles(value.includes(role) ? value.filter(r => r !== role) : [...value, role]));
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
      {ASSIGNABLE_ROLES.map(r => {
        const on = value.includes(r);
        return (
          <button
            key={r} type="button" onClick={() => toggle(r)}
            style={{
              fontSize: 11, padding: "3px 9px", borderRadius: 99, cursor: "pointer",
              border: `1px solid ${on ? "#4f46e5" : "var(--color-border)"}`,
              background: on ? "#ede9fe" : "var(--color-surface-2)",
              color: on ? "#4338ca" : "var(--color-text-secondary)",
              fontWeight: on ? 700 : 500,
            }}
          >
            {on ? "✓ " : ""}{ROLE_LABEL[r] ?? r}
          </button>
        );
      })}
    </div>
  );
}

function WingRolePicker({ pairs, onChange }: {
  pairs: WingRolePair[]; onChange: (pairs: WingRolePair[]) => void;
}) {
  function rolesFor(wing: Wing): Role[] {
    return pairs.find(p => p.wing === wing)?.roles ?? [];
  }

  // Checking/unchecking a role chip commits immediately — no separate "Add"
  // step to forget. Unchecking every role for a wing just removes it from
  // the pending list (equivalent to no access there).
  function updateRoles(wing: Wing, roles: Role[]) {
    const exists = pairs.some(p => p.wing === wing);
    if (roles.length === 0) {
      onChange(pairs.filter(p => p.wing !== wing));
    } else if (exists) {
      onChange(pairs.map(p => p.wing === wing ? { ...p, roles } : p));
    } else {
      onChange([...pairs, { wing, roles }]);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {ALL_WINGS.map(wing => (
        <div key={wing} style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" as const }}>
          <span style={{ ...s.roleChip, minWidth: 130, textAlign: "center" as const, marginTop: 3 }}>{WING_LABELS[wing]}</span>
          <div style={{ flex: 1, minWidth: 180 }}>
            <RoleCheckboxGroup value={rolesFor(wing)} onChange={roles => updateRoles(wing, roles)} />
            {rolesFor(wing).length === 0 && (
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>
                No roles checked — no access in this wing.
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Manage Roles modal ─────────────────────────────────────────────────────

function ManageRolesModal({ target, onClose, onSaved }: {
  target: User; onClose: () => void; onSaved: () => void;
}) {
  const initialPairs = useMemo<WingRolePair[]>(() =>
    getUserWings(target)
      .map(wing => ({ wing, roles: getRolesForWing(target, wing) }))
      .filter(p => p.roles.length > 0),
  [target]);
  const [pairs, setPairs] = useState<WingRolePair[]>(initialPairs);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const initialMap = new Map(initialPairs.map(p => [p.wing, p.roles]));
  const currentMap = new Map(pairs.map(p => [p.wing, p.roles]));
  const sameRoles = (a: Role[], b: Role[]) => a.length === b.length && a.every(r => b.includes(r));
  const dirty = ALL_WINGS.some(w => !sameRoles(initialMap.get(w) ?? [], currentMap.get(w) ?? []));

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      for (const w of ALL_WINGS) {
        const next = currentMap.get(w) ?? [];
        const prev = initialMap.get(w) ?? [];
        if (sameRoles(next, prev)) continue;
        await setWingRoles(target.uid, w, next);
        invalidateRoleCaches(w);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save roles.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={m.overlay} onClick={onClose}>
      <div style={m.box} onClick={e => e.stopPropagation()}>
        <div style={m.header}>
          <span style={m.title}>Manage roles — {target.displayName}</span>
          <button onClick={onClose} style={m.closeBtn}>×</button>
        </div>
        <div style={m.body}>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>
            Check one or more roles per wing — e.g. Admin and Teacher together — change what's checked for a wing they already have, or revoke one entirely.
          </p>
          <WingRolePicker pairs={pairs} onChange={setPairs} />
          {err && <div style={s.bannerErr}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" style={s.btnGhost} onClick={onClose}>Cancel</button>
            <button type="button" disabled={!dirty || saving} onClick={handleSave}
              style={{ ...s.btnPrimary, opacity: !dirty || saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Save roles"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Create Login modal ─────────────────────────────────────────────────────
// The only place in the app that provisions a Firebase Auth account for an
// existing profile-only record (see createLoginForUser()).

function CreateLoginModal({ target, onClose, onCreated }: {
  target: User; onClose: () => void; onCreated: () => void;
}) {
  const { user } = useAuth();
  const [authMethod, setAuthMethod] = useState<"email" | "loginId">(target.email ? "email" : "loginId");
  const [email, setEmail] = useState(target.email ?? "");
  const [loginIdVal, setLoginIdVal] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    if (password.length < 6) return setErr("Password must be at least 6 characters.");
    if (authMethod === "email" && !email.trim()) return setErr("Email is required.");
    if (authMethod === "loginId" && !isValidLoginId(loginIdVal)) {
      return setErr("Login ID: 3–32 chars — letters, numbers, . _ - , starting and ending with a letter or number.");
    }

    setBusy(true);
    try {
      await createLoginForUser(
        {
          uid: target.uid,
          authMethod,
          email: authMethod === "email" ? email.trim() : undefined,
          loginId: authMethod === "loginId" ? normalizeLoginId(loginIdVal) : undefined,
          password,
        },
        user?.uid ?? "unknown",
        user?.role ?? ROLES.FOUNDER,
      );
      onCreated();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Failed to create login.";
      setErr(
        raw.startsWith("LOGIN_ID_IN_USE") ? "That Login ID is already taken."
          : raw.startsWith("EMAIL_IN_USE") ? "That email is already registered."
          : raw.includes("email-already-in-use") ? "That email is already registered."
          : raw
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={m.overlay} onClick={onClose}>
      <div style={m.box} onClick={e => e.stopPropagation()}>
        <div style={m.header}>
          <span style={m.title}>Create login — {target.displayName}</span>
          <button onClick={onClose} style={m.closeBtn}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={m.body}>
          <div style={{ display: "flex", gap: 14 }}>
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 5 }}>
              <input type="radio" checked={authMethod === "email"} onChange={() => setAuthMethod("email")} />
              Email
            </label>
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 5 }}>
              <input type="radio" checked={authMethod === "loginId"} onChange={() => setAuthMethod("loginId")} />
              Login ID
            </label>
          </div>

          {authMethod === "email" ? (
            <div style={s.field}>
              <label style={s.label}>Email</label>
              <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
            </div>
          ) : (
            <div style={s.field}>
              <label style={s.label}>Login ID</label>
              <input
                style={{ ...s.input, fontFamily: "monospace" }}
                value={loginIdVal}
                onChange={e => setLoginIdVal(e.target.value.replace(/\s/g, ""))}
                placeholder="anilkumar"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
          )}

          <div style={s.field}>
            <label style={s.label}>Password</label>
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
          </div>

          {err && <div style={s.bannerErr}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" style={s.btnGhost} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Creating…" : "Create login"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Reset Password modal ───────────────────────────────────────────────────

function ResetPasswordModal({ target, onClose, onReset }: {
  target: User; onClose: () => void; onReset: () => void;
}) {
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    if (password.length < 6) return setErr("Password must be at least 6 characters.");
    setBusy(true);
    try {
      const res = await resetUserPassword(target.uid, password);
      if (res.success) onReset();
      else setErr(res.error ?? "Failed to reset password.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to reset password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={m.overlay} onClick={onClose}>
      <div style={m.box} onClick={e => e.stopPropagation()}>
        <div style={m.header}>
          <span style={m.title}>Reset password — {target.displayName}</span>
          <button onClick={onClose} style={m.closeBtn}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={m.body}>
          <div style={s.field}>
            <label style={s.label}>New Password</label>
            <div style={{ position: "relative" }}>
              <input
                style={{ ...s.input, paddingRight: 52 }}
                type={showPw ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min. 6 characters"
                autoFocus
              />
              <button type="button" tabIndex={-1} onClick={() => setShowPw(v => !v)} style={s.showHide}>
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {err && <div style={s.bannerErr}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" style={s.btnGhost} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Updating…" : "Update password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Linked children (Parent role) ──────────────────────────────────────────

function ChildPicker({ options, value, onChange }: {
  options: StudentOpt[]; value: string[]; onChange: (v: string[]) => void;
}) {
  function toggle(uid: string) {
    onChange(value.includes(uid) ? value.filter(u => u !== uid) : [...value, uid]);
  }
  if (options.length === 0) return <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No students in this wing.</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
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

function ManageChildrenModal({ target, options, onClose, onSaved }: {
  target: User; options: StudentOpt[]; onClose: () => void; onSaved: () => void;
}) {
  const rec = target as unknown as { childUids?: string[] };
  const [childUids, setChildUids] = useState<string[]>(Array.isArray(rec.childUids) ? rec.childUids : []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      await setParentChildren(target.uid, childUids);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={m.overlay} onClick={onClose}>
      <div style={m.box} onClick={e => e.stopPropagation()}>
        <div style={m.header}>
          <span style={m.title}>Linked children — {target.displayName}</span>
          <button onClick={onClose} style={m.closeBtn}>×</button>
        </div>
        <div style={m.body}>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>
            Choose which students this parent may view.
          </p>
          <ChildPicker options={options} value={childUids} onChange={setChildUids} />
          {err && <div style={s.bannerErr}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" style={s.btnGhost} onClick={onClose}>Cancel</button>
            <button type="button" disabled={saving} onClick={handleSave}
              style={{ ...s.btnPrimary, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
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
  table: { width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontSize: 12.5 },
  th: { textAlign: "left", padding: "9px 12px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr: { borderBottom: "1px solid var(--color-border)" },
  td: { padding: "10px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle", wordBreak: "break-word" },
  expandChevron: { fontSize: 11.5, fontWeight: 600, color: "var(--color-accent)", whiteSpace: "nowrap" as const },
  trDetail: { borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)" },
  tdDetail: { padding: "14px 16px", cursor: "default" },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px 20px" },
  detailLabel: { fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: 4 },
  code: { fontFamily: "monospace", fontSize: 12, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4 },
  roleChip: { fontSize: 11, fontWeight: 600, background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", padding: "2px 8px", borderRadius: 99 },
  badgeOk: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f0fdf4", color: "#166534" },
  badgeOff: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f3f4f6", color: "#6b7280" },
  linkBtn: { padding: "5px 12px", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  empty: { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },
  emptySmall: { padding: "14px 0 20px", color: "var(--color-text-muted)", fontSize: 13 },
  foot: { fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 14, marginBottom: 0, lineHeight: 1.5 },
};

const m: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  box: { background: "var(--color-surface)", borderRadius: 12, width: "100%", maxWidth: 440, boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)" },
  title: { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" },
  closeBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--color-text-secondary)", lineHeight: 1 },
  body: { padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 },
};
