"use client";

import { useState, useEffect, useRef, Fragment, type FormEvent } from "react";
import { getDocs, collection, query, where, doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  createTeacher,
  getTeachers,
  updateTeacherCenters,
  uploadTeacherPhoto,
} from "@/services/teacher/teacher.service";
import type { TeacherUser, UserStatus } from "@/types";
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
  const [viewTarget,        setViewTarget]        = useState<TeacherUser | null>(null);
  const [editDetailsTarget, setEditDetailsTarget] = useState<TeacherUser | null>(null);

  // Create form
  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [showPw,   setShowPw]   = useState(false);
  const [selectedCenters, setSelectedCenters] = useState<string[]>([]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);

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
      const created = await createTeacher(
        { displayName: name.trim(), email: email.trim(), password, centerIds: selectedCenters },
        user?.uid ?? "unknown",
        (user?.role ?? ROLES.ADMIN) as Parameters<typeof createTeacher>[2],
      );
      if (photoFile) {
        try {
          const photoURL = await uploadTeacherPhoto(created.uid, photoFile);
          await updateDoc(doc(db, "users", created.uid), { photoURL, updatedAt: serverTimestamp() });
        } catch (photoErr) {
          console.error("Failed to upload teacher photo:", photoErr);
        }
      }
      setSuccessMsg("Teacher created successfully.");
      setName(""); setEmail(""); setPassword(""); setSelectedCenters([]); setPhotoFile(null);
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

      {viewTarget && (
        <ViewTeacherModal teacher={viewTarget} centerName={centerName} onClose={() => setViewTarget(null)} />
      )}

      {editDetailsTarget && (
        <EditTeacherDetailsModal
          teacher={editDetailsTarget}
          onClose={() => setEditDetailsTarget(null)}
          onSaved={updated => {
            setTeachers(prev => prev.map(t => t.uid !== editDetailsTarget.uid ? t : { ...t, ...updated }));
            setEditDetailsTarget(null);
            setSuccessMsg("Teacher details updated.");
          }}
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
                  <Field label="Profile Picture (optional)">
                    <PhotoUploadField file={photoFile} name={name || "New Teacher"} onChange={setPhotoFile} />
                  </Field>
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
              <div style={s.grid}>
                {teachers.map(t => (
                  <TeacherCard
                    key={t.uid}
                    teacher={t}
                    onView={() => setViewTarget(t)}
                    onEditDetails={() => setEditDetailsTarget(t)}
                    onEditCenters={() => openEdit(t)}
                    onDelete={() => setDeleteTarget(t)}
                  />
                ))}
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
                    {["Teacher", "Centers", "Present", "Absent", "Break", "Cancelled", "Total", ""].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teachers.map(t => (
                    <TeacherPerfRow
                      key={t.uid}
                      teacher={t}
                      centerName={centerName}
                      stats={attStats[t.uid] ?? { present: 0, absent: 0, break: 0, cancelled: 0, total: 0 }}
                      centerStats={attByCenter[t.uid] ?? {}}
                      expanded={expandedTeacher === t.uid}
                      onToggle={() => setExpandedTeacher(prev => prev === t.uid ? null : t.uid)}
                      onEditDetails={() => setEditDetailsTarget(t)}
                      onEditCenters={() => openEdit(t)}
                      onDelete={() => setDeleteTarget(t)}
                    />
                  ))}
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

function initials(name: string): string {
  return name.split(" ").map(n => n[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
}

// ─── Avatar (photo, falls back to initials) ─────────────────────────────────────

function TeacherAvatar({ photoURL, name, size = 36 }: {
  photoURL?: string | null; name: string; size?: number;
}) {
  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={name}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" as const, flexShrink: 0 }}
      />
    );
  }
  return (
    <div style={{ ...s.tAvatar, width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {initials(name)}
    </div>
  );
}

// ─── Profile picture upload field (Add/Edit teacher forms) ─────────────────────

function PhotoUploadField({ file, currentUrl, name, onChange }: {
  file: File | null; currentUrl?: string | null; name: string; onChange: (file: File | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <TeacherAvatar photoURL={preview ?? currentUrl} name={name} size={48} />
      <input
        type="file"
        accept="image/*"
        onChange={e => onChange(e.target.files?.[0] ?? null)}
        style={s.fileInput}
      />
    </div>
  );
}

// ─── Three-dots actions menu (shared by both card grids) ───────────────────────

function TeacherActionsMenu({ onEditDetails, onEditCenters, onDelete }: {
  onEditDetails: () => void; onEditCenters: () => void; onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
        style={s.menuBtn}
        title="More actions"
        aria-label="More actions"
      >
        ⋮
      </button>
      {menuOpen && (
        <div style={s.menuPanel} onClick={e => e.stopPropagation()}>
          <button onClick={() => { setMenuOpen(false); onEditDetails(); }} style={s.menuItem}>✏ Edit Details</button>
          <button onClick={() => { setMenuOpen(false); onEditCenters(); }} style={s.menuItem}>🏫 Edit Assigned Centers</button>
          <button onClick={() => { setMenuOpen(false); onDelete(); }} style={{ ...s.menuItem, ...s.menuItemDanger }}>✕ Delete / Remove Teacher</button>
        </div>
      )}
    </div>
  );
}

// ─── Teacher card (Teachers tab grid) ───────────────────────────────────────────

function TeacherCard({ teacher, onView, onEditDetails, onEditCenters, onDelete }: {
  teacher: TeacherUser;
  onView: () => void; onEditDetails: () => void; onEditCenters: () => void; onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onView}
      style={{ ...s.tCard, ...(hover ? s.tCardHover : {}) }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    >
      <div style={s.tCardHeader}>
        <TeacherAvatar photoURL={teacher.photoURL} name={teacher.displayName} size={36} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={teacher.status} />
          <TeacherActionsMenu onEditDetails={onEditDetails} onEditCenters={onEditCenters} onDelete={onDelete} />
        </div>
      </div>
      <div style={s.tName}>{teacher.displayName}</div>
      <div style={s.tEmail}>{teacher.email}</div>
    </div>
  );
}

// ─── Teacher performance row (Performance tab list) ─────────────────────────────

type AttCounts = { present: number; absent: number; break: number; cancelled: number; total: number };

function TeacherPerfRow({ teacher, centerName, stats, centerStats, expanded, onToggle, onEditDetails, onEditCenters, onDelete }: {
  teacher: TeacherUser; centerName: (id: string) => string;
  stats: AttCounts; centerStats: Record<string, AttCounts>;
  expanded: boolean; onToggle: () => void;
  onEditDetails: () => void; onEditCenters: () => void; onDelete: () => void;
}) {
  const hasCentres = (teacher.centerIds ?? []).length > 0;
  return (
    <Fragment>
      <tr
        style={{ ...s.tr, cursor: hasCentres ? "pointer" : "default", background: expanded ? "var(--color-surface-2)" : undefined }}
        onClick={() => hasCentres && onToggle()}
      >
        <td style={{ ...s.td, fontWeight: 600, color: "var(--color-text-primary)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <TeacherAvatar photoURL={teacher.photoURL} name={teacher.displayName} size={26} />
            {teacher.displayName}
            {hasCentres && <span style={{ fontSize: 10, color: "#9ca3af" }}>{expanded ? "▼" : "▶"}</span>}
          </div>
        </td>
        <td style={s.td}>
          {!hasCentres ? (
            <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>
          ) : (
            <div style={s.centerTags}>
              {teacher.centerIds!.map(id => <span key={id} style={s.centerTag}>{centerName(id)}</span>)}
            </div>
          )}
        </td>
        <td style={{ ...s.td, textAlign: "center" as const }}>
          <span style={attChip("#16a34a", "#f0fdf4", "#bbf7d0")}>{stats.present}</span>
        </td>
        <td style={{ ...s.td, textAlign: "center" as const }}>
          <span style={attChip("#dc2626", "#fef2f2", "#fecaca")}>{stats.absent}</span>
        </td>
        <td style={{ ...s.td, textAlign: "center" as const }}>
          <span style={attChip("#d97706", "#fffbeb", "#fde68a")}>{stats.break}</span>
        </td>
        <td style={{ ...s.td, textAlign: "center" as const }}>
          <span style={attChip("#6b7280", "#f9fafb", "#e5e7eb")}>{stats.cancelled}</span>
        </td>
        <td style={{ ...s.td, textAlign: "center" as const }}>
          <span style={attChip("#1d4ed8", "#eff6ff", "#bfdbfe")}>{stats.total}</span>
        </td>
        <td style={s.td} onClick={e => e.stopPropagation()}>
          <TeacherActionsMenu onEditDetails={onEditDetails} onEditCenters={onEditCenters} onDelete={onDelete} />
        </td>
      </tr>

      {expanded && hasCentres && (
        <tr style={{ background: "var(--color-surface-2)", borderBottom: "1px solid var(--color-border)" }}>
          <td colSpan={8} style={{ padding: "0 16px 16px 44px" }}>
            <div style={s.perfBreakdownTitle}>Per-centre breakdown</div>
            {teacher.centerIds!.map(cid => {
              const cs = centerStats[cid] ?? { present: 0, absent: 0, break: 0, cancelled: 0, total: 0 };
              return (
                <div key={cid} style={s.perfBreakdownRow}>
                  <span style={{ fontWeight: 600, color: "#4338ca", fontSize: 12 }}>{centerName(cid)}</span>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                    <span style={attChip("#16a34a", "#f0fdf4", "#bbf7d0")}>{cs.present}</span>
                    <span style={attChip("#dc2626", "#fef2f2", "#fecaca")}>{cs.absent}</span>
                    <span style={attChip("#d97706", "#fffbeb", "#fde68a")}>{cs.break}</span>
                    <span style={attChip("#6b7280", "#f9fafb", "#e5e7eb")}>{cs.cancelled}</span>
                    <span style={attChip("#1d4ed8", "#eff6ff", "#bfdbfe")}>{cs.total}</span>
                  </div>
                </div>
              );
            })}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ─── View Teacher Modal ──────────────────────────────────────────────────────

function ViewTeacherModal({ teacher, centerName, onClose }: {
  teacher: TeacherUser; centerName: (id: string) => string; onClose: () => void;
}) {
  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span style={s.modalTitle}>{teacher.displayName}</span>
          <button onClick={onClose} style={s.closeBtn}>×</button>
        </div>
        <div style={s.modalBody}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <TeacherAvatar photoURL={teacher.photoURL} name={teacher.displayName} size={64} />
          </div>
          <ViewRow label="Email" value={teacher.email} />
          <ViewRow label="Status" value={<StatusBadge status={teacher.status} />} />
          <ViewRow label="Assigned Centers" value={
            (teacher.centerIds ?? []).length === 0
              ? <span style={{ color: "#9ca3af", fontSize: 12 }}>None assigned</span>
              : <div style={{ ...s.centerTags, justifyContent: "flex-end" as const }}>
                  {(teacher.centerIds ?? []).map(id => <span key={id} style={s.centerTag}>{centerName(id)}</span>)}
                </div>
          } />
        </div>
      </div>
    </div>
  );
}

function ViewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={s.viewRow}>
      <span style={s.viewRowLabel}>{label}</span>
      <span style={s.viewRowValue}>{value}</span>
    </div>
  );
}

// ─── Edit Teacher Details Modal ─────────────────────────────────────────────

function EditTeacherDetailsModal({ teacher, onClose, onSaved }: {
  teacher: TeacherUser;
  onClose: () => void;
  onSaved: (updated: { displayName: string; email: string; status: UserStatus; photoURL?: string | null }) => void;
}) {
  const [name, setName]       = useState(teacher.displayName);
  const [email, setEmail]     = useState(teacher.email);
  const [status, setStatus]   = useState<UserStatus>(teacher.status);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!name.trim())  { setError("Name is required.");  return; }
    if (!email.trim()) { setError("Email is required."); return; }
    setError("");
    setSaving(true);
    try {
      let photoURL = teacher.photoURL ?? null;
      if (photoFile) {
        photoURL = await uploadTeacherPhoto(teacher.uid, photoFile);
      }
      await updateDoc(doc(db, "users", teacher.uid), {
        displayName: name.trim(),
        email:       email.trim().toLowerCase(),
        status,
        photoURL,
        updatedAt:   serverTimestamp(),
      });
      if (email.trim().toLowerCase() !== teacher.email.toLowerCase()) {
        // Firestore updated; Firebase Auth email update requires server-side Admin SDK.
        console.info("Teacher email changed in Firestore. Firebase Auth email was not updated.");
      }
      onSaved({ displayName: name.trim(), email: email.trim().toLowerCase(), status, photoURL });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span style={s.modalTitle}>Edit Details — {teacher.displayName}</span>
          <button onClick={onClose} style={s.closeBtn}>×</button>
        </div>
        <div style={s.modalBody}>
          <form onSubmit={handleSave}>
            {error && <div style={{ ...s.bannerError, marginBottom: 14 }}>{error}</div>}
            <div style={s.grid2}>
              <Field label="Full Name">
                <input style={s.input} value={name} onChange={e => setName(e.target.value)} required />
              </Field>
              <Field label="Email Address">
                <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} required />
              </Field>
              <Field label="Status">
                <select style={s.input} value={status} onChange={e => setStatus(e.target.value as UserStatus)}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
              <Field label="Profile Picture">
                <PhotoUploadField file={photoFile} currentUrl={teacher.photoURL} name={name || teacher.displayName} onChange={setPhotoFile} />
              </Field>
            </div>
            <div style={s.formActions}>
              <button type="button" style={s.btnGhost} onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" disabled={saving} style={{ ...s.btnPrimary, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
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
  fileInput:    { fontSize: 12.5, color: "var(--color-text-secondary)" },
  showHide:     { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#9ca3af", fontSize: 11, cursor: "pointer", padding: 0 },
  formActions:  { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 },

  checkboxGrid: { display: "flex", flexDirection: "column", gap: 10 },
  checkboxLabel:{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
  centerCode:   { fontFamily: "monospace", fontSize: 11, background: "#ede9fe", color: "#6d28d9", padding: "1px 7px", borderRadius: 4, fontWeight: 600, marginLeft: 4 },

  badge:        { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600 },
  centerTags:   { display: "flex", flexWrap: "wrap" as const, gap: 6 },
  centerTag:    { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: "#e0e7ff", color: "#4338ca" },

  empty:        { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },

  // ── Card grid (Teachers + Performance tabs) ──────────────────────────────
  grid:         { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 },
  tCard:        { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 18px", display: "flex", flexDirection: "column" as const, gap: 8, cursor: "pointer" },
  tCardHover:   { boxShadow: "0 4px 14px rgba(0,0,0,0.08)" },
  tCardHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between" },
  tAvatar: {
    width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
    background: "linear-gradient(135deg, #6d28d9, #4f46e5)",
    color: "#fff", fontSize: 13, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  tName:        { fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" },
  tEmail:       { fontSize: 13, color: "var(--color-text-secondary)" },

  // ── Three-dots menu ───────────────────────────────────────────────────────
  menuBtn: {
    background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 8,
    width: 28, height: 28, fontSize: 15, fontWeight: 700, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
  },
  menuPanel: {
    position: "absolute" as const, top: "calc(100% + 6px)", right: 0, background: "#fff",
    border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
    minWidth: 190, overflow: "hidden", zIndex: 10,
  },
  menuItem: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px",
    fontSize: 13, fontWeight: 500, color: "#111827", background: "none", border: "none",
    textAlign: "left" as const, cursor: "pointer", boxSizing: "border-box" as const, whiteSpace: "nowrap" as const,
  },
  menuItemDanger: { color: "#dc2626" },

  // ── Performance list (table) ─────────────────────────────────────────────
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th:    { textAlign: "left" as const, padding: "8px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-2)", whiteSpace: "nowrap" as const },
  tr:    { borderBottom: "1px solid var(--color-border)" },
  td:    { padding: "10px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle" as const },
  perfBreakdownTitle: { fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 8 },
  perfBreakdownRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" as const, padding: "6px 0" },

  overlay:      { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:        { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 480, boxShadow: "0 8px 32px rgba(0,0,0,0.16)", overflow: "hidden" },
  modalHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" },
  modalTitle:   { fontSize: 15, fontWeight: 600, color: "#111" },
  closeBtn:     { background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#6b7280", lineHeight: 1 },
  modalBody:    { padding: "20px" },
  modalHint:    { fontSize: 13, color: "#6b7280", marginTop: 0, marginBottom: 14 },

  viewRow:      { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: "1px solid #f3f4f6" },
  viewRowLabel: { fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.04em", minWidth: 110 },
  viewRowValue: { fontSize: 13, color: "#111827", textAlign: "right" as const, flex: 1 },
};
