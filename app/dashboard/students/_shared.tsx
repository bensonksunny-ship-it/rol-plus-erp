"use client";

import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  collection, getDocs, setDoc, updateDoc, doc, getDoc,
  query, where, serverTimestamp, addDoc, increment,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import { updateEmail } from "firebase/auth";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { logAction } from "@/services/audit/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import { useWing } from "@/hooks/useWing";
import { inWing, isSchoolOfMusic, wingOf } from "@/lib/wing";
import { getCached, setCached } from "@/lib/dataCache";
import Link from "next/link";
import {
  clearStudentHistory,
  deleteUser as deleteUserRecord,
  type ClearHistoryOptions,
} from "@/services/admin/delete.service";
import { computeStudentBalances, editTransaction, deleteTransaction } from "@/services/finance/finance.service";
import type { Transaction, EditableTransactionInput, PaymentMethod, TransactionStatus } from "@/types/finance";
import type { CenterBatch } from "@/types";
import { batchIdToStore, batchSchedule, effectiveBatches, isDefaultBatchId } from "@/lib/batches";
import { formatTime12, formatTimeRange12, formatTimesIn12h } from "@/lib/timeFormat";
import { getTeacherDisplayName } from "@/lib/teacherName";
import { safeCompare } from "@/lib/sortKey";

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
  batchId:     string | null;
  wing:        string;   // "rol_plus" | "school_of_music"
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
  monthlyFee:  number;
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

export interface CenterOption {
  id: string;
  name: string;
  monthlyFee?: number;
  batches: CenterBatch[];
}

type StudentTab = "active" | "inactive";

/** Finer-grained status breakdown used by the Insights panel's chart — wider
 *  than the two list tabs, since "on break" / pending-request counts are
 *  still useful at a glance even though they no longer get their own tab. */
type StatusPickKey = "active" | "inactive" | "on_break" | "break_requests" | "requests";

interface EditForm {
  name:               string;
  email:              string;
  admissionNo:        string;
  phone:              string;
  centerId:           string;
  batchId:            string;
  instrument:         string;
  course:             string;
  classType:          string;   // "group" | "personal"
  billingMode:        string;   // "postpay" | "prepay"
  assignedTeacherUid: string;
  classDays:          string[];   // e.g. ["Mon","Wed"]
  classTime:          string;     // e.g. "17:00"
  feeCycle:           string;
  feePerClass:        string;
  monthlyFee:         string;
  status:             string;
}

const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
  confirm:                { background: "#dcfce7", color: "#16a34a" },
  confirmed:              { background: "#dcfce7", color: "#16a34a" },
  inactive:               { background: "#f3f4f6", color: "#6b7280" },
  cancelled:              { background: "#f3f4f6", color: "#6b7280" },
  canceled:               { background: "#f3f4f6", color: "#6b7280" },
  deactivation_requested: { background: "#fef3c7", color: "#d97706" },
  break_requested:        { background: "#e0f2fe", color: "#0369a1" },
  on_break:               { background: "#f0f9ff", color: "#0284c7" },
};

/** A student counts as "active" whether their `status` field carries the
 *  Students page's own vocabulary ("active") or the Registry's ("confirm" /
 *  "confirmed") — historical Registry imports/edits can leave either spelling
 *  on the shared field, and both mean the same thing: an enrolled student. */
export function isActiveStatus(status: string): boolean {
  return /^(active|confirm|confirmed)$/i.test((status || "").trim());
}

/** The Registry-vocabulary counterpart — "cancelled"/"canceled" is the same
 *  thing as "inactive" on the shared `status` field. */
export function isInactiveStatus(status: string): boolean {
  return /^(inactive|cancelled|canceled)$/i.test((status || "").trim());
}

/** Firestore auto-IDs are long base62 strings ("41IW9G1vBvPxQKJG55Hz") — never
 *  a human centre name. Used so a failed name lookup never leaks a raw id into
 *  a group header or table cell; it falls back to a plain placeholder instead. */
function looksLikeCenterId(v: string): boolean {
  return /^[A-Za-z0-9]{15,}$/.test(v.trim());
}

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
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]}>
      <Suspense fallback={null}>
        <StudentsContent />
      </Suspense>
    </ProtectedRoute>
  );
}

function StudentsContent() {
  const { user, role }                  = useAuth();
  const { wing }                        = useWing();
  const isSom                           = isSchoolOfMusic(wing);
  const router                          = useRouter();
  const searchParams                    = useSearchParams();
  const { isAllowed, filterCentres, teacherCentreIds, isTeacherRole } = useCentreAccess();
  // Seed from the last visit's cache so switching back to Students renders
  // instantly instead of a blank loading state — fetchData() below still
  // always re-fetches to stay fresh.
  const [students, setStudents]         = useState<StudentRow[]>(() => getCached(`students:${wing}:students`) ?? []);
  const [transactions, setTransactions] = useState<Transaction[]>(() => getCached(`students:${wing}:transactions`) ?? []);
  const [centerMap, setCenterMap]       = useState<Map<string, string>>(() => getCached(`students:${wing}:centerMap`) ?? new Map());
  const [centerOptions, setCenterOpts]  = useState<CenterOption[]>(() => getCached(`students:${wing}:centerOptions`) ?? []);
  const [teacherOptions, setTeacherOpts] = useState<{ id: string; name: string }[]>(() => getCached(`students:${wing}:teacherOptions`) ?? []);
  const [teacherMap, setTeacherMap]     = useState<Map<string, string>>(() => getCached(`students:${wing}:teacherMap`) ?? new Map());
  const [loading, setLoading]           = useState(() => !getCached<StudentRow[]>(`students:${wing}:students`));
  const [tab, setTab]                   = useState<StudentTab>("active");
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [breakRequestsOpen, setBreakRequestsOpen] = useState(false);
  const [editTarget, setEditTarget]         = useState<StudentRow | null>(null);
  const [clearHistoryTarget, setClearHistoryTarget] = useState<StudentRow | null>(null);
  const [deleteTarget, setDeleteTarget]     = useState<StudentRow | null>(null);
  const [breakTarget, setBreakTarget]       = useState<StudentRow | null>(null);
  const debounceRef                         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, toast, remove }           = useToast();

  // ── UI prefs (persisted) ───────────────────────────────────────────────────
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [listView, setListView]         = useState<"cards" | "table">("table");
  const [sortKey, setSortKey]           = useState<"name" | "centerName" | "balance" | "status">("name");
  const [sortDir, setSortDir]           = useState<1 | -1>(1);
  useEffect(() => {
    try {
      if (localStorage.getItem("students_insights_open") === "1") setInsightsOpen(true);
      const v = localStorage.getItem("students_list_view");
      if (v === "table" || v === "cards") setListView(v);
    } catch { /* storage blocked */ }
  }, []);
  function toggleInsights() {
    setInsightsOpen(o => {
      try { localStorage.setItem("students_insights_open", o ? "0" : "1"); } catch { /* ignore */ }
      return !o;
    });
  }
  function pickListView(v: "cards" | "table") {
    setListView(v);
    try { localStorage.setItem("students_list_view", v); } catch { /* ignore */ }
  }
  function toggleSort(k: typeof sortKey) {
    if (sortKey === k) setSortDir(d => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(1); }
  }

  // Filters
  const [searchInput, setSearchInput]   = useState("");
  const [search, setSearch]             = useState("");
  const [filterCenter, setFilterCenter] = useState("all");
  const [filterCourse, setFilterCourse] = useState("");
  const [filterInstrument, setFilterInstrument] = useState("");
  const [filterFeeStatus, setFilterFeeStatus]   = useState("all");
  const [filterClassType, setFilterClassType]   = useState("all");

  // Deep-link support: a "View active students" link from a Centre card lands
  // here as ?center=<id>&status=active — pick those up once on arrival so the
  // Centre filter and tab reflect what was clicked, without further clicks.
  useEffect(() => {
    const centerParam = searchParams.get("center");
    const statusParam = searchParams.get("status");
    if (centerParam) setFilterCenter(centerParam);
    if (statusParam === "active" || statusParam === "inactive") setTab(statusParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Leadership roles that manage students. NOTE: chief_teacher is included here
  // for full student management on this screen; the finer split (no hard-delete
  // / no deactivation approval for chief_teacher) is a later capability pass.
  const isAdmin = role === ROLES.ADMIN || role === ROLES.FOUNDER
    || role === ROLES.DIRECTOR || role === ROLES.CHIEF_TEACHER;
  const isTeacher = role === ROLES.TEACHER;

  async function fetchData() {
    const cachedStudents = getCached<StudentRow[]>(`students:${wing}:students`);
    if (cachedStudents) {
      setStudents(cachedStudents);
      setTransactions(getCached(`students:${wing}:transactions`) ?? []);
      setCenterMap(getCached(`students:${wing}:centerMap`) ?? new Map());
      setCenterOpts(getCached(`students:${wing}:centerOptions`) ?? []);
      setTeacherOpts(getCached(`students:${wing}:teacherOptions`) ?? []);
      setTeacherMap(getCached(`students:${wing}:teacherMap`) ?? new Map());
    }
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
      setCached(`students:${wing}:transactions`, txs);

      // `cMap` (this wing only) drives the filter/edit dropdowns. `cMapAll`
      // additionally resolves display names for legacy/mistagged centre docs
      // (created before wing-tagging existed) so a student record pointing at
      // one doesn't fall back to a raw Firestore id in the group headers.
      const cMap = new Map<string, string>();
      const cMapAll = new Map<string, string>();
      const cOptsAll: CenterOption[] = [];
      centerSnap.docs.forEach(d => {
        const nm = (d.data().name as string) ?? d.id;
        cMapAll.set(d.id, nm);
        if (!inWing(d.data(), wing)) return;
        cMap.set(d.id, nm);
        cOptsAll.push({
          id: d.id,
          name: nm,
          monthlyFee: typeof d.data().monthlyFee === "number" ? (d.data().monthlyFee as number) : undefined,
          batches: effectiveBatches(d.id, d.data()),
        });
      });
      setCenterMap(cMap);
      setCached(`students:${wing}:centerMap`, cMap);
      // Teachers: show only their assigned centres in the filter dropdown
      const filteredCenterOpts = filterCentres(cOptsAll);
      setCenterOpts(filteredCenterOpts);
      setCached(`students:${wing}:centerOptions`, filteredCenterOpts);

      const tMap = new Map<string, string>();
      const tOptsAll: { id: string; name: string }[] = [];
      teacherSnap.docs
        .filter(d => inWing(d.data(), wing))
        .forEach(d => {
          const tName = ((d.data().displayName ?? d.data().name ?? "-") as string);
          tMap.set(d.id, tName);
          tOptsAll.push({ id: d.id, name: tName });
        });
      setTeacherMap(tMap);
      setCached(`students:${wing}:teacherMap`, tMap);
      setTeacherOpts(tOptsAll);
      setCached(`students:${wing}:teacherOptions`, tOptsAll);

      const allStudentsRaw = studentSnap.docs
        .filter(d => inWing(d.data(), wing))
        .map(d => {
        const s = d.data();
        const assignedTUid = (s.assignedTeacherUid ?? null) as string | null;
        const centerIdRaw = String(s.centerId ?? "").trim();
        return {
          id:          d.id,
          name:        (s.displayName ?? s.name ?? "-") as string,
          email:       (s.email       ?? "-") as string,
          studentID:   (s.studentID   ?? "-") as string,
          admissionNo: (s.admissionNo ?? s.admissionNumber ?? "-") as string,
          phone:       (s.phone       ?? "") as string,
          centerId:    centerIdRaw || "-",
          centerName:  cMap.get(centerIdRaw) || cMapAll.get(centerIdRaw)
            || (centerIdRaw && !looksLikeCenterId(centerIdRaw) ? centerIdRaw : "Unassigned Center"),
          batchId:     (s.batchId ?? null) as string | null,
          wing:        wingOf(s),
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
          monthlyFee:  Number(s.monthlyFee ?? 0),
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
      setCached(`students:${wing}:students`, allStudents);
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchData(); }, [wing]);

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
  // Two top-level tabs only. A pending deactivation/break request hasn't
  // actually changed the student's standing yet, so it stays in Active
  // (surfaced via the header badges instead of its own tab); an approved
  // break moves the student to Inactive, same as deactivated/cancelled.
  const requestStudents      = students.filter(s => s.status === "deactivation_requested");
  const breakRequestStudents = students.filter(s => s.status === "break_requested");
  const onBreakStudents      = students.filter(s => s.status === "on_break");
  const activeStudents       = students.filter(s =>
    isActiveStatus(s.status) || s.status === "deactivation_requested" || s.status === "break_requested");
  const inactiveStudents     = students.filter(s => isInactiveStatus(s.status) || s.status === "on_break");

  const baseList = tab === "active" ? activeStudents : inactiveStudents;

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

  // Inactive tab holds both truly-inactive students and on-break ones; the
  // latter keep their dedicated "End Break" panel instead of the standard
  // edit/deactivate row actions, so they're split out before the normal
  // table/card rendering below.
  const filteredOnBreak = tab === "inactive" ? filtered.filter(s => s.status === "on_break") : [];
  const filteredRest    = tab === "inactive" ? filtered.filter(s => s.status !== "on_break") : filtered;

  function buildCenterGroups(students: StudentRow[]) {
    const map = new Map<string, { centerId: string; centerName: string; students: StudentRow[] }>();
    students.forEach(s => {
      if (!map.has(s.centerId)) map.set(s.centerId, { centerId: s.centerId, centerName: s.centerName, students: [] });
      map.get(s.centerId)!.students.push(s);
    });
    return Array.from(map.values()).sort((a, b) => safeCompare(a.centerName, b.centerName));
  }

  const groupedByCenter = useMemo(() => {
    const groupStudents    = filteredRest.filter(s => s.classType !== "personal");
    const personalStudents = filteredRest.filter(s => s.classType === "personal");
    return {
      group:    buildCenterGroups(groupStudents),
      personal: buildCenterGroups(personalStudents),
    };
  }, [filteredRest]);

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
    <div className="mx-auto max-w-[794px]" style={p.page}>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* ── Header ── */}
      <div style={p.header}>
        <div>
          <h1 style={p.heading}>Students</h1>
          <div style={p.subheading}>
            {students.length} total · {activeStudents.length} active
            {!isSom && <>
              {" "}· {students.filter(s => s.classType === "group").length} group ·{" "}
              {students.filter(s => s.classType === "personal").length} personal
            </>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {requestStudents.length > 0 && (
            <div style={p.deactivationBadge} onClick={() => setRequestsOpen(true)}>
              ⚠ Deactivation Requests ({requestStudents.length})
            </div>
          )}
          {breakRequestStudents.length > 0 && (
            <div style={{ ...p.deactivationBadge, background: "#e0f2fe", color: "#0369a1", borderColor: "#7dd3fc" }}
              onClick={() => setBreakRequestsOpen(true)}>
              ☕ Break Requests ({breakRequestStudents.length})
            </div>
          )}
          {(isAdmin || isTeacher) && (
            // Students are only created through the admissions pipeline
            // (application → screening → centre assignment → enrol).
            <Link href={isSom ? "/dashboard/admissions" : "/dashboard/screening"}
              title="New students are enrolled through Admissions & Screening"
              style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-accent-text)", whiteSpace: "nowrap", alignSelf: "center" }}>
              🎓 New admission →
            </Link>
          )}
        </div>
      </div>

      {/* ── Insights ── */}
      <InsightsPanel
        students={students}
        centerOptions={centerOptions}
        open={insightsOpen}
        onToggle={toggleInsights}
        onPickStatus={key => {
          if (key === "break_requests") setBreakRequestsOpen(true);
          else if (key === "requests") setRequestsOpen(true);
          else if (key === "on_break") setTab("inactive");
          else setTab(key);
        }}
      />

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
        {!isSom && (
          <select value={filterClassType} onChange={e => setFilterClassType(e.target.value)} style={p.filterSelect}>
            <option value="all">All Class Types</option>
            <option value="group">👥 Group</option>
            <option value="personal">👤 Personal</option>
          </select>
        )}
        {(search || filterCenter !== "all" || filterCourse || filterInstrument || filterFeeStatus !== "all" || filterClassType !== "all") && (
          <button onClick={resetFilters} style={p.resetBtn}>✕ Reset</button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 2, background: "#f1f5f9", borderRadius: 8, padding: 2 }}>
          {(["cards", "table"] as const).map(v => (
            <button key={v} onClick={() => pickListView(v)}
              style={{
                border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                padding: "5px 12px", borderRadius: 6,
                background: listView === v ? "#fff" : "transparent",
                color: listView === v ? "#4338ca" : "#6b7280",
                boxShadow: listView === v ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
              }}>
              {v === "cards" ? "▦ Cards" : "☰ Table"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={p.tabs}>
        {(["active", "inactive"] as StudentTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...p.tab, ...(tab === t ? p.tabActive : {}) }}>
            {t === "active" ? `Active (${activeStudents.length})` : `Inactive (${inactiveStudents.length})`}
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
      ) : (
        <div>
          {/* On-break students keep their dedicated End Break action, shown
              above the rest of the Inactive list. */}
          {tab === "inactive" && filteredOnBreak.length > 0 && (
            <div style={{ marginBottom: filteredRest.length > 0 ? 24 : 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#0369a1", letterSpacing: 0.5, textTransform: "uppercase" as const, marginBottom: 14, paddingBottom: 6, borderBottom: "2px solid #e0f2fe" }}>
                ☕ On Break
              </div>
              <OnBreakPanel
                students={filteredOnBreak}
                onEndBreak={endBreak}
                isAdmin={isAdmin}
              />
            </div>
          )}
          {filteredRest.length === 0 ? null : listView === "table" ? (
        <StudentTableView
          students={filteredRest}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={toggleSort}
          showStatus={tab !== "active"}
          isAdmin={isAdmin}
          isTeacher={isTeacher}
          onEdit={s => setEditTarget(s)}
          onRequestDeactivation={s => requestDeactivation(s)}
          onRequestBreak={s => setBreakTarget(s)}
          onClearHistory={isAdmin ? s => setClearHistoryTarget(s) : undefined}
          onDelete={isAdmin ? s => setDeleteTarget(s) : undefined}
        />
      ) : (
        <div>
          {/* ── Group classes ── */}
          {groupedByCenter.group.length > 0 && (
            <>
              {!isSom && (
                <div style={{ fontSize: 13, fontWeight: 700, color: "#6d28d9", letterSpacing: 0.5, textTransform: "uppercase" as const, marginBottom: 14, paddingBottom: 6, borderBottom: "2px solid #ede9fe" }}>
                  👥 Group Classes
                </div>
              )}
              {groupedByCenter.group.map(group => (
                <div key={group.centerId} style={{ marginBottom: 28 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #e5e7eb" }}>
                    <span style={{ fontSize: 16 }}>🏫</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{group.centerName}</span>
                    <span style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>
                      {group.students.length}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
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
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
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

      {/* ── Deactivation Requests overlay ── */}
      {requestsOpen && (
        <div style={modal.overlay} onClick={() => setRequestsOpen(false)}>
          <div style={modal.box} onClick={e => e.stopPropagation()}>
            <div style={modal.header}>
              <div>
                <div style={modal.title}>Deactivation Requests</div>
                <div style={modal.subtitle}>Pending admin approval — students stay Active until resolved.</div>
              </div>
              <button onClick={() => setRequestsOpen(false)} style={modal.closeBtn}>✕</button>
            </div>
            <div style={modal.body}>
              <RequestsPanel
                requests={requestStudents}
                onApprove={s => { approveDeactivation(s); }}
                onReject={s => { rejectDeactivation(s); }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Break Requests overlay ── */}
      {breakRequestsOpen && (
        <div style={modal.overlay} onClick={() => setBreakRequestsOpen(false)}>
          <div style={modal.box} onClick={e => e.stopPropagation()}>
            <div style={modal.header}>
              <div>
                <div style={modal.title}>Break Requests</div>
                <div style={modal.subtitle}>Pending admin approval — students stay Active until resolved.</div>
              </div>
              <button onClick={() => setBreakRequestsOpen(false)} style={modal.closeBtn}>✕</button>
            </div>
            <div style={modal.body}>
              <BreakRequestsPanel
                requests={breakRequestStudents}
                onApprove={(s, startDate) => approveBreak(s, startDate)}
                onReject={s => rejectBreak(s)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Student Row ───────────────────────────────────────────────────────────────

function StudentRow({ student: s, index, isAdmin, isTeacher, showStatus, expanded, onToggleExpand, onEdit, onRequestDeactivation, onRequestBreak, onClearHistory, onDelete }: {
  student: StudentRow; index: number; isAdmin: boolean; isTeacher: boolean; showStatus: boolean;
  expanded: boolean; onToggleExpand: () => void;
  onEdit: () => void; onRequestDeactivation: () => void; onRequestBreak: () => void;
  onClearHistory?: () => void; onDelete?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const rowBg = expanded ? "#eef2ff" : hover ? "#f0f4ff" : index % 2 === 0 ? "#fff" : "#fafafa";
  const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
  return (
    <>
    <tr style={{ background: rowBg, transition: "background 0.12s", cursor: "pointer" }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={onToggleExpand}>
      <td style={{ ...p.td, textAlign: "center" as const }}><span style={p.expandChevron}>{expanded ? "▾" : "▸"}</span></td>
      <td style={{ ...p.td, ...ellipsis, fontWeight: 600, color: "#111827", maxWidth: 180 }} title={s.name}>{s.name}</td>
      <td style={{ ...p.td, ...ellipsis, maxWidth: 150 }} title={s.centerName}>{s.centerName}</td>
      <td style={{ ...p.td, fontWeight: 700, color: s.balance > 0 ? "#d97706" : "#16a34a" }}>
        {fmtINR(s.balance)}
      </td>
      {showStatus && (
        <td style={p.td}>
          <span style={{ ...p.badge, ...ellipsis, maxWidth: 90, ...(STATUS_BADGE[s.status.toLowerCase()] ?? { background: "#f3f4f6", color: "#6b7280" }) }}>
            {s.status.replace(/_/g, " ")}
          </span>
        </td>
      )}
    </tr>
    {expanded && (
      <tr>
        <td colSpan={showStatus ? 5 : 4} style={p.tdDetail}>
          <div style={p.detailGrid}>
            <div>
              <div style={p.detailLabel}>Student ID</div>
              <div style={p.detailValue}><span style={p.idChip}>{s.studentID}</span></div>
            </div>
            <div>
              <div style={p.detailLabel}>Admission No.</div>
              <div style={p.detailValue}><span style={p.admChip}>{s.admissionNo}</span></div>
            </div>
            <div>
              <div style={p.detailLabel}>Email</div>
              <div style={p.detailValue}>{s.email || "—"}</div>
            </div>
            <div>
              <div style={p.detailLabel}>Phone</div>
              <div style={p.detailValue}>{s.phone || "—"}</div>
            </div>
            <div>
              <div style={p.detailLabel}>Date of Admission</div>
              <div style={p.detailValue}>{s.createdAt ? s.createdAt.slice(0, 10) : "—"}</div>
            </div>
            <div>
              <div style={p.detailLabel}>Type</div>
              <div style={p.detailValue}>
                {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
                {s.classType === "personal" && (
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                    {s.assignedTeacherName
                      ? `🎓 ${s.assignedTeacherName}`
                      : <span style={{ color: "#d97706" }}>⚠ Unassigned</span>}
                    {s.classDays.length > 0 && ` · ${s.classDays.join(", ")}`}
                    {s.classTime ? ` · ${s.classTime}` : ""}
                  </div>
                )}
              </div>
            </div>
            <div>
              <div style={p.detailLabel}>Instrument / Course</div>
              <div style={p.detailValue}>{s.instrument}{s.course ? ` · ${s.course}` : ""}</div>
            </div>
            <div>
              <div style={p.detailLabel}>Billing Frequency</div>
              <div style={p.detailValue}>
                {s.feeCycle === "per_class" ? `₹${s.feePerClass}/class` : s.monthlyFee > 0 ? `₹${s.monthlyFee}/mo` : "Monthly"}
                {" · "}{s.billingMode === "prepay" ? "Prepay" : "Postpay"}
              </div>
            </div>
            <div>
              <div style={p.detailLabel}>Fee status</div>
              <div style={p.detailValue}>{s.balance > 0 ? `₹${s.balance.toLocaleString("en-IN")} due` : "Fully paid"}</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }} onClick={e => e.stopPropagation()}>
            <StudentActionsMenu
              student={s} isAdmin={isAdmin} isTeacher={isTeacher}
              onEdit={onEdit} onRequestDeactivation={onRequestDeactivation} onRequestBreak={onRequestBreak}
              onClearHistory={onClearHistory} onDelete={onDelete}
            />
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

// ─── Compact actions menu (Table view) ──────────────────────────────────────

function StudentActionsMenu({ student: s, isAdmin, isTeacher, onEdit, onRequestDeactivation, onRequestBreak, onClearHistory, onDelete }: {
  student: StudentRow; isAdmin: boolean; isTeacher: boolean;
  onEdit: () => void; onRequestDeactivation: () => void; onRequestBreak: () => void;
  onClearHistory?: () => void; onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: "relative" as const, display: "inline-block" }}>
      <button onClick={e => { e.stopPropagation(); setOpen(v => !v); }} style={p.moreBtn} title="Actions" aria-label="Actions">⋮</button>
      {open && (
        <div style={{ ...p.menuPanel, bottom: "auto", top: "calc(100% + 4px)" }} onClick={e => e.stopPropagation()}>
          {(isAdmin || isTeacher) && (
            <button onClick={() => { setOpen(false); onEdit(); }} style={p.menuItem}>✏ Edit</button>
          )}
          {(isAdmin || isTeacher) && isActiveStatus(s.status) && (
            <button onClick={() => { setOpen(false); onRequestDeactivation(); }} style={{ ...p.menuItem, ...p.menuItemDanger }}>Deactivate</button>
          )}
          {(isAdmin || isTeacher) && isActiveStatus(s.status) && (
            <button onClick={() => { setOpen(false); onRequestBreak(); }} style={p.menuItem}>☕ Break</button>
          )}
          <Link href={`/dashboard/student-syllabus/${s.id}`} style={p.menuItem} onClick={() => setOpen(false)}>Syllabus</Link>
          {onClearHistory && (
            <button onClick={() => { setOpen(false); onClearHistory(); }} style={p.menuItem}>🗑 Clear History</button>
          )}
          {onDelete && (
            <button onClick={() => { setOpen(false); onDelete(); }} style={{ ...p.menuItem, ...p.menuItemDanger }}>✕ Delete</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Requests Panel ────────────────────────────────────────────────────────────

function RequestsPanel({ requests, onApprove, onReject }: {
  requests: StudentRow[];
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
                {s.centerName}
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

function BreakRequestsPanel({ requests, onApprove, onReject }: {
  requests: StudentRow[];
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
                  {s.centerName}
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

function OnBreakPanel({ students, onEndBreak, isAdmin }: {
  students: StudentRow[];
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
                {s.centerName}
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
  centerOptions:   CenterOption[];
  teacherOptions:  { id: string; name: string }[];
  transactions:    Transaction[];
  isAdmin:         boolean;
  onTransactionsChanged: () => void;
  onClose:         () => void;
  onSaved:         (updated: Partial<StudentRow> & { id: string }) => void;
  currentUserUid:  string;
  currentUserRole: string;
}) {
  const isSom = isSchoolOfMusic(student.wing);
  const [form, setForm]     = useState<EditForm>({
    name:               student.name,
    email:              student.email,
    admissionNo:        student.admissionNo,
    phone:              student.phone,
    centerId:           student.centerId,
    batchId:            student.batchId ?? "",
    instrument:         student.instrument,
    course:             student.course,
    classType:          isSom ? "group"  : (student.classType || "group"),
    billingMode:        isSom ? "prepay" : (student.billingMode || "postpay"),
    assignedTeacherUid: student.assignedTeacherUid ?? "",
    classDays:          student.classDays ?? [],
    classTime:          student.classTime ?? "",
    feeCycle:           isSom ? "monthly" : student.feeCycle,
    feePerClass:        String(student.feePerClass),
    monthlyFee:         student.monthlyFee ? String(student.monthlyFee) : "",
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
    if (isSom && Number(form.monthlyFee) <= 0) { setError("Monthly fee is required."); return; }

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
        batchId:            batchIdToStore(centerOptions.find(c => c.id === form.centerId)?.batches, form.batchId),
        instrument:         form.instrument.trim(),
        course:             form.course.trim(),
        classType:          isSom ? "group"  : (form.classType || "group"),
        billingMode:        isSom ? "prepay" : (form.billingMode || "postpay"),
        assignedTeacherUid: !isSom && form.classType === "personal" ? (form.assignedTeacherUid || null) : null,
        classDays:          !isSom && form.classType === "personal" ? form.classDays : [],
        classTime:          !isSom && form.classType === "personal" ? (form.classTime || null) : null,
        feeCycle:           isSom ? "monthly" : form.feeCycle,
        feePerClass:        !isSom && form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        ...(isSom ? { monthlyFee: Number(form.monthlyFee) } : {}),
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
        batchId:             batchIdToStore(centerOptions.find(c => c.id === form.centerId)?.batches, form.batchId),
        instrument:          form.instrument.trim(),
        course:              form.course.trim(),
        classType:           isSom ? "group"  : (form.classType || "group"),
        billingMode:         isSom ? "prepay" : (form.billingMode || "postpay"),
        assignedTeacherUid:  !isSom && form.classType === "personal" ? (form.assignedTeacherUid || null) : null,
        classDays:           !isSom && form.classType === "personal" ? form.classDays : [],
        classTime:           !isSom && form.classType === "personal" ? (form.classTime || null) : null,
        feeCycle:            isSom ? "monthly" : form.feeCycle,
        feePerClass:         !isSom && form.feeCycle === "per_class" ? Number(form.feePerClass) : 0,
        monthlyFee:          isSom ? Number(form.monthlyFee) : student.monthlyFee,
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
                <select
                  name="centerId"
                  value={form.centerId}
                  onChange={e => {
                    const cid = e.target.value;
                    const centerFee = centerOptions.find(c => c.id === cid)?.monthlyFee;
                    setForm(prev => ({
                      ...prev,
                      centerId: cid,
                      batchId: cid === prev.centerId ? prev.batchId : "",
                      monthlyFee: isSom && !prev.monthlyFee && centerFee ? String(centerFee) : prev.monthlyFee,
                    }));
                  }}
                  required style={p.input}>
                  <option value="">— Select center —</option>
                  {centerOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              {form.centerId && (
                <Field label="Batch">
                  <BatchSelect
                    batches={centerOptions.find(c => c.id === form.centerId)?.batches ?? []}
                    value={form.batchId}
                    onChange={v => setForm(prev => ({ ...prev, batchId: v }))}
                  />
                </Field>
              )}
              {isSom && (
                <Field label="Monthly Fee (₹) *">
                  <input name="monthlyFee" type="number" min="0" step="1" value={form.monthlyFee} onChange={f} required style={p.input} />
                </Field>
              )}
              {!isSom && (
              <Field label="Class Type *">
                <select name="classType" value={form.classType}
                  onChange={e => setForm(prev => ({ ...prev, classType: e.target.value, assignedTeacherUid: "", classDays: [], classTime: "" }))}
                  style={p.input}>
                  <option value="group">Group Class (batch at center)</option>
                  <option value="personal">Personal Class (one-on-one / private)</option>
                </select>
              </Field>
              )}
              {!isSom && (
              <Field label="Billing Mode *">
                <select name="billingMode" value={form.billingMode} onChange={f} style={p.input}>
                  <option value="postpay">Postpay — billed first, pays after</option>
                  <option value="prepay">Prepay — payments advance, fee deducted</option>
                </select>
              </Field>
              )}
              {!isSom && form.classType === "personal" && (
                <Field label="Assign Teacher">
                  <select name="assignedTeacherUid" value={form.assignedTeacherUid} onChange={f} style={p.input}>
                    <option value="">— Unassigned —</option>
                    {teacherOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              )}
              {!isSom && form.classType === "personal" && (
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
              {!isSom && form.classType === "personal" && (
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
              {!isSom && (
              <Field label="Fee Cycle">
                <select name="feeCycle" value={form.feeCycle} onChange={f} style={p.input}>
                  <option value="monthly">Monthly</option>
                  <option value="per_class">Per Class</option>
                </select>
              </Field>
              )}
              {!isSom && form.feeCycle === "per_class" && (
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

            {/* Ledger editing deliberately lives on the Finance page only, so
                corrections to money happen in exactly one place. */}
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
  const statusStyle = STATUS_BADGE[s.status.toLowerCase()] ?? { background: "#f3f4f6", color: "#6b7280" };
  const isDue = s.balance > 0;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 14,
        background: "#fff",
        border: `1px solid ${hover ? "#a5b4fc" : "#e5e7eb"}`,
        borderRadius: 10, padding: "10px 16px", cursor: "pointer",
        boxShadow: hover ? "0 4px 16px rgba(79,70,229,0.12)" : "0 1px 2px rgba(0,0,0,0.04)",
        transition: "box-shadow 0.15s, border-color 0.15s",
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
        background: "linear-gradient(135deg, #6d28d9, #4f46e5)",
        color: "#fff", fontSize: 12, fontWeight: 700,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {initials}
      </div>
      <div style={{ flex: "1 1 170px", minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "#111827", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
        <span style={p.idChip}>{s.studentID}</span>
      </div>
      <div style={{ flex: "1 1 160px", minWidth: 0, fontSize: 12, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600 }}>{s.instrument}</span>
        {s.course ? <span style={{ color: "#6b7280" }}> · {s.course}</span> : null}
      </div>
      <div style={{ flex: "0 0 auto", display: "flex", gap: 5, flexWrap: "wrap" as const }}>
        {!isSchoolOfMusic(s.wing) && (
          <span style={{ ...p.badge, ...(s.classType === "personal" ? { background: "#fef9c3", color: "#92400e" } : { background: "#dcfce7", color: "#166534" }) }}>
            {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
          </span>
        )}
        <span style={{ ...p.badge, ...statusStyle }}>{s.status.replace(/_/g, " ")}</span>
      </div>
      <div style={{ flex: "0 0 96px", textAlign: "right" as const }}>
        {isDue ? (
          <span style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "3px 8px", borderRadius: 4, display: "inline-block", whiteSpace: "nowrap" }}>
            Due {fmtINR(s.balance)}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>—</span>
        )}
      </div>
    </div>
  );
}

// ─── Insights panel ───────────────────────────────────────────────────────────

const CHART_HUE = "#4f46e5";

interface BarDatum { label: string; value: number; hint?: string }

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "13px 16px", flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 800, color: tone ?? "#111827", marginTop: 4, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function BarList({ title, rows, color = CHART_HUE, emptyText = "No data" }: {
  title: string; rows: BarDatum[]; color?: string; emptyText?: string;
}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "13px 16px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9ca3af", padding: "6px 0" }}>{emptyText}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 7 }}>
          {rows.map(r => (
            <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div title={r.label} style={{ width: 92, flexShrink: 0, fontSize: 12, color: "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
              <div style={{ flex: 1, background: "#f1f5f9", borderRadius: 5, height: 15, overflow: "hidden" }}>
                <div style={{ width: `${Math.max(3, (r.value / max) * 100)}%`, background: color, height: "100%", borderRadius: 5 }} />
              </div>
              <div style={{ width: 66, flexShrink: 0, textAlign: "right" as const, fontSize: 12, fontWeight: 700, color: "#111827" }}>
                {r.hint ?? String(r.value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniMonthBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "13px 16px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 12 }}>New enrolments · last 12 months</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 92 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 3 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "#6b7280", minHeight: 12 }}>{d.value || ""}</div>
            <div title={`${d.label}: ${d.value}`} style={{
              width: "100%", background: CHART_HUE, opacity: 0.85, borderRadius: 3,
              height: `${Math.max(2, (d.value / max) * 60)}px`,
            }} />
            <div style={{ fontSize: 9, color: "#9ca3af" }}>{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

type AttAgg = { overallPct: number; byCourse: BarDatum[]; byCenter: BarDatum[] };

function InsightsPanel({ students, centerOptions, open, onToggle, onPickStatus }: {
  students: StudentRow[];
  centerOptions: CenterOption[];
  open: boolean;
  onToggle: () => void;
  onPickStatus: (key: StatusPickKey) => void;
}) {
  const [att, setAtt] = useState<AttAgg | "error" | null>(null);
  const [attLoading, setAttLoading] = useState(false);

  useEffect(() => {
    if (!open || att !== null || attLoading) return;
    let cancelled = false;
    setAttLoading(true);
    (async () => {
      try {
        const wingCenterIds = new Set(centerOptions.map(c => c.id));
        const snap = await getDocs(collection(db, "attendance"));
        const perStudent = new Map<string, { present: number; total: number }>();
        snap.docs.forEach(d => {
          const r = d.data() as { studentUid?: string; centerId?: string; status?: string; present?: boolean };
          if (r.centerId && !wingCenterIds.has(r.centerId)) return;
          const uid = r.studentUid;
          if (!uid) return;
          const counted = r.status
            ? r.status === "present" || r.status === "absent"
            : typeof r.present === "boolean";
          if (!counted) return;
          const isPresent = r.status ? r.status === "present" : r.present === true;
          const cur = perStudent.get(uid) ?? { present: 0, total: 0 };
          cur.total += 1;
          if (isPresent) cur.present += 1;
          perStudent.set(uid, cur);
        });
        const byCourse = new Map<string, { p: number; t: number }>();
        const byCenter = new Map<string, { p: number; t: number }>();
        let gp = 0, gt = 0;
        students.forEach(s => {
          const a = perStudent.get(s.id);
          if (!a || a.total === 0) return;
          gp += a.present; gt += a.total;
          const c = byCourse.get(s.course || "—") ?? { p: 0, t: 0 };
          c.p += a.present; c.t += a.total; byCourse.set(s.course || "—", c);
          const ce = byCenter.get(s.centerName || "—") ?? { p: 0, t: 0 };
          ce.p += a.present; ce.t += a.total; byCenter.set(s.centerName || "—", ce);
        });
        const toRows = (m: Map<string, { p: number; t: number }>): BarDatum[] =>
          Array.from(m.entries())
            .map(([label, v]) => { const pct = Math.round((v.p / v.t) * 100); return { label, value: pct, hint: `${pct}%` }; })
            .sort((a, b) => b.value - a.value)
            .slice(0, 8);
        if (!cancelled) {
          setAtt({
            overallPct: gt > 0 ? Math.round((gp / gt) * 100) : 0,
            byCourse: toRows(byCourse),
            byCenter: toRows(byCenter),
          });
        }
      } catch {
        if (!cancelled) setAtt("error");
      } finally {
        if (!cancelled) setAttLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, att, attLoading, centerOptions, students]);

  const stats = useMemo(() => {
    const total = students.length;
    const active = students.filter(s => isActiveStatus(s.status)).length;
    const owing = students.filter(s => s.balance > 0);
    const dues = owing.reduce((a, s) => a + s.balance, 0);
    const ym = new Date().toISOString().slice(0, 7);
    const newThisMonth = students.filter(s => (s.createdAt ?? "").slice(0, 7) === ym).length;

    const tally = (key: (s: StudentRow) => string): BarDatum[] => {
      const m = new Map<string, number>();
      students.forEach(s => { const k = (key(s) || "—").trim() || "—"; m.set(k, (m.get(k) ?? 0) + 1); });
      return Array.from(m.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    };
    const cap = (rows: BarDatum[], n: number): BarDatum[] => {
      if (rows.length <= n) return rows;
      const rest = rows.slice(n).reduce((a, r) => a + r.value, 0);
      return [...rows.slice(0, n), { label: "Other", value: rest }];
    };
    const withPct = (rows: BarDatum[]): BarDatum[] =>
      rows.map(r => ({ ...r, hint: `${r.value} · ${total ? Math.round((r.value / total) * 100) : 0}%` }));

    const statusRows = ([
      { label: "Active", key: "active" as StatusPickKey, value: active, color: "#16a34a" },
      { label: "On break", key: "on_break" as StatusPickKey, value: students.filter(s => s.status === "on_break").length, color: "#0284c7" },
      { label: "Break req.", key: "break_requests" as StatusPickKey, value: students.filter(s => s.status === "break_requested").length, color: "#0369a1" },
      { label: "Deact. req.", key: "requests" as StatusPickKey, value: students.filter(s => s.status === "deactivation_requested").length, color: "#d97706" },
      { label: "Inactive", key: "inactive" as StatusPickKey, value: students.filter(s => isInactiveStatus(s.status)).length, color: "#6b7280" },
    ]).filter(r => r.value > 0);

    const months: { label: string; value: number }[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push({
        label: d.toLocaleDateString("en-IN", { month: "short" }),
        value: students.filter(s => (s.createdAt ?? "").slice(0, 7) === key).length,
      });
    }

    return {
      total, active, dues, owingCount: owing.length, newThisMonth,
      byCourse: withPct(cap(tally(s => s.course), 8)),
      byInstrument: withPct(cap(tally(s => s.instrument), 8)),
      byCenter: withPct(cap(tally(s => s.centerName), 8)),
      courseGroups: tally(s => s.course).length,
      statusRows, months,
    };
  }, [students]);

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 14, boxShadow: "0 1px 4px rgba(0,0,0,0.05)", overflow: "hidden" }}>
      <button onClick={onToggle} style={{
        width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 18px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 700, color: "#111827", flexWrap: "wrap" as const }}>
          📊 Insights
          <span style={{ fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>
            {stats.total} students · {stats.courseGroups} courses · {fmtINR(stats.dues)} outstanding
          </span>
        </span>
        <span style={{ fontSize: 12, color: "#6b7280", flexShrink: 0 }}>{open ? "▲ Hide" : "▼ Show"}</span>
      </button>

      {open && (
        <div style={{ padding: "2px 18px 20px", borderTop: "1px solid #f1f5f9" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, margin: "14px 0" }}>
            <StatTile label="Total" value={String(stats.total)} />
            <StatTile label="Active" value={String(stats.active)} tone="#16a34a" sub={`${stats.total - stats.active} not active`} />
            <StatTile label="Outstanding dues" value={fmtINR(stats.dues)} tone={stats.dues > 0 ? "#d97706" : "#16a34a"} sub={`${stats.owingCount} owing`} />
            <StatTile label="New this month" value={String(stats.newThisMonth)} tone="#4f46e5" />
          </div>

          {stats.statusRows.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 8 }}>Status</div>
              <div style={{ display: "flex", height: 16, borderRadius: 6, overflow: "hidden", border: "1px solid #e5e7eb" }}>
                {stats.statusRows.map(r => (
                  <div key={r.key} onClick={() => onPickStatus(r.key)} title={`${r.label}: ${r.value}`}
                    style={{ flex: r.value, background: r.color, cursor: "pointer" }} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" as const, marginTop: 8 }}>
                {stats.statusRows.map(r => (
                  <button key={r.key} onClick={() => onPickStatus(r.key)} style={{
                    display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
                    cursor: "pointer", fontSize: 12, color: "#374151", fontFamily: "inherit", padding: 0,
                  }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: r.color }} />
                    {r.label} <strong>{r.value}</strong>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(258px, 1fr))", gap: 12 }}>
            <BarList title="By course" rows={stats.byCourse} />
            <BarList title="By instrument" rows={stats.byInstrument} />
            <BarList title="By centre" rows={stats.byCenter} />
            <MiniMonthBars data={stats.months} />
          </div>

          <div style={{ marginTop: 12 }}>
            {attLoading ? (
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}><Spinner /></div>
            ) : att === "error" ? (
              <div style={{ fontSize: 12, color: "#9ca3af" }}>Attendance data unavailable.</div>
            ) : att ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(258px, 1fr))", gap: 12 }}>
                <BarList title={`Attendance by course · ${att.overallPct}% overall`} rows={att.byCourse} color="#16a34a" emptyText="No attendance recorded yet" />
                <BarList title="Attendance by centre" rows={att.byCenter} color="#16a34a" emptyText="No attendance recorded yet" />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function StudentTableView({
  students, sortKey, sortDir, onSort, showStatus, isAdmin, isTeacher,
  onEdit, onRequestDeactivation, onRequestBreak, onClearHistory, onDelete,
}: {
  students: StudentRow[];
  sortKey: "name" | "centerName" | "balance" | "status";
  sortDir: 1 | -1;
  onSort: (k: "name" | "centerName" | "balance" | "status") => void;
  // The Active tab only ever shows one status ("confirm"/"active") — the
  // column is noise there. Inactive can hold several (inactive/cancelled/
  // canceled/…), so it stays visible for that tab.
  showStatus: boolean;
  isAdmin: boolean;
  isTeacher: boolean;
  onEdit: (s: StudentRow) => void;
  onRequestDeactivation: (s: StudentRow) => void;
  onRequestBreak: (s: StudentRow) => void;
  onClearHistory?: (s: StudentRow) => void;
  onDelete?: (s: StudentRow) => void;
}) {
  const sorted = useMemo(() => {
    const arr = [...students];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "balance") cmp = a.balance - b.balance;
      else cmp = safeCompare(a[sortKey], b[sortKey]);
      return cmp * sortDir;
    });
    return arr;
  }, [students, sortKey, sortDir]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  const arrow = (k: typeof sortKey) => (sortKey === k ? (sortDir === 1 ? " ▲" : " ▼") : "");
  const sortableTh = (k: typeof sortKey, label: string) => (
    <th style={{ ...p.th, cursor: "pointer", userSelect: "none" as const }} onClick={() => onSort(k)}>{label}{arrow(k)}</th>
  );

  return (
    <div style={p.tableWrap}>
      <table style={p.table}>
        <thead>
          <tr>
            <th style={{ ...p.th, width: 20 }}></th>
            {sortableTh("name", "Name")}
            {sortableTh("centerName", "Centre")}
            {sortableTh("balance", "Balance")}
            {showStatus && sortableTh("status", "Status")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => (
            <StudentRow
              key={s.id}
              student={s}
              index={i}
              isAdmin={isAdmin}
              isTeacher={isTeacher}
              showStatus={showStatus}
              expanded={expandedId === s.id}
              onToggleExpand={() => toggleExpand(s.id)}
              onEdit={() => onEdit(s)}
              onRequestDeactivation={() => onRequestDeactivation(s)}
              onRequestBreak={() => onRequestBreak(s)}
              onClearHistory={onClearHistory ? () => onClearHistory(s) : undefined}
              onDelete={onDelete ? () => onDelete(s) : undefined}
            />
          ))}
        </tbody>
      </table>
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
// Deposits) newest-first.
//
// `editMode` is currently only ever false: the student profile renders this as
// a read-only record, and all money corrections happen on the Finance page so
// there is a single place where the ledger can be changed. The editing branch
// is kept because it is the same component the Finance page can adopt if that
// consolidation is taken further.
//
// Edit/delete call the same finance.service functions the Finance page uses —
// both already reconcile `users.currentBalance` server-side by the exact delta,
// so `onChanged` just needs to refetch transactions to pick up the new balance.

export function LedgerEditor({
  transactions, currentUserUid, currentUserRole, onChanged, editMode,
}: {
  transactions:    Transaction[];
  currentUserUid:  string;
  currentUserRole: string;
  onChanged:       () => void;
  editMode:        boolean;
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
    return [...transactions].sort((a, b) => safeCompare(b.date, a.date));
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
        currentUserRole as import("@/types").Role,
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
    deleteTransaction(txId, currentUserUid, currentUserRole as import("@/types").Role)
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

        return (
          <div key={tx.id}>
            <div
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 10, padding: "9px 12px", borderRadius: 8,
                border: `1px solid ${isEditingRow ? "#93c5fd" : isPending ? "#fecaca" : "#f3f4f6"}`,
                background: isEditingRow ? "#eff6ff" : isPending ? "#fff7f7" : "#fafafa",
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
            teacherName = getTeacherDisplayName(tSnap.data()) || "—";
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
      ? `${data.daysOfWeek.join(", ")}${data.startTime ? ` · ${formatTimeRange12(data.startTime, data.endTime) || formatTime12(data.startTime)}` : ""}`
      : (formatTimesIn12h(data.timeSlot) || "—")
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

// ─── Batch picker ──────────────────────────────────────────────────────────────

/**
 * `batches` comes from effectiveBatches(): a centre without explicit batches
 * yields just its default "General Batch", which every student there belongs
 * to automatically (batchId stays null). Once real batches exist they replace
 * the default and the student can be placed in one of them.
 */
export function BatchSelect({ batches, value, onChange }: {
  batches:  CenterBatch[];
  value:    string;
  onChange: (batchId: string) => void;
}) {
  const label = (b: CenterBatch) => {
    const sched = batchSchedule(b);
    return `${b.name || "Unnamed batch"}${sched ? ` · ${sched}` : ""}`;
  };
  if (batches.length === 1 && isDefaultBatchId(batches[0].id)) {
    return (
      <select value="" disabled style={{ ...p.input, color: "#6b7280" }} title="No batches defined for this centre — using the centre schedule">
        <option value="">{label(batches[0])} (centre schedule)</option>
      </select>
    );
  }
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={p.input}>
      <option value="">— No batch —</option>
      {batches.map(b => <option key={b.id} value={b.id}>{label(b)}</option>)}
    </select>
  );
}

// ─── Page styles ───────────────────────────────────────────────────────────────

export const p: Record<string, React.CSSProperties> = {
  page:    { padding: "0 0 32px", background: "#f8fafc", minHeight: "100vh" },
  header:  { display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 12, marginBottom: 20 },
  heading: { fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 },
  subheading: { fontSize: 12, color: "#6b7280", marginTop: 3 },
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
  table:     { width: "100%", minWidth: 760, borderCollapse: "collapse" as const },
  th: {
    padding: "10px 10px", textAlign: "left" as const, fontSize: 12, fontWeight: 700,
    color: "#4b5563", textTransform: "uppercase" as const, letterSpacing: "0.05em",
    borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" as const,
  },
  td: { padding: "10px 10px", fontSize: 13.5, color: "#111827", borderBottom: "1px solid #f3f4f6" },
  expandChevron: { display: "inline-block", fontSize: 13, color: "#9ca3af", width: 12, textAlign: "center" as const },
  tdDetail: { padding: "14px 20px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb", cursor: "default" as const },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px 24px" },
  detailLabel: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em", color: "#9ca3af", marginBottom: 3 },
  detailValue: { fontSize: 13.5, color: "#111827" },

  badge: { display: "inline-block", padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" as const },
  idChip:  { display: "inline-block", fontFamily: "monospace", fontSize: 11, fontWeight: 700, background: "#dbeafe", color: "#1e40af", padding: "2px 6px", borderRadius: 4 },
  admChip: { display: "inline-block", fontFamily: "monospace", fontSize: 11, fontWeight: 600, background: "#fef9c3", color: "#92400e", padding: "2px 6px", borderRadius: 4 },

  editBtn:     { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  deactBtn:    { background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  syllabusBtn: { background: "#ede9fe", color: "#6d28d9", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, textDecoration: "none", display: "inline-block" },
  clearBtn:    { background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  deleteBtn:   { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },

  moreBtn:     { background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 6, width: 24, height: 24, fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
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
