"use client";

import { useEffect, useRef, useState } from "react";
import { getCenters, createCenter, updateCenter } from "@/services/center/center.service";
import { getTeachers } from "@/services/teacher/teacher.service";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import type { Center } from "@/types";
import type { TeacherUser } from "@/types";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { useAuth } from "@/hooks/useAuth";
import { deleteCenter } from "@/services/admin/delete.service";

// ─── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = typeof DAYS[number];

const EMPTY_FORM = {
  name:        "",
  teacherUid:  "",
  status:      "active" as "active" | "inactive",
  daysOfWeek:  [] as Day[],
  startTime:   "",
  endTime:     "",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const style = status === "active"
    ? { background: "#dcfce7", color: "#16a34a" }
    : { background: "#f3f4f6", color: "#6b7280" };
  return <span style={{ ...styles.badge, ...style }}>{status}</span>;
}

function FormField({ label, required, children, fullWidth }: {
  label: string; required?: boolean; children: React.ReactNode; fullWidth?: boolean;
}) {
  return (
    <div style={{ ...formStyles.field, ...(fullWidth ? { gridColumn: "1 / -1" } : {}) }}>
      <label style={formStyles.label}>
        {label}{required && <span style={formStyles.required}> *</span>}
      </label>
      {children}
    </div>
  );
}

function DayChips({ selected, onChange }: { selected: Day[]; onChange: (d: Day[]) => void }) {
  function toggle(day: Day) {
    if (selected.includes(day)) onChange(selected.filter(d => d !== day));
    else if (selected.length < 6) onChange([...selected, day]);
  }
  return (
    <div style={chipStyles.row}>
      {DAYS.map(day => {
        const active = selected.includes(day);
        return (
          <button key={day} type="button" onClick={() => toggle(day)}
            style={{ ...chipStyles.chip, ...(active ? chipStyles.chipActive : chipStyles.chipInactive) }}>
            {day}
          </button>
        );
      })}
    </div>
  );
}

// ─── View Modal ────────────────────────────────────────────────────────────────

function ViewModal({ center, onClose, teachers }: { center: Center; onClose: () => void; teachers: TeacherUser[] }) {
  const raw = center as Center & { daysOfWeek?: string[]; startTime?: string; endTime?: string };
  const teacher = teachers.find(t => t.uid === center.teacherUid);
  const teacherLabel = teacher ? `${teacher.displayName} (${teacher.email})` : center.teacherUid || "-";
  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.box} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>{center.name}</span>
          <button onClick={onClose} style={modalStyles.closeBtn}>×</button>
        </div>
        <div style={modalStyles.body}>
          <ViewRow label="Center Code"  value={(center as Center & { centerCode?: string }).centerCode || "-"} mono />
          <ViewRow label="Teacher"      value={teacherLabel} />
          <ViewRow label="Days"         value={raw.daysOfWeek?.join(", ") || center.timeSlot || "-"} />
          <ViewRow label="Start Time"   value={raw.startTime  || "-"} />
          <ViewRow label="End Time"     value={raw.endTime    || "-"} />
          <ViewRow label="Status"       value={center.status} />
        </div>
      </div>
    </div>
  );
}

function ViewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={modalStyles.row}>
      <span style={modalStyles.rowLabel}>{label}</span>
      <span style={{ ...modalStyles.rowValue, ...(mono ? styles.mono : {}) }}>{value}</span>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CentersPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <CentersContent />
    </ProtectedRoute>
  );
}

function CentersContent() {
  const { user, role }              = useAuth();
  const [centers, setCenters]       = useState<Center[]>([]);
  const [teachers, setTeachers]     = useState<TeacherUser[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [editTarget, setEditTarget] = useState<Center | null>(null);
  const [viewTarget, setViewTarget] = useState<Center | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Center | null>(null);
  const [form, setForm]             = useState({ ...EMPTY_FORM });
  const [saving, setSaving]         = useState(false);
  const [dayError, setDayError]     = useState("");
  const { toasts, toast, remove }   = useToast();

  async function fetchCenters() {
    try {
      const [data, teacherList] = await Promise.all([
        getCenters(),
        getTeachers(),
      ]);
      setCenters(data);
      setTeachers(teacherList.sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch (err) {
      console.error("Failed to fetch centers:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchCenters(); }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleDaysChange(days: Day[]) {
    setForm(prev => ({ ...prev, daysOfWeek: days }));
    if (days.length > 0) setDayError("");
  }

  function openCreate() {
    setEditTarget(null);
    setForm({ ...EMPTY_FORM });
    setDayError("");
    setShowForm(true);
  }

  function openEdit(center: Center) {
    const raw = center as Center & { daysOfWeek?: Day[]; startTime?: string; endTime?: string };
    setEditTarget(center);
    setForm({
      name:       center.name,
      teacherUid: center.teacherUid,
      status:     center.status as "active" | "inactive",
      daysOfWeek: raw.daysOfWeek ?? [],
      startTime:  raw.startTime  ?? "",
      endTime:    raw.endTime    ?? "",
    });
    setDayError("");
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditTarget(null);
    setForm({ ...EMPTY_FORM });
    setDayError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.daysOfWeek.length === 0) { setDayError("Select at least 1 day."); return; }
    setSaving(true);
    const timeSlot = `${form.daysOfWeek.join("/")} ${form.startTime}–${form.endTime}`;
    try {
      if (editTarget) {
        await updateCenter(editTarget.id, {
          name:       form.name.trim(),
          teacherUid: form.teacherUid.trim(),
          status:     form.status,
          timeSlot,
          // extra fields — passed through by updateCenter's whitelist only for known keys
        });
        // patch extra fields directly since updateCenter whitelists known Center fields
        const { doc: fsDoc, updateDoc, serverTimestamp } = await import("firebase/firestore");
        const { db } = await import("@/config/firebase");
        await updateDoc(fsDoc(db, "centers", editTarget.id), {
          daysOfWeek: form.daysOfWeek,
          startTime:  form.startTime,
          endTime:    form.endTime,
        });
        toast("Center updated successfully.", "success");
      } else {
        await createCenter({
          name:        form.name.trim(),
          location:    "",
          timeSlot,
          teacherUid:  form.teacherUid.trim(),
          studentUids: [],
          status:      form.status,
          ...(({ daysOfWeek: form.daysOfWeek, startTime: form.startTime, endTime: form.endTime }) as object),
        } as Parameters<typeof createCenter>[0]);
        toast("Center created successfully.", "success");
      }
      closeForm();
      setLoading(true);
      await fetchCenters();
    } catch (err) {
      console.error("Failed to save center:", err);
      toast(editTarget ? "Failed to update center." : "Failed to create center.", "error");
    } finally {
      setSaving(false);
    }
  }

  const isEditing = !!editTarget;

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />
      {viewTarget && <ViewModal center={viewTarget} onClose={() => setViewTarget(null)} teachers={teachers} />}
      {deleteTarget && (
        <DeleteCenterModal
          center={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setCenters(prev => prev.filter(c => c.id !== deleteTarget.id));
            setDeleteTarget(null);
            toast(`Center "${deleteTarget.name}" deleted.`, "success");
          }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}

      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.heading}>Centers</h1>
        <button onClick={showForm ? closeForm : openCreate} style={styles.addBtn}>
          {showForm ? "Cancel" : "Add Center"}
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={formStyles.wrapper}>
          <div style={formStyles.sectionTitle}>
            {isEditing ? `Editing: ${editTarget!.name}` : "New Center"}
          </div>
          <div style={formStyles.grid}>
            <FormField label="Name" required>
              <input name="name" value={form.name} onChange={handleChange} required
                placeholder="e.g. Koramangala Center" style={formStyles.input} />
            </FormField>
            <FormField label="Assigned Teacher" required>
              <select
                name="teacherUid"
                value={form.teacherUid}
                onChange={handleChange}
                required
                style={formStyles.input}
              >
                <option value="">— Select a teacher —</option>
                {teachers.map(t => (
                  <option key={t.uid} value={t.uid}>{t.displayName} ({t.email})</option>
                ))}
              </select>
            </FormField>
            <FormField label="Status">
              <select name="status" value={form.status} onChange={handleChange} style={formStyles.input}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </FormField>
            <FormField label="Start Time" required>
              <input name="startTime" type="time" value={form.startTime} onChange={handleChange}
                required style={formStyles.input} />
            </FormField>
            <FormField label="End Time" required>
              <input name="endTime" type="time" value={form.endTime} onChange={handleChange}
                required style={formStyles.input} />
            </FormField>
            <FormField label="Days of Week" required fullWidth>
              <DayChips selected={form.daysOfWeek} onChange={handleDaysChange} />
              {dayError && <span style={formStyles.errorText}>{dayError}</span>}
              {form.daysOfWeek.length > 0 && (
                <span style={formStyles.helperText}>
                  {form.daysOfWeek.join(", ")} · {form.daysOfWeek.length}/6 selected
                </span>
              )}
            </FormField>
          </div>
          <div style={formStyles.actions}>
            <button type="submit" disabled={saving}
              style={{ ...formStyles.submitBtn, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : isEditing ? "Update Center" : "Create Center"}
            </button>
          </div>
        </form>
      )}

      {/* Grid */}
      {loading ? (
        <div style={styles.stateRow}>Loading…</div>
      ) : centers.length === 0 ? (
        <div style={styles.stateRow}>No centers available.</div>
      ) : (
        <div style={styles.grid}>
          {centers.map(center => (
            <CenterCard key={center.id} center={center}
              teachers={teachers}
              onView={() => setViewTarget(center)}
              onEdit={() => openEdit(center)}
              onDelete={() => setDeleteTarget(center)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────────────

function CenterCard({ center, teachers, onView, onEdit, onDelete }: {
  center: Center; teachers: TeacherUser[];
  onView: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const [hover, setHover]     = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const raw = center as Center & { centerCode?: string };
  const teacher = teachers.find(t => t.uid === center.teacherUid);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <div
      onClick={onView}
      style={{ ...styles.card, ...(hover ? styles.cardHover : {}), cursor: "pointer", position: "relative" }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    >
      <div style={styles.cardHeader}>
        <span style={styles.codeChip}>{raw.centerCode || "-"}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={center.status} />
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
              style={actionStyles.menuBtn}
              title="More actions"
              aria-label="More actions"
            >
              ⋮
            </button>
            {menuOpen && (
              <div style={actionStyles.menuPanel} onClick={e => e.stopPropagation()}>
                <button onClick={() => { setMenuOpen(false); onEdit(); }} style={actionStyles.menuItem}>
                  ✏ Edit
                </button>
                <button onClick={() => { setMenuOpen(false); onDelete(); }} style={{ ...actionStyles.menuItem, ...actionStyles.menuItemDanger }}>
                  ✕ Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={styles.cardName}>{center.name}</div>
      <div style={styles.cardMeta}>
        <span style={styles.cardMetaLabel}>Teacher</span>
        {teacher
          ? <span>{teacher.displayName}</span>
          : <span style={{ color: "#9ca3af", fontSize: 12 }}>Unassigned</span>}
      </div>
      <div style={styles.cardMeta}>
        <span style={styles.cardMetaLabel}>Schedule</span>
        <span>{center.timeSlot || "-"}</span>
      </div>
    </div>
  );
}

// ─── Delete Center Modal ───────────────────────────────────────────────────────

function DeleteCenterModal({ center, onClose, onDeleted, currentUserUid, currentUserRole }: {
  center:          Center;
  onClose:         () => void;
  onDeleted:       () => void;
  currentUserUid:  string;
  currentUserRole: string;
}) {
  const [confirmed, setConfirmed] = useState("");
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState("");

  const confirmWord = center.name.split(" ")[0] ?? "DELETE";
  const canDelete   = confirmed === confirmWord;

  async function handleDelete() {
    if (!canDelete) return;
    setBusy(true);
    setError("");
    try {
      const res = await deleteCenter(center.id, currentUserUid, currentUserRole as never);
      if (res.success) {
        onDeleted();
      } else {
        setError(res.error ?? "Delete failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={{ ...modalStyles.box, maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={{ ...modalStyles.title, color: "#991b1b" }}>✕ Delete Center</span>
          <button onClick={onClose} style={modalStyles.closeBtn}>×</button>
        </div>
        <div style={modalStyles.body}>
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#991b1b" }}>
            <strong>This will permanently delete &ldquo;{center.name}&rdquo;</strong> and all its center-wide lessons. Students and teachers must be reassigned before deletion.
          </div>
          <div style={{ fontSize: 12, color: "#374151" }}>
            Type <strong style={{ color: "#dc2626" }}>{confirmWord}</strong> to confirm:
          </div>
          <input
            value={confirmed}
            onChange={e => { setConfirmed(e.target.value); setError(""); }}
            placeholder={`Type "${confirmWord}"`}
            style={{ padding: "8px 10px", border: `1px solid ${canDelete ? "#86efac" : "#d1d5db"}`, borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111827", width: "100%", boxSizing: "border-box" }}
          />
          {error && (
            <div style={{ fontSize: 12, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "7px 10px" }}>
              ✕ {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
            <button onClick={onClose} style={{ background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={handleDelete} disabled={!canDelete || busy}
              style={{ background: canDelete && !busy ? "#dc2626" : "#f3f4f6", color: canDelete && !busy ? "#fff" : "#9ca3af", border: "none", padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: canDelete && !busy ? "pointer" : "not-allowed" }}>
              {busy ? "Deleting…" : "Delete Center"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header:      { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  heading:     { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)" },
  addBtn:      { background: "#4f46e5", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  stateRow:    { padding: "24px 16px", textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10 },
  grid:        { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 },
  card:        { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 },
  cardHover:   { boxShadow: "0 4px 14px rgba(0,0,0,0.08)" },
  cardHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between" },
  cardName:    { fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" },
  cardMeta:    { display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: "var(--color-text-primary)" },
  cardMetaLabel:{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  mono:        { fontFamily: "monospace", fontSize: 12, color: "var(--color-text-secondary)" },
  codeChip:    { fontFamily: "monospace", fontSize: 11, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4, fontWeight: 600 },
  badge:       { display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize" },
};

const formStyles: Record<string, React.CSSProperties> = {
  wrapper:     { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "20px 24px", marginBottom: 16 },
  sectionTitle:{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 16 },
  grid:        { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 16 },
  field:       { display: "flex", flexDirection: "column", gap: 6 },
  label:       { fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.04em" },
  required:    { color: "#dc2626" },
  input:       { padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111827" },
  errorText:   { fontSize: 11, color: "#dc2626", marginTop: 2 },
  helperText:  { fontSize: 11, color: "#6b7280", marginTop: 4 },
  actions:     { display: "flex", justifyContent: "flex-end" },
  submitBtn:   { background: "#4f46e5", color: "#fff", border: "none", padding: "8px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
};

const chipStyles: Record<string, React.CSSProperties> = {
  row:         { display: "flex", gap: 8, flexWrap: "wrap" },
  chip:        { padding: "5px 12px", borderRadius: 99, fontSize: 12, fontWeight: 600, border: "1.5px solid transparent", cursor: "pointer" },
  chipActive:  { background: "#4f46e5", color: "#fff", borderColor: "#4f46e5" },
  chipInactive:{ background: "#f3f4f6", color: "#374151", borderColor: "#e5e7eb" },
};

const actionStyles: Record<string, React.CSSProperties> = {
  menuBtn: {
    background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 8,
    width: 28, height: 28, fontSize: 15, fontWeight: 700, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
  },
  menuPanel: {
    position: "absolute", top: "calc(100% + 6px)", right: 0, background: "#fff",
    border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
    minWidth: 150, overflow: "hidden", zIndex: 10,
  },
  menuItem: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px",
    fontSize: 13, fontWeight: 500, color: "#111827", background: "none", border: "none",
    textAlign: "left", cursor: "pointer", boxSizing: "border-box",
  },
  menuItemDanger: { color: "#dc2626" },
};

const modalStyles: Record<string, React.CSSProperties> = {
  overlay:  { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
  box:      { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 420, boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" },
  header:   { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" },
  title:    { fontSize: 15, fontWeight: 600, color: "#111827" },
  closeBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1 },
  body:     { padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 },
  row:      { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  rowLabel: { fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 90 },
  rowValue: { fontSize: 13, color: "#111827", textAlign: "right" },
};
