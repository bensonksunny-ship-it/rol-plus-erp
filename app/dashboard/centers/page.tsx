"use client";

import { useEffect, useState } from "react";
import { getCenters, createCenter, updateCenter } from "@/services/center/center.service";
import { getTeachers } from "@/services/teacher/teacher.service";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import type { Center } from "@/types";
import type { TeacherUser } from "@/types";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";

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

function ActionButton({ label, onClick, variant = "ghost" }: {
  label: string; onClick: () => void; variant?: "ghost" | "primary";
}) {
  const [hover, setHover] = useState(false);
  const base = variant === "primary" ? actionStyles.primary : actionStyles.ghost;
  const hov  = variant === "primary" ? actionStyles.primaryHover : actionStyles.ghostHover;
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...actionStyles.base, ...base, ...(hover ? hov : {}) }}>
      {label}
    </button>
  );
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
  const [centers, setCenters]       = useState<Center[]>([]);
  const [teachers, setTeachers]     = useState<TeacherUser[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [editTarget, setEditTarget] = useState<Center | null>(null);
  const [viewTarget, setViewTarget] = useState<Center | null>(null);
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

      {/* Table */}
      <div style={styles.tableWrapper}>
        {loading ? (
          <div style={styles.stateRow}>Loading…</div>
        ) : centers.length === 0 ? (
          <div style={styles.stateRow}>No centers available.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Code</th>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Teacher</th>
                <th style={styles.th}>Schedule</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {centers.map((center, i) => (
                <CenterRow key={center.id} center={center} index={i}
                  teachers={teachers}
                  onView={() => setViewTarget(center)}
                  onEdit={() => openEdit(center)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────────

function CenterRow({ center, index, teachers, onView, onEdit }: {
  center: Center; index: number; teachers: TeacherUser[]; onView: () => void; onEdit: () => void;
}) {
  const [hover, setHover] = useState(false);
  const raw = center as Center & { centerCode?: string };
  const teacher = teachers.find(t => t.uid === center.teacherUid);
  return (
    <tr style={{ ...(index % 2 === 0 ? styles.rowEven : styles.rowOdd), ...(hover ? styles.rowHover : {}) }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <td style={{ ...styles.td, ...styles.mono }}>
        <span style={styles.codeChip}>{raw.centerCode || "-"}</span>
      </td>
      <td style={styles.tdBold}>{center.name}</td>
      <td style={styles.td}>
        {teacher
          ? <span>{teacher.displayName}</span>
          : <span style={{ color: "#9ca3af", fontSize: 12 }}>Unassigned</span>}
      </td>
      <td style={styles.td}>{center.timeSlot || "-"}</td>
      <td style={styles.td}><StatusBadge status={center.status} /></td>
      <td style={styles.td}>
        <div style={actionStyles.row}>
          <ActionButton label="View" variant="ghost"   onClick={onView} />
          <ActionButton label="Edit" variant="primary" onClick={onEdit} />
        </div>
      </td>
    </tr>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header:      { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  heading:     { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)" },
  addBtn:      { background: "#4f46e5", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  tableWrapper:{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  stateRow:    { padding: "24px 16px", textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" },
  table:       { width: "100%", borderCollapse: "collapse" },
  th:          { padding: "11px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid var(--color-border)", background: "#f9fafb" },
  td:          { padding: "12px 16px", fontSize: 13, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  tdBold:      { padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:     { background: "var(--color-surface)" },
  rowOdd:      { background: "#fafafa" },
  rowHover:    { background: "#f0f4ff" },
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
  row:          { display: "flex", gap: 6, alignItems: "center" },
  base:         { border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  ghost:        { background: "#f3f4f6", color: "#374151" },
  ghostHover:   { background: "#e5e7eb" },
  primary:      { background: "#ede9fe", color: "#4f46e5" },
  primaryHover: { background: "#ddd6fe" },
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
