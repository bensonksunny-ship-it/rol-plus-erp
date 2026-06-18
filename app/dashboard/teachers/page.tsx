"use client";

import { useState, useEffect, type FormEvent } from "react";
import { getDocs, collection, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  createTeacher,
  getTeachers,
  updateTeacherCenters,
} from "@/services/teacher/teacher.service";
import type { TeacherUser } from "@/types";
import type { Center } from "@/types";
import { deleteUser as deleteUserRecord } from "@/services/admin/delete.service";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TeachersPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <TeachersContent />
    </ProtectedRoute>
  );
}

type Tab = "teachers" | "performance";

// ─── Main content ─────────────────────────────────────────────────────────────

function TeachersContent() {
  const { user } = useAuthContext();

  const [tab, setTab]             = useState<Tab>("teachers");
  const [showCreate, setShowCreate] = useState(false);

  const [teachers, setTeachers] = useState<TeacherUser[]>([]);
  const [centers,  setCenters]  = useState<Center[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [editTarget,   setEditTarget]   = useState<TeacherUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeacherUser | null>(null);

  // Create form
  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [showPw,   setShowPw]   = useState(false);
  const [selectedCenters, setSelectedCenters] = useState<string[]>([]);

  // Edit form
  const [editCenters, setEditCenters] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);
  const [attStats,        setAttStats]        = useState<Record<string, { present: number; absent: number; break: number; cancelled: number; total: number }>>({});
  const [attByCenter,     setAttByCenter]     = useState<Record<string, Record<string, { present: number; absent: number; break: number; cancelled: number; total: number }>>>({});
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  async function load() {
    try {
      const thisMonth  = new Date().toISOString().slice(0, 7);
      const monthStart = thisMonth + "-01";
      const [teacherList, centerSnap, attSnap] = await Promise.all([
        getTeachers(),
        getDocs(collection(db, "centers")),
        getDocs(query(collection(db, "attendance"), where("date", ">=", monthStart))),
      ]);

      setTeachers(teacherList.sort((a, b) => a.displayName.localeCompare(b.displayName)));
      setCenters(centerSnap.docs.map(d => ({ id: d.id, ...d.data() } as Center)));

      const centreTeacher: Record<string, string> = {};
      centerSnap.docs.forEach(d => {
        const uid = d.data().teacherUid as string | undefined;
        if (uid) centreTeacher[d.id] = uid;
      });

      type Counts = { present: number; absent: number; break: number; cancelled: number; total: number };
      const zero = (): Counts => ({ present: 0, absent: 0, break: 0, cancelled: 0, total: 0 });
      const bump = (c: Counts, status: string | undefined) => {
        c.total++;
        if (status === "present")                c.present++;
        else if (status === "absent")            c.absent++;
        else if (status === "break")             c.break++;
        else if (status?.startsWith("cancelled")) c.cancelled++;
      };

      const stats:    Record<string, Counts>                 = {};
      const byCenter: Record<string, Record<string, Counts>> = {};

      attSnap.forEach(d => {
        const cid    = d.data().centerId as string | undefined;
        const status = d.data().status   as string | undefined;
        const date   = d.data().date     as string | undefined;
        if (!cid || !date?.startsWith(thisMonth)) return;
        const uid = centreTeacher[cid];
        if (!uid) return;
        if (!stats[uid])          stats[uid]          = zero();
        if (!byCenter[uid])       byCenter[uid]        = {};
        if (!byCenter[uid][cid])  byCenter[uid][cid]   = zero();
        bump(stats[uid], status);
        bump(byCenter[uid][cid], status);
      });

      setAttStats(stats);
      setAttByCenter(byCenter);
    } catch (err) {
      console.error("Failed to load teachers:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // ── Create ────────────────────────────────────────────────────────────────

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSuccessMsg(null);
    setErrorMsg(null);
    if (!name.trim())        return setErrorMsg("Name is required.");
    if (!email.trim())       return setErrorMsg("Email is required.");
    if (password.length < 6) return setErrorMsg("Password must be at least 6 characters.");
    setSubmitting(true);
    try {
      await createTeacher(
        { displayName: name.trim(), email: email.trim(), password, centerIds: selectedCenters },
        user?.uid ?? "unknown",
        (user?.role ?? ROLES.ADMIN) as Parameters<typeof createTeacher>[2],
      );
      setSuccessMsg("Teacher created successfully.");
      setName(""); setEmail(""); setPassword(""); setSelectedCenters([]);
      setLoading(true);
      await load();
      setShowCreate(false);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/email-already-in-use") {
        setErrorMsg("This email is already registered in Firebase Auth.");
      } else {
        setErrorMsg(err instanceof Error ? err.message : "Failed to create teacher.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Edit centers ──────────────────────────────────────────────────────────

  function openEdit(teacher: TeacherUser) {
    setEditTarget(teacher);
    setEditCenters(teacher.centerIds ?? []);
    setSuccessMsg(null);
    setErrorMsg(null);
  }

  async function handleSaveCenters(e: FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setSubmitting(true);
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      await updateTeacherCenters(
        editTarget.uid,
        editCenters,
        user?.uid ?? "unknown",
        (user?.role ?? ROLES.ADMIN) as Parameters<typeof updateTeacherCenters>[3],
      );
      setSuccessMsg("Centers updated.");
      setEditTarget(null);
      setLoading(true);
      await load();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to update centers.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function toggleCenter(id: string, arr: string[], setter: (v: string[]) => void) {
    setter(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  }

  function centerName(id: string): string {
    return centers.find(c => c.id === id)?.name ?? id;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const TABS: { key: Tab; label: string }[] = [
    { key: "teachers",    label: "Teachers" },
    { key: "performance", label: "Performance" },
  ];

  return (
    <div>

      {/* ── Page header ── */}
      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>Teachers</h1>
          <p style={s.subtitle}>Manage teacher accounts and attendance performance</p>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div style={s.tabBar}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setSuccessMsg(null); setErrorMsg(null); setShowCreate(false); }}
            style={{ ...s.tabBtn, ...(tab === t.key ? s.tabBtnActive : {}) }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Banners ── */}
      {successMsg && <div style={s.bannerSuccess}>{successMsg}</div>}
      {errorMsg   && <div style={s.bannerError}>{errorMsg}</div>}

      {/* ── Modals ── */}
      {deleteTarget && (
        <DeleteUserModal
          name={deleteTarget.displayName}
          role="teacher"
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setTeachers(prev => prev.filter(t => t.uid !== deleteTarget.uid));
            setDeleteTarget(null);
            setSuccessMsg(`Teacher "${deleteTarget.displayName}" deleted.`);
          }}
          onError={msg => setErrorMsg(msg)}
          uid={deleteTarget.uid}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={(user?.role ?? ROLES.ADMIN) as string}
        />
      )}

      {editTarget && (
        <div style={s.overlay} onClick={() => setEditTarget(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={s.modalTitle}>Edit Centers — {editTarget.displayName}</span>
              <button onClick={() => setEditTarget(null)} style={s.closeBtn}>×</button>
            </div>
            <div style={s.modalBody}>
              <form onSubmit={handleSaveCenters}>
                <p style={s.modalHint}>Select the centers this teacher is assigned to.</p>
                <CenterCheckboxes
                  centers={centers}
                  selected={editCenters}
                  onToggle={id => toggleCenter(id, editCenters, setEditCenters)}
                />
                <div style={s.formActions}>
                  <button type="button" style={s.btnGhost} onClick={() => setEditTarget(null)}>Cancel</button>
                  <button type="submit"
                    style={{ ...s.btnPrimary, opacity: submitting ? 0.6 : 1, minWidth: 130 }}
                    disabled={submitting}>
                    {submitting ? "Saving…" : "Save Centers"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ══ TAB: TEACHERS + ADD NEW ══ */}
      {tab === "teachers" && (
        <>
          {/* Add form (collapsible) */}
          <div style={s.card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: showCreate ? 20 : 0 }}>
              <p style={{ ...s.cardTitle, marginBottom: 0 }}>New Teacher</p>
              <button
                style={showCreate ? s.btnGhost : s.btnPrimary}
                onClick={() => { setShowCreate(v => !v); setSuccessMsg(null); setErrorMsg(null); }}
              >
                {showCreate ? "✕ Cancel" : "+ Add Teacher"}
              </button>
            </div>
            {showCreate && (
              <form onSubmit={handleCreate}>
                <div style={s.grid2}>
                  <Field label="Full Name">
                    <input style={s.input} type="text" value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="e.g. Priya Nair" required />
                  </Field>
                  <Field label="Email Address">
                    <input style={s.input} type="email" value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="teacher@rolsplus.com" required />
                  </Field>
                  <Field label="Password">
                    <div style={{ position: "relative" }}>
                      <input
                        style={{ ...s.input, paddingRight: 52 }}
                        type={showPw ? "text" : "password"}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Min. 6 characters"
                        required minLength={6}
                      />
                      <button type="button" tabIndex={-1}
                        onClick={() => setShowPw(v => !v)} style={s.showHide}>
                        {showPw ? "Hide" : "Show"}
                      </button>
                    </div>
                  </Field>
                  <div />
                  <Field label="Assign Centers (optional)" fullWidth>
                    <CenterCheckboxes
                      centers={centers}
                      selected={selectedCenters}
                      onToggle={id => toggleCenter(id, selectedCenters, setSelectedCenters)}
                    />
                  </Field>
                </div>
                <div style={s.formActions}>
                  <button type="button" style={s.btnGhost} onClick={() => setShowCreate(false)}>Cancel</button>
                  <button type="submit"
                    style={{ ...s.btnPrimary, opacity: submitting ? 0.6 : 1, minWidth: 140 }}
                    disabled={submitting}>
                    {submitting ? "Creating…" : "Create Teacher"}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Teacher list */}
          <div style={s.card}>
            <p style={s.cardTitle}>
              All Teachers{" "}
              <span style={{ color: "#9ca3af", fontWeight: 400 }}>({teachers.length})</span>
            </p>
            {loading ? (
              <div style={s.empty}>Loading…</div>
            ) : teachers.length === 0 ? (
              <div style={s.empty}>No teachers yet. Click "+ Add Teacher" above to create one.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {["Name", "Email", "Status", "Centers", ""].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {teachers.map(t => (
                      <tr key={t.uid} style={s.tr}>
                        <td style={{ ...s.td, fontWeight: 600, color: "#111" }}>{t.displayName}</td>
                        <td style={s.td}>{t.email}</td>
                        <td style={s.td}><StatusBadge status={t.status} /></td>
                        <td style={s.td}>
                          {(t.centerIds ?? []).length === 0 ? (
                            <span style={{ color: "#9ca3af", fontSize: 12 }}>None assigned</span>
                          ) : (
                            <div style={s.centerTags}>
                              {(t.centerIds ?? []).map(id => (
                                <span key={id} style={s.centerTag}>{centerName(id)}</span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td style={s.td}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <button style={s.editBtn} onClick={() => openEdit(t)}>Edit Centers</button>
                            <button style={s.deleteBtn} onClick={() => setDeleteTarget(t)}>✕ Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ══ TAB: PERFORMANCE ══ */}
      {tab === "performance" && (
        <div style={s.card}>
          <p style={s.cardTitle}>
            Attendance This Month
            <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12, marginLeft: 10 }}>
              {new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
            </span>
          </p>
          {loading ? (
            <div style={s.empty}>Loading…</div>
          ) : teachers.length === 0 ? (
            <div style={s.empty}>No teachers to show.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["Teacher", "Centers", "Present", "Absent", "Break", "Cancelled", "Total"].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teachers.map(t => {
                    const st       = attStats[t.uid]    ?? { present: 0, absent: 0, break: 0, cancelled: 0, total: 0 };
                    const centreMap = attByCenter[t.uid] ?? {};
                    const isOpen   = expandedTeacher === t.uid;
                    const hasCentres = (t.centerIds ?? []).length > 0;
                    return (
                      <>
                        <tr
                          key={t.uid}
                          style={{ ...s.tr, cursor: hasCentres ? "pointer" : "default", background: isOpen ? "#f8f7ff" : undefined }}
                          onClick={() => hasCentres && setExpandedTeacher(isOpen ? null : t.uid)}
                        >
                          <td style={{ ...s.td, fontWeight: 600, color: "#111" }}>
                            <span style={{ marginRight: 6, fontSize: 10, color: "#9ca3af" }}>
                              {hasCentres ? (isOpen ? "▼" : "▶") : ""}
                            </span>
                            {t.displayName}
                          </td>
                          <td style={s.td}>
                            {!hasCentres ? (
                              <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>
                            ) : (
                              <div style={s.centerTags}>
                                {(t.centerIds ?? []).map(id => (
                                  <span key={id} style={s.centerTag}>{centerName(id)}</span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td style={{ ...s.td, textAlign: "center" as const }}>
                            <span style={attChip("#16a34a", "#f0fdf4", "#bbf7d0")}>{st.present}</span>
                          </td>
                          <td style={{ ...s.td, textAlign: "center" as const }}>
                            <span style={attChip("#dc2626", "#fef2f2", "#fecaca")}>{st.absent}</span>
                          </td>
                          <td style={{ ...s.td, textAlign: "center" as const }}>
                            <span style={attChip("#d97706", "#fffbeb", "#fde68a")}>{st.break}</span>
                          </td>
                          <td style={{ ...s.td, textAlign: "center" as const }}>
                            <span style={attChip("#6b7280", "#f9fafb", "#e5e7eb")}>{st.cancelled}</span>
                          </td>
                          <td style={{ ...s.td, textAlign: "center" as const }}>
                            <span style={attChip("#1d4ed8", "#eff6ff", "#bfdbfe")}>{st.total}</span>
                          </td>
                        </tr>

                        {/* Expanded: per-centre breakdown */}
                        {isOpen && (
                          <tr key={t.uid + "-detail"} style={{ background: "#f8f7ff", borderBottom: "1px solid #e5e7eb" }}>
                            <td colSpan={7} style={{ padding: "0 16px 16px 36px" }}>
                              <table style={{ ...s.table, marginTop: 10 }}>
                                <thead>
                                  <tr>
                                    {["Centre", "Present", "Absent", "Break", "Cancelled", "Total"].map(h => (
                                      <th key={h} style={{ ...s.th, background: "#ede9fe", fontSize: 10 }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {(t.centerIds ?? []).map(cid => {
                                    const cs = centreMap[cid] ?? { present: 0, absent: 0, break: 0, cancelled: 0, total: 0 };
                                    return (
                                      <tr key={cid} style={{ borderBottom: "1px solid #e5e7eb" }}>
                                        <td style={{ ...s.td, fontWeight: 600, color: "#4338ca", fontSize: 12 }}>{centerName(cid)}</td>
                                        <td style={{ ...s.td, textAlign: "center" as const }}>
                                          <span style={attChip("#16a34a", "#f0fdf4", "#bbf7d0")}>{cs.present}</span>
                                        </td>
                                        <td style={{ ...s.td, textAlign: "center" as const }}>
                                          <span style={attChip("#dc2626", "#fef2f2", "#fecaca")}>{cs.absent}</span>
                                        </td>
                                        <td style={{ ...s.td, textAlign: "center" as const }}>
                                          <span style={attChip("#d97706", "#fffbeb", "#fde68a")}>{cs.break}</span>
                                        </td>
                                        <td style={{ ...s.td, textAlign: "center" as const }}>
                                          <span style={attChip("#6b7280", "#f9fafb", "#e5e7eb")}>{cs.cancelled}</span>
                                        </td>
                                        <td style={{ ...s.td, textAlign: "center" as const }}>
                                          <span style={attChip("#1d4ed8", "#eff6ff", "#bfdbfe")}>{cs.total}</span>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, children, fullWidth }: { label: string; children: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, ...(fullWidth ? { gridColumn: "1 / -1" } : {}) }}>
      <label style={s.label}>{label}</label>
      {children}
    </div>
  );
}

function CenterCheckboxes({ centers, selected, onToggle }: { centers: Center[]; selected: string[]; onToggle: (id: string) => void }) {
  if (centers.length === 0) return <p style={{ fontSize: 13, color: "#9ca3af" }}>No centers available.</p>;
  return (
    <div style={s.checkboxGrid}>
      {centers.map(c => (
        <label key={c.id} style={s.checkboxLabel}>
          <input type="checkbox" checked={selected.includes(c.id)} onChange={() => onToggle(c.id)} style={{ accentColor: "#4f46e5" }} />
          <span style={{ fontSize: 13, color: "#111" }}>{c.name}</span>
          {(c as Center & { centerCode?: string }).centerCode && (
            <span style={s.centerCode}>{(c as Center & { centerCode?: string }).centerCode}</span>
          )}
        </label>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style = status === "active"
    ? { background: "#dcfce7", color: "#16a34a" }
    : { background: "#f3f4f6", color: "#6b7280" };
  return <span style={{ ...s.badge, ...style }}>{status}</span>;
}

function DeleteUserModal({ name, role, uid, onClose, onDeleted, onError, currentUserUid, currentUserRole }: {
  name: string; role: "teacher" | "admin"; uid: string;
  onClose: () => void; onDeleted: () => void; onError: (msg: string) => void;
  currentUserUid: string; currentUserRole: string;
}) {
  const [confirmed, setConfirmed] = useState("");
  const [busy, setBusy]           = useState(false);
  const confirmWord = name.split(" ")[0] ?? "DELETE";
  const canDelete   = confirmed === confirmWord;

  async function handleDelete() {
    if (!canDelete) return;
    setBusy(true);
    try {
      const res = await deleteUserRecord(uid, role, currentUserUid, currentUserRole as never);
      if (res.success) { onDeleted(); }
      else { onError(res.error ?? "Delete failed."); onClose(); }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.modal, maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span style={{ ...s.modalTitle, color: "#991b1b" }}>✕ Delete {role === "teacher" ? "Teacher" : "Admin"}</span>
          <button onClick={onClose} style={s.closeBtn}>×</button>
        </div>
        <div style={s.modalBody}>
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#991b1b", marginBottom: 14 }}>
            <strong>This will permanently delete &ldquo;{name}&rdquo;</strong>. Their login account will be disabled. This action cannot be undone.
          </div>
          <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 6 }}>
            Type <strong style={{ color: "#dc2626" }}>{confirmWord}</strong> to confirm:
          </label>
          <input
            value={confirmed}
            onChange={e => setConfirmed(e.target.value)}
            placeholder={`Type "${confirmWord}"`}
            style={{ padding: "8px 10px", border: `1px solid ${canDelete ? "#86efac" : "#d1d5db"}`, borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111827", width: "100%", boxSizing: "border-box" as const }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
            <button onClick={onClose} style={s.btnGhost}>Cancel</button>
            <button onClick={handleDelete} disabled={!canDelete || busy}
              style={{ ...s.btnPrimary, background: canDelete && !busy ? "#dc2626" : "#f3f4f6", color: canDelete && !busy ? "#fff" : "#9ca3af", cursor: canDelete && !busy ? "pointer" : "not-allowed" }}>
              {busy ? "Deleting…" : `Delete ${role === "teacher" ? "Teacher" : "Admin"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function attChip(color: string, bg: string, border: string): React.CSSProperties {
  return { display: "inline-block", minWidth: 36, padding: "3px 10px", borderRadius: 99, fontSize: 13, fontWeight: 700, color, background: bg, border: `1px solid ${border}`, textAlign: "center" };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  headerRow:    { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  title:        { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle:     { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4, marginBottom: 0 },

  tabBar:       { display: "flex", gap: 4, borderBottom: "2px solid var(--color-border)", marginBottom: 24 },
  tabBtn:       { padding: "9px 20px", background: "none", border: "none", borderBottom: "2px solid transparent", marginBottom: -2, fontSize: 13, fontWeight: 600, color: "var(--color-text-muted)", cursor: "pointer", borderRadius: "6px 6px 0 0" },
  tabBtnActive: { color: "#4f46e5", borderBottomColor: "#4f46e5", background: "#f5f3ff" },

  btnPrimary:   { padding: "9px 18px", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnGhost:     { padding: "9px 18px", background: "transparent", color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },

  bannerSuccess:{ borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
  bannerError:  { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },

  card:         { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24, marginBottom: 24 },
  cardTitle:    { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 20, marginTop: 0 },

  grid2:        { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px", marginBottom: 16 },
  label:        { fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" },
  input:        { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 12px", fontSize: 14, color: "var(--color-text-primary)", outline: "none", width: "100%", boxSizing: "border-box" },
  showHide:     { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#9ca3af", fontSize: 11, cursor: "pointer", padding: 0 },
  formActions:  { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 },

  checkboxGrid: { display: "flex", flexDirection: "column", gap: 10 },
  checkboxLabel:{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
  centerCode:   { fontFamily: "monospace", fontSize: 11, background: "#ede9fe", color: "#6d28d9", padding: "1px 7px", borderRadius: 4, fontWeight: 600, marginLeft: 4 },

  table:        { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:           { textAlign: "left", padding: "8px 14px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr:           { borderBottom: "1px solid var(--color-border)" },
  td:           { padding: "13px 14px", color: "var(--color-text-secondary)", verticalAlign: "middle" },

  badge:        { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600 },
  centerTags:   { display: "flex", flexWrap: "wrap", gap: 6 },
  centerTag:    { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: "#e0e7ff", color: "#4338ca" },

  editBtn:      { padding: "5px 12px", background: "#ede9fe", color: "#4f46e5", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  deleteBtn:    { padding: "5px 12px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  empty:        { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },

  overlay:      { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:        { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 480, boxShadow: "0 8px 32px rgba(0,0,0,0.16)", overflow: "hidden" },
  modalHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" },
  modalTitle:   { fontSize: 15, fontWeight: 600, color: "#111" },
  closeBtn:     { background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#6b7280", lineHeight: 1 },
  modalBody:    { padding: "20px" },
  modalHint:    { fontSize: 13, color: "#6b7280", marginTop: 0, marginBottom: 14 },
};
