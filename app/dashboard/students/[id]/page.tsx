"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  collection, getDocs, query, where, doc, getDoc, updateDoc, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { logAction } from "@/services/audit/audit.service";
import { computeStudentBalances } from "@/services/finance/finance.service";
import type { Transaction } from "@/types/finance";
import {
  type StudentRow, p, modal, STATUS_BADGE, fmtINR, fmtDate, toISODate,
  Row, Field, LedgerEditor, RecordPaymentModal, CenterDetailModal,
  EditModal, ClearHistoryModal, DeleteStudentModal, BreakRequestModal,
  HISTORY_STATUS_STYLE, HISTORY_STATUS_LABEL,
} from "../_shared";
import { StudentSyllabusContent } from "../../student-syllabus/[studentId]/_shared";
import { getScreeningByStudent } from "@/services/screening/screening.service";
import type { ScreeningResult } from "@/types";
import { DiagnosticCard } from "@/components/DiagnosticCard";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StudentDetailPage({ params }: { params: { id: string } }) {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={null}>
        <StudentDetailContent studentId={params.id} />
      </Suspense>
    </ProtectedRoute>
  );
}

type DetailTab = "overview" | "syllabus" | "attendance" | "financial";

// Fields captured on the original Admission (application) form. These land
// directly on the student's own `users` doc when the admissions flow enrolls
// them (see app/dashboard/screening/page.tsx handleEnrollStudent) — the
// source `admissions` doc itself is deleted at that point, so this is the
// only surviving record for an already-enrolled student.
export interface ApplicationFields {
  age:           string;
  dob:           string;
  parentName:    string;
  workingStatus: string;
  schoolCompany: string;
  address1:      string;
  address2:      string;
  musicalSkill:  string;
  instruments:   string[];
}

function isApplicationComplete(a: ApplicationFields): boolean {
  return Boolean(a.dob.trim()) && Boolean(a.parentName.trim());
}

// ─── Content ─────────────────────────────────────────────────────────────────

function StudentDetailContent({ studentId }: { studentId: string }) {
  const { user, role }                 = useAuth();
  const router                         = useRouter();
  const searchParams                   = useSearchParams();
  const { isAllowed, isTeacherRole }   = useCentreAccess();
  const { toasts, toast, remove }      = useToast();

  const isAdmin   = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
  const isTeacher = role === ROLES.TEACHER;

  const [tab, setTab] = useState<DetailTab>(() => {
    const t = searchParams.get("tab");
    return t === "syllabus" || t === "attendance" || t === "financial" ? t : "overview";
  });

  const [student, setStudent]           = useState<StudentRow | null>(null);
  const [applicationFields, setApplicationFields] = useState<ApplicationFields | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [centerMap, setCenterMap]       = useState<Map<string, string>>(new Map());
  const [centerOptions, setCenterOptions] = useState<{ id: string; name: string }[]>([]);
  const [teacherOptions, setTeacherOptions] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading]           = useState(true);
  const [notFound, setNotFound]         = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const [studentSnap, centerSnap, teacherSnap, txSnap] = await Promise.all([
        getDoc(doc(db, "users", studentId)),
        getDocs(collection(db, "centers")),
        getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
        getDocs(query(collection(db, "transactions"), where("studentUid", "==", studentId))),
      ]);

      if (!studentSnap.exists()) { setNotFound(true); setLoading(false); return; }

      const cMap = new Map<string, string>();
      const cOptsAll: { id: string; name: string }[] = [];
      centerSnap.docs.forEach(d => {
        cMap.set(d.id, (d.data().name as string) ?? d.id);
        cOptsAll.push({ id: d.id, name: (d.data().name as string) ?? d.id });
      });
      setCenterMap(cMap);
      setCenterOptions(cOptsAll);

      const tMap = new Map<string, string>();
      const tOptsAll: { id: string; name: string }[] = [];
      teacherSnap.docs.forEach(d => {
        const tName = ((d.data().displayName ?? d.data().name ?? "-") as string);
        tMap.set(d.id, tName);
        tOptsAll.push({ id: d.id, name: tName });
      });
      setTeacherOptions(tOptsAll);

      const txs = txSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction);
      setTransactions(txs);
      const balanceMap = computeStudentBalances(txs);

      const s = studentSnap.data();
      const assignedTUid = (s.assignedTeacherUid ?? null) as string | null;
      setStudent({
        id:          studentSnap.id,
        name:        (s.displayName ?? s.name ?? "-") as string,
        email:       (s.email       ?? "-") as string,
        studentID:   (s.studentID   ?? "-") as string,
        admissionNo: (s.admissionNo ?? s.admissionNumber ?? "-") as string,
        phone:       (s.phone       ?? "") as string,
        centerId:    (s.centerId    ?? "-") as string,
        centerName:  cMap.get(s.centerId as string) ?? (s.centerId as string) ?? "-",
        instrument:  (s.instrument  ?? "-") as string,
        course:      (s.course      ?? "-") as string,
        classType:   ((s.classType  as string) === "personal" ? "personal" : "group"),
        billingMode: ((s.billingMode as string) === "prepay" ? "prepay" : "postpay"),
        assignedTeacherUid:  assignedTUid,
        assignedTeacherName: assignedTUid ? (tMap.get(assignedTUid) ?? null) : null,
        classDays:   Array.isArray(s.classDays) ? (s.classDays as string[]) : [],
        classTime:   (s.classTime ?? null) as string | null,
        feeCycle:    (s.feeCycle    ?? "-") as string,
        feePerClass: Number(s.feePerClass ?? 0),
        balance:     balanceMap.get(studentSnap.id) ?? 0,
        status:      (s.status ?? s.studentStatus ?? "active") as string,
        createdAt:   toISODate(s.createdAt),
        deactivationRequestedBy: (s.deactivationRequestedBy ?? null) as string | null,
        deactivationRequestedAt: (s.deactivationRequestedAt ?? null) as string | null,
        breakRequestedBy: (s.breakRequestedBy ?? null) as string | null,
        breakRequestedAt: (s.breakRequestedAt ?? null) as string | null,
        breakStartDate:   (s.breakStartDate   ?? null) as string | null,
        breakReason:      (s.breakReason ?? null) as string | null,
      });
      setApplicationFields({
        age:           (s.age           ?? "") as string,
        dob:           (s.dob           ?? "") as string,
        parentName:    (s.parentName    ?? "") as string,
        workingStatus: (s.workingStatus ?? "") as string,
        schoolCompany: (s.schoolCompany ?? "") as string,
        address1:      (s.address1      ?? "") as string,
        address2:      (s.address2      ?? "") as string,
        musicalSkill:  (s.musicalSkill  ?? "") as string,
        instruments:   Array.isArray(s.instruments) ? (s.instruments as string[]) : [],
      });
    } catch (err) {
      console.error("Failed to load student:", err);
      toast("Failed to load student.", "error");
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  // ── Quick action modal targets ───────────────────────────────────────────────
  const [editOpen, setEditOpen]                 = useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen]             = useState(false);
  const [breakOpen, setBreakOpen]               = useState(false);
  const [payTarget, setPayTarget]               = useState<Transaction | null>(null);
  const [statementEditMode, setStatementEditMode] = useState(false);

  async function requestDeactivation() {
    if (!user || !student) return;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:                     "deactivation_requested",
        studentStatus:              "deactivation_requested",
        deactivationApprovalStatus: "pending",
        deactivationRequestedBy:    user.uid,
        deactivationRequestedAt:    new Date().toISOString(),
        updatedAt:                  serverTimestamp(),
      });
      logAction({
        action: "DEACTIVATION_REQUESTED", initiatorId: user.uid, initiatorRole: role ?? "teacher",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id },
      });
      setStudent(prev => prev && { ...prev, status: "deactivation_requested", deactivationRequestedBy: user.uid, deactivationRequestedAt: new Date().toISOString() });
      toast("Deactivation request submitted.", "success");
    } catch {
      toast("Failed to submit request.", "error");
    }
  }

  if (loading) {
    return (
      <div style={dp.page}>
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <BackBar router={router} />
          <div className="bg-white shadow-sm rounded-xl border border-gray-100">
            <div style={dp.state}>Loading student…</div>
          </div>
        </div>
      </div>
    );
  }
  if (notFound || !student) {
    return (
      <div style={dp.page}>
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <BackBar router={router} />
          <div className="bg-white shadow-sm rounded-xl border border-gray-100">
            <div style={{ ...dp.state, color: "#dc2626" }}>Student not found.</div>
          </div>
        </div>
      </div>
    );
  }

  const statusStyle = STATUS_BADGE[student.status] ?? { background: "#f3f4f6", color: "#6b7280" };
  const canEdit = (isAdmin || isTeacher) && (!isTeacherRole || isAllowed(student.centerId));

  return (
    <div style={dp.page}>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* A4-style document container: capped width, centered, clean card framing */}
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <BackBar router={router} />

        <div className="bg-white shadow-sm rounded-xl border border-gray-100 overflow-hidden">
          {/* ── Header ── */}
          <div style={{ ...dp.header, padding: "24px 24px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" as const }}>
              <div style={dp.avatar}>
                {student.name.split(" ").map(n => n[0] ?? "").join("").slice(0, 2).toUpperCase() || "?"}
              </div>
              <div>
                <div style={dp.name}>{student.name}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" as const }}>
                  <span style={p.idChip}>{student.studentID}</span>
                  <span style={{ ...p.badge, ...statusStyle }}>{student.status.replace(/_/g, " ")}</span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
              {canEdit && (
                <button onClick={() => setEditOpen(true)} style={p.editBtn}>✏ Edit</button>
              )}
              {(isAdmin || isTeacher) && student.status === "active" && (
                <button onClick={() => setBreakOpen(true)} style={{ ...p.editBtn, background: "#e0f2fe", color: "#0369a1", borderColor: "#7dd3fc" }}>☕ Break</button>
              )}
              {(isAdmin || isTeacher) && student.status === "active" && (
                <button onClick={requestDeactivation} style={p.deactBtn}>Deactivate</button>
              )}
              {isAdmin && (
                <button onClick={() => setClearHistoryOpen(true)} style={p.clearBtn} title="Clear student history">🗑 History</button>
              )}
              {isAdmin && (
                <button onClick={() => setDeleteOpen(true)} style={p.deleteBtn} title="Delete student permanently">✕ Delete</button>
              )}
            </div>
          </div>

          {/* ── Tabs ── */}
          <div style={{ padding: "0 24px" }}>
            <div style={p.tabs}>
              {([
                ["overview",   "Overview"],
                ["syllabus",   "Syllabus"],
                ["attendance", "Attendance"],
                ["financial",  "Financial Statement"],
              ] as [DetailTab, string][]).map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)} style={{ ...p.tab, ...(tab === key ? p.tabActive : {}) }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Tab content ── */}
          <div style={{ padding: "24px" }}>
            {tab === "overview" && (
              <OverviewTab
                student={student}
                applicationFields={applicationFields}
                isAdmin={isAdmin}
                onApplicationSaved={load}
              />
            )}
            {tab === "syllabus" && <StudentSyllabusContent studentId={student.id} hideBackBar viewOnly />}
            {tab === "attendance" && <AttendanceTab studentId={student.id} centerMap={centerMap} />}
            {tab === "financial" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div style={dp.cardHeader}>Financial Statement</div>
                  {isAdmin && transactions.length > 0 && (
                    <button
                      onClick={() => setStatementEditMode(v => !v)}
                      style={{
                        fontSize: 12, fontWeight: 700, padding: "5px 14px", borderRadius: 99, cursor: "pointer",
                        border: `1px solid ${statementEditMode ? "#1d4ed8" : "#d1d5db"}`,
                        background: statementEditMode ? "#dbeafe" : "#fff",
                        color: statementEditMode ? "#1d4ed8" : "#374151",
                      }}
                    >
                      {statementEditMode ? "Done" : "✏ Edit Statement"}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 13, marginBottom: 14 }}>
                  <span style={{ color: "#6b7280" }}>Running balance: </span>
                  <span style={{ fontWeight: 700, color: student.balance > 0 ? "#dc2626" : "#16a34a" }}>{fmtINR(student.balance)}</span>
                </div>
                <LedgerEditor
                  transactions={transactions}
                  currentUserUid={user?.uid ?? ""}
                  currentUserRole={role ?? "admin"}
                  onChanged={load}
                  editMode={statementEditMode}
                  onPayDue={isAdmin ? tx => setPayTarget(tx) : undefined}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Quick action modals ── */}
      {editOpen && (
        <EditModal
          student={student}
          centerOptions={centerOptions}
          teacherOptions={teacherOptions}
          transactions={transactions}
          isAdmin={isAdmin}
          onTransactionsChanged={load}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); load(); toast("Student updated.", "success"); }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}
      {clearHistoryOpen && (
        <ClearHistoryModal
          student={student}
          onClose={() => setClearHistoryOpen(false)}
          onCleared={() => { setClearHistoryOpen(false); load(); toast("History cleared successfully.", "success"); }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}
      {deleteOpen && (
        <DeleteStudentModal
          student={student}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            toast(`Student "${student.name}" deleted.`, "success");
            router.push("/dashboard/students");
          }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}
      {breakOpen && (
        <BreakRequestModal
          student={student}
          onClose={() => setBreakOpen(false)}
          onRequested={() => { setBreakOpen(false); load(); toast("Break request submitted for admin approval.", "success"); }}
          onApprovedDirectly={(_reason, startDate) => { setBreakOpen(false); load(); toast(`${student.name} is on break from ${startDate}.`, "success"); }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "teacher"}
          isAdmin={isAdmin}
        />
      )}
      {payTarget && (
        <RecordPaymentModal
          student={student}
          feeDue={payTarget}
          receivedBy={user?.displayName ?? user?.email ?? "admin"}
          onClose={() => setPayTarget(null)}
          onRecorded={() => { setPayTarget(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Back bar ──────────────────────────────────────────────────────────────────

function BackBar({ router }: { router: ReturnType<typeof useRouter> }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <button onClick={() => router.push("/dashboard/students")} style={dp.backBtn}>← Back to Students</button>
    </div>
  );
}

// ─── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({ student: s, applicationFields, isAdmin, onApplicationSaved }: {
  student: StudentRow; applicationFields: ApplicationFields | null; isAdmin: boolean; onApplicationSaved: () => void;
}) {
  const [centerDetailOpen, setCenterDetailOpen] = useState(false);
  return (
    <div>
      {/* ── Date of Joining (prominent) ── */}
      <div style={dp.joinBanner}>
        <span style={{ fontSize: 20 }}>📅</span>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#0369a1", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Date of Joining</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>
            {s.createdAt ? fmtDate(s.createdAt) : "Not recorded"}
          </div>
        </div>
      </div>

      <div style={dp.cardHeader}>Personal Info</div>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 20 }}>
        <Row label="Admission No" value={<span style={p.admChip}>{s.admissionNo}</span>} />
        <Row label="Email"        value={s.email} />
        {s.phone && <Row label="Phone" value={s.phone} />}
      </div>

      <div style={dp.cardHeader}>Academic Info</div>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 20 }}>
        <Row label="Instrument" value={s.instrument} />
        <Row label="Course"     value={s.course} />
        <Row label="Class Type" value={
          <span style={{ ...p.badge, ...(s.classType === "personal" ? { background: "#fef9c3", color: "#92400e" } : { background: "#dcfce7", color: "#166534" }) }}>
            {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
          </span>
        } />
        {s.classType === "personal" && (
          <Row label="Teacher" value={s.assignedTeacherName ?? <span style={{ color: "#d97706" }}>⚠ Unassigned</span>} />
        )}
        {s.classType === "personal" && s.classDays.length > 0 && (
          <Row label="Class Days" value={`${s.classDays.join(", ")}${s.classTime ? " · " + s.classTime : ""}`} />
        )}
        <Row label="Fee" value={
          <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const }}>
            <span>{s.feeCycle === "per_class" ? `₹${s.feePerClass}/class` : "Monthly"}</span>
            <span style={{ color: "#d1d5db" }}>•</span>
            <span>{s.billingMode === "prepay" ? "⬆ Prepay" : "⬇ Postpay"}</span>
          </span>
        } />
        <Row label="Balance" value={
          <span style={{ fontWeight: 700, color: s.balance > 0 ? "#dc2626" : "#16a34a" }}>{fmtINR(s.balance)}</span>
        } />
      </div>

      <div style={dp.cardHeader}>Center Info</div>
      <button
        type="button"
        onClick={() => setCenterDetailOpen(true)}
        title="View center details"
        style={{
          display: "flex", gap: 8, fontSize: 13, width: "100%",
          border: "1px solid #e5e7eb", textAlign: "left" as const, borderRadius: 8,
          cursor: "pointer", padding: "10px 12px", background: "#fafafa", font: "inherit",
        }}
      >
        <span style={{ color: "#111827", flex: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const }}>
          {s.centerName}
          <span style={{ fontSize: 11, color: "#4f46e5", marginLeft: "auto" }}>View details →</span>
        </span>
      </button>

      {centerDetailOpen && (
        <CenterDetailModal centerId={s.centerId} onClose={() => setCenterDetailOpen(false)} />
      )}

      <div style={{ marginTop: 20 }}>
        <ApplicationFormSection
          studentId={s.id}
          fields={applicationFields}
          isAdmin={isAdmin}
          onSaved={onApplicationSaved}
        />
      </div>

      <div style={{ marginTop: 20 }}>
        <ScreeningSection studentId={s.id} studentName={s.name} />
      </div>
    </div>
  );
}

// ─── Application Form section ──────────────────────────────────────────────────

function ApplicationFormSection({ studentId, fields, isAdmin, onSaved }: {
  studentId: string; fields: ApplicationFields | null; isAdmin: boolean; onSaved: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const complete = fields ? isApplicationComplete(fields) : false;

  return (
    <div>
      <div style={dp.cardHeader}>Application Form</div>
      {complete && fields ? (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, border: "1px solid #e5e7eb", borderRadius: 8, padding: "14px 16px", background: "#fafafa" }}>
          {fields.age           && <Row label="Age"                value={fields.age} />}
          {fields.dob            && <Row label="Date of Birth"      value={fmtDate(fields.dob)} />}
          {fields.parentName    && <Row label="Parent / Guardian"  value={fields.parentName} />}
          {fields.workingStatus && <Row label="Working Status"     value={fields.workingStatus} />}
          {fields.schoolCompany && <Row label="School / Company"   value={fields.schoolCompany} />}
          {(fields.address1 || fields.address2) && (
            <Row label="Address" value={[fields.address1, fields.address2].filter(Boolean).join(", ")} />
          )}
          {fields.musicalSkill  && <Row label="Musical Skill"      value={fields.musicalSkill} />}
          {fields.instruments.length > 0 && (
            <Row label="Instruments" value={fields.instruments.join(", ")} />
          )}
          {isAdmin && (
            <button onClick={() => setFormOpen(true)} style={{ ...p.editBtn, alignSelf: "flex-start", marginTop: 4 }}>✏ Edit Application Form</button>
          )}
        </div>
      ) : (
        <div style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: "16px", textAlign: "center" as const, background: "#fafafa" }}>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: isAdmin ? 10 : 0 }}>No application form on file for this student.</div>
          {isAdmin && (
            <button onClick={() => setFormOpen(true)} style={p.primaryBtn}>+ Complete Application Form</button>
          )}
        </div>
      )}

      {formOpen && (
        <ApplicationFormModal
          studentId={studentId}
          initial={fields}
          onClose={() => setFormOpen(false)}
          onSaved={() => { setFormOpen(false); onSaved(); }}
        />
      )}
    </div>
  );
}

function ApplicationFormModal({ studentId, initial, onClose, onSaved }: {
  studentId: string; initial: ApplicationFields | null; onClose: () => void; onSaved: () => void;
}) {
  const [age, setAge]                     = useState(initial?.age ?? "");
  const [dob, setDob]                     = useState(initial?.dob ?? "");
  const [parentName, setParentName]       = useState(initial?.parentName ?? "");
  const [workingStatus, setWorkingStatus] = useState(initial?.workingStatus ?? "Student");
  const [schoolCompany, setSchoolCompany] = useState(initial?.schoolCompany ?? "");
  const [address1, setAddress1]           = useState(initial?.address1 ?? "");
  const [address2, setAddress2]           = useState(initial?.address2 ?? "");
  const [musicalSkill, setMusicalSkill]   = useState(initial?.musicalSkill ?? "Beginner");
  const [instrumentsStr, setInstrumentsStr] = useState((initial?.instruments ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dob.trim())        { setError("Date of birth is required."); return; }
    if (!parentName.trim()) { setError("Parent / guardian name is required."); return; }
    setError("");
    setSaving(true);
    try {
      await updateDoc(doc(db, "users", studentId), {
        age:            age.trim(),
        dob:            dob.trim(),
        parentName:     parentName.trim(),
        workingStatus,
        schoolCompany:  schoolCompany.trim(),
        address1:       address1.trim(),
        address2:       address2.trim(),
        musicalSkill,
        instruments:    instrumentsStr.split(",").map(v => v.trim()).filter(Boolean),
        updatedAt:      serverTimestamp(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={modal.box} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={modal.title}>{initial && isApplicationComplete(initial) ? "Edit" : "Complete"} Application Form</div>
          <button onClick={onClose} style={modal.closeBtn}>✕</button>
        </div>
        <form onSubmit={handleSave}>
          <div style={modal.body}>
            {error && <div style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "9px 14px", marginBottom: 14, fontSize: 13 }}>{error}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
              <Field label="Age">
                <input value={age} onChange={e => setAge(e.target.value)} style={p.input} placeholder="e.g. 9" />
              </Field>
              <Field label="Date of Birth *">
                <input type="date" value={dob} onChange={e => setDob(e.target.value)} style={p.input} required />
              </Field>
              <Field label="Parent / Guardian Name *">
                <input value={parentName} onChange={e => setParentName(e.target.value)} style={p.input} required />
              </Field>
              <Field label="Working Status">
                <select value={workingStatus} onChange={e => setWorkingStatus(e.target.value)} style={p.input}>
                  <option value="Student">Student</option>
                  <option value="Working">Working</option>
                  <option value="Other">Other</option>
                </select>
              </Field>
              <Field label="School / Company">
                <input value={schoolCompany} onChange={e => setSchoolCompany(e.target.value)} style={p.input} />
              </Field>
              <Field label="Musical Skill Level">
                <select value={musicalSkill} onChange={e => setMusicalSkill(e.target.value)} style={p.input}>
                  <option value="Beginner">Beginner</option>
                  <option value="Intermediate">Intermediate</option>
                  <option value="Advanced">Advanced</option>
                </select>
              </Field>
              <Field label="Address Line 1">
                <input value={address1} onChange={e => setAddress1(e.target.value)} style={p.input} />
              </Field>
              <Field label="Address Line 2">
                <input value={address2} onChange={e => setAddress2(e.target.value)} style={p.input} />
              </Field>
              <Field label="Instruments (comma-separated)">
                <input value={instrumentsStr} onChange={e => setInstrumentsStr(e.target.value)} style={p.input} placeholder="e.g. Guitar, Keyboard" />
              </Field>
            </div>
          </div>
          <div style={modal.footer}>
            <button type="button" onClick={onClose} style={modal.cancelBtn} disabled={saving}>Cancel</button>
            <button type="submit" disabled={saving} style={{ ...p.primaryBtn, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Save Application Form"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Screening Form section ─────────────────────────────────────────────────────

function ScreeningSection({ studentId, studentName }: { studentId: string; studentName: string }) {
  const router = useRouter();
  const [screening, setScreening] = useState<ScreeningResult | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setScreening(undefined);
      setError(false);
      try {
        const result = await getScreeningByStudent(studentId);
        if (!cancelled) setScreening(result);
      } catch (err) {
        console.error("Failed to load screening result:", err);
        if (!cancelled) { setScreening(null); setError(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [studentId]);

  return (
    <div>
      <div style={dp.cardHeader}>Screening Form</div>
      {screening === undefined ? (
        <div style={{ fontSize: 13, color: "#9ca3af", padding: "10px 0" }}>Loading…</div>
      ) : screening ? (
        <DiagnosticCard result={screening} compact />
      ) : (
        <div style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: "16px", textAlign: "center" as const, background: "#fafafa" }}>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
            {error ? "Couldn't load screening data." : "No screening record on file for this student."}
          </div>
          <button
            onClick={() => router.push("/dashboard/screening")}
            style={p.primaryBtn}
            title={`Search for "${studentName}" in the screening tool to attach a new record`}
          >
            + Fill Screening Form
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Attendance tab ────────────────────────────────────────────────────────────
// Self-contained: fetches this one student's full historical attendance record
// on demand, so it never affects the queries backing the active attendance grid.

interface AttendanceHistoryRec {
  date:     string;
  status:   string;
  centerId: string;
}

function AttendanceTab({ studentId, centerMap }: { studentId: string; centerMap: Map<string, string> }) {
  const [records, setRecords] = useState<AttendanceHistoryRec[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snap = await getDocs(query(collection(db, "attendance"), where("studentUid", "==", studentId)));
        if (cancelled) return;
        const recs = snap.docs
          .map(d => {
            const r = d.data();
            return {
              date:     (r.date     as string) ?? "",
              status:   (r.status   as string) ?? "",
              centerId: (r.centerId as string) ?? "",
            };
          })
          .sort((a, b) => b.date.localeCompare(a.date));
        setRecords(recs);
      } catch (err) {
        console.error("Failed to load attendance history:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [studentId]);

  const presentCount = records.filter(r => r.status === "present").length;
  const absentCount  = records.filter(r => r.status === "absent").length;

  return (
    <div>
      <div style={dp.cardHeader}>Attendance History</div>
      {loading ? (
        <div style={dp.state}>Loading…</div>
      ) : records.length === 0 ? (
        <div style={{ fontSize: 13, color: "#9ca3af", padding: "20px 0", textAlign: "center" as const }}>
          No attendance records for this student yet.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" as const }}>
            <span style={{ ...p.badge, background: "#dcfce7", color: "#16a34a" }}>{presentCount} Present</span>
            <span style={{ ...p.badge, background: "#fee2e2", color: "#dc2626" }}>{absentCount} Absent</span>
            <span style={{ ...p.badge, background: "#f3f4f6", color: "#6b7280" }}>{records.length} Total</span>
          </div>
          <div style={{ maxHeight: 480, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={dp.attTh}>Date</th>
                  <th style={dp.attTh}>Centre</th>
                  <th style={dp.attTh}>Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={`${r.date}-${i}`} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={dp.attTd}>{fmtDate(r.date)}</td>
                    <td style={{ ...dp.attTd, color: "#6b7280" }}>{centerMap.get(r.centerId) ?? r.centerId ?? "—"}</td>
                    <td style={dp.attTd}>
                      <span style={{ ...p.badge, ...(HISTORY_STATUS_STYLE[r.status] ?? { background: "#f3f4f6", color: "#6b7280" }) }}>
                        {HISTORY_STATUS_LABEL[r.status] ?? (r.status.replace(/_/g, " ") || "—")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const dp: Record<string, React.CSSProperties> = {
  page:    { padding: "0 0 32px", background: "#f8fafc", minHeight: "100vh" },
  state:   { textAlign: "center" as const, padding: "48px 0", color: "#9ca3af", fontSize: 14 },
  backBtn: { background: "none", border: "none", color: "#4f46e5", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 },
  header:  { display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 14, marginBottom: 20 },
  avatar:  {
    width: 52, height: 52, borderRadius: "50%", flexShrink: 0,
    background: "linear-gradient(135deg, #6d28d9, #4f46e5)",
    color: "#fff", fontSize: 18, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  name: { fontSize: 20, fontWeight: 700, color: "#111827" },
  joinBanner: {
    display: "flex", alignItems: "center", gap: 12, background: "#eff6ff",
    border: "1px solid #bfdbfe", borderRadius: 10, padding: "12px 16px", marginBottom: 20,
  },
  cardHeader: { fontSize: 12, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 12 },
  attTh: { padding: "8px 12px", textAlign: "left" as const, fontSize: 11, fontWeight: 700, color: "#6b7280", borderBottom: "2px solid #e5e7eb", background: "#f9fafb", position: "sticky" as const, top: 0 },
  attTd: { padding: "7px 12px", borderBottom: "1px solid #f3f4f6", color: "#111827" },
};
