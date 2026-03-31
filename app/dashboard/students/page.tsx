"use client";

import { useState, useEffect, useRef } from "react";
import { collection, getDocs, addDoc, query, where, serverTimestamp } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { logAction } from "@/services/audit/audit.service";
import { useAuth } from "@/hooks/useAuth";
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

// ─── Row component ─────────────────────────────────────────────────────────────

function StudentRow({ student: s, index }: { student: StudentRow; index: number }) {
  const [hover, setHover] = useState(false);

  const rowBase  = index % 2 === 0 ? styles.rowEven : styles.rowOdd;
  const rowStyle: React.CSSProperties = {
    ...rowBase,
    ...(hover ? styles.rowHover : {}),
  };

  return (
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
      <td style={{ ...styles.td, minWidth: 200 }}>
        <div style={actionStyles.row}>
          <Link href={`/dashboard/student-syllabus/${s.id}`} style={actionStyles.linkBtn}>
            View Syllabus
          </Link>
          <ActionButton label="Deactivate" variant="danger" onClick={() => {}} />
        </div>
      </td>
    </tr>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap" as const,
    gap: 10,
    marginBottom: 16,
  },
  heading: {
    fontSize: 20,
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
    flexShrink: 0,
  },
  searchRow: {
    marginBottom: 14,
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



