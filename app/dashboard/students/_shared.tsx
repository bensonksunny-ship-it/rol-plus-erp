"use client";

import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter } from "next/navigation";
import {
  collection, getDocs, setDoc, updateDoc, doc, getDoc,
  query, where, serverTimestamp, addDoc, increment,
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
import {
  clearStudentHistory,
  deleteUser as deleteUserRecord,
  type ClearHistoryOptions,
} from "@/services/admin/delete.service";
import { computeStudentBalances, editTransaction, deleteTransaction } from "@/services/finance/finance.service";
import type { Transaction, EditableTransactionInput, PaymentMethod, TransactionStatus } from "@/types/finance";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface StudentRow {
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
  classType:   string;   // "group" | "personal"
  billingMode: string;   // "postpay" | "prepay"
  assignedTeacherUid:  string | null;
  assignedTeacherName: string | null;
  classDays:   string[];   // e.g. ["Mon","Wed"] — personal only
  classTime:   string | null; // e.g. "17:00" — personal only
  feeCycle:    string;
  feePerClass: number;
  balance:     number;
  status:      string;
  deactivationRequestedBy: string | null;
  deactivationRequestedAt: string | null;
  breakRequestedBy: string | null;
  breakRequestedAt: string | null;
  breakStartDate: string | null;
  breakReason: string | null;
  createdAt: string;   // ISO date — joining date, "" if unknown
}

type StudentTab = "active" | "requests" | "break_requests" | "on_break" | "inactive";

interface EditForm {
  name:               string;
  email:              string;
  admissionNo:        string;
  phone:              string;
  centerId:           string;
  instrument:         string;
  course:             string;
  classType:          string;   // "group" | "personal"
  billingMode:        string;   // "postpay" | "prepay"
  assignedTeacherUid: string;
  classDays:          string[];   // e.g. ["Mon","Wed"]
  classTime:          string;     // e.g. "17:00"
  feeCycle:           string;
  feePerClass:        string;
  status:             string;
}

const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const EMPTY_CREATE = {
  name: "", email: "", admissionNo: "", phone: "",
  centerId: "", instrument: "", course: "",
  classType: "group",
  billingMode: "postpay",
  assignedTeacherUid: "",
  classDays: [] as string[],
  classTime: "",
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

export function fmtINR(n: number): string {
  return n === 0 ? "₹0" : `₹${n.toLocaleString("en-IN")}`;
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "2026-08" → "August 2026" */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y ?? ""}`.trim();
}

/** "2026-08-12" → "12 Aug 2026" */
export function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 7 ? `${iso}-01` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** Normalizes a Firestore Timestamp or ISO string field to an ISO string ("" if neither). */
export function toISODate(v: unknown): string {
  if (v && typeof v === "object" && "toDate" in v) {
    return (v as { toDate(): Date }).toDate().toISOString();
  }
  if (typeof v === "string") return v;
  return "";
}

// ─── Status styles ─────────────────────────────────────────────────────────────

export const STATUS_BADGE: Record<string, React.CSSProperties> = {
  active:                 { background: "#dcfce7", color: "#16a34a" },
  inactive:               { background: "#f3f4f6", color: "#6b7280" },
  deactivation_requested: { background: "#fef3c7", color: "#d97706" },
  break_requested:        { background: "#e0f2fe", color: "#0369a1" },
  on_break:               { background: "#f0f9ff", color: "#0284c7" },
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
      <Suspense fallback={null}>
        <StudentsContent />
      </Suspense>
    </ProtectedRoute>
  );
}

function StudentsContent() {
  const { user, role }                  = useAuth();
  const router                          = useRouter();
  const { isAllowed, filterCentres, teacherCentreIds, isTeacherRole } = useCentreAccess();
  const [students, setStudents]         = useState<StudentRow[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [centerMap, setCenterMap]       = useState<Map<string, string>>(new Map());
  const [centerOptions, setCenterOpts]  = useState<{ id: string; name: string }[]>([]);
  const [teacherOptions, setTeacherOpts] = useState<{ id: string; name: string }[]>([]);
  const [teacherMap, setTeacherMap]     = useState<Map<string, string>>(new Map());
  const [loading, setLoading]           = useState(true);
  const [tab, setTab]                   = useState<StudentTab>("active");
  const [showForm, setShowForm]         = useState(false);
  const [form, setForm]                 = useState({ ...EMPTY_CREATE });
  const [saving, setSaving]             = useState(false);
  const [editTarget, setEditTarget]         = useState<StudentRow | null>(null);
  const [clearHistoryTarget, setClearHistoryTarget] = useState<StudentRow | null>(null);
  const [deleteTarget, setDeleteTarget]     = useState<StudentRow | null>(null);
  const [breakTarget, setBreakTarget]       = useState<StudentRow | null>(null);
  const debounceRef                         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, toast, remove }           = useToast();

  // Filters
  const [searchInput, setSearchInput]   = useState("");
  const [search, setSearch]             = useState("");
  const [filterCenter, setFilterCenter] = useState("all");
  const [filterCourse, setFilterCourse] = useState("");
  const [filterInstrument, setFilterInstrument] = useState("");
  const [filterFeeStatus, setFilterFeeStatus]   = useState("all");
  const [filterClassType, setFilterClassType]   = useState("all");

  const isAdmin = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
  const isTeacher = role === ROLES.TEACHER;

  async function fetchData() {
    try {
      const [studentSnap, centerSnap, teacherSnap, txSnap] = await Promise.all([
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "centers")),
        getDocs(query(collection(db, "users"), where("role", "==", "teacher"))),
        getDocs(collection(db, "transactions")),
      ]);

      // Single source of truth for balance: derive from the transaction
      // ledger (Total Dues Generated − Total Payments Received) rather than
      // the denormalized `currentBalance` field, which can drift out of sync.
      const txs = txSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction);
      const balanceMap = computeStudentBalances(txs);
      setTransactions(txs);

      const cMap = new Map<string, string>();
      const cOptsAll: { id: string; name: string }[] = [];
      centerSnap.docs.forEach(d => {
        cMap.set(d.id, (d.data().name as string) ?? d.id);
        cOptsAll.push({ id: d.id, name: (d.data().name as string) ?? d.id });
      });
      setCenterMap(cMap);
      // Teachers: show only their assigned centres in the filter dropdown
      setCenterOpts(filterCentres(cOptsAll));

      const tMap = new Map<string, string>();
      const tOptsAll: { id: string; name: string }[] = [];
      teacherSnap.docs.forEach(d => {
        const tName = ((d.data().displayName ?? d.data().name ?? "-") as string);
        tMap.set(d.id, tName);
        tOptsAll.push({ id: d.id, name: tName });
      });
      setTeacherMap(tMap);
      setTeacherOpts(tOptsAll);

      const allStudentsRaw = studentSnap.docs.map(d => {
        const s = d.data();
        const assignedTUid = (s.assignedTeacherUid ?? null) as string | null;
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
          classType:   ((s.classType  as string) === "personal" ? "personal" : "group"),
          billingMode: ((s.billingMode as string) === "prepay" ? "prepay" : "postpay"),
          assignedTeacherUid:  assignedTUid,
          assignedTeacherName: assignedTUid ? (tMap.get(assignedTUid) ?? null) : null,
          classDays:   Array.isArray(s.classDays) ? (s.classDays as string[]) : [],
          classTime:   (s.classTime ?? null) as string | null,
          feeCycle:    (s.feeCycle    ?? "-") as string,
          feePerClass: Number(s.feePerClass ?? 0),
          balance:     balanceMap.get(d.id) ?? 0,
          status:      (s.status ?? s.studentStatus ?? "active") as string,
          createdAt:   toISODate(s.createdAt),
          deactivationRequestedBy: (s.deactivationRequestedBy ?? null) as string | null,
          deactivationRequestedAt: (s.deactivationRequestedAt ?? null) as string | null,
          breakRequestedBy: (s.breakRequestedBy ?? null) as string | null,
          breakRequestedAt: (s.breakRequestedAt ?? null) as string | null,
          breakStartDate:   (s.breakStartDate   ?? null) as string | null,
          breakReason:      (s.breakReason ?? null) as string | null,
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
    setFilterCourse(""); setFilterInstrument(""); setFilterFeeStatus("all"); setFilterClassType("all");
  }

  // ── Tab-split lists ─────────────────────────────────────────────────────────
  const activeStudents       = students.filter(s => s.status === "active");
  const requestStudents      = students.filter(s => s.status === "deactivation_requested");
  const breakRequestStudents = students.filter(s => s.status === "break_requested");
  const onBreakStudents      = students.filter(s => s.status === "on_break");
  const inactiveStudents     = students.filter(s => s.status === "inactive");

  const baseList = tab === "active" ? activeStudents
    : tab === "requests" ? requestStudents
    : tab === "break_requests" ? breakRequestStudents
    : tab === "on_break" ? onBreakStudents
    : inactiveStudents;

  // Unique courses + instruments for filter dropdowns
  const courses     = useMemo(() => Array.from(new Set(students.map(s => s.course).filter(Boolean))).sort(), [students]);
  const instruments = useMemo(() => Array.from(new Set(students.map(s => s.instrument).filter(Boolean))).sort(), [students]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const list = baseList.filter(s => {
      if (q && !s.name.toLowerCase().includes(q) && !s.email.toLowerCase().includes(q)
           && !s.studentID.toLowerCase().includes(q) && !s.admissionNo.toLowerCase().includes(q))
        return false;
      if (filterCenter !== "all" && s.centerId !== filterCenter) return false;
      if (filterCourse && s.course !== filterCourse) return false;
      if (filterInstrument && s.instrument !== filterInstrument) return false;
      if (filterFeeStatus === "pending" && s.balance <= 0) return false;
      if (filterFeeStatus === "paid"    && s.balance > 0)  return false;
      if (filterClassType !== "all" && s.classType !== filterClassType) return false;
      return true;
    });
    return list;
  }, [baseList, search, filterCenter, filterCourse, filterInstrument, filterFeeStatus, filterClassType]);

  function buildCenterGroups(students: StudentRow[]) {
    const map = new Map<string, { centerId: string; centerName: string; students: StudentRow[] }>();
    students.forEach(s => {
      if (!map.has(s.centerId)) map.set(s.centerId, { centerId: s.centerId, centerName: s.centerName, students: [] });
      map.get(s.centerId)!.students.push(s);
    });
    return Array.from(map.values()).sort((a, b) => a.centerName.localeCompare(b.centerName));
  }

  const groupedByCenter = useMemo(() => {
    const groupStudents    = filtered.filter(s => s.classType !== "personal");
    const personalStudents = filtered.filter(s => s.classType === "personal");
    return {
      group:    buildCenterGroups(groupStudents),
      personal: buildCenterGroups(personalStudents),
    };
  }, [filtered]);

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
        classType:          form.classType || "group",
        billingMode:        form.billingMode || "postpay",
        assignedTeacherUid: form.classType === "personal" ? (form.assignedTeacherUid || null) : null,
        classDays:          form.classType === "personal" ? form.classDays : [],
        classTime:          form.classType === "personal" ? (form.classTime || null) : null,
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
        breakRequestedBy:    null,
        breakRequestedAt:    null,
        breakStartDate:      null,
        breakReason:         null,
        breakApprovalStatus: null,
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

  // ── Break actions ──────────────────────────────────────────────────────────
  async function approveBreak(student: StudentRow, breakStartDate?: string) {
    if (!user) return;
    // Default break start = today (IST-safe)
    const d = new Date();
    const startDate = breakStartDate || `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:              "on_break",
        studentStatus:       "on_break",
        breakApprovalStatus: "approved",
        breakStartDate:      startDate,
        updatedAt:           serverTimestamp(),
      });
      logAction({ action: "BREAK_APPROVED", initiatorId: user.uid, initiatorRole: role ?? "admin",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id, breakStartDate: startDate } });
      setStudents(prev => prev.map(s => s.id !== student.id ? s : { ...s, status: "on_break", breakStartDate: startDate }));
      toast(`Student is now on break from ${startDate}.`, "success");
    } catch { toast("Failed to approve break.", "error"); }
  }

  async function rejectBreak(student: StudentRow) {
    if (!user) return;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:              "active",
        studentStatus:       "active",
        breakApprovalStatus: "rejected",
        breakRequestedBy:    null,
        breakRequestedAt:    null,
        breakStartDate:      null,
        breakReason:         null,
        updatedAt:           serverTimestamp(),
      });
      logAction({ action: "BREAK_REJECTED", initiatorId: user.uid, initiatorRole: role ?? "admin",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id } });
      setStudents(prev => prev.map(s => s.id !== student.id ? s : {
        ...s, status: "active", breakRequestedBy: null, breakRequestedAt: null, breakStartDate: null, breakReason: null,
      }));
      toast("Break request rejected. Student is active.", "success");
    } catch { toast("Failed to reject break.", "error"); }
  }

  async function endBreak(student: StudentRow) {
    if (!user) return;
    try {
      await updateDoc(doc(db, "users", student.id), {
        status:              "active",
        studentStatus:       "active",
        breakApprovalStatus: null,
        breakRequestedBy:    null,
        breakRequestedAt:    null,
        breakStartDate:      null,
        breakReason:         null,
        updatedAt:           serverTimestamp(),
      });
      logAction({ action: "BREAK_ENDED", initiatorId: user.uid, initiatorRole: role ?? "admin",
        approverId: null, approverRole: null, reason: null, metadata: { studentId: student.id } });
      setStudents(prev => prev.map(s => s.id !== student.id ? s : {
        ...s, status: "active", breakRequestedBy: null, breakRequestedAt: null, breakStartDate: null, breakReason: null,
      }));
      toast("Break ended. Student is active.", "success");
    } catch { toast("Failed to end break.", "error"); }
  }

  return (
    <div style={p.page}>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* ── Header ── */}
      <div style={p.header}>
        <div>
          <h1 style={p.heading}>Students</h1>
          <div style={p.subheading}>
            {students.length} total · {activeStudents.length} active ·{" "}
            {students.filter(s => s.classType === "group").length} group ·{" "}
            {students.filter(s => s.classType === "personal").length} personal
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {requestStudents.length > 0 && (
            <div style={p.deactivationBadge} onClick={() => setTab("requests")}>
              ⚠ Deactivation Requests ({requestStudents.length})
            </div>
          )}
          {breakRequestStudents.length > 0 && (
            <div style={{ ...p.deactivationBadge, background: "#e0f2fe", color: "#0369a1", borderColor: "#7dd3fc" }}
              onClick={() => setTab("break_requests")}>
              ☕ Break Requests ({breakRequestStudents.length})
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
              <Field label="Class Type *">
                <select value={form.classType} onChange={e => setForm(f => ({ ...f, classType: e.target.value, assignedTeacherUid: "", classDays: [], classTime: "" }))} style={p.input}>
                  <option value="group">Group Class (batch at center)</option>
                  <option value="personal">Personal Class (one-on-one / private)</option>
                </select>
              </Field>
              <Field label="Billing Mode *">
                <select value={form.billingMode} onChange={e => setForm(f => ({ ...f, billingMode: e.target.value }))} style={p.input}>
                  <option value="postpay">Postpay — billed first, pays after</option>
                  <option value="prepay">Prepay — payments advance, fee deducted</option>
                </select>
              </Field>
              {form.classType === "personal" && (
                <Field label="Assign Teacher">
                  <select value={form.assignedTeacherUid} onChange={e => setForm(f => ({ ...f, assignedTeacherUid: e.target.value }))} style={p.input}>
                    <option value="">— Unassigned —</option>
                    {teacherOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              )}
              {form.classType === "personal" && (
                <Field label="Class Days">
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8, paddingTop: 4 }}>
                    {DAYS_OF_WEEK.map(day => (
                      <label key={day} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
                        <input type="checkbox" checked={form.classDays.includes(day)}
                          onChange={e => setForm(f => ({
                            ...f,
                            classDays: e.target.checked
                              ? [...f.classDays, day]
                              : f.classDays.filter(d => d !== day),
                          }))} />
                        {day}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              {form.classType === "personal" && (
                <Field label="Class Time">
                  <input type="time" value={form.classTime}
                    onChange={e => setForm(f => ({ ...f, classTime: e.target.value }))}
                    style={p.input} />
                </Field>
              )}
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
        <select value={filterClassType} onChange={e => setFilterClassType(e.target.value)} style={p.filterSelect}>
          <option value="all">All Class Types</option>
          <option value="group">👥 Group</option>
          <option value="personal">👤 Personal</option>
        </select>
        {(search || filterCenter !== "all" || filterCourse || filterInstrument || filterFeeStatus !== "all" || filterClassType !== "all") && (
          <button onClick={resetFilters} style={p.resetBtn}>✕ Reset</button>
        )}
      </div>

      {/* ── Tabs ── */}
      <div style={p.tabs}>
        {(["active", "requests", "break_requests", "on_break", "inactive"] as StudentTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...p.tab, ...(tab === t ? p.tabActive : {}) }}>
            {t === "active" ? `Active (${activeStudents.length})`
              : t === "requests" ? (
                <span>
                  Deactivation
                  {requestStudents.length > 0 && (
                    <span style={p.tabBadge}>{requestStudents.length}</span>
                  )}
                </span>
              )
              : t === "break_requests" ? (
                <span>
                  Break Requests
                  {breakRequestStudents.length > 0 && (
                    <span style={{ ...p.tabBadge, background: "#0369a1" }}>{breakRequestStudents.length}</span>
                  )}
                </span>
              )
              : t === "on_break" ? `On Break (${onBreakStudents.length})`
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
      ) : tab === "break_requests" ? (
        <BreakRequestsPanel
          requests={filtered}
          centerMap={centerMap}
          onApprove={(s, startDate) => approveBreak(s, startDate)}
          onReject={rejectBreak}
        />
      ) : tab === "on_break" ? (
        <OnBreakPanel
          students={filtered}
          centerMap={centerMap}
          onEndBreak={endBreak}
          isAdmin={isAdmin}
        />
      ) : (
        <div>
          {/* ── Group classes ── */}
          {groupedByCenter.group.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#6d28d9", letterSpacing: 0.5, textTransform: "uppercase" as const, marginBottom: 14, paddingBottom: 6, borderBottom: "2px solid #ede9fe" }}>
                👥 Group Classes
              </div>
              {groupedByCenter.group.map(group => (
                <div key={group.centerId} style={{ marginBottom: 28 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #e5e7eb" }}>
                    <span style={{ fontSize: 16 }}>🏫</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{group.centerName}</span>
                    <span style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>
                      {group.students.length}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                    {group.students.map(s => (
                      <StudentCard key={s.id} student={s} onClick={() => router.push(`/dashboard/students/${s.id}`)} />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* ── Individual classes ── */}
          {groupedByCenter.personal.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e", letterSpacing: 0.5, textTransform: "uppercase" as const, marginBottom: 14, marginTop: groupedByCenter.group.length > 0 ? 24 : 0, paddingBottom: 6, borderBottom: "2px solid #fef3c7" }}>
                👤 Individual Classes
              </div>
              {groupedByCenter.personal.map(group => (
                <div key={group.centerId} style={{ marginBottom: 28 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #e5e7eb" }}>
                    <span style={{ fontSize: 16 }}>🏫</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{group.centerName}</span>
                    <span style={{ background: "#fef3c7", color: "#92400e", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>
                      {group.students.length}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                    {group.students.map(s => (
                      <StudentCard key={s.id} student={s} onClick={() => router.push(`/dashboard/students/${s.id}`)} />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── Edit Modal ── */}
      {editTarget && (
        <EditModal
          student={editTarget}
          centerOptions={centerOptions}
          teacherOptions={teacherOptions}
          transactions={transactions.filter(t => t.studentUid === editTarget.id)}
          isAdmin={isAdmin}
          onTransactionsChanged={() => fetchData()}
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

      {/* ── Clear History Modal ── */}
      {clearHistoryTarget && (
        <ClearHistoryModal
          student={clearHistoryTarget}
          onClose={() => setClearHistoryTarget(null)}
          onCleared={() => {
            setClearHistoryTarget(null);
            toast("History cleared successfully.", "success");
          }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}

      {/* ── Delete Student Modal ── */}
      {deleteTarget && (
        <DeleteStudentModal
          student={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setStudents(prev => prev.filter(s => s.id !== deleteTarget.id));
            setDeleteTarget(null);
            toast(`Student "${deleteTarget.name}" deleted.`, "success");
          }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "admin"}
        />
      )}

      {/* ── Break Request Modal ── */}
      {breakTarget && (
        <BreakRequestModal
          student={breakTarget}
          onClose={() => setBreakTarget(null)}
          onRequested={(reason) => {
            if (!user) return;
            setStudents(prev => prev.map(s => s.id !== breakTarget.id ? s : {
              ...s,
              status: "break_requested",
              breakRequestedBy: user.uid,
              breakRequestedAt: new Date().toISOString(),
              breakReason: reason,
            }));
            setBreakTarget(null);
            toast("Break request submitted for admin approval.", "success");
          }}
          onApprovedDirectly={(reason, startDate) => {
            if (!user) return;
            setStudents(prev => prev.map(s => s.id !== breakTarget.id ? s : {
              ...s,
              status: "on_break",
              breakRequestedBy: user.uid,
              breakRequestedAt: new Date().toISOString(),
              breakStartDate: startDate,
              breakReason: reason,
            }));
            setBreakTarget(null);
            toast(`${breakTarget.name} is on break from ${startDate}.`, "success");
          }}
          currentUserUid={user?.uid ?? ""}
          currentUserRole={role ?? "teacher"}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}

// ─── Student Row ───────────────────────────────────────────────────────────────

function StudentRow({ student: s, index, isAdmin, isTeacher, onEdit, onRequestDeactivation, onRequestBreak, onClearHistory, onDelete }: {
  student: StudentRow; index: number; isAdmin: boolean; isTeacher: boolean;
  onEdit: () => void; onRequestDeactivation: () => void; onRequestBreak: () => void;
  onClearHistory?: () => void; onDelete?: () => void;
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
        <span style={{
          ...p.badge,
          ...(s.classType === "personal"
            ? { background: "#fef9c3", color: "#92400e" }
            : { background: "#dcfce7", color: "#166534" }),
        }}>
          {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
        </span>
        {s.classType === "personal" && (
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3, lineHeight: 1.6 }}>
            {s.assignedTeacherName
              ? `🎓 ${s.assignedTeacherName}`
              : <span style={{ color: "#d97706" }}>⚠ Unassigned</span>}
            {s.classDays.length > 0 && (
              <div>{s.classDays.join(", ")}{s.classTime ? ` · ${s.classTime}` : ""}</div>
            )}
          </div>
        )}
      </td>
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
        <div style={{ marginTop: 3 }}>
          <span style={{
            ...p.badge,
            fontSize: 10,
            ...(s.billingMode === "prepay"
              ? { background: "#fef3c7", color: "#92400e" }
              : { background: "#f3f4f6", color: "#374151" }),
          }}>
            {s.billingMode === "prepay" ? "⬆ Prepay" : "⬇ Postpay"}
          </span>
        </div>
      </td>
      <td style={{ ...p.td, fontWeight: 700, color: s.balance > 0 ? "#d97706" : "#16a34a" }}>
        {fmtINR(s.balance)}
      </td>
      <td style={p.td}>
        <span style={{ ...p.badge, ...(STATUS_BADGE[s.status] ?? { background: "#f3f4f6", color: "#6b7280" }) }}>
          {s.status.replace(/_/g, " ")}
        </span>
      </td>
      <td style={{ ...p.td, minWidth: 240 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
          {(isAdmin || isTeacher) && (
            <button onClick={onEdit} style={p.editBtn}>✏ Edit</button>
          )}
          {(isAdmin || isTeacher) && s.status === "active" && (
            <button onClick={onRequestDeactivation} style={p.deactBtn}>Deactivate</button>
          )}
          {(isAdmin || isTeacher) && s.status === "active" && (
            <button onClick={onRequestBreak}
              style={{ ...p.editBtn, background: "#e0f2fe", color: "#0369a1", borderColor: "#7dd3fc" }}>
              ☕ Break
            </button>
          )}
          <Link href={`/dashboard/student-syllabus/${s.id}`} style={p.syllabusBtn}>
            Syllabus
          </Link>
          {onClearHistory && (
            <button onClick={onClearHistory} style={p.clearBtn} title="Clear student history">
              🗑 History
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} style={p.deleteBtn} title="Delete student permanently">
              ✕ Delete
            </button>
          )}
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

// ─── Break Requests Panel ─────────────────────────────────────────────────────

function BreakRequestsPanel({ requests, centerMap, onApprove, onReject }: {
  requests: StudentRow[]; centerMap: Map<string, string>;
  onApprove: (s: StudentRow, startDate: string) => void; onReject: (s: StudentRow) => void;
}) {
  // Per-row break start date — defaults to today
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  const [startDates, setStartDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(requests.map(r => [r.id, todayStr()]))
  );

  if (requests.length === 0) {
    return (
      <div style={p.card}>
        <EmptyState icon="☕" title="No pending break requests" hint="All students are active or already on break." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
      {requests.map(s => {
        const startDate = startDates[s.id] ?? todayStr();
        return (
          <div key={s.id} style={{ ...p.card, borderLeft: "4px solid #0369a1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 16 }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{s.name}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                  <span style={p.idChip}>{s.studentID}</span>
                  {" · "}
                  {centerMap.get(s.centerId) ?? s.centerId}
                  {" · "}
                  {s.course}
                </div>
                {s.breakReason && (
                  <div style={{ fontSize: 12, color: "#0369a1", marginTop: 6, background: "#f0f9ff", padding: "5px 10px", borderRadius: 6 }}>
                    <strong>Reason:</strong> {s.breakReason}
                  </div>
                )}
                {s.breakRequestedAt && (
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                    Requested: {s.breakRequestedAt.slice(0, 10)}
                  </div>
                )}
                {/* Break start date picker */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>Break starts:</label>
                  <input
                    type="date"
                    value={startDate}
                    min={todayStr()}
                    onChange={e => setStartDates(prev => ({ ...prev, [s.id]: e.target.value }))}
                    style={{ fontSize: 12, border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", color: "#111827", outline: "none" }}
                  />
                  <span style={{ fontSize: 11, color: "#6b7280" }}>Attendance excluded from this date</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignSelf: "flex-end" as const }}>
                <button onClick={() => onApprove(s, startDate)}
                  style={{ background: "#0369a1", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  ✓ Approve Break
                </button>
                <button onClick={() => onReject(s)}
                  style={{ background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  ✕ Reject
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── On Break Panel ────────────────────────────────────────────────────────────

function OnBreakPanel({ students, centerMap, onEndBreak, isAdmin }: {
  students: StudentRow[]; centerMap: Map<string, string>;
  onEndBreak: (s: StudentRow) => void; isAdmin: boolean;
}) {
  if (students.length === 0) {
    return (
      <div style={p.card}>
        <EmptyState icon="☕" title="No students on break" hint="No students are currently on break." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
      {students.map(s => (
        <div key={s.id} style={{ ...p.card, borderLeft: "4px solid #7dd3fc" }}>
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
              {s.breakReason && (
                <div style={{ fontSize: 12, color: "#0369a1", marginTop: 6, background: "#f0f9ff", padding: "5px 10px", borderRadius: 6 }}>
                  <strong>Break reason:</strong> {s.breakReason}
                </div>
              )}
              {s.breakStartDate && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, background: "#fef3c7", padding: "4px 10px", borderRadius: 6 }}>
                  <span style={{ fontSize: 13 }}>📅</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#92400e" }}>
                    On break from: {s.breakStartDate}
                  </span>
                  <span style={{ fontSize: 11, color: "#b45309" }}>— attendance excluded from this date</span>
                </div>
              )}
            </div>
            {isAdmin && (
              <button onClick={() => onEndBreak(s)}
                style={{ background: "#16a34a", color: "#fff", border: "none", padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                ▶ End Break (Reactivate)
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Break Request Modal ───────────────────────────────────────────────────────

export function BreakRequestModal({ student, onClose, onRequested, onApprovedDirectly, currentUserUid, currentUserRole, isAdmin }: {
  student: StudentRow;
  onClose: () => void;
  onRequested: (reason: string) => void;
  onApprovedDirectly: (reason: string, startDate: string) => void;
  currentUserUid: string;
  currentUserRole: string;
  isAdmin: boolean;
}) {
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  const [reason, setReason]       = useState("");
  const [startDate, setStartDate] = useState(todayStr);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) { setError("Please provide a reason for the break."); return; }
    if (isAdmin && !startDate) { setError("Please select a break start date."); return; }
    setError("");
    setSaving(true);
    try {
      const { updateDoc, doc, serverTimestamp: sts } = await import("firebase/firestore");
      const { db: fdb } = await import("@/config/firebase");
      const { logAction: la } = await import("@/services/audit/audit.service");

      if (isAdmin) {
        // Admin: approve directly, no request step
        await updateDoc(doc(fdb, "users", student.id), {
          status:              "on_break",
          studentStatus:       "on_break",
          breakApprovalStatus: "approved",
          breakRequestedBy:    currentUserUid,
          breakRequestedAt:    new Date().toISOString(),
          breakStartDate:      startDate,
          breakReason:         reason.trim(),
          updatedAt:           sts(),
        });
        la({
          action: "BREAK_APPROVED", initiatorId: currentUserUid, initiatorRole: currentUserRole as import("@/types").Role,
          approverId: null, approverRole: null, reason: reason.trim(),
          metadata: { studentId: student.id, studentName: student.name, breakStartDate: startDate },
        });
        onApprovedDirectly(reason.trim(), startDate);
      } else {
        // Teacher: submit for admin approval
        await updateDoc(doc(fdb, "users", student.id), {
          status:              "break_requested",
          studentStatus:       "break_requested",
          breakApprovalStatus: "pending",
          breakRequestedBy:    currentUserUid,
          breakRequestedAt:    new Date().toISOString(),
          breakReason:         reason.trim(),
          updatedAt:           sts(),
        });
        la({
          action: "BREAK_REQUESTED", initiatorId: currentUserUid, initiatorRole: currentUserRole as import("@/types").Role,
          approverId: null, approverRole: null, reason: reason.trim(),
          metadata: { studentId: student.id, studentName: student.name },
        });
        onRequested(reason.trim());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit break.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{ background: "#fff", borderRadius: 14, padding: 28, width: "100%", maxWidth: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
        <div style={{ fontWeight: 700, fontSize: 17, color: "#111827", marginBottom: 4 }}>☕ {isAdmin ? "Put on Break" : "Request Break"}</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 18 }}>
          {isAdmin
            ? <>Directly putting <strong>{student.name}</strong> on break. Choose start date — attendance will be excluded from that date.</>
            : <>Submitting break request for <strong>{student.name}</strong>. An admin will confirm.</>
          }
        </div>
        <form onSubmit={handleSubmit}>
          {isAdmin && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
                📅 Break starts on *
              </label>
              <input
                type="date"
                value={startDate}
                min={todayStr()}
                onChange={e => setStartDate(e.target.value)}
                required
                style={{ border: "1px solid #d1d5db", borderRadius: 7, padding: "8px 12px", fontSize: 14, outline: "none", color: "#111827" }}
              />
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                Attendance will not be counted for this student from this date onwards.
              </div>
            </div>
          )}
          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
            Reason *
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Medical leave, out of town, personal reasons…"
            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "9px 12px", fontSize: 14, resize: "vertical", outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
          />
          {error && <div style={{ fontSize: 13, color: "#dc2626", marginTop: 8 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
            <button type="button" onClick={onClose}
              style={{ padding: "8px 18px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 14, cursor: "pointer", color: "#374151" }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: saving ? "#93c5fd" : "#0369a1", color: "#fff", fontSize: 14, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : isAdmin ? "Put on Break" : "Submit Request"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Edit Modal ────────────────────────────────────────────────────────────────

export function EditModal({ student, centerOptions, teacherOptions, transactions, isAdmin, onTransactionsChanged, onClose, onSaved, currentUserUid, currentUserRole }: {
  student:         StudentRow;
  centerOptions:   { id: string; name: string }[];
  teacherOptions:  { id: string; name: string }[];
  transactions:    Transaction[];
  isAdmin:         boolean;
  onTransactionsChanged: () => void;
  onClose:         () => void;
  onSaved:         (updated: Partial<StudentRow> & { id: string }) => void;
  currentUserUid:  string;
  currentUserRole: string;
}) {
  const [form, setForm]     = useState<EditForm>({
    name:               student.name,
    email:              student.email,
    admissionNo:        student.admissionNo,
    phone:              student.phone,
    centerId:           student.centerId,
    instrument:         student.instrument,
    course:             student.course,
    classType:          student.classType || "group",
    billingMode:        student.billingMode || "postpay",
    assignedTeacherUid: student.assignedTeacherUid ?? "",
    classDays:          student.classDays ?? [],
    classTime:          student.classTime ?? "",
    feeCycle:           student.feeCycle,
    feePerClass:        String(student.feePerClass),
    status:             student.status,
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
        name:               form.name.trim(),
        displayName:        form.name.trim(),
        email:              form.email.trim().toLowerCase(),
        admissionNo:        form.admissionNo.trim(),
        phone:              form.phone.trim(),
        centerId:           form.centerId,
        instrument:         form.instrument.trim(),
        course:             form.course.trim(),
        classType:          form.classType || "group",
        billingMode:        form.billingMode || "postpay",
        assignedTeacherUid: form.classType === "personal" ? (form.assignedTeacherUid || null) : null,
        classDays:          form.classType === "personal" ? form.classDays : [],
        classTime:          form.classType === "personal" ? (form.classTime || null) : null,
        feeCycle:           form.feeCycle,
        feePerClass:        form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        status:             form.status,
        studentStatus:      form.status,   // mirror for type-system compatibility
        updatedAt:          serverTimestamp(),
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
        id:                  student.id,
        name:                form.name.trim(),
        email:               form.email.trim().toLowerCase(),
        admissionNo:         form.admissionNo.trim(),
        phone:               form.phone.trim(),
        centerId:            form.centerId,
        instrument:          form.instrument.trim(),
        course:              form.course.trim(),
        classType:           form.classType || "group",
        billingMode:         form.billingMode || "postpay",
        assignedTeacherUid:  form.classType === "personal" ? (form.assignedTeacherUid || null) : null,
        classDays:           form.classType === "personal" ? form.classDays : [],
        classTime:           form.classType === "personal" ? (form.classTime || null) : null,
        feeCycle:            form.feeCycle,
        feePerClass:         form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        status:              form.status,
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
              <Field label="Class Type *">
                <select name="classType" value={form.classType}
                  onChange={e => setForm(prev => ({ ...prev, classType: e.target.value, assignedTeacherUid: "", classDays: [], classTime: "" }))}
                  style={p.input}>
                  <option value="group">Group Class (batch at center)</option>
                  <option value="personal">Personal Class (one-on-one / private)</option>
                </select>
              </Field>
              <Field label="Billing Mode *">
                <select name="billingMode" value={form.billingMode} onChange={f} style={p.input}>
                  <option value="postpay">Postpay — billed first, pays after</option>
                  <option value="prepay">Prepay — payments advance, fee deducted</option>
                </select>
              </Field>
              {form.classType === "personal" && (
                <Field label="Assign Teacher">
                  <select name="assignedTeacherUid" value={form.assignedTeacherUid} onChange={f} style={p.input}>
                    <option value="">— Unassigned —</option>
                    {teacherOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              )}
              {form.classType === "personal" && (
                <Field label="Class Days">
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8, paddingTop: 4 }}>
                    {DAYS_OF_WEEK.map(day => (
                      <label key={day} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
                        <input type="checkbox" checked={form.classDays.includes(day)}
                          onChange={e => setForm(prev => ({
                            ...prev,
                            classDays: e.target.checked
                              ? [...prev.classDays, day]
                              : prev.classDays.filter(d => d !== day),
                          }))} />
                        {day}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              {form.classType === "personal" && (
                <Field label="Class Time">
                  <input type="time" name="classTime" value={form.classTime} onChange={f} style={p.input} />
                </Field>
              )}
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

            {/* ── Financial Statement / Ledger Edit (admin only) ── */}
            {isAdmin && (
              <>
                <div style={modal.sectionLabel}>Financial Statement / Ledger Edit</div>
                <div style={{ marginBottom: 4 }}>
                  <LedgerEditor
                    transactions={transactions}
                    currentUserUid={currentUserUid}
                    currentUserRole={currentUserRole}
                    onChanged={onTransactionsChanged}
                    editMode
                  />
                </div>
              </>
            )}
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

// ─── Clear History Modal ───────────────────────────────────────────────────────

export function ClearHistoryModal({ student, onClose, onCleared, currentUserUid, currentUserRole }: {
  student:         StudentRow;
  onClose:         () => void;
  onCleared:       () => void;
  currentUserUid:  string;
  currentUserRole: string;
}) {
  const [opts, setOpts] = useState<ClearHistoryOptions>({ syllabus: false, payments: false, attendance: false });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ cleared: string[]; errors: string[] } | null>(null);
  const [confirmed, setConfirmed] = useState("");

  const noneSelected = !opts.syllabus && !opts.payments && !opts.attendance;
  const confirmPhrase = "CLEAR";
  const canProceed = !noneSelected && confirmed === confirmPhrase;

  async function handleClear() {
    if (!canProceed) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await clearStudentHistory(student.id, opts, currentUserUid, currentUserRole as never);
      setResult(res);
      if (res.errors.length === 0) {
        setTimeout(onCleared, 1200);
      }
    } catch (err) {
      setResult({ cleared: [], errors: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modal.overlay} onClick={onClose}>
      <div style={{ ...modal.box, maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div>
            <div style={{ ...modal.title, color: "#c2410c" }}>🗑 Clear Student History</div>
            <div style={modal.subtitle}><span style={p.idChip}>{student.studentID}</span> · {student.name}</div>
          </div>
          <button onClick={onClose} style={modal.closeBtn}>✕</button>
        </div>
        <div style={modal.body}>
          <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#c2410c" }}>
            ⚠ This action is <strong>irreversible</strong>. Selected history will be permanently deleted.
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
            Select what to clear:
          </div>

          {([
            { key: "syllabus",   label: "Syllabus Progress", desc: "Clears imported syllabus, lesson progress records, and custom lessons" },
            { key: "payments",   label: "Payment / Transaction History", desc: "Deletes all transactions, fee records, and resets balance to ₹0" },
            { key: "attendance", label: "Attendance Records", desc: "Removes all attendance entries for this student" },
          ] as { key: keyof ClearHistoryOptions; label: string; desc: string }[]).map(({ key, label, desc }) => (
            <label key={key} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 12px", background: opts[key] ? "#fef2f2" : "#f9fafb", border: `1px solid ${opts[key] ? "#fca5a5" : "#e5e7eb"}`, borderRadius: 8, marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={opts[key]} onChange={e => setOpts(o => ({ ...o, [key]: e.target.checked }))}
                style={{ marginTop: 2, accentColor: "#dc2626" }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{label}</div>
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{desc}</div>
              </div>
            </label>
          ))}

          {!noneSelected && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, color: "#374151", marginBottom: 6 }}>
                Type <strong style={{ color: "#dc2626" }}>{confirmPhrase}</strong> to confirm:
              </div>
              <input
                value={confirmed}
                onChange={e => setConfirmed(e.target.value)}
                placeholder={`Type ${confirmPhrase}`}
                style={{ ...p.input, borderColor: confirmed === confirmPhrase ? "#86efac" : "#d1d5db" }}
              />
            </div>
          )}

          {result && (
            <div style={{ marginTop: 14 }}>
              {result.cleared.map((c, i) => (
                <div key={i} style={{ fontSize: 12, color: "#16a34a", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 6, padding: "6px 10px", marginBottom: 5 }}>✓ {c}</div>
              ))}
              {result.errors.map((e, i) => (
                <div key={i} style={{ fontSize: 12, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 10px", marginBottom: 5 }}>✕ {e}</div>
              ))}
            </div>
          )}
        </div>
        <div style={modal.footer}>
          <button onClick={onClose} style={modal.cancelBtn}>Cancel</button>
          <button
            onClick={handleClear}
            disabled={!canProceed || busy}
            style={{ background: canProceed && !busy ? "#dc2626" : "#f3f4f6", color: canProceed && !busy ? "#fff" : "#9ca3af", border: "none", padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: canProceed && !busy ? "pointer" : "not-allowed" }}
          >
            {busy ? "Clearing…" : "Clear Selected History"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Student Modal ──────────────────────────────────────────────────────

export function DeleteStudentModal({ student, onClose, onDeleted, currentUserUid, currentUserRole }: {
  student:         StudentRow;
  onClose:         () => void;
  onDeleted:       () => void;
  currentUserUid:  string;
  currentUserRole: string;
}) {
  const [confirmed, setConfirmed] = useState("");
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState("");

  const confirmPhrase = student.name.split(" ")[0] ?? "DELETE";
  const canDelete = confirmed === confirmPhrase;

  async function handleDelete() {
    if (!canDelete) return;
    setBusy(true);
    setError("");
    try {
      const res = await deleteUserRecord(student.id, "student", currentUserUid, currentUserRole as never);
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
    <div style={modal.overlay} onClick={onClose}>
      <div style={{ ...modal.box, maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div>
            <div style={{ ...modal.title, color: "#991b1b" }}>✕ Delete Student</div>
            <div style={modal.subtitle}><span style={p.idChip}>{student.studentID}</span> · {student.name}</div>
          </div>
          <button onClick={onClose} style={modal.closeBtn}>✕</button>
        </div>
        <div style={modal.body}>
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 14px", marginBottom: 16, fontSize: 13, color: "#991b1b" }}>
            <strong>This will permanently delete this student.</strong> All syllabus progress, payment history, and attendance records will also be cleared. The login account will be disabled.
          </div>
          <div style={{ fontSize: 12, color: "#374151", marginBottom: 6 }}>
            Type the student&apos;s first name <strong style={{ color: "#dc2626" }}>{confirmPhrase}</strong> to confirm:
          </div>
          <input
            value={confirmed}
            onChange={e => { setConfirmed(e.target.value); setError(""); }}
            placeholder={`Type "${confirmPhrase}"`}
            style={{ ...p.input, borderColor: canDelete ? "#86efac" : "#d1d5db" }}
          />
          {error && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "7px 10px" }}>
              ✕ {error}
            </div>
          )}
        </div>
        <div style={modal.footer}>
          <button onClick={onClose} style={modal.cancelBtn}>Cancel</button>
          <button
            onClick={handleDelete}
            disabled={!canDelete || busy}
            style={{ background: canDelete && !busy ? "#dc2626" : "#f3f4f6", color: canDelete && !busy ? "#fff" : "#9ca3af", border: "none", padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: canDelete && !busy ? "pointer" : "not-allowed" }}
          >
            {busy ? "Deleting…" : "Delete Student"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Student Card (grid tile) ─────────────────────────────────────────────────

function StudentCard({ student: s, onClick }: { student: StudentRow; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const initials = s.name.split(" ").map(n => n[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
  const statusStyle = STATUS_BADGE[s.status] ?? { background: "#f3f4f6", color: "#6b7280" };
  const isDue = s.balance > 0;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "#fff",
        border: `1px solid ${hover ? "#a5b4fc" : "#e5e7eb"}`,
        borderRadius: 12, padding: "14px 16px", cursor: "pointer",
        boxShadow: hover ? "0 4px 16px rgba(79,70,229,0.12)" : "0 1px 3px rgba(0,0,0,0.05)",
        transition: "box-shadow 0.15s, border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
          background: "linear-gradient(135deg, #6d28d9, #4f46e5)",
          color: "#fff", fontSize: 13, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {initials}
        </div>
        <div style={{ overflow: "hidden" }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#111827", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
          <span style={p.idChip}>{s.studentID}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "#374151", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600 }}>{s.instrument}</span>
        {s.course ? <span style={{ color: "#6b7280" }}> · {s.course}</span> : null}
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const, marginBottom: isDue ? 8 : 0 }}>
        <span style={{ ...p.badge, ...(s.classType === "personal" ? { background: "#fef9c3", color: "#92400e" } : { background: "#dcfce7", color: "#166534" }) }}>
          {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
        </span>
        <span style={{ ...p.badge, ...statusStyle }}>{s.status.replace(/_/g, " ")}</span>
      </div>
      {isDue && (
        <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "3px 8px", borderRadius: 4 }}>
          Due {fmtINR(s.balance)}
        </div>
      )}
    </div>
  );
}

// ─── Attendance history status styling (also used by the student detail page) ──

export const HISTORY_STATUS_STYLE: Record<string, React.CSSProperties> = {
  present:           { background: "#dcfce7", color: "#16a34a" },
  absent:            { background: "#fee2e2", color: "#dc2626" },
  break:             { background: "#e0f2fe", color: "#0369a1" },
  cancelled_teacher: { background: "#fef3c7", color: "#92400e" },
  // Stored value is "cancelled_student" for compatibility with existing records,
  // but it now means the student had no class scheduled that day.
  cancelled_student: { background: "#f3f4f6", color: "#6b7280" },
};

export const HISTORY_STATUS_LABEL: Record<string, string> = {
  cancelled_student: "Not Assigned",
};

// ─── Student Detail Modal ──────────────────────────────────────────────────────

export function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13, paddingBottom: 8, borderBottom: "1px solid #f3f4f6" }}>
      <span style={{ minWidth: 130, fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.04em", paddingTop: 2 }}>{label}</span>
      <span style={{ color: "#111827", flex: 1 }}>{value}</span>
    </div>
  );
}

// ─── Ledger Editor (shared) ─────────────────────────────────────────────────────
// Renders a student's transaction line items (Fee Dues, Payments, Auto Charges,
// Deposits) newest-first. Used both by the Student Detail Modal's collapsible
// "Financial Statement" (editMode toggled by a button) and by the Edit Student
// Modal's always-editable "Financial Statement / Ledger Edit" section.
// Edit/delete call the same finance.service functions the Finance page uses —
// both already reconcile `users.currentBalance` server-side by the exact delta,
// so `onChanged` just needs to refetch transactions to pick up the new balance.

export function LedgerEditor({
  transactions, currentUserUid, currentUserRole, onChanged, editMode, onPayDue,
}: {
  transactions:    Transaction[];
  currentUserUid:  string;
  currentUserRole: string;
  onChanged:       () => void;
  editMode:        boolean;
  onPayDue?:       (tx: Transaction) => void;
}) {
  const [editingTxId,  setEditingTxId]  = useState<string | null>(null);
  const [txAmount,     setTxAmount]     = useState("");
  const [txMethod,     setTxMethod]     = useState<PaymentMethod>("Cash");
  const [txDate,       setTxDate]       = useState("");
  const [txStatus,     setTxStatus]     = useState<TransactionStatus>("completed");
  const [txNote,       setTxNote]       = useState("");
  const [txSaving,     setTxSaving]     = useState(false);
  const [txError,      setTxError]      = useState("");
  const [txDeletePending, setTxDeletePending] = useState<string | null>(null);
  const [txDeleteSubmitting, setTxDeleteSubmitting] = useState(false);
  const txDeleteResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chronological (newest first) statement: fee dues, payments, deposits, auto-charges.
  const statement = useMemo(() => {
    return [...transactions].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }, [transactions]);

  function startTxEdit(tx: Transaction) {
    setEditingTxId(tx.id);
    setTxAmount(String(tx.amount ?? ""));
    setTxMethod(tx.method);
    setTxDate((tx.date ?? "").slice(0, 10));
    setTxStatus(tx.status);
    setTxNote(tx.note ?? "");
    setTxError("");
    setTxDeletePending(null);
  }
  function cancelTxEdit() {
    setEditingTxId(null);
    setTxError("");
  }
  async function saveTxEdit(tx: Transaction) {
    const amt = Number(txAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setTxError("Enter a valid amount."); return; }
    if (!txDate) { setTxError("Date is required."); return; }
    setTxError("");
    setTxSaving(true);
    try {
      await editTransaction(
        tx.id,
        { amount: amt, method: txMethod, date: txDate, status: txStatus, note: txNote.trim() || null },
        currentUserUid,
        currentUserRole as "admin" | "super_admin",
      );
      setEditingTxId(null);
      onChanged(); // refetches transactions + recomputes the student's balance
    } catch (err) {
      setTxError(err instanceof Error ? err.message : "Failed to save changes.");
    } finally {
      setTxSaving(false);
    }
  }
  function clickTxDelete(txId: string) {
    if (txDeletePending !== txId) {
      setTxDeletePending(txId);
      if (txDeleteResetTimer.current) clearTimeout(txDeleteResetTimer.current);
      txDeleteResetTimer.current = setTimeout(() => setTxDeletePending(null), 4000);
      return;
    }
    if (txDeleteResetTimer.current) clearTimeout(txDeleteResetTimer.current);
    setTxDeletePending(null);
    setTxDeleteSubmitting(true);
    deleteTransaction(txId, currentUserUid, currentUserRole as "admin" | "super_admin")
      .then(() => {
        setEditingTxId(null);
        onChanged(); // refetches transactions + recomputes the student's balance
      })
      .catch(err => setTxError(err instanceof Error ? err.message : "Failed to delete."))
      .finally(() => setTxDeleteSubmitting(false));
  }

  if (statement.length === 0) {
    return <div style={{ fontSize: 12, color: "#9ca3af", padding: "10px 0" }}>No transactions yet.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
      {statement.map(tx => {
        const raw      = tx as unknown as Record<string, unknown>;
        const isFeeDue = raw.type === "fee_due";
        const isDeposit = raw.type === "deposit";
        const isAuto   = tx.method === "auto" || tx.method === "auto-monthly";
        const isPending = isFeeDue && tx.status === "due";
        const isCharge  = isFeeDue || isAuto;
        const isEditingRow = editingTxId === tx.id;
        const isPendingDelete = txDeletePending === tx.id;

        const label = isFeeDue
          ? `Fee Due — ${fmtMonth(tx.billingMonth ?? (tx.date ?? "").slice(0, 7))}`
          : isDeposit
          ? "Advance Deposit"
          : isAuto
          ? "Auto Charge"
          : `Payment — ${tx.method ?? "—"}`;

        // Two clear categories: charges/dues owed (red, +amount) vs
        // payments received from the student (green, -amount).
        const badge = isPending
          ? { label: "Due", background: "#fee2e2", color: "#dc2626" }
          : isCharge
          ? { label: "Charged", background: "#fef3c7", color: "#92400e" }
          : { label: "Received", background: "#dcfce7", color: "#16a34a" };

        const clickable = isPending && !editMode && !!onPayDue;

        return (
          <div key={tx.id}>
            <div
              onClick={clickable ? () => onPayDue!(tx) : undefined}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 10, padding: "9px 12px", borderRadius: 8,
                border: `1px solid ${isEditingRow ? "#93c5fd" : isPending ? "#fecaca" : "#f3f4f6"}`,
                background: isEditingRow ? "#eff6ff" : isPending ? "#fff7f7" : "#fafafa",
                cursor: clickable ? "pointer" : "default",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827" }}>{label}</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>
                  {fmtDate(tx.date)}{tx.note ? ` · ${tx.note}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: isCharge ? "#dc2626" : "#16a34a" }}>
                  {isCharge ? "+" : "−"}{fmtINR(tx.amount)}
                </span>
                <span style={{ ...p.badge, background: badge.background, color: badge.color }}>{badge.label}</span>
                {clickable && <span style={{ fontSize: 12, color: "#9ca3af" }}>→</span>}
                {editMode && (
                  <>
                    <button
                      type="button"
                      onClick={() => (isEditingRow ? cancelTxEdit() : startTxEdit(tx))}
                      title={isEditingRow ? "Close editor" : "Edit this entry"}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, padding: 2, lineHeight: 1 }}
                    >
                      {isEditingRow ? "✕" : "✏️"}
                    </button>
                    <button
                      type="button"
                      onClick={() => clickTxDelete(tx.id)}
                      disabled={txDeleteSubmitting}
                      title={isPendingDelete ? "Click again to confirm permanent delete" : "Delete this entry"}
                      style={{
                        background: "none", border: "none", cursor: "pointer", fontSize: 13, padding: 2, lineHeight: 1,
                        color: isPendingDelete ? "#dc2626" : undefined,
                      }}
                    >
                      {isPendingDelete ? "⚠" : "🗑"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Inline edit panel for this single line item */}
            {isEditingRow && (
              <div style={{ marginTop: 4, padding: "10px 12px", borderRadius: 8, border: "1px solid #93c5fd", background: "#f8fafc" }}>
                {txError && <div style={{ ...modal.errorBanner, marginBottom: 10, padding: "7px 10px", fontSize: 11 }}>{txError}</div>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginBottom: 8 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.04em", display: "flex", flexDirection: "column" as const, gap: 3 }}>
                    Amount (₹)
                    <input type="number" min={1} step={1} value={txAmount} onChange={e => setTxAmount(e.target.value)} style={{ ...p.input, padding: "6px 8px", fontSize: 12 }} />
                  </label>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.04em", display: "flex", flexDirection: "column" as const, gap: 3 }}>
                    Description
                    <input type="text" value={txNote} onChange={e => setTxNote(e.target.value)} placeholder="Optional note" style={{ ...p.input, padding: "6px 8px", fontSize: 12 }} />
                  </label>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.04em", display: "flex", flexDirection: "column" as const, gap: 3 }}>
                    Date
                    <input type="date" value={txDate} max={todayStr()} onChange={e => setTxDate(e.target.value)} style={{ ...p.input, padding: "6px 8px", fontSize: 12 }} />
                  </label>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.04em", display: "flex", flexDirection: "column" as const, gap: 3 }}>
                    Type / Method
                    <select value={txMethod} onChange={e => setTxMethod(e.target.value as PaymentMethod)} style={{ ...p.input, padding: "6px 8px", fontSize: 12 }}>
                      <option value="Cash">Cash</option>
                      <option value="UPI">UPI</option>
                      <option value="Bank">Bank</option>
                      <option value="auto-monthly">auto-monthly</option>
                      <option value="auto">auto</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.04em", display: "flex", flexDirection: "column" as const, gap: 3 }}>
                    Payment Status
                    <select value={txStatus} onChange={e => setTxStatus(e.target.value as TransactionStatus)} style={{ ...p.input, padding: "6px 8px", fontSize: 12 }}>
                      <option value="completed">Received</option>
                      <option value="pending">Due</option>
                      <option value="failed">Failed</option>
                    </select>
                  </label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button type="button" onClick={cancelTxEdit} disabled={txSaving} style={{ ...p.resetBtn, fontSize: 12 }}>Cancel</button>
                  <button
                    type="button"
                    onClick={() => saveTxEdit(tx)}
                    disabled={txSaving || !txAmount || Number(txAmount) <= 0 || !txDate}
                    style={{ ...p.primaryBtn, fontSize: 12, padding: "6px 14px", opacity: txSaving ? 0.6 : 1 }}
                  >
                    {txSaving ? "Saving…" : "💾 Save"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Center Detail Modal ────────────────────────────────────────────────────────

interface CenterDetailData {
  name:        string;
  centerCode:  string;
  location:    string;
  timeSlot:    string;
  daysOfWeek:  string[];
  startTime:   string;
  endTime:     string;
  status:      string;
  teacherName: string;
}

export function CenterDetailModal({ centerId, onClose }: { centerId: string; onClose: () => void }) {
  const [data, setData]       = useState<CenterDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const snap = await getDoc(doc(db, "centers", centerId));
        if (cancelled) return;
        if (!snap.exists()) { setError("Center not found."); setLoading(false); return; }
        const c = snap.data();

        let teacherName = "—";
        const teacherUid = (c.teacherUid ?? "") as string;
        if (teacherUid) {
          const tSnap = await getDoc(doc(db, "users", teacherUid));
          if (!cancelled && tSnap.exists()) {
            teacherName = ((tSnap.data().displayName ?? tSnap.data().name ?? "—") as string);
          }
        }
        if (cancelled) return;

        setData({
          name:        (c.name ?? "—") as string,
          centerCode:  (c.centerCode ?? "—") as string,
          location:    (c.location ?? "—") as string,
          timeSlot:    (c.timeSlot ?? "") as string,
          daysOfWeek:  Array.isArray(c.daysOfWeek) ? (c.daysOfWeek as string[]) : [],
          startTime:   (c.startTime ?? "") as string,
          endTime:     (c.endTime ?? "") as string,
          status:      (c.status ?? "active") as string,
          teacherName,
        });
      } catch {
        if (!cancelled) setError("Failed to load center details.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [centerId]);

  const schedule = data
    ? data.daysOfWeek.length > 0
      ? `${data.daysOfWeek.join(", ")}${data.startTime ? ` · ${data.startTime}${data.endTime ? "–" + data.endTime : ""}` : ""}`
      : (data.timeSlot || "—")
    : "—";

  return (
    <div style={{ ...modal.overlay, zIndex: 1100 }} onClick={onClose}>
      <div style={{ ...modal.box, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={modal.title}>Center Details</div>
          <button onClick={onClose} style={modal.closeBtn}>✕</button>
        </div>
        <div style={{ ...modal.body, display: "flex", flexDirection: "column" as const, gap: 8 }}>
          {loading ? (
            <div style={{ fontSize: 13, color: "#9ca3af", padding: "24px 0", textAlign: "center" as const }}>Loading…</div>
          ) : error ? (
            <div style={{ fontSize: 13, color: "#dc2626", padding: "24px 0", textAlign: "center" as const }}>{error}</div>
          ) : data && (
            <>
              <Row label="Name"     value={data.name} />
              <Row label="Code"     value={<span style={p.admChip}>{data.centerCode}</span>} />
              <Row label="Location" value={data.location} />
              <Row label="Schedule" value={schedule} />
              <Row label="Teacher"  value={data.teacherName} />
              <Row label="Status"   value={
                <span style={{ ...p.badge, ...(data.status === "active" ? { background: "#dcfce7", color: "#166534" } : { background: "#f3f4f6", color: "#6b7280" }) }}>
                  {data.status}
                </span>
              } />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Record Payment Modal ───────────────────────────────────────────────────────

export function RecordPaymentModal({ student, feeDue, receivedBy, onClose, onRecorded }: {
  student: StudentRow; feeDue: Transaction; receivedBy: string;
  onClose: () => void; onRecorded: () => void;
}) {
  const [amount, setAmount]       = useState(String(feeDue.amount));
  const [payDate, setPayDate]     = useState(todayStr());
  const [method, setMethod]       = useState<"Cash" | "UPI" | "Bank">("Cash");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const feeMonth  = fmtMonth(feeDue.billingMonth ?? (feeDue.date ?? "").slice(0, 7));
  const genDate   = fmtDate(feeDue.date);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const net = Number(amount);
    if (!net || net <= 0) { setError("Enter a valid amount (must be > 0)"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await addDoc(collection(db, "transactions"), {
        studentUid: student.id,
        centerId:   student.centerId,
        amount:     net,
        method,
        receivedBy,
        date:       payDate || todayStr(),
        status:     "completed",
        createdAt:  serverTimestamp(),
      });
      await updateDoc(doc(db, "users", student.id), {
        currentBalance: increment(-net),
        updatedAt:      new Date().toISOString(),
      });
      await updateDoc(doc(db, "transactions", feeDue.id), {
        status: "completed",
        paidAt: payDate || todayStr(),
      });
      onRecorded();
    } catch (err) {
      console.error("Record payment failed:", err);
      setError("Payment failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ ...modal.overlay, zIndex: 1100 }} onClick={onClose}>
      <div style={{ ...modal.box, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={modal.header}>
          <div>
            <div style={modal.title}>Record Payment</div>
            <div style={modal.subtitle}>{student.name} · {student.studentID}</div>
          </div>
          <button onClick={onClose} style={modal.closeBtn}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div style={modal.body}>
            {error && <div style={modal.errorBanner}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
              <Field label="Fee Month">
                <div style={{ ...p.input, background: "#f9fafb", color: "#374151" }}>{feeMonth}</div>
              </Field>
              <Field label="Due / Generated Date">
                <div style={{ ...p.input, background: "#f9fafb", color: "#374151" }}>{genDate}</div>
              </Field>
              <Field label="Payment Date">
                <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
                  max={todayStr()} style={p.input} required />
              </Field>
              <Field label="Payment Method">
                <select value={method} onChange={e => setMethod(e.target.value as "Cash" | "UPI" | "Bank")} style={p.input}>
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="Bank">Bank</option>
                </select>
              </Field>
              <Field label="Payable Amount">
                <input type="number" min={1} step="1" value={amount}
                  onChange={e => setAmount(e.target.value)} style={p.input} required />
              </Field>
            </div>
          </div>
          <div style={modal.footer}>
            <button type="button" onClick={onClose} style={modal.cancelBtn}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ ...p.primaryBtn, opacity: submitting ? 0.6 : 1, cursor: submitting ? "not-allowed" : "pointer" }}>
              {submitting ? "Recording…" : "Record Payment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Field wrapper ─────────────────────────────────────────────────────────────

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
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

export const p: Record<string, React.CSSProperties> = {
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
  clearBtn:    { background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  deleteBtn:   { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },

  moreBtn:     { background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 8, width: 32, height: 32, fontSize: 16, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  menuPanel:   { position: "absolute" as const, bottom: "calc(100% + 6px)", left: 0, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.16)", minWidth: 180, overflow: "hidden", zIndex: 10 },
  menuItem:    { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px", fontSize: 13, fontWeight: 500, color: "#111827", background: "none", border: "none", textAlign: "left" as const, cursor: "pointer", textDecoration: "none", boxSizing: "border-box" as const },
  menuItemDanger: { color: "#dc2626" },
};

// ─── Modal styles ──────────────────────────────────────────────────────────────

export const modal: Record<string, React.CSSProperties> = {
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
