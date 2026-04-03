"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import {
  collection, getDocs, setDoc, updateDoc, doc, getDoc,
  query, where, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import {
  createUserWithEmailAndPassword, getAuth, signOut as fbSignOut,
  updateEmail,
} from "firebase/auth";
import { deleteApp } from "firebase/app";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { logAction } from "@/services/audit/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import Link from "next/link";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StudentRow {
  id:          string;
  name:        string;
  email:       string;
  studentID:   string;
  admissionNo: string;
  phone:       string;
  centerId:    string;
  centerName:  string;
  instrument:  string;
  course:      string;
  feeCycle:    string;
  feePerClass: number;
  balance:     number;
  status:      string;
  deactivationRequestedBy: string | null;
  deactivationRequestedAt: string | null;
}

type StudentTab = "active" | "requests" | "inactive";

interface EditForm {
  name:        string;
  email:       string;
  admissionNo: string;
  phone:       string;
  centerId:    string;
  instrument:  string;
  course:      string;
  feeCycle:    string;
  feePerClass: string;
  status:      string;
}

const EMPTY_CREATE = {
  name: "", email: "", admissionNo: "", phone: "",
  centerId: "", instrument: "", course: "",
  feeCycle: "monthly", feePerClass: "", status: "active",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function getNextStudentSeq(): Promise<number> {
  const ref  = doc(db, "counters", "student_global");
  const snap = await getDoc(ref);
  const next = snap.exists() ? (snap.data().seq as number) + 1 : 1;
  const { setDoc: sd } = await import("firebase/firestore");
  await sd(ref, { seq: next }, { merge: true });
  return next;
}

function buildStudentID(seq: number): string {
  return `ROL${new Date().getFullYear()}${String(seq).padStart(4, "0")}`;
}

function fmtINR(n: number): string {
  return n === 0 ? "₹0" : `₹${n.toLocaleString("en-IN")}`;
}

// ─── Status styles ─────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, React.CSSProperties> = {
  active:                 { background: "#dcfce7", color: "#16a34a" },
  inactive:               { background: "#f3f4f6", color: "#6b7280" },
  deactivation_requested: { background: "#fef3c7", color: "#d97706" },
};

// ─── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 0", gap: 10 }}>
      <div style={{
        width: 20, height: 20, border: "2px solid #e5e7eb",
        borderTopColor: "#4f46e5", borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize: 13, color: "#6b7280" }}>Loading…</span>
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 24px" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: 6 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, color: "#6b7280" }}>{hint}</div>}
    </div>
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
  const { user, role }                  = useAuth();
  const { isAllowed, filterCentres, teacherCentreIds, isTeacherRole } = useCentreAccess();
  const [students, setStudents]         = useState<StudentRow[]>([]);
  const [centerMap, setCenterMap]       = useState<Map<string, string>>(new Map());
  const [centerOptions, setCenterOpts]  = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading]           = useState(true);
  const [tab, setTab]                   = useState<StudentTab>("active");
  const [showForm, setShowForm]         = useState(false);
  const [form, setForm]                 = useState({ ...EMPTY_CREATE });
  const [saving, setSaving]             = useState(false);
  const [editTarget, setEditTarget]     = useState<StudentRow | null>(null);
  const debounceRef                     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, toast, remove }       = useToast();

  // Filters
  const [searchInput, setSearchInput]   = useState("");
  const [search, setSearch]             = useState("");
  const [filterCenter, setFilterCenter] = useState("all");
  const [filterCourse, setFilterCourse] = useState("");
  const [filterInstrument, setFilterInstrument] = useState("");
  const [filterFeeStatus, setFilterFeeStatus]   = useState("all");

  const isAdmin = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
  const isTeacher = role === ROLES.TEACHER;

  async function fetchData() {
    try {
      const [studentSnap, centerSnap] = await Promise.all([
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "centers")),
      ]);

      const cMap = new Map<string, string>();
      const cOptsAll: { id: string; name: string }[] = [];
      centerSnap.docs.forEach(d => {
        cMap.set(d.id, (d.data().name as string) ?? d.id);
        cOptsAll.push({ id: d.id, name: (d.data().name as string) ?? d.id });
      });
      setCenterMap(cMap);
      // Teachers: show only their assigned centres in the filter dropdown
      setCenterOpts(filterCentres(cOptsAll));

      const allStudentsRaw = studentSnap.docs.map(d => {
        const s = d.data();
        return {
          id:          d.id,
          name:        (s.displayName ?? s.name ?? "-") as string,
          email:       (s.email       ?? "-") as string,
          studentID:   (s.studentID   ?? "-") as string,
          admissionNo: (s.admissionNo ?? s.admissionNumber ?? "-") as string,
          phone:       (s.phone       ?? "") as string,
          centerId:    (s.centerId    ?? "-") as string,
          centerName:  cMap.get(s.centerId as string) ?? (s.centerId as string) ?? "-",
          instrument:  (s.instrument  ?? "-") as string,
          course:      (s.course      ?? "-") as string,
          feeCycle:    (s.feeCycle    ?? "-") as string,
          feePerClass: Number(s.feePerClass ?? 0),
          balance:     Number(s.currentBalance ?? 0),
          status:      (s.status ?? s.studentStatus ?? "active") as string,
          deactivationRequestedBy: (s.deactivationRequestedBy ?? null) as string | null,
          deactivationRequestedAt: (s.deactivationRequestedAt ?? null) as string | null,
        };
      });
      // Teachers: restrict to their assigned centres only
      const allStudents = isTeacherRole
        ? allStudentsRaw.filter(s => teacherCentreIds.includes(s.centerId))
        : allStudentsRaw;
      setStudents(allStudents);
    } catch (err) {
      console.error("Failed to fetch students:", err);
    } finally {
      setLoading(false);
    }
  }

  // Teachers: auto-lock centre filter to their first assigned centre
  useEffect(() => {
    if (isTeacherRole && teacherCentreIds.length > 0) {
      setFilterCenter(teacherCentreIds[0]);
    }
  }, [isTeacherRole, teacherCentreIds]);

  useEffect(() => { fetchData(); }, []);

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(val), 250);
  }

  function resetFilters() {
    setSearchInput(""); setSearch(""); setFilterCenter("all");
    setFilterCourse(""); setFilterInstrument(""); setFilterFeeStatus("all");
  }

  // ── Tab-split lists ─────────────────────────────────────────────────────────
  const activeStudents   = students.filter(s => s.status === "active");
  const requestStudents  = students.filter(s => s.status === "deactivation_requested");
  const inactiveStudents = students.filter(s => s.status === "inactive");

  const baseList = tab === "active" ? activeStudents
    : tab === "requests" ? requestStudents
    : inactiveStudents;

  // Unique courses + instruments for filter dropdowns
  const courses     = useMemo(() => Array.from(new Set(students.map(s => s.course).filter(Boolean))).sort(), [students]);
  const instruments = useMemo(() => Array.from(new Set(students.map(s => s.instrument).filter(Boolean))).sort(), [students]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return baseList.filter(s => {
      if (q && !s.name.toLowerCase().includes(q) && !s.email.toLowerCase().includes(q)
           && !s.studentID.toLowerCase().includes(q) && !s.admissionNo.toLowerCase().includes(q))
        return false;
      if (filterCenter !== "all" && s.centerId !== filterCenter) return false;
      if (filterCourse && s.course !== filterCourse) return false;
      if (filterInstrument && s.instrument !== filterInstrument) return false;
      if (filterFeeStatus === "pending" && s.balance <= 0) return false;
      if (filterFeeStatus === "paid"    && s.balance > 0)  return false;
      return true;
    });
  }, [baseList, search, filterCenter, filterCourse, filterInstrument, filterFeeStatus]);

  // ── Create student ─────────────────────────────────────────────────────────
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.email.trim())     { toast("Email is required.", "error"); return; }
    if (!form.admissionNo.trim()) { toast("Admission number is required.", "error"); return; }
    if (!form.centerId.trim())  { toast("Center is required.", "error"); return; }

    setSaving(true);
    try {
      const dupEmail = await getDocs(query(collection(db, "users"), where("email", "==", form.email.trim().toLowerCase())));
      if (!dupEmail.empty) { toast("Email already in use.", "error"); return; }

      const { initializeApp } = await import("firebase/app");
      const { default: primaryApp } = await import("@/services/firebase/firebase");
      const secondaryApp  = initializeApp(primaryApp.options, `student-create-${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      let uid: string;
      try {
        const cred = await createUserWithEmailAndPassword(
          secondaryAuth, form.email.trim().toLowerCase(), form.admissionNo.trim()
        );
        uid = cred.user.uid;
      } finally {
        await fbSignOut(secondaryAuth).catch(() => {});
        await deleteApp(secondaryApp).catch(() => {});
      }

      const seq       = await getNextStudentSeq();
      const studentID = buildStudentID(seq);

      await setDoc(doc(db, "users", uid), {
        uid, name: form.name.trim(), displayName: form.name.trim(),
        email:       form.email.trim().toLowerCase(),
        studentID,
        admissionNo: form.admissionNo.trim(),
        phone:       form.phone.trim(),
        centerId:    form.centerId.trim(),
        instrument:  form.instrument.trim(),
        course:      form.course.trim(),
        feeCycle:    form.feeCycle,
        feePerClass: form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        status:        form.status,
        studentStatus: form.status,   // mirror for type-system compatibility
        role:        "student",
        mustResetPassword: true,
        currentBalance: 0,
        deactivationRequestedBy: null,
        deactivationRequestedAt: null,
        deactivationApprovalStatus: null,
        createdBy:   user?.uid ?? "unknown",
        createdAt:   serverTimestamp(),
        updatedAt:   serverTimestamp(),
      });

      logAction({ action: "STUDENT_CREATED", initiatorId: user?.uid ?? "", initiatorRole: role ?? "admin",
        approverId: null, approverRole: null, reason: null,
        metadata: { uid, studentID, name: form.name.trim(), email: form.email.trim().toLowerCase() } });

      setForm({ ...EMPTY_CREATE });
      setShowForm(false);
      setLoading(true);
      await fetchData();
      toast(`Student created. ID: ${studentID}`, "success");
    } catch (err) {
      toast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  // ── Deactivation actions ───────────────────────────────────────────────────
  async function requestDeactivation(student: StudentRow) {
    if (!user) return;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:                     "deactivation_requested",
        studentStatus:              "deactivation_requested",
        deactivationApprovalStatus: "pending",
        deactivationRequestedBy:    user.uid,
        deactivationRequestedAt:    new Date().toISOString(),
        updatedAt:                  serverTimestamp(),
      });
      logAction({ action: "DEACTIVATION_REQUESTED", initiatorId: user.uid, initiatorRole: role ?? "teacher",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id } });
      setStudents(prev => prev.map(s => s.id !== student.id ? s : {
        ...s, status: "deactivation_requested",
        deactivationRequestedBy: user.uid,
        deactivationRequestedAt: new Date().toISOString(),
      }));
      toast("Deactivation request submitted.", "success");
    } catch { toast("Failed to submit request.", "error"); }
  }

  async function approveDeactivation(student: StudentRow) {
    if (!user) return;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:                     "inactive",
        studentStatus:              "inactive",
        deactivationApprovalStatus: "approved",
        updatedAt:                  serverTimestamp(),
      });
      logAction({ action: "DEACTIVATION_APPROVED", initiatorId: user.uid, initiatorRole: role ?? "admin",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id } });
      setStudents(prev => prev.map(s => s.id !== student.id ? s : { ...s, status: "inactive" }));
      toast("Student deactivated.", "success");
    } catch { toast("Failed to deactivate.", "error"); }
  }

  async function rejectDeactivation(student: StudentRow) {
    if (!user) return;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:                     "active",
        studentStatus:              "active",
        deactivationApprovalStatus: "rejected",
        deactivationRequestedBy:    null,
        deactivationRequestedAt:    null,
        updatedAt:                  serverTimestamp(),
      });
      logAction({ action: "DEACTIVATION_REJECTED", initiatorId: user.uid, initiatorRole: role ?? "admin",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id } });
      setStudents(prev => prev.map(s => s.id !== student.id ? s : {
        ...s, status: "active", deactivationRequestedBy: null, deactivationRequestedAt: null,
      }));
      toast("Deactivation request rejected. Student is active.", "success");
    } catch { toast("Failed to reject.", "error"); }
  }

  return (
    <div style={p.page}>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* ── Header ── */}
      <div style={p.header}>
        <div>
          <h1 style={p.heading}>Students</h1>
          <div style={p.subheading}>{students.length} total · {activeStudents.length} active</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {requestStudents.length > 0 && (
            <div style={p.deactivationBadge} onClick={() => setTab("requests")}>
              ⚠ Deactivation Requests ({requestStudents.length})
            </div>
          )}
          {(isAdmin || isTeacher) && (
            <button onClick={() => { setShowForm(v => !v); setEditTarget(null); }} style={p.addBtn}>
              {showForm ? "Cancel" : "+ Add Student"}
            </button>
          )}
        </div>
      </div>

      {/* ── Create Form ── */}
      {showForm && (
        <div style={p.card}>
          <div style={p.cardHeader}>New Student</div>
          <div style={p.hint}>
            🔐 Login: <strong>email</strong> as username · <strong>admission no.</strong> as password · System assigns Student ID automatically
          </div>
          <form onSubmit={handleCreate}>
            <div style={p.formGrid}>
              <Field label="Full Name *">
                <input name="name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  required placeholder="e.g. Arjun Sharma" style={p.input} />
              </Field>
              <Field label="Email (login username) *">
                <input name="email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  required placeholder="e.g. arjun@gmail.com" style={p.input} />
              </Field>
              <Field label="Admission No. (initial password) *">
                <input name="admissionNo" value={form.admissionNo} onChange={e => setForm(f => ({ ...f, admissionNo: e.target.value }))}
                  required placeholder="e.g. ADM-2026-001" style={p.input} />
              </Field>
              <Field label="Phone">
                <input name="phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="e.g. +91 98765 43210" style={p.input} />
              </Field>
              <Field label="Center *">
                <select value={form.centerId} onChange={e => setForm(f => ({ ...f, centerId: e.target.value }))}
                  required style={p.input}>
                  <option value="">— Select center —</option>
                  {centerOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Instrument *">
                <input name="instrument" value={form.instrument} onChange={e => setForm(f => ({ ...f, instrument: e.target.value }))}
                  required placeholder="e.g. Guitar" style={p.input} />
              </Field>
              <Field label="Course *">
                <input name="course" value={form.course} onChange={e => setForm(f => ({ ...f, course: e.target.value }))}
                  required placeholder="e.g. Beginner Guitar" style={p.input} />
              </Field>
              <Field label="Fee Cycle">
                <select value={form.feeCycle} onChange={e => setForm(f => ({ ...f, feeCycle: e.target.value }))} style={p.input}>
                  <option value="monthly">Monthly</option>
                  <option value="per_class">Per Class</option>
                </select>
              </Field>
              {form.feeCycle === "per_class" && (
                <Field label="Fee Per Class (₹)">
                  <input name="feePerClass" type="number" min="0" step="1" value={form.feePerClass}
                    onChange={e => setForm(f => ({ ...f, feePerClass: e.target.value }))}
                    required placeholder="500" style={p.input} />
                </Field>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button type="submit" disabled={saving}
                style={{ ...p.primaryBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Creating…" : "Create Student"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Filter Bar ── */}
      <div style={p.filterBar}>
        <input type="text" placeholder="Search name, email, ID…"
          value={searchInput} onChange={handleSearch} style={p.searchInput} />
        {isTeacherRole ? (
          /* Teachers: locked to their centre — no dropdown needed */
          <span style={{ ...p.filterSelect, background: "#f9fafb", cursor: "default", fontWeight: 600, color: "#374151", display: "inline-flex", alignItems: "center" }}>
            {centerOptions.find(c => c.id === filterCenter)?.name ?? "Centre"}
          </span>
        ) : (
          <select value={filterCenter} onChange={e => setFilterCenter(e.target.value)} style={p.filterSelect}>
            <option value="all">All Centers</option>
            {centerOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select value={filterCourse} onChange={e => setFilterCourse(e.target.value)} style={p.filterSelect}>
          <option value="">All Courses</option>
          {courses.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterInstrument} onChange={e => setFilterInstrument(e.target.value)} style={p.filterSelect}>
          <option value="">All Instruments</option>
          {instruments.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <select value={filterFeeStatus} onChange={e => setFilterFeeStatus(e.target.value)} style={p.filterSelect}>
          <option value="all">All Fee Status</option>
          <option value="paid">Paid (₹0 due)</option>
          <option value="pending">Pending balance</option>
        </select>
        {(search || filterCenter !== "all" || filterCourse || filterInstrument || filterFeeStatus !== "all") && (
          <button onClick={resetFilters} style={p.resetBtn}>✕ Reset</button>
        )}
      </div>

      {/* ── Tabs ── */}
      <div style={p.tabs}>
        {(["active", "requests", "inactive"] as StudentTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...p.tab, ...(tab === t ? p.tabActive : {}) }}>
            {t === "active" ? `Active (${activeStudents.length})`
              : t === "requests" ? (
                <span>
                  Requests
                  {requestStudents.length > 0 && (
                    <span style={p.tabBadge}>{requestStudents.length}</span>
                  )}
                </span>
              )
              : `Inactive (${inactiveStudents.length})`}
          </button>
        ))}
      </div>

      {/* ── Student Table ── */}
      {loading ? (
        <div style={p.card}><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div style={p.card}>
          <EmptyState icon="👥" title="No students found"
            hint={search ? `No results for "${search}"` : "Try adjusting your filters"} />
        </div>
      ) : tab === "requests" ? (
        <RequestsPanel
          requests={filtered}
          centerMap={centerMap}
          onApprove={approveDeactivation}
          onReject={rejectDeactivation}
        />
      ) : (
        <div style={p.tableWrap}>
          <table style={p.table}>
            <thead>
              <tr style={{ background: "#f9fafb" }}>
                <th style={p.th}>Student ID</th>
                <th style={p.th}>Name</th>
                <th style={p.th}>Email</th>
                <th style={p.th}>Adm. No.</th>
                <th style={p.th}>Center</th>
                <th style={p.th}>Instrument / Course</th>
                <th style={p.th}>Fee</th>
                <th style={p.th}>Balance</th>
                <th style={p.th}>Status</th>
                <th style={p.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <StudentRow
                  key={s.id}
                  student={s}
                  index={i}
                  isAdmin={isAdmin}
                  isTeacher={isTeacher}
                  onEdit={() => {
                    if (isTeacherRole && !isAllowed(s.centerId)) return; // hard block
                    setEditTarget(s);
                  }}
                  onRequestDeactivation={() => requestDeactivation(s)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Edit Modal ── */}
      {editTarget && (
        <EditModal
          student={editTarget}
          centerOptions={centerOptions}
          onClose={() => setEditTarget(null)}
          onSaved={(updated) => {
            const newCenterId = updated.centerId ?? "";
            setStudents(prev => prev.map(s => s.id !== updated.id ? s : {
              ...s, ...updated,
              centerName: centerMap.get(newCenterId) ?? newCenterId,
            } as StudentRow));
            setEditTarget(null);
            toast("Student updated.", "success");
          }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}
    </div>
  );
}

// ─── Student Row ───────────────────────────────────────────────────────────────

function StudentRow({ student: s, index, isAdmin, isTeacher, onEdit, onRequestDeactivation }: {
  student: StudentRow; index: number; isAdmin: boolean; isTeacher: boolean;
  onEdit: () => void; onRequestDeactivation: () => void;
}) {
  const [hover, setHover] = useState(false);
  const rowBg = hover ? "#f0f4ff" : index % 2 === 0 ? "#fff" : "#fafafa";
  return (
    <tr style={{ background: rowBg, transition: "background 0.12s" }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <td style={p.td}><span style={p.idChip}>{s.studentID}</span></td>
      <td style={{ ...p.td, fontWeight: 600, color: "#111827", minWidth: 130 }}>{s.name}</td>
      <td style={{ ...p.td, fontSize: 12, color: "#6b7280", minWidth: 160 }}>{s.email}</td>
      <td style={p.td}><span style={p.admChip}>{s.admissionNo}</span></td>
      <td style={{ ...p.td, minWidth: 110 }}>{s.centerName}</td>
      <td style={p.td}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{s.instrument}</div>
        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{s.course}</div>
      </td>
      <td style={p.td}>
        <span style={{
          ...p.badge,
          ...(s.feeCycle === "per_class"
            ? { background: "#ede9fe", color: "#7c3aed" }
            : { background: "#dbeafe", color: "#1d4ed8" }),
        }}>
          {s.feeCycle === "per_class" ? `₹${s.feePerClass}/class` : "Monthly"}
        </span>
      </td>
      <td style={{ ...p.td, fontWeight: 700, color: s.balance > 0 ? "#d97706" : "#16a34a" }}>
        {fmtINR(s.balance)}
      </td>
      <td style={p.td}>
        <span style={{ ...p.badge, ...(STATUS_BADGE[s.status] ?? { background: "#f3f4f6", color: "#6b7280" }) }}>
          {s.status.replace(/_/g, " ")}
        </span>
      </td>
      <td style={{ ...p.td, minWidth: 200 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
          {(isAdmin || isTeacher) && (
            <button onClick={onEdit} style={p.editBtn}>✏ Edit</button>
          )}
          {(isAdmin || isTeacher) && s.status === "active" && (
            <button onClick={onRequestDeactivation} style={p.deactBtn}>Deactivate</button>
          )}
          <Link href={`/dashboard/student-syllabus/${s.id}`} style={p.syllabusBtn}>
            Syllabus
          </Link>
        </div>
      </td>
    </tr>
  );
}

// ─── Requests Panel ────────────────────────────────────────────────────────────

function RequestsPanel({ requests, centerMap, onApprove, onReject }: {
  requests: StudentRow[]; centerMap: Map<string, string>;
  onApprove: (s: StudentRow) => void; onReject: (s: StudentRow) => void;
}) {
  if (requests.length === 0) {
    return (
      <div style={p.card}>
        <EmptyState icon="✅" title="No pending deactivation requests" hint="All students are active or already inactive." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
      {requests.map(s => (
        <div key={s.id} style={{ ...p.card, borderLeft: "4px solid #f59e0b" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 12 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{s.name}</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                <span style={p.idChip}>{s.studentID}</span>
                {" · "}
                {centerMap.get(s.centerId) ?? s.centerId}
                {" · "}
                {s.course}
              </div>
              {s.deactivationRequestedAt && (
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                  Requested: {s.deactivationRequestedAt.slice(0, 10)}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => onApprove(s)}
                style={{ background: "#dc2626", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Approve (Deactivate)
              </button>
              <button onClick={() => onReject(s)}
                style={{ background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Reject (Keep Active)
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Edit Modal ────────────────────────────────────────────────────────────────

function EditModal({ student, centerOptions, onClose, onSaved, currentUserUid, currentUserRole }: {
  student:         StudentRow;
  centerOptions:   { id: string; name: string }[];
  onClose:         () => void;
  onSaved:         (updated: Partial<StudentRow> & { id: string }) => void;
  currentUserUid:  string;
  currentUserRole: string;
}) {
  const [form, setForm]     = useState<EditForm>({
    name:        student.name,
    email:       student.email,
    admissionNo: student.admissionNo,
    phone:       student.phone,
    centerId:    student.centerId,
    instrument:  student.instrument,
    course:      student.course,
    feeCycle:    student.feeCycle,
    feePerClass: String(student.feePerClass),
    status:      student.status,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  function f(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!form.name.trim())  { setError("Name is required."); return; }
    if (!form.email.trim()) { setError("Email is required."); return; }
    if (!/\S+@\S+\.\S+/.test(form.email)) { setError("Invalid email format."); return; }

    setSaving(true);
    try {
      // Update Firestore
      const payload: Record<string, unknown> = {
        name:          form.name.trim(),
        displayName:   form.name.trim(),
        email:         form.email.trim().toLowerCase(),
        admissionNo:   form.admissionNo.trim(),
        phone:         form.phone.trim(),
        centerId:      form.centerId,
        instrument:    form.instrument.trim(),
        course:        form.course.trim(),
        feeCycle:      form.feeCycle,
        feePerClass:   form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        status:        form.status,
        studentStatus: form.status,   // mirror for type-system compatibility
        updatedAt:     serverTimestamp(),
      };

      await updateDoc(doc(db, "users", student.id), payload);

      // If email changed, update Firebase Auth via admin SDK pattern
      // (We can only do this if we have a secondary app or the Admin SDK)
      // For now, update Firestore only and note the email change
      // Firebase Auth email update requires re-authentication or Admin SDK
      if (form.email.trim().toLowerCase() !== student.email.toLowerCase()) {
        // Update the admissionNo as well to keep login consistent
        // Admin SDK email update would go here in a server action
        console.info("Email changed in Firestore. Firebase Auth email update requires server-side Admin SDK.");
      }

      logAction({
        action: "STUDENT_UPDATED", initiatorId: currentUserUid,
        initiatorRole: currentUserRole as never, approverId: null, approverRole: null, reason: null,
        metadata: { studentId: student.id, fields: Object.keys(payload) },
      });

      onSaved({
        id:          student.id,
        name:        form.name.trim(),
        email:       form.email.trim().toLowerCase(),
        admissionNo: form.admissionNo.trim(),
        phone:       form.phone.trim(),
        centerId:    form.centerId,
        instrument:  form.instrument.trim(),
        course:      form.course.trim(),
        feeCycle:    form.feeCycle,
        feePerClass: form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        status:      form.status,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={modal.box} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={modal.header}>
          <div>
            <div style={modal.title}>Edit Student</div>
            <div style={modal.subtitle}><span style={p.idChip}>{student.studentID}</span> · {student.name}</div>
          </div>
          <button onClick={onClose} style={modal.closeBtn}>✕</button>
        </div>

        {/* Body */}
        <form onSubmit={handleSave}>
          <div style={modal.body}>
            {error && <div style={modal.errorBanner}>⚠ {error}</div>}

            <div style={modal.sectionLabel}>Personal Info</div>
            <div style={modal.grid}>
              <Field label="Full Name *">
                <input name="name" value={form.name} onChange={f} required style={p.input} />
              </Field>
              <Field label="Email">
                <input name="email" type="email" value={form.email} onChange={f} style={p.input} />
              </Field>
              <Field label="Admission No.">
                <input name="admissionNo" value={form.admissionNo} onChange={f} style={p.input} />
              </Field>
              <Field label="Phone">
                <input name="phone" value={form.phone} onChange={f} placeholder="+91 98765 43210" style={p.input} />
              </Field>
            </div>

            <div style={modal.sectionLabel}>Academic Info</div>
            <div style={modal.grid}>
              <Field label="Center *">
                <select name="centerId" value={form.centerId} onChange={f} required style={p.input}>
                  <option value="">— Select center —</option>
                  {centerOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Instrument">
                <input name="instrument" value={form.instrument} onChange={f} style={p.input} />
              </Field>
              <Field label="Course">
                <input name="course" value={form.course} onChange={f} style={p.input} />
              </Field>
              <Field label="Fee Cycle">
                <select name="feeCycle" value={form.feeCycle} onChange={f} style={p.input}>
                  <option value="monthly">Monthly</option>
                  <option value="per_class">Per Class</option>
                </select>
              </Field>
              {form.feeCycle === "per_class" && (
                <Field label="Fee Per Class (₹)">
                  <input name="feePerClass" type="number" min="0" value={form.feePerClass} onChange={f} style={p.input} />
                </Field>
              )}
              <Field label="Status">
                <select name="status" value={form.status} onChange={f} style={p.input}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="deactivation_requested">Deactivation Requested</option>
                </select>
              </Field>
            </div>
          </div>

          {/* Footer */}
          <div style={modal.footer}>
            <button type="button" onClick={onClose} style={modal.cancelBtn}>Cancel</button>
            <button type="submit" disabled={saving}
              style={{ ...p.primaryBtn, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Field wrapper ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Page styles ───────────────────────────────────────────────────────────────

const p: Record<string, React.CSSProperties> = {
  page:    { padding: "0 0 32px", background: "#f8fafc", minHeight: "100vh" },
  header:  { display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 12, marginBottom: 20 },
  heading: { fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 },
  subheading: { fontSize: 12, color: "#6b7280", marginTop: 3 },
  addBtn:  { background: "#4f46e5", color: "#fff", border: "none", padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  primaryBtn: { background: "#4f46e5", color: "#fff", border: "none", padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  card:      { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 24px", marginBottom: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" },
  cardHeader:{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 12 },
  hint:      { fontSize: 12, color: "#1d4ed8", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "9px 14px", marginBottom: 16 },
  formGrid:  { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 },

  input: {
    padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6,
    fontSize: 13, outline: "none", background: "#fff", color: "#111827",
    width: "100%", boxSizing: "border-box" as const,
  },

  filterBar:    { display: "flex", gap: 10, flexWrap: "wrap" as const, marginBottom: 14, alignItems: "center" },
  searchInput:  { padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, outline: "none", background: "#fff", color: "#111827", minWidth: 220, flex: 1, maxWidth: 300 },
  filterSelect: { padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, outline: "none", background: "#fff", color: "#111827", cursor: "pointer" },
  resetBtn:     { background: "#fee2e2", color: "#dc2626", border: "none", padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" },

  tabs:     { display: "flex", gap: 4, marginBottom: 14, background: "#fff", borderRadius: 8, padding: 4, border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  tab:      { flex: 1, padding: "8px 0", border: "none", background: "transparent", fontSize: 13, fontWeight: 500, color: "#6b7280", cursor: "pointer", borderRadius: 6, textAlign: "center" as const },
  tabActive:{ background: "#ede9fe", color: "#6d28d9", fontWeight: 700 },
  tabBadge: { display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#dc2626", color: "#fff", borderRadius: 99, fontSize: 10, fontWeight: 700, padding: "1px 6px", marginLeft: 6 },

  deactivationBadge: {
    background: "#fef3c7", color: "#d97706", border: "1px solid #fde68a",
    borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
  },

  tableWrap: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "auto", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" },
  table:     { width: "100%", minWidth: 1200, borderCollapse: "collapse" as const },
  th: {
    padding: "11px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 700,
    color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.04em",
    borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" as const,
  },
  td: { padding: "11px 14px", fontSize: 13, color: "#111827", borderBottom: "1px solid #f3f4f6" },

  badge: { display: "inline-block", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" as const },
  idChip:  { display: "inline-block", fontFamily: "monospace", fontSize: 11, fontWeight: 700, background: "#dbeafe", color: "#1e40af", padding: "2px 7px", borderRadius: 4 },
  admChip: { display: "inline-block", fontFamily: "monospace", fontSize: 11, fontWeight: 600, background: "#fef9c3", color: "#92400e", padding: "2px 7px", borderRadius: 4 },

  editBtn:     { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  deactBtn:    { background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  syllabusBtn: { background: "#ede9fe", color: "#6d28d9", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, textDecoration: "none", display: "inline-block" },
};

// ─── Modal styles ──────────────────────────────────────────────────────────────

const modal: Record<string, React.CSSProperties> = {
  overlay:  { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  box:      { background: "#fff", borderRadius: 16, width: "100%", maxWidth: 680, maxHeight: "90vh", display: "flex", flexDirection: "column" as const, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", overflow: "hidden" },
  header:   { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  title:    { fontSize: 17, fontWeight: 700, color: "#111827" },
  subtitle: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  closeBtn: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 },
  body:     { padding: "20px 24px", overflowY: "auto" as const, flex: 1 },
  footer:   { padding: "16px 24px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0, background: "#f9fafb" },
  cancelBtn:{ background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  errorBanner: { background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "9px 14px", marginBottom: 14, fontSize: 13 },
  sectionLabel: { fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 12, marginTop: 8 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 16 },
};
