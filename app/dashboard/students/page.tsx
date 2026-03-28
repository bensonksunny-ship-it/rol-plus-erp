"use client";

import { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { collection, getDocs, addDoc, query, where, serverTimestamp } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { getUnits, assignSyllabus, getStudentSyllabus } from "@/services/syllabus/syllabus.service";
import { logAction } from "@/services/audit/audit.service";
import { useAuth } from "@/hooks/useAuth";
import type { SyllabusUnit } from "@/types/syllabus";
import {
  buildLessonsFromRows,
  validateSyllabusRows,
  saveStudentSyllabus,
} from "@/services/studentSyllabus/studentSyllabus.service";
import type { SyllabusImportRow } from "@/types/studentSyllabus";
import Link from "next/link";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StudentRow {
  id: string;
  name: string;
  admissionNumber: string;
  centerId: string;
  instrument: string;
  course: string;
  feeCycle: string;
  feePerClass: number;
  status: string;
}

const EMPTY_FORM = {
  name:            "",
  admissionNumber: "",
  centerId:        "",
  instrument:      "",
  course:          "",
  feeCycle:        "monthly",
  feePerClass:     "",
  status:          "active",
};

// ─── Constants ─────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  active:                 { background: "#dcfce7", color: "#16a34a" },
  inactive:               { background: "#f3f4f6", color: "#6b7280" },
  deactivation_requested: { background: "#fef9c3", color: "#b45309" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ ...styles.badge, ...(STATUS_STYLES[status] ?? { background: "#f3f4f6", color: "#6b7280" }) }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ActionButton({
  label,
  onClick,
  variant = "ghost",
}: {
  label: string;
  onClick: () => void;
  variant?: "ghost" | "danger";
}) {
  const [hover, setHover] = useState(false);
  const base = variant === "danger" ? actionStyles.danger : actionStyles.ghost;
  const hov  = variant === "danger" ? actionStyles.dangerHover : actionStyles.ghostHover;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...actionStyles.base, ...base, ...(hover ? hov : {}) }}
    >
      {label}
    </button>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StudentsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <StudentsContent />
    </ProtectedRoute>
  );
}

function StudentsContent() {
  const { user, role }                = useAuth();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch]           = useState("");
  const [students, setStudents]       = useState<StudentRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState({ ...EMPTY_FORM });
  const [saving, setSaving]           = useState(false);
  const debounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, toast, remove }     = useToast();

  // Debounced search
  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(val), 300);
  }

  async function fetchStudents() {
    try {
      const q = query(collection(db, "users"), where("role", "==", "student"));
      const snap = await getDocs(q);
      const rows: StudentRow[] = snap.docs.map(doc => {
        const d = doc.data();
        return {
          id:              doc.id,
          name:            d.name            ?? "-",
          admissionNumber: d.admissionNumber ?? "-",
          centerId:        d.centerId        ?? "-",
          instrument:      d.instrument      ?? "-",
          course:          d.course          ?? "-",
          feeCycle:        d.feeCycle        ?? "-",
          feePerClass:     d.feePerClass     ?? 0,
          status:          d.status          ?? "-",
        };
      });
      setStudents(rows);
    } catch (err) {
      console.error("Failed to fetch students:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchStudents(); }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const studentRef = await addDoc(collection(db, "users"), {
        name:            form.name.trim(),
        admissionNumber: form.admissionNumber.trim(),
        centerId:        form.centerId.trim(),
        instrument:      form.instrument.trim(),
        course:          form.course.trim(),
        feeCycle:        form.feeCycle,
        feePerClass:     form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        status:          form.status,
        role:            "student",
        currentBalance:  0,
        createdAt:       serverTimestamp(),
        updatedAt:       serverTimestamp(),
      });
      logAction({
        action:        "STUDENT_CREATED",
        initiatorId:   user?.uid ?? "unknown",
        initiatorRole: role ?? "admin",
        approverId:    null,
        approverRole:  null,
        reason:        null,
        metadata:      {
          studentId:       studentRef.id,
          name:            form.name.trim(),
          admissionNumber: form.admissionNumber.trim(),
          centerId:        form.centerId.trim(),
          course:          form.course.trim(),
          feeCycle:        form.feeCycle,
        },
      });
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      setLoading(true);
      await fetchStudents();
      toast("Student created successfully.", "success");
    } catch (err) {
      console.error("Failed to create student:", err);
      toast("Failed to create student.", "error");
    } finally {
      setSaving(false);
    }
  }

  const filtered = students.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  const isEmpty   = !loading && students.length === 0;
  const noResults = !loading && students.length > 0 && filtered.length === 0;

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.heading}>Students</h1>
        <button onClick={() => setShowForm(v => !v)} style={styles.addBtn}>
          {showForm ? "Cancel" : "Add Student"}
        </button>
      </div>

      {/* Inline Form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={formStyles.wrapper}>
          <div style={formStyles.grid}>
            <div style={formStyles.field}>
              <label style={formStyles.label}>Name</label>
              <input name="name" value={form.name} onChange={handleChange} required
                placeholder="e.g. Arjun Sharma" style={formStyles.input} />
            </div>
            <div style={formStyles.field}>
              <label style={formStyles.label}>Admission No.</label>
              <input name="admissionNumber" value={form.admissionNumber} onChange={handleChange} required
                placeholder="e.g. ROL-2026-001" style={formStyles.input} />
            </div>
            <div style={formStyles.field}>
              <label style={formStyles.label}>Center ID</label>
              <input name="centerId" value={form.centerId} onChange={handleChange} required
                placeholder="Firestore center doc ID" style={formStyles.input} />
            </div>
            <div style={formStyles.field}>
              <label style={formStyles.label}>Instrument</label>
              <input name="instrument" value={form.instrument} onChange={handleChange} required
                placeholder="e.g. Guitar" style={formStyles.input} />
            </div>
            <div style={formStyles.field}>
              <label style={formStyles.label}>Course</label>
              <input name="course" value={form.course} onChange={handleChange} required
                placeholder="e.g. Beginner Guitar" style={formStyles.input} />
            </div>
            <div style={formStyles.field}>
              <label style={formStyles.label}>Fee Cycle</label>
              <select name="feeCycle" value={form.feeCycle} onChange={handleChange} style={formStyles.input}>
                <option value="monthly">Monthly</option>
                <option value="per_class">Per Class</option>
              </select>
            </div>
            {form.feeCycle === "per_class" && (
              <div style={formStyles.field}>
                <label style={formStyles.label}>Fee Per Class (₹)</label>
                <input name="feePerClass" type="number" min="0" step="1"
                  value={form.feePerClass} onChange={handleChange} required
                  placeholder="e.g. 500" style={formStyles.input} />
              </div>
            )}
            <div style={formStyles.field}>
              <label style={formStyles.label}>Status</label>
              <select name="status" value={form.status} onChange={handleChange} style={formStyles.input}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div style={formStyles.actions}>
            <button type="submit" disabled={saving} style={{ ...formStyles.submitBtn, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Create Student"}
            </button>
          </div>
        </form>
      )}

      {/* Search */}
      <div style={styles.searchRow}>
        <input
          type="text"
          placeholder="Search students…"
          value={searchInput}
          onChange={handleSearchChange}
          style={styles.searchInput}
        />
      </div>

      {/* Table */}
      <div style={styles.tableWrapper}>
        {loading ? (
          <div style={styles.stateRow}>Loading…</div>
        ) : isEmpty ? (
          <div style={styles.stateRow}>No students available.</div>
        ) : noResults ? (
          <div style={styles.stateRow}>No students found for "{search}".</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Admission No.</th>
                <th style={styles.th}>Center ID</th>
                <th style={styles.th}>Instrument</th>
                <th style={styles.th}>Course</th>
                <th style={styles.th}>Fee Cycle</th>
                <th style={styles.th}>Fee/Class</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <StudentRow
                  key={s.id}
                  student={s}
                  index={i}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

// ─── Set Syllabus Modal ────────────────────────────────────────────────────────

function SetSyllabusModal({
  studentId,
  studentName,
  onClose,
  onSaved,
}: {
  studentId:   string;
  studentName: string;
  onClose:     () => void;
  onSaved:     () => void;
}) {
  const [units, setUnits]       = useState<SyllabusUnit[]>([]);
  const [checked, setChecked]   = useState<Set<string>>(new Set());
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const { toasts, toast, remove } = useToast();

  useEffect(() => {
    async function load() {
      try {
        const [allUnits, assignment] = await Promise.all([
          getUnits(),
          getStudentSyllabus(studentId),
        ]);
        setUnits(allUnits);
        if (assignment) setChecked(new Set(assignment.unitIds));
      } catch (err) {
        console.error("Failed to load syllabus data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [studentId]);

  function toggle(unitId: string) {
    setChecked(prev => {
      const next = new Set(prev);
      next.has(unitId) ? next.delete(unitId) : next.add(unitId);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await assignSyllabus(studentId, Array.from(checked));
      toast("Syllabus assigned.", "success");
      setTimeout(() => { onSaved(); onClose(); }, 800);
    } catch (err) {
      console.error("Failed to assign syllabus:", err);
      toast("Failed to assign syllabus.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.box} onClick={e => e.stopPropagation()}>
        <ToastContainer toasts={toasts} onRemove={remove} />
        <div style={modalStyles.header}>
          <div>
            <div style={modalStyles.title}>Set Syllabus</div>
            <div style={modalStyles.sub}>{studentName}</div>
          </div>
          <button onClick={onClose} style={modalStyles.closeBtn}>✕</button>
        </div>

        {loading ? (
          <div style={modalStyles.state}>Loading units…</div>
        ) : units.length === 0 ? (
          <div style={modalStyles.state}>No units found in syllabus master.</div>
        ) : (
          <div style={modalStyles.list}>
            {units.map(unit => (
              <label key={unit.id} style={modalStyles.item}>
                <input
                  type="checkbox"
                  checked={checked.has(unit.id)}
                  onChange={() => toggle(unit.id)}
                  style={{ marginRight: 10, accentColor: "#4f46e5" }}
                />
                <span style={modalStyles.unitLabel}>
                  <span style={modalStyles.unitTitle}>{unit.title}</span>
                  <span style={modalStyles.unitLevel}>{unit.level}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <div style={modalStyles.footer}>
          <button onClick={onClose} style={modalStyles.cancelBtn}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{ ...modalStyles.saveBtn, opacity: saving || loading ? 0.6 : 1 }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Row component ─────────────────────────────────────────────────────────────

function StudentRow({ student: s, index }: { student: StudentRow; index: number }) {
  const [hover, setHover]                     = useState(false);
  const [showSyllabus, setShowSyllabus]       = useState(false);
  const [showImportSyllabus, setShowImportSyllabus] = useState(false);

  const rowBase  = index % 2 === 0 ? styles.rowEven : styles.rowOdd;
  const rowStyle: React.CSSProperties = {
    ...rowBase,
    ...(hover ? styles.rowHover : {}),
  };

  return (
    <>
      {showSyllabus && typeof document !== "undefined" && ReactDOM.createPortal(
        <SetSyllabusModal
          studentId={s.id}
          studentName={s.name}
          onClose={() => setShowSyllabus(false)}
          onSaved={() => {}}
        />,
        document.body
      )}
      {showImportSyllabus && typeof document !== "undefined" && ReactDOM.createPortal(
        <ImportSyllabusModal
          studentId={s.id}
          studentName={s.name}
          admissionNumber={s.admissionNumber}
          onClose={() => setShowImportSyllabus(false)}
        />,
        document.body
      )}
      <tr
        style={rowStyle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <td style={{ ...styles.td, minWidth: 140 }}>{s.name}</td>
        <td style={{ ...styles.td, ...styles.mono, minWidth: 120 }}>{s.admissionNumber}</td>
        <td style={{ ...styles.td, ...styles.mono, minWidth: 100 }}>{s.centerId}</td>
        <td style={styles.td}>{s.instrument}</td>
        <td style={styles.td}>{s.course}</td>
        <td style={styles.td}>
          <span style={{
            ...styles.badge,
            ...(s.feeCycle === "per_class"
              ? { background: "#ede9fe", color: "#7c3aed" }
              : { background: "#dbeafe", color: "#1d4ed8" }),
          }}>
            {s.feeCycle === "per_class" ? "Per Class" : s.feeCycle === "monthly" ? "Monthly" : s.feeCycle}
          </span>
        </td>
        <td style={styles.td}>
          {s.feeCycle === "per_class" ? `₹${s.feePerClass}` : "—"}
        </td>
        <td style={styles.td}>
          <StatusBadge status={s.status} />
        </td>
        <td style={{ ...styles.td, minWidth: 280 }}>
          <div style={actionStyles.row}>
            <Link href={`/dashboard/student-syllabus/${s.id}`} style={actionStyles.linkBtn}>
              Syllabus
            </Link>
            <ActionButton label="Import Syllabus" variant="ghost"  onClick={() => setShowImportSyllabus(true)} />
            <ActionButton label="Set Syllabus"    variant="ghost"  onClick={() => setShowSyllabus(true)} />
            <ActionButton label="Deactivate"      variant="danger" onClick={() => {}} />
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  addBtn: {
    background: "#4f46e5",
    color: "#ffffff",
    border: "none",
    padding: "8px 16px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  searchRow: {
    marginBottom: 16,
  },
  searchInput: {
    width: "100%",
    maxWidth: 320,
    padding: "8px 12px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    fontSize: 13,
    outline: "none",
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
  },
  tableWrapper: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    overflow: "auto",
  },
  stateRow: {
    padding: "24px 16px",
    textAlign: "center",
    fontSize: 13,
    color: "var(--color-text-secondary)",
  },
  table: {
    width: "100%",
    minWidth: 1100,
    borderCollapse: "collapse",
  },
  th: {
    padding: "11px 16px",
    textAlign: "left",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--color-text-secondary)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    borderBottom: "1px solid var(--color-border)",
    background: "#f9fafb",
  },
  td: {
    padding: "12px 16px",
    fontSize: 13,
    color: "var(--color-text-primary)",
    borderBottom: "1px solid var(--color-border)",
  },
  rowEven: { background: "var(--color-surface)" },
  rowOdd:  { background: "#fafafa" },
  rowHover:{ background: "#f0f4ff" },
  mono: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "var(--color-text-secondary)",
  },
  badge: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "capitalize",
  },
};

const formStyles: Record<string, React.CSSProperties> = {
  wrapper: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "20px 24px",
    marginBottom: 16,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
    marginBottom: 16,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: "#374151",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  input: {
    padding: "8px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 13,
    outline: "none",
    background: "#ffffff",
    color: "#111827",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
  },
  submitBtn: {
    background: "#4f46e5",
    color: "#ffffff",
    border: "none",
    padding: "8px 20px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};

const actionStyles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    alignItems: "center",
  },
  base: {
    border: "none",
    borderRadius: 5,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.15s",
  },
  ghost: {
    background: "#f3f4f6",
    color: "#374151",
  },
  ghostHover: {
    background: "#e5e7eb",
  },
  danger: {
    background: "#fff1f2",
    color: "#dc2626",
  },
  dangerHover: {
    background: "#fee2e2",
  },
  linkBtn: {
    background: "#ede9fe",
    color: "#6d28d9",
    borderRadius: 5,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    textDecoration: "none",
    display: "inline-block",
  },
};

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position:        "fixed",
    inset:           0,
    background:      "rgba(0,0,0,0.45)",
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    zIndex:          1000,
  },
  box: {
    background:   "#ffffff",
    borderRadius: 12,
    width:        "100%",
    maxWidth:     480,
    maxHeight:    "80vh",
    display:      "flex",
    flexDirection:"column",
    overflow:     "hidden",
    boxShadow:    "0 20px 60px rgba(0,0,0,0.18)",
  },
  header: {
    display:        "flex",
    alignItems:     "flex-start",
    justifyContent: "space-between",
    padding:        "20px 24px 16px",
    borderBottom:   "1px solid #e5e7eb",
  },
  title: {
    fontSize:   16,
    fontWeight: 700,
    color:      "#111827",
  },
  sub: {
    fontSize:    12,
    color:       "#6b7280",
    marginTop:   2,
  },
  closeBtn: {
    background:   "transparent",
    border:       "none",
    fontSize:     16,
    cursor:       "pointer",
    color:        "#9ca3af",
    padding:      "2px 6px",
    borderRadius: 4,
  },
  state: {
    padding:    "24px",
    fontSize:   13,
    color:      "#6b7280",
    textAlign:  "center",
  },
  list: {
    overflowY: "auto",
    padding:   "12px 24px",
    flex:      1,
    display:   "flex",
    flexDirection: "column",
    gap:       4,
  },
  item: {
    display:     "flex",
    alignItems:  "center",
    padding:     "8px 0",
    cursor:      "pointer",
    borderBottom:"1px solid #f3f4f6",
    fontSize:    13,
  },
  unitLabel: {
    display:       "flex",
    alignItems:    "center",
    gap:           8,
    flex:          1,
  },
  unitTitle: {
    fontWeight: 500,
    color:      "#111827",
  },
  unitLevel: {
    fontSize:    11,
    background:  "#f3f4f6",
    color:       "#6b7280",
    padding:     "1px 7px",
    borderRadius:99,
  },
  footer: {
    display:        "flex",
    justifyContent: "flex-end",
    gap:            8,
    padding:        "16px 24px",
    borderTop:      "1px solid #e5e7eb",
  },
  cancelBtn: {
    background:   "#f3f4f6",
    color:        "#374151",
    border:       "none",
    padding:      "8px 16px",
    borderRadius: 6,
    fontSize:     13,
    fontWeight:   600,
    cursor:       "pointer",
  },
  saveBtn: {
    background:   "#4f46e5",
    color:        "#ffffff",
    border:       "none",
    padding:      "8px 20px",
    borderRadius: 6,
    fontSize:     13,
    fontWeight:   600,
    cursor:       "pointer",
  },
};

// ─── Native xlsx parser (browser-only, no external deps) ──────────────────────

async function readZipEntry(
  buffer: ArrayBuffer,
  filename: string,
): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  let offset  = 0;

  while (offset + 30 < bytes.length) {
    const sig = (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
    if (sig !== 0x04034b50) break;

    const compression  = bytes[offset + 8]! | (bytes[offset + 9]! << 8);
    const compSize     = bytes[offset + 18]! | (bytes[offset + 19]! << 8) | (bytes[offset + 20]! << 16) | (bytes[offset + 21]! << 24);
    const nameLen      = bytes[offset + 26]! | (bytes[offset + 27]! << 8);
    const extraLen     = bytes[offset + 28]! | (bytes[offset + 29]! << 8);
    const nameBytes    = bytes.slice(offset + 30, offset + 30 + nameLen);
    const entryName    = new TextDecoder().decode(nameBytes);
    const dataStart    = offset + 30 + nameLen + extraLen;
    const compData     = bytes.slice(dataStart, dataStart + compSize);

    if (entryName === filename) {
      if (compression === 0) {
        return new TextDecoder().decode(compData);
      }
      if (compression === 8) {
        const ds     = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(compData);
        writer.close();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total  = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) { merged.set(c, pos); pos += c.length; }
        return new TextDecoder().decode(merged);
      }
    }

    offset = dataStart + compSize;
  }
  return null;
}

async function parseXlsxToSyllabusRows(
  buffer: ArrayBuffer,
): Promise<{ rows: SyllabusImportRow[]; error: string | null }> {
  try {
    const ssXml    = await readZipEntry(buffer, "xl/sharedStrings.xml");
    const sheetXml = await readZipEntry(buffer, "xl/worksheets/sheet1.xml");
    if (!sheetXml) return { rows: [], error: "Could not read sheet1.xml from the xlsx file." };

    // Parse shared strings
    const shared: string[] = [];
    if (ssXml) {
      const tMatches = ssXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g);
      for (const m of tMatches) shared.push(m[1] ?? "");
    }

    function cellValue(c: string, t: string, v: string): string {
      if (t === "s") return shared[parseInt(v, 10)] ?? "";
      if (t === "inlineStr") {
        const m = c.match(/<t>([\s\S]*?)<\/t>/);
        return m?.[1] ?? "";
      }
      return v;
    }

    const rowMatches = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
    if (rowMatches.length < 2) return { rows: [], error: "File has no data rows." };

    // Parse header
    const headerRowXml = rowMatches[0]?.[1] ?? "";
    const headers: string[] = [];
    for (const cellMatch of headerRowXml.matchAll(/<c\s[^>]*r="([A-Z]+)\d+"[^>]*(?:t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is><t>([\s\S]*?)<\/t><\/is>)?<\/c>/g)) {
      const t   = cellMatch[2] ?? "";
      const v   = cellMatch[3] ?? cellMatch[4] ?? "";
      const full = cellMatch[0] ?? "";
      headers.push(cellValue(full, t, v).trim().toLowerCase().replace(/[\s_]/g, ""));
    }

    const lessonIdx  = headers.indexOf("lesson");
    const typeIdx    = headers.indexOf("type");
    const titleIdx   = headers.indexOf("title");

    if (lessonIdx === -1 || typeIdx === -1 || titleIdx === -1) {
      return { rows: [], error: `Missing required columns. Expected: Lesson, Type, Title. Found: ${headers.join(", ")}` };
    }

    const rows: SyllabusImportRow[] = [];
    for (let ri = 1; ri < rowMatches.length; ri++) {
      const rowXml = rowMatches[ri]?.[1] ?? "";
      const cells: string[] = [];
      for (const cellMatch of rowXml.matchAll(/<c\s[^>]*r="([A-Z]+)\d+"[^>]*(?:t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is><t>([\s\S]*?)<\/t><\/is>)?<\/c>/g)) {
        const col   = cellMatch[1] ?? "";
        const t     = cellMatch[2] ?? "";
        const v     = cellMatch[3] ?? cellMatch[4] ?? "";
        const colIndex = col.charCodeAt(0) - 65; // A=0, B=1 …
        const full = cellMatch[0] ?? "";
        cells[colIndex] = cellValue(full, t, v);
      }
      const lesson = (cells[lessonIdx] ?? "").trim();
      const type   = (cells[typeIdx]   ?? "").trim();
      const title  = (cells[titleIdx]  ?? "").trim();
      if (!lesson && !type && !title) continue; // skip blank rows
      rows.push({ lesson, type, title });
    }

    return { rows, error: null };
  } catch {
    return { rows: [], error: "Failed to parse the xlsx file. Please check the format." };
  }
}

// ─── Import Syllabus Modal ────────────────────────────────────────────────────

function ImportSyllabusModal({
  studentId,
  studentName,
  admissionNumber,
  onClose,
}: {
  studentId:       string;
  studentName:     string;
  admissionNumber: string;
  onClose:         () => void;
}) {
  const [rows, setRows]         = useState<SyllabusImportRow[]>([]);
  const [errors, setErrors]     = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [saving, setSaving]     = useState(false);
  const [done, setDone]         = useState(false);
  const [parseErr, setParseErr] = useState("");
  const fileRef                 = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setErrors([]);
    setParseErr("");
    setRows([]);
    setDone(false);

    const buffer  = await file.arrayBuffer();
    const { rows: parsed, error } = await parseXlsxToSyllabusRows(buffer);
    if (error) { setParseErr(error); return; }

    const validation = validateSyllabusRows(parsed);
    setRows(parsed);
    setErrors(validation.errors);
  }

  async function handleImport() {
    if (errors.length > 0 || rows.length === 0) return;
    setSaving(true);
    try {
      const lessons = buildLessonsFromRows(rows);
      await saveStudentSyllabus(studentId, lessons);
      setDone(true);
    } catch {
      setErrors(["Failed to save. Please try again."]);
    } finally {
      setSaving(false);
    }
  }

  const lessonsPreview = (() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const k = r.lesson.trim();
      if (k) map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()];
  })();

  return (
    <div style={importStyles.overlay}>
      <div style={importStyles.modal}>
        <div style={importStyles.header}>
          <div>
            <div style={importStyles.title}>Import Syllabus</div>
            <div style={importStyles.sub}>
              {studentName}
              <span style={importStyles.admNo}> · {admissionNumber}</span>
            </div>
          </div>
          <button onClick={onClose} style={importStyles.closeBtn}>✕</button>
        </div>

        {!done ? (
          <>
            {/* Format hint */}
            <div style={importStyles.hint}>
              Expected columns: <code style={importStyles.code}>Lesson</code>{" "}
              <code style={importStyles.code}>Type</code>{" "}
              <code style={importStyles.code}>Title</code>
              <br />
              Type values: <code style={importStyles.code}>concept</code>{" "}
              <code style={importStyles.code}>exercise</code>{" "}
              <code style={importStyles.code}>songsheet</code>
            </div>

            {/* File input */}
            <div style={importStyles.uploadArea} onClick={() => fileRef.current?.click()}>
              <div style={importStyles.uploadIcon}>📂</div>
              <div style={importStyles.uploadLabel}>
                {fileName || "Click to select .xlsx file"}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx"
                style={{ display: "none" }}
                onChange={handleFile}
              />
            </div>

            {/* Parse error */}
            {parseErr && (
              <div style={importStyles.errorBox}>{parseErr}</div>
            )}

            {/* Validation errors */}
            {errors.length > 0 && (
              <div style={importStyles.errorBox}>
                {errors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                {errors.length > 5 && <div>…and {errors.length - 5} more errors</div>}
              </div>
            )}

            {/* Preview */}
            {rows.length > 0 && errors.length === 0 && (
              <div style={importStyles.previewBox}>
                <div style={importStyles.previewTitle}>
                  Ready to import — {lessonsPreview.length} lesson{lessonsPreview.length !== 1 ? "s" : ""},{" "}
                  {rows.length} item{rows.length !== 1 ? "s" : ""}
                </div>
                <div style={importStyles.previewList}>
                  {lessonsPreview.map(([title, count]) => (
                    <div key={title} style={importStyles.previewRow}>
                      <span style={importStyles.previewLesson}>{title}</span>
                      <span style={importStyles.previewCount}>{count} item{count !== 1 ? "s" : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={importStyles.footer}>
              <button onClick={onClose} style={importStyles.cancelBtn}>Cancel</button>
              <button
                onClick={handleImport}
                disabled={saving || rows.length === 0 || errors.length > 0}
                style={{ ...importStyles.importBtn, opacity: (saving || rows.length === 0 || errors.length > 0) ? 0.5 : 1 }}
              >
                {saving ? "Importing…" : "Import"}
              </button>
            </div>
          </>
        ) : (
          <div style={importStyles.successBox}>
            <div style={importStyles.successIcon}>✅</div>
            <div style={importStyles.successTitle}>Syllabus imported</div>
            <div style={importStyles.successSub}>
              {lessonsPreview.length} lesson{lessonsPreview.length !== 1 ? "s" : ""} saved for {studentName}.
            </div>
            <button onClick={onClose} style={importStyles.importBtn}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

const importStyles: Record<string, React.CSSProperties> = {
  overlay:      { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 },
  modal:        { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 520, maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" },
  header:       { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "20px 24px 0" },
  title:        { fontSize: 16, fontWeight: 700, color: "#111827" },
  sub:          { fontSize: 12, color: "#6b7280", marginTop: 2 },
  admNo:        { fontFamily: "monospace", color: "#4f46e5" },
  closeBtn:     { background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "#6b7280", padding: "0 0 0 8px", lineHeight: 1 },
  hint:         { margin: "16px 24px 0", fontSize: 12, color: "#6b7280", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "10px 12px", lineHeight: 1.7 },
  code:         { fontFamily: "monospace", background: "#ede9fe", color: "#5b21b6", borderRadius: 3, padding: "1px 4px", fontSize: 11 },
  uploadArea:   { margin: "16px 24px 0", border: "2px dashed #d1d5db", borderRadius: 8, padding: "24px", textAlign: "center", cursor: "pointer" },
  uploadIcon:   { fontSize: 24, marginBottom: 8 },
  uploadLabel:  { fontSize: 13, color: "#374151", fontWeight: 500 },
  errorBox:     { margin: "12px 24px 0", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "#991b1b" },
  previewBox:   { margin: "16px 24px 0", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "12px 16px" },
  previewTitle: { fontSize: 12, fontWeight: 700, color: "#15803d", marginBottom: 10 },
  previewList:  { display: "flex", flexDirection: "column" as const, gap: 4 },
  previewRow:   { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#166534" },
  previewLesson:{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: 320 },
  previewCount: { color: "#15803d", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" as const, marginLeft: 12 },
  footer:       { display: "flex", justifyContent: "flex-end", gap: 8, padding: "20px 24px" },
  cancelBtn:    { background: "#f3f4f6", color: "#374151", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  importBtn:    { background: "#4f46e5", color: "#fff", border: "none", padding: "8px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  successBox:   { display: "flex", flexDirection: "column" as const, alignItems: "center", padding: "40px 24px", gap: 10 },
  successIcon:  { fontSize: 32 },
  successTitle: { fontSize: 16, fontWeight: 700, color: "#111827" },
  successSub:   { fontSize: 13, color: "#6b7280", marginBottom: 8 },
};
