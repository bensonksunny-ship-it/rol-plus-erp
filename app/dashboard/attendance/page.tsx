"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, where, doc, getDoc } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { getClassesByCenter, getClassesByTeacher, markAttendance } from "@/services/attendance/attendance.service";
import { getCenters } from "@/services/center/center.service";
import { chargeStudentPerClass } from "@/services/finance/finance.service";
import type { Class } from "@/types/attendance";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";

interface StudentOption {
  uid: string;
  name: string;
  centerId: string;
}

// ─── Status badge styles ───────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  scheduled: { background: "#dbeafe", color: "#1d4ed8" },
  completed:  { background: "#dcfce7", color: "#16a34a" },
  ghost:      { background: "#fee2e2", color: "#dc2626" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(value: string | undefined): string {
  return value ?? "-";
}

function studentsForCenter(students: StudentOption[], centerId: string): StudentOption[] {
  return students
    .filter(s => s.centerId === centerId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ ...styles.badge, ...(STATUS_STYLES[status] ?? {}) }}>
      {status ?? "-"}
    </span>
  );
}

function PresentBadge() {
  return <span style={markStyles.presentBadge}>Present</span>;
}

// ─── Mark Present cell ─────────────────────────────────────────────────────────

interface MarkCellProps {
  cls: Class;
  students: StudentOption[];
  selected: string;
  isMarking: boolean;
  isMarked: boolean;
  onSelect: (value: string) => void;
  onMark: () => void;
}

function MarkCell({ cls, students, selected, isMarking, isMarked, onSelect, onMark }: MarkCellProps) {
  if (isMarked) return <PresentBadge />;

  const options = studentsForCenter(students, cls.centerId);
  const hasOptions = options.length > 0;
  const canMark = hasOptions && !!selected && !isMarking;

  return (
    <div style={markStyles.row}>
      <select
        value={selected}
        onChange={e => onSelect(e.target.value)}
        disabled={!hasOptions}
        style={{
          ...markStyles.select,
          opacity: hasOptions ? 1 : 0.5,
          cursor:  hasOptions ? "pointer" : "not-allowed",
        }}
      >
        <option value="">
          {hasOptions ? "Select student…" : "No students available"}
        </option>
        {options.map(s => (
          <option key={s.uid} value={s.uid}>{s.name}</option>
        ))}
      </select>
      <button
        onClick={onMark}
        disabled={!canMark}
        style={{ ...markStyles.btn, opacity: canMark ? 1 : 0.45 }}
      >
        {isMarking ? "…" : "Present"}
      </button>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <AttendanceContent />
    </ProtectedRoute>
  );
}

function AttendanceContent() {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate]       = useState(today);
  const [classes, setClasses] = useState<Class[]>([]);
  const [loading, setLoading] = useState(true);
  const [students, setStudents] = useState<StudentOption[]>([]);

  const { user, role } = useAuth();

  const [selected, setSelected]   = useState<Record<string, string>>({});
  const [marking, setMarking]     = useState<Record<string, boolean>>({});
  const [marked, setMarked]       = useState<Record<string, boolean>>({});
  const { toasts, toast, remove } = useToast();

  // Fetch students for dropdown
  useEffect(() => {
    async function fetchStudents() {
      try {
        const q = query(collection(db, "users"), where("role", "==", "student"));
        const snap = await getDocs(q);
        const opts: StudentOption[] = snap.docs.map(doc => ({
          uid:      doc.id,
          name:     (doc.data().name as string) || doc.id,
          centerId: (doc.data().centerId as string) || "",
        }));
        setStudents(opts);
      } catch (err) {
        console.error("Failed to fetch students:", err);
      }
    }
    fetchStudents();
  }, []);

  // Fetch classes
  useEffect(() => {
    if (!user) return;

    async function fetchClasses() {
      setLoading(true);
      try {
        let result: Class[] = [];
        if (role === ROLES.TEACHER) {
          result = await getClassesByTeacher(user!.uid);
        } else {
          const centers = await getCenters();
          const nested  = await Promise.all(centers.map(c => getClassesByCenter(c.id)));
          result = nested.flat();
        }
        setClasses(result);
      } catch (err) {
        console.error("Failed to fetch classes:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchClasses();
  }, [user, role]);

  function handleSelect(classId: string, value: string) {
    setSelected(prev => ({ ...prev, [classId]: value }));
  }

  async function handleMarkPresent(cls: Class) {
    const studentUid = selected[cls.id] ?? "";
    if (!studentUid) return;
    setMarking(prev => ({ ...prev, [cls.id]: true }));
    try {
      await markAttendance({
        classId:    cls.id,
        studentUid,
        centerId:   cls.centerId,
        markedAt:   new Date().toISOString(),
        method:     "manual",
        status:     "present",
      });

      // Finance: charge per-class students automatically
      try {
        const studentSnap = await getDoc(doc(db, "users", studentUid));
        if (studentSnap.exists()) {
          const studentData = studentSnap.data();
          if (studentData.feeCycle === "per_class" && studentData.feePerClass > 0) {
            await chargeStudentPerClass(studentUid, cls.centerId, studentData.feePerClass);
          }
        }
      } catch (feeErr) {
        // Non-blocking: log but don't fail attendance
        console.error("Failed to apply per-class fee:", feeErr);
      }

      setMarked(prev => ({ ...prev, [cls.id]: true }));
      setSelected(prev => ({ ...prev, [cls.id]: "" }));
      toast("Attendance marked as present.", "success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("DUPLICATE_ATTENDANCE")) {
        setMarked(prev => ({ ...prev, [cls.id]: true }));
        toast("Attendance already marked for this student.", "error");
      } else {
        console.error("Failed to mark attendance:", msg);
        toast("Failed to mark attendance.", "error");
      }
    } finally {
      setMarking(prev => ({ ...prev, [cls.id]: false }));
    }
  }

  const filtered = classes.filter(cls => (cls.date ?? "") === date);

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.heading}>Attendance</h1>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={styles.datePicker}
        />
      </div>

      {/* Table */}
      <div style={styles.tableWrapper}>
        {loading ? (
          <div style={styles.stateRow}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={styles.stateRow}>No classes scheduled for this date.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Center ID</th>
                <th style={styles.th}>Teacher UID</th>
                <th style={styles.th}>Time</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Mark Present</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((cls, i) => {
                const isMarked = !!marked[cls.id];
                const rowStyle = isMarked
                  ? styles.rowMarked
                  : i % 2 === 0 ? styles.rowEven : styles.rowOdd;

                return (
                  <tr key={cls.id} style={rowStyle}>
                    <td style={{ ...styles.td, ...styles.mono }}>{cls.centerId  ?? "-"}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{cls.teacherUid ?? "-"}</td>
                    <td style={styles.td}>{formatTime(cls.startTime)} – {formatTime(cls.endTime)}</td>
                    <td style={styles.td}>
                      <StatusBadge status={cls.status ?? "-"} />
                    </td>
                    <td style={styles.td}>
                      <MarkCell
                        cls={cls}
                        students={students}
                        selected={selected[cls.id] ?? ""}
                        isMarking={!!marking[cls.id]}
                        isMarked={isMarked}
                        onSelect={v => handleSelect(cls.id, v)}
                        onMark={() => handleMarkPresent(cls)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  datePicker: {
    padding: "7px 12px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    fontSize: 13,
    outline: "none",
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
    cursor: "pointer",
  },
  tableWrapper: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    overflow: "hidden",
  },
  stateRow: {
    padding: "24px 16px",
    textAlign: "center",
    fontSize: 13,
    color: "var(--color-text-secondary)",
  },
  table: {
    width: "100%",
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
  rowEven:  { background: "var(--color-surface)" },
  rowOdd:   { background: "#fafafa" },
  rowMarked:{ background: "#f0fdf4" },
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

const markStyles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  select: {
    padding: "5px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 12,
    outline: "none",
    color: "#111827",
    background: "#fff",
    maxWidth: 190,
  },
  btn: {
    background: "#4f46e5",
    color: "#fff",
    border: "none",
    padding: "5px 12px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  presentBadge: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 600,
    background: "#dcfce7",
    color: "#16a34a",
  },
};
