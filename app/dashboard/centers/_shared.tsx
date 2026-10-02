"use client";

import { claimAdmissionNo, releaseAdmissionNo } from "@/services/student/admissionLock.service";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getDoc, getDocs, collection, query, where, doc, updateDoc, writeBatch, serverTimestamp, arrayUnion, arrayRemove } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { getCenters, createCenter, updateCenter, centreTeacherUids, type CenterRenameResult } from "@/services/center/center.service";
import { getTeachers } from "@/services/teacher/teacher.service";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import type { Center, CenterBatch, Wing } from "@/types";
import { DEFAULT_BATCH_NAME, effectiveBatches, explicitBatches } from "@/lib/batches";
import { cancelClass, undoCancelClass, canCancelClass } from "@/services/attendance/attendance.service";
import { CancelClassMenu, CancelClassDialog } from "@/components/attendance/CancelClassControls";
import { formatTime12, formatTimeRange12, formatTimesIn12h } from "@/lib/timeFormat";
import { getTeacherDisplayName } from "@/lib/teacherName";
import { courseLabel } from "@/lib/course";
import { normAdmNo } from "@/lib/dedup";
import { hasAdmissionNo, isActiveStudentStatus } from "@/lib/activeStudents";
import { enforceSingleActiveCentre } from "@/services/student/singleCentre.service";
import MergeDuplicatesModal from "@/components/dedup/MergeDuplicatesModal";
import type { TeacherUser } from "@/types";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { useAuth } from "@/hooks/useAuth";
import { useWing } from "@/hooks/useWing";
import { isSchoolOfMusic, inWing, wingOf } from "@/lib/wing";
import { getCached, invalidateCache, setCached } from "@/lib/dataCache";
import { deleteCenter } from "@/services/admin/delete.service";
import { safeCompare, sortKey } from "@/lib/sortKey";
import Link from "next/link";
import { computeDueSettlements, computeStudentBalances, outstandingDuesForStudent } from "@/services/finance/finance.service";
import type { Transaction } from "@/types/finance";
import { canEnterAdmissionNo, cleanAdmissionNo, isAdmissionNoTaken } from "@/lib/admissionNumber";
import {
  DEACTIVATION_REQUESTED, approveStudentDeactivation, canApproveDeactivation,
  rejectStudentDeactivation, requestStudentDeactivation,
} from "@/services/student/deactivation.service";

// ─── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = typeof DAYS[number];

const EMPTY_FORM = {
  name:        "",
  teacherUid:  "",
  status:      "active" as "active" | "inactive",
  wing:        WINGS.ROL_PLUS as Wing,
  daysOfWeek:  [] as Day[],
  startTime:   "",
  endTime:     "",
  batches:     [] as CenterBatch[],
  demoClassDate:  "",
  firstClassDate: "",
  subtitle:       "",
  // ROL+ centre label only (Group / Personal) — never touches students' classType or fees.
  classType:      "group" as "group" | "personal",
};

function newBatchId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const style = status === "active"
    ? { background: "#dcfce7", color: "#16a34a" }
    : { background: "#f3f4f6", color: "#6b7280" };
  return <span style={{ ...styles.badge, ...style }}>{status}</span>;
}

/** "Type new" | "Select existing" switch beside the New Center name field. */
function NameModeToggle({ existing, onChange }: { existing: boolean; onChange: (existing: boolean) => void }) {
  const opt = (on: boolean): React.CSSProperties => ({ ...nameModeStyles.opt, ...(on ? nameModeStyles.optOn : {}) });
  return (
    <div role="group" aria-label="Center name mode" style={nameModeStyles.group}>
      <button type="button" aria-pressed={!existing} onClick={() => existing && onChange(false)} style={opt(!existing)}>✏ Type new</button>
      <button type="button" aria-pressed={existing} onClick={() => !existing && onChange(true)} style={opt(existing)}>📋 Select existing</button>
    </div>
  );
}

const nameModeStyles: Record<string, React.CSSProperties> = {
  group:  { display: "inline-flex", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", flexShrink: 0 },
  opt:    { border: "none", background: "#fff", color: "#6b7280", fontSize: 11.5, fontWeight: 600, padding: "3px 9px", cursor: "pointer" },
  optOn:  { background: "#eef2ff", color: "#4338ca" },
  link:   { border: "none", background: "none", color: "#4f46e5", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 },
  locked: { background: "#f9fafb", color: "#374151", cursor: "default" },
};

function FormField({ label, required, children, fullWidth, action }: {
  label: string; required?: boolean; children: React.ReactNode; fullWidth?: boolean;
  /** Small control shown at the right of the label (e.g. a mode toggle). */
  action?: React.ReactNode;
}) {
  return (
    <div style={{ ...formStyles.field, ...(fullWidth ? { gridColumn: "1 / -1" } : {}) }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <label style={formStyles.label}>
          {label}{required && <span style={formStyles.required}> *</span>}
        </label>
        {action}
      </div>
      {children}
    </div>
  );
}

// Teacher, days and times are optional — build the display slot from whatever is set.
function buildTimeSlot(days: Day[], start: string, end: string): string {
  const time = start && end ? `${start}–${end}` : start || end;
  return [days.join("/"), time].filter(Boolean).join(" ");
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

type BatchDraft = { id: string | null; name: string; teacherUid: string; daysOfWeek: Day[]; startTime: string; endTime: string };
const EMPTY_BATCH_DRAFT: BatchDraft = { id: null, name: "", teacherUid: "", daysOfWeek: [], startTime: "", endTime: "" };

/** "Mon, Wed · 5:00 PM – 6:00 PM" */
function batchSummary(b: CenterBatch): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    if (Number.isNaN(h)) return t;
    return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  const days = b.daysOfWeek.length ? b.daysOfWeek.join(", ") : "No days set";
  const time = b.startTime && b.endTime ? `${fmt(b.startTime)} – ${fmt(b.endTime)}` : b.startTime ? fmt(b.startTime) : "No time set";
  return `${days} · ${time}`;
}

/**
 * Sub-batches of a centre. Saved batches show as summary cards (edit / remove);
 * "+ Add New Batch to Current Center" opens an inline form. The list is only
 * written when the surrounding centre form is saved. No batches → the centre
 * runs as its single General Batch (see lib/batches).
 */
/** The centre's own schedule — what Batch 1 is made from when there are no batches yet. */
interface CentreSchedule { daysOfWeek: string[]; startTime: string; endTime: string; teacherUid: string }

const IMPLICIT_BATCH = "__batch1__";

function BatchesEditor({ batches, onChange, teachers, base, lockedIds }: {
  batches: CenterBatch[];
  onChange: (b: CenterBatch[]) => void;
  teachers: TeacherUser[];
  /** Centre schedule + teacher — shown as Batch 1 until the centre has real batches. */
  base: CentreSchedule;
  /** Append-only mode: these (already saved) batches, and the implicit Batch 1, can't be edited or removed. */
  lockedIds?: Set<string>;
}) {
  const appendOnly = !!lockedIds;
  const [autoLocked, setAutoLocked] = useState<Set<string>>(new Set());
  const isLocked = (id: string) => !!lockedIds?.has(id) || autoLocked.has(id);
  const [draft, setDraft] = useState<BatchDraft | null>(null);
  const [draftErr, setDraftErr] = useState("");

  const teacherName = (uid?: string) => {
    if (!uid) return "";
    const t = teachers.find(x => x.uid === uid);
    return t ? getTeacherDisplayName(t) : "Unknown teacher";
  };

  /** Batch 1 as a real batch: the centre's days, times and teacher. */
  function batchOneFromBase(name = DEFAULT_BATCH_NAME): CenterBatch {
    return {
      id: newBatchId(), name,
      teacherUid: base.teacherUid || "",
      daysOfWeek: DAYS.filter(d => base.daysOfWeek.includes(d)),
      startTime: base.startTime || "", endTime: base.endTime || "",
    };
  }

  function openNew() {
    setDraft({ ...EMPTY_BATCH_DRAFT, name: batches.length === 0 ? "Batch 2" : `Batch ${batches.length + 1}` });
    setDraftErr("");
  }
  /** Rename / adjust Batch 1 while it's still the centre's implicit batch. */
  function openImplicit() {
    setDraft({ id: IMPLICIT_BATCH, name: DEFAULT_BATCH_NAME, teacherUid: base.teacherUid || "",
      daysOfWeek: DAYS.filter(d => base.daysOfWeek.includes(d)) as Day[], startTime: base.startTime, endTime: base.endTime });
    setDraftErr("");
  }
  function openEdit(b: CenterBatch) {
    setDraft({ id: b.id, name: b.name, teacherUid: b.teacherUid ?? "", daysOfWeek: b.daysOfWeek as Day[], startTime: b.startTime, endTime: b.endTime });
    setDraftErr("");
  }
  function commitDraft() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setDraftErr("Give the batch a name."); return; }
    // Batch 1 (implicit) → becomes a real batch; its schedule may be left as the centre had it.
    if (draft.id === IMPLICIT_BATCH) {
      if (draft.startTime && draft.endTime && draft.endTime <= draft.startTime) { setDraftErr("End time must be after the start time."); return; }
      onChange([{ id: newBatchId(), name, teacherUid: draft.teacherUid,
        daysOfWeek: DAYS.filter(d => draft.daysOfWeek.includes(d)), startTime: draft.startTime, endTime: draft.endTime }]);
      setDraft(null);
      return;
    }
    if (draft.daysOfWeek.length === 0) { setDraftErr("Pick at least one class day."); return; }
    if (!draft.startTime || !draft.endTime) { setDraftErr("Set both start and end time."); return; }
    if (draft.endTime <= draft.startTime) { setDraftErr("End time must be after the start time."); return; }
    // The first extra batch turns the centre's own schedule into Batch 1 (keeps every student there).
    const current = batches.length === 0 && !draft.id ? [batchOneFromBase()] : batches;
    // Append-only: that Batch 1 holds the centre's existing students — keep it locked too.
    if (appendOnly && current !== batches) setAutoLocked(new Set([current[0].id]));
    if (current.some(b => b.id !== draft.id && b.name.trim().toLowerCase() === name.toLowerCase())) {
      setDraftErr("Another batch already has this name."); return;
    }
    // Always a string teacherUid — Firestore rejects undefined values.
    const saved: CenterBatch = {
      id: draft.id && draft.id !== IMPLICIT_BATCH ? draft.id : newBatchId(), name, teacherUid: draft.teacherUid,
      daysOfWeek: DAYS.filter(d => draft.daysOfWeek.includes(d)), startTime: draft.startTime, endTime: draft.endTime,
    };
    onChange(draft.id ? current.map(b => b.id === draft.id ? saved : b) : [...current, saved]);
    setDraft(null);
  }
  function removeBatch(id: string) {
    onChange(batches.filter(b => b.id !== id));
    if (draft?.id === id) setDraft(null);
  }

  const draftForm = draft && (
    <div style={batchStyles.draft}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#312e81" }}>
        {draft.id === IMPLICIT_BATCH ? "Batch 1 — rename / adjust" : draft.id ? "Edit batch" : batches.length === 0 ? "New batch (Batch 2)" : "New batch"}
      </div>
      {!draft.id && batches.length === 0 && (
        <div style={{ fontSize: 11.5, color: "#4338ca" }}>
          Adding this turns the centre&apos;s current days, time and teacher into <b>Batch 1 ({DEFAULT_BATCH_NAME})</b> —
          every student already here stays in Batch 1. You can rename it afterwards.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <label style={batchStyles.field}>
          <span style={batchStyles.label}>Batch name *</span>
          <input autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Mon/Wed Evening Batch" style={formStyles.input} />
        </label>
        <label style={batchStyles.field}>
          <span style={batchStyles.label}>Batch teacher</span>
          <select value={draft.teacherUid} onChange={e => setDraft({ ...draft, teacherUid: e.target.value })} style={formStyles.input}>
            <option value="">— Centre teacher / none —</option>
            {teachers.map(t => <option key={t.uid} value={t.uid}>{getTeacherDisplayName(t)}</option>)}
          </select>
        </label>
      </div>
      <div style={batchStyles.field}>
        <span style={batchStyles.label}>Class days *</span>
        <DayChips selected={draft.daysOfWeek} onChange={days => setDraft({ ...draft, daysOfWeek: days })} />
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" as const }}>
        <label style={batchStyles.field}>
          <span style={batchStyles.label}>Start time *</span>
          <input type="time" value={draft.startTime} onChange={e => setDraft({ ...draft, startTime: e.target.value })} style={{ ...formStyles.input, width: 130 }} />
        </label>
        <label style={batchStyles.field}>
          <span style={batchStyles.label}>End time *</span>
          <input type="time" value={draft.endTime} onChange={e => setDraft({ ...draft, endTime: e.target.value })} style={{ ...formStyles.input, width: 130 }} />
        </label>
      </div>
      {draftErr && <div style={{ fontSize: 12, color: "#dc2626" }}>{draftErr}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setDraft(null)} style={batchStyles.cancelBtn}>Cancel</button>
        <button type="button" onClick={commitDraft} style={batchStyles.saveBtn}>{draft.id ? "Update batch" : "Add batch"}</button>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
      {batches.length === 0 && draft?.id !== IMPLICIT_BATCH && (
        <div style={batchStyles.card}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#111827" }}>
              {DEFAULT_BATCH_NAME}
              <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: "#4338ca", background: "#e0e7ff", borderRadius: 999, padding: "1px 7px" }}>Batch 1</span>
            </div>
            <div style={{ fontSize: 12, color: "#4b5563", marginTop: 2 }}>
              {batchSummary({ id: "", name: "", daysOfWeek: base.daysOfWeek, startTime: base.startTime, endTime: base.endTime }) || "Uses the centre's days & time above"}
            </div>
            <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 2 }}>
              👤 {teacherName(base.teacherUid) || "Centre teacher"} · all current students
            </div>
          </div>
          {!appendOnly && (
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button type="button" onClick={openImplicit} style={batchStyles.iconBtn} title="Rename Batch 1" aria-label="Rename Batch 1">✎</button>
            </div>
          )}
        </div>
      )}
      {draft?.id === IMPLICIT_BATCH && draftForm}

      {batches.map(b => draft?.id === b.id ? <div key={b.id}>{draftForm}</div> : (
        <div key={b.id} style={batchStyles.card}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#111827" }}>
              {b.name || <em style={{ color: "#9ca3af" }}>Unnamed batch</em>}
              <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: "#6b7280", background: "#f3f4f6", borderRadius: 999, padding: "1px 7px" }}>Batch {batches.indexOf(b) + 1}</span>
            </div>
            <div style={{ fontSize: 12, color: "#4b5563", marginTop: 2 }}>{batchSummary(b)}</div>
            <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 2 }}>
              👤 {teacherName(b.teacherUid) || "Centre teacher"}
            </div>
          </div>
          {isLocked(b.id) ? (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#6b7280", flexShrink: 0 }} title="Existing batch — edit it from Edit Center">Existing</span>
          ) : (
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button type="button" onClick={() => openEdit(b)} style={batchStyles.iconBtn} title="Edit batch" aria-label={`Edit ${b.name}`}>✎</button>
              <button type="button" onClick={() => removeBatch(b.id)} style={batchStyles.removeBtn} title="Remove batch" aria-label={`Remove ${b.name}`}>🗑</button>
            </div>
          )}
        </div>
      ))}

      {draft && !draft.id && draftForm}

      {!draft && (
        <button type="button" onClick={openNew} style={batchStyles.addBtn}>+ Add New Batch to Current Center</button>
      )}
      {draft && (
        <div style={{ fontSize: 11, color: "#9ca3af" }}>Finish with “{draft.id ? "Update batch" : "Add batch"}” — batches are saved with the centre.</div>
      )}
    </div>
  );
}

/**
 * Keep students in step with a centre's batches after it's saved:
 *   • first real batches on a batch-less centre → every student with no batch
 *     is put in Batch 1 (the first batch), so no one drops out of a roster;
 *   • a renamed batch → its students' stored batch label follows.
 * Rosters, Attendance and the Registry resolve batches by id, so they pick the
 * new names up on their own; this also keeps the stored label tidy.
 */
async function syncStudentsToBatches(centerId: string, prev: CenterBatch[], next: CenterBatch[]): Promise<number> {
  const becameBatched = prev.length === 0 && next.length > 0;
  // No batches left → the centre is one class again: clear leftover batch
  // fields from its students (also tidies centres whose batches were removed earlier).
  const unbatched = next.length === 0;
  const renamed = next.filter(b => { const old = prev.find(p => p.id === b.id); return old && old.name !== b.name; });
  if (!becameBatched && !unbatched && renamed.length === 0) return 0;
  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "student"), where("centerId", "==", centerId)));
  const ids = new Set(next.map(b => b.id));
  const wb = writeBatch(db);
  let n = 0;
  snap.docs.forEach(d => {
    const st = d.data();
    const cur = typeof st.batchId === "string" ? st.batchId : "";
    if (unbatched) {
      if (cur || (typeof st.batch === "string" && st.batch)) { wb.update(d.ref, { batchId: null, batch: null, updatedAt: serverTimestamp() }); n++; }
      return;
    }
    if (becameBatched && (!cur || !ids.has(cur))) {
      wb.update(d.ref, { batchId: next[0].id, batch: next[0].name, updatedAt: serverTimestamp() }); n++; return;
    }
    const r = renamed.find(b => b.id === cur);
    if (r && st.batch !== r.name) { wb.update(d.ref, { batch: r.name, updatedAt: serverTimestamp() }); n++; }
  });
  if (n > 0) await wb.commit();
  return n;
}

// ─── Date / format helpers (Center Detail view) ─────────────────────────────────

function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(n: number): string { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
function currentMonthStr(): string { return new Date().toISOString().slice(0, 7); }
function monthsAgoStr(n: number): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 7);
}
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtMonthLong(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[parseInt(m, 10) - 1] ?? m} ${y}`;
}
function fmtMonthShort(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTH_SHORT[parseInt(m, 10) - 1] ?? m} ${y?.slice(2)}`;
}
function fmtDateShort(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${parseInt(d, 10)} ${MONTH_SHORT[parseInt(m, 10) - 1] ?? m} ${y}`;
}
/** Firestore Timestamp / ISO string / Date → local "YYYY-MM-DD", or "" if unparseable. */
function toLocalYMD(v: unknown): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v && typeof v === "object" && "toDate" in v
    ? (v as { toDate(): Date }).toDate()
    : typeof v === "string" || typeof v === "number" || v instanceof Date ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toISODateLocal(v: unknown): string {
  if (v && typeof v === "object" && "toDate" in v) return (v as { toDate(): Date }).toDate().toISOString();
  if (typeof v === "string") return v;
  return "";
}
function attChip(color: string, bg: string, border: string): React.CSSProperties {
  return { display: "inline-block", padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 700, color, background: bg, border: `1px solid ${border}` };
}
const ATT_STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  present:           { bg: "#dcfce7", fg: "#16a34a" },
  absent:            { bg: "#fee2e2", fg: "#dc2626" },
  break:             { bg: "#fef9c3", fg: "#92400e" },
  cancelled_teacher: { bg: "#ede9fe", fg: "#5b21b6" },
  cancelled_student: { bg: "#f3f4f6", fg: "#6b7280" },
};

// ─── Center Detail data types ────────────────────────────────────────────────

interface CenterAttRec { id: string; studentUid: string; date: string; status: string; }
interface CenterStudentRec {
  uid: string; name: string; admissionNo: string; status: string; createdAt: string;
  /** When the student became inactive (ISO) — inactivatedAt, else the approval
   *  time, else the last update. "" when unknown. Drives the 60-day window. */
  inactiveSince?: string;
  /** Profile photo (admission `photo` data URL, or an uploaded photoURL) — "" when none. */
  photo?: string;
  /** Course title ("Introduction to Keyboard"), else the instrument(s) — see lib/course. */
  instrument?: string;
  batchId?: string | null;
}

/** First non-empty photo field on a user doc. */
function studentPhoto(st: Record<string, unknown>): string {
  for (const k of ["photo", "photoURL", "photoUrl", "avatarUrl"]) {
    const v = st[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
interface CenterTxRec { amount: number; date: string; status: string; type?: string; method?: string; }
interface PickedStudent {
  uid: string; name: string; admissionNo: string; createdAt: string; photo?: string; instrument?: string; batchId?: string | null;
  /** Centre the student is moving from (registry-wide add), if any. */
  fromCenterId?: string | null;
}

function countsAsActive(s: { status: string; admissionNo: string }): boolean {
  return isActiveStudentStatus(s.status) && hasAdmissionNo(s.admissionNo);
}
/** Who may type an admission number in — per wing (ROL+ → Founder / Admin). */
function canAssignAdmissionNo(role: string | null | undefined, wing: string | null | undefined): boolean {
  return canEnterAdmissionNo(role, wing) || (wing !== WINGS.ROL_PLUS && role === ROLES.ADMIN);
}

/**
 * Collapse duplicate student records (same admission number — e.g. imported
 * twice) to one roster row. Keeps the most complete record: active, then in a
 * batch, then the most attendance, then the oldest. The hidden copies are
 * returned so staff can merge them for real (MergeDuplicatesModal).
 */
/**
 * Which of one person's duplicate records the roster keeps — used by BOTH the
 * centre modal (dedupeRoster) and the centre/batch grid cards, so a student with
 * two records in different batches is counted in the same batch everywhere:
 * active → in a batch → most attendance at this centre → oldest.
 */
function byRosterPreference(attCount: Map<string, number>) {
  const score = (r: { uid: string; status: string; batchId?: string | null }) =>
    (isActiveStudentStatus(r.status) ? 1_000_000 : 0) + (r.batchId ? 100_000 : 0) + (attCount.get(r.uid) ?? 0);
  return (a: { uid: string; status: string; batchId?: string | null; createdAt: string },
          b: { uid: string; status: string; batchId?: string | null; createdAt: string }) =>
    score(b) - score(a) || safeCompare(a.createdAt, b.createdAt);
}

function dedupeRoster(list: CenterStudentRec[], attCount: Map<string, number>): { unique: CenterStudentRec[]; hidden: CenterStudentRec[] } {
  const groups = new Map<string, CenterStudentRec[]>();
  for (const r of list) {
    const k = normAdmNo(r.admissionNo) || `uid:${r.uid}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const unique: CenterStudentRec[] = [], hidden: CenterStudentRec[] = [];
  for (const g of groups.values()) {
    g.sort(byRosterPreference(attCount));
    unique.push(g[0]);
    hidden.push(...g.slice(1));
  }
  return { unique, hidden };
}

/** Toast text after a save; spells out the rename cascade when the name changed. */
function renameMessage(r: CenterRenameResult): string {
  const parts = [
    r.students ? `${r.students} student record${r.students !== 1 ? "s" : ""}` : "",
    r.applications ? `${r.applications} application${r.applications !== 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return `Center renamed to ${r.to}. All associated student records and ledgers updated successfully!`
    + (parts.length ? ` (${parts.join(", ")} relabelled)` : "");
}

function isManualPayment(t: CenterTxRec): boolean {
  return t.status === "completed" && t.type !== "fee_due" && t.type !== "charge" && t.method !== "auto" && t.method !== "auto-monthly";
}

// ─── View Modal (tabbed: Attendance History / Graphs & Insights) ───────────────

type ViewTab = "attendance" | "students" | "insights";

function ViewModal({ center: centerProp, onClose, teachers, onSaved, onActiveCount, initialBatch = "all" }: {
  center: Center; onClose: () => void; teachers: TeacherUser[]; onSaved?: (updated: Center, rename: CenterRenameResult | null) => void;
  /** Live active-student counts after roster changes — centre total + per batch id. */
  onActiveCount?: (centerId: string, count: number, perBatch: Map<string, number>) => void;
  /** Opened from a batch card → the roster starts filtered to that batch ("all" | batch id | "none"). */
  initialBatch?: string;
}) {
  // Local copy so a saved edit reflects immediately without waiting on the
  // parent's list to refetch — onSaved still fires so the grid stays in sync.
  const [center, setCenter] = useState(centerProp);
  const raw = center as Center & { daysOfWeek?: Day[]; startTime?: string; endTime?: string };
  const teacher = teachers.find(t => t.uid === center.teacherUid);
  const teacherLabel = teacher ? getTeacherDisplayName(teacher) : center.teacherUid || "-";
  const { wing: viewingWing } = useWing();

  // ── Edit mode ──────────────────────────────────────────────────────────────
  const [editing, setEditing]         = useState(false);
  const [editForm, setEditForm]       = useState({ ...EMPTY_FORM });
  const [editDayError, setEditDayError] = useState("");
  const [editErr, setEditErr]         = useState("");
  const [savingEdit, setSavingEdit]   = useState(false);

  function openEditMode() {
    setEditForm({
      name:       center.name,
      teacherUid: center.teacherUid,
      status:     center.status as "active" | "inactive",
      wing:       wingOf(center),
      daysOfWeek: raw.daysOfWeek ?? [],
      startTime:  raw.startTime  ?? "",
      endTime:    raw.endTime    ?? "",
      batches:    center.batches ?? [],
      demoClassDate:  center.demoClassDate  ?? "",
      firstClassDate: center.firstClassDate ?? "",
      subtitle:       center.subtitle ?? "",
      classType:      (center.classType === "personal" ? "personal" : "group") as "group" | "personal",
    });
    setEditDayError("");
    setEditErr("");
    setEditing(true);
  }

  function handleEditChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setEditErr("");
    setEditForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }
  function handleEditDaysChange(days: Day[]) {
    setEditForm(prev => ({ ...prev, daysOfWeek: days }));
    if (days.length > 0) setEditDayError("");
  }
  function handleEditBatchesChange(batches: CenterBatch[]) {
    setEditForm(prev => ({ ...prev, batches }));
  }

  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // Built at render time (needs the roster below).
  function getBatchGridItems(): BatchGridItem[] {
    return (center.batches ?? []).length > 0
    ? (center.batches ?? []).map(b => ({
        id: b.id, name: b.name, teacherUid: b.teacherUid || "",
        days: b.daysOfWeek ?? [], startTime: b.startTime, endTime: b.endTime,
        students: students.filter(st => st.batchId === b.id && countsAsActive(st)).length,
      }))
    : [{
        id: null, name: DEFAULT_BATCH_NAME, teacherUid: center.teacherUid || "",
        days: raw.daysOfWeek ?? [], startTime: raw.startTime ?? "", endTime: raw.endTime ?? "",
        students: students.filter(countsAsActive).length,
      }];
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    // Active → Inactive goes through the transfer/cancel step first.
    if (center.status === "active" && editForm.status === "inactive") { setConfirmDeactivate(true); return; }
    await saveEdit();
  }

  async function saveEdit() {
    setSavingEdit(true);
    setEditErr("");
    const timeSlot = buildTimeSlot(editForm.daysOfWeek, editForm.startTime, editForm.endTime);
    try {
      const rename = await updateCenter(center.id, {
        name:       editForm.name.trim(),
        teacherUid: editForm.teacherUid.trim(),
        status:     editForm.status,
        timeSlot,
        batches:    editForm.batches,
        demoClassDate:  editForm.demoClassDate,
        firstClassDate: editForm.firstClassDate,
        subtitle:       editForm.subtitle.trim(),
        classType:      editForm.wing === WINGS.ROL_PLUS ? editForm.classType : "group",
      });
      // Extra scheduling fields aren't in updateCenter's canonical whitelist —
      // patched directly, same as the page-level edit form does.
      const { doc: fsDoc, updateDoc, serverTimestamp } = await import("firebase/firestore");
      await updateDoc(fsDoc(db, "centers", center.id), {
        wing:       editForm.wing,
        daysOfWeek: editForm.daysOfWeek,
        startTime:  editForm.startTime,
        endTime:    editForm.endTime,
        updatedAt:  serverTimestamp(),
      });
      // First batches → current students go into Batch 1; renames follow onto students.
      const prevBatches = explicitBatches(center as unknown as Record<string, unknown>);
      await syncStudentsToBatches(center.id, prevBatches, editForm.batches)
        .catch(err => console.error("[centre] batch sync:", err));
      if (prevBatches.length === 0 && editForm.batches.length > 0) {
        const first = editForm.batches[0].id, ids = new Set(editForm.batches.map(b => b.id));
        setStudents(prev => prev.map(st => (!st.batchId || !ids.has(st.batchId) ? { ...st, batchId: first } : st)));
      }
      invalidateCache(`registry:${editForm.wing}:entries`);
      invalidateCache(`students:${editForm.wing}:students`);
      const updated = {
        ...center,
        name:       editForm.name.trim(),
        teacherUid: editForm.teacherUid.trim(),
        status:     editForm.status,
        wing:       editForm.wing,
        timeSlot,
        batches:    editForm.batches,
        demoClassDate:  editForm.demoClassDate,
        firstClassDate: editForm.firstClassDate,
        subtitle:       editForm.subtitle.trim(),
        classType:      editForm.wing === WINGS.ROL_PLUS ? editForm.classType : "group",
        daysOfWeek: editForm.daysOfWeek,
        startTime:  editForm.startTime,
        endTime:    editForm.endTime,
      } as Center & { daysOfWeek: Day[]; startTime: string; endTime: string };
      setCenter(updated);
      setEditing(false);
      onSaved?.(updated, rename);
    } catch (err) {
      console.error("[ViewModal] update error:", err);
      setEditErr(err instanceof Error ? err.message : "Failed to update center.");
    } finally {
      setSavingEdit(false);
    }
  }

  const [tab, setTab] = useState<ViewTab>("students");
  // Selected batch — shared by the batch cards and the roster's batch pills.
  // "all" | batch id | "none" (students whose batch no longer exists).
  const [batchFilter, setBatchFilter] = useState<string>(() => {
    const bs = centerProp.batches ?? [];
    return initialBatch === "all" && bs.length >= 2 ? bs[0].id : initialBatch;
  });
  const [attRecs,  setAttRecs]  = useState<CenterAttRec[]>([]);
  const [students, setStudents] = useState<CenterStudentRec[]>([]);
  // Duplicate records (same admission no.) collapsed out of the roster.
  const [hiddenDups, setHiddenDups] = useState<CenterStudentRec[]>([]);
  const [showMerge, setShowMerge]   = useState(false);
  const { role: viewerRole, user: viewer } = useAuth();
  const canMergeDuplicates = !!viewerRole && ([ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR] as string[]).includes(viewerRole);

  // ── Cancel today's class (Chief Teacher / Director / Admin / Founder) ──────
  // Same action as Attendance → "🚫 Cancel class": every active student's mark
  // for today becomes Cancelled (Teacher), Break stays. Offered only on a day
  // this centre (or one of its batches) has class.
  const todayLocal = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const classToday = (() => {
    const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
    const days = [...(raw.daysOfWeek ?? []), ...(center.batches ?? []).flatMap(b => b.daysOfWeek ?? [])].map(d => String(d).slice(0, 3).toLowerCase());
    return days.includes(dow);
  })();
  const [cancelledToday, setCancelledToday] = useState(false);
  const [confirmCancelToday, setConfirmCancelToday] = useState(false);
  const [cancellingToday, setCancellingToday] = useState(false);
  const [cancelTodayMsg, setCancelTodayMsg] = useState("");
  useEffect(() => {
    let off = false;
    getDoc(doc(db, "class_cancellations", `${center.id}_${todayLocal}`))
      .then(snap => { if (!off) setCancelledToday(snap.exists()); })
      .catch(() => {});
    return () => { off = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.id]);
  async function cancelTodaysClass(cancelTodayReason: string) {
    const uids = students.filter(st => countsAsActive(st)).map(st => st.uid);
    setCancellingToday(true);
    try {
      const { cancelled, keptBreak } = await cancelClass({
        centerId: center.id, date: todayLocal, studentUids: uids, markedBy: viewer?.uid ?? "", reason: cancelTodayReason,
      });
      setCancelledToday(true); setConfirmCancelToday(false);
      setCancelTodayMsg(`Today's class cancelled — ${cancelled.length} student${cancelled.length !== 1 ? "s" : ""} marked Cancelled${keptBreak.length ? `, ${keptBreak.length} kept on Break` : ""}.`);
    } catch (err) {
      console.error("Cancel today's class failed:", err);
      setCancelTodayMsg("Couldn't cancel today's class — try again.");
    } finally {
      setCancellingToday(false);
    }
  }
  /** Undo: every student's mark from before the cancellation comes back (or none). */
  async function undoTodaysCancel() {
    setCancellingToday(true); setCancelTodayMsg("");
    try {
      const { restored, cleared } = await undoCancelClass({ centerId: center.id, date: todayLocal, markedBy: viewer?.uid ?? "" });
      setCancelledToday(false);
      setCancelTodayMsg(`Cancellation undone — ${restored.length} mark${restored.length !== 1 ? "s" : ""} put back${cleared.length ? `, ${cleared.length} cleared to unmarked` : ""}.`);
    } catch (err) {
      console.error("Undo cancel failed:", err);
      setCancelTodayMsg("Couldn't undo the cancellation — try again.");
    } finally {
      setCancellingToday(false);
    }
  }
  const [txs,      setTxs]      = useState<CenterTxRec[]>([]);
  const [loading,  setLoading]  = useState(true);
  // Bumped after the roster is saved (Manage Active Students) → the roster re-reads
  // Firestore quietly (no spinner), so the list matches what was written without
  // closing and reopening the modal.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (reloadKey === 0) setLoading(true);
      try {
        const [attSnap, stuSnap, txSnap] = await Promise.all([
          getDocs(query(collection(db, "attendance"), where("centerId", "==", center.id))),
          getDocs(query(collection(db, "users"), where("role", "==", "student"), where("centerId", "==", center.id))),
          getDocs(query(collection(db, "transactions"), where("centerId", "==", center.id))),
        ]);
        if (cancelled) return;
        setAttRecs(attSnap.docs.map(d => {
          const r = d.data();
          return { id: d.id, studentUid: (r.studentUid ?? "") as string, date: (r.date ?? "") as string, status: (r.status ?? "") as string };
        }));
        const attCount = new Map<string, number>();
        attSnap.docs.forEach(d => {
          const uid = (d.data().studentUid ?? "") as string;
          if (uid) attCount.set(uid, (attCount.get(uid) ?? 0) + 1);
        });
        const { unique, hidden } = dedupeRoster(stuSnap.docs.filter(d => d.data().status !== "merged").map(d => {
          const st = d.data();
          return {
            uid: d.id,
            name: (st.displayName ?? st.name ?? "-") as string,
            admissionNo: (st.admissionNo ?? st.admissionNumber ?? "") as string,
            status: (st.status ?? st.studentStatus ?? "") as string,
            createdAt: toISODateLocal(st.createdAt),
            photo: studentPhoto(st),
            instrument: courseLabel(st),
            batchId: (st.batchId ?? null) as string | null,
            inactiveSince: sortKey(st.inactivatedAt) || sortKey(st.deactivationApprovedAt) || sortKey(st.updatedAt),
          };
        }), attCount);
        setStudents(unique);
        setHiddenDups(hidden);
        setTxs(txSnap.docs.map(d => {
          const t = d.data();
          return {
            amount: Number(t.amount ?? 0),
            date:   (t.date   ?? "") as string,
            status: (t.status ?? "") as string,
            type:   t.type   as string | undefined,
            method: t.method as string | undefined,
          };
        }));
      } catch (err) {
        console.error("[ViewModal] load error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [center.id, reloadKey]);

  const studentMap = useMemo(() => {
    const m = new Map<string, string>();
    students.forEach(s => m.set(s.uid, s.name));
    return m;
  }, [students]);

  // Sets exactly `activeUids` active and every other student at this centre
  // inactive — the "active roster" for the centre.
  /**
   * Sets one student's status (Deactivate, Undo, Restore). Only status /
   * studentStatus change — centerId and batchId are untouched, so a restored
   * student drops straight back into their batch. Registry, Attendance and
   * Finance all read this same user doc; the page caches that could show a
   * stale status are dropped so their next visit refetches.
   */
  async function setStudentStatus(uid: string, status: string) {
    const batch = writeBatch(db);
    const nowInactive = !isActiveStudentStatus(status);
    batch.update(doc(db, "users", uid), {
      status, studentStatus: status, updatedAt: serverTimestamp(),
      inactivatedAt: nowInactive ? new Date().toISOString() : null,
    });
    await batch.commit();
    patchStudentStatus(uid, status);
  }

  /** An admission number was assigned from the preview — the student joins the active roster. */
  function patchStudentAdmissionNo(uid: string, admissionNo: string) {
    setStudents(prev => prev.map(s => (s.uid === uid ? { ...s, admissionNo } : s)));
    const w = wingOf(center);
    invalidateCache(`students:${w}:students`);
    invalidateCache(`centers:${w}:activeCounts`);
    invalidateCache(`registry:${w}:entries`);
  }

  /** Reflect a status already written elsewhere (inactivation request / approval). */
  function patchStudentStatus(uid: string, status: string) {
    setStudents(prev => prev.map(s => (s.uid === uid
      ? { ...s, status, inactiveSince: isActiveStudentStatus(status) ? "" : new Date().toISOString() }
      : s)));
    const w = wingOf(center);
    invalidateCache(`students:${w}:students`);
    invalidateCache(`centers:${w}:activeCounts`);
    invalidateCache(`registry:${w}:entries`);
  }

  // Keep the centre card's "🎓 N" badge in step with this roster.
  // Batches are independent: each batch card shows only its own active students.
  const activeCount = useMemo(() => students.filter(countsAsActive).length, [students]);
  const perBatchActive = useMemo(() => {
    const m = new Map<string, number>();
    students.filter(countsAsActive).forEach(s => { if (s.batchId) m.set(s.batchId, (m.get(s.batchId) ?? 0) + 1); });
    return m;
  }, [students]);
  const perBatchKey = [...perBatchActive.entries()].sort().map(([b, n]) => `${b}:${n}`).join(",");
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!loadedRef.current) { loadedRef.current = true; return; }   // skip the initial load
    onActiveCount?.(center.id, activeCount, perBatchActive);
  }, [activeCount, perBatchKey, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Assigns existing/new students to this centre and marks them Active —
  // updates their `centerId` (the source of truth for centre membership) and
  // folds them straight into local state so the roster/count reflect it immediately.
  async function addStudentsToCenter(picked: PickedStudent[]) {
    const batch = writeBatch(db);
    const centreBatches = explicitBatches(center as unknown as Record<string, unknown>);
    picked.forEach(p => {
      const b = centreBatches.find(x => x.id === p.batchId);
      // Same centre/batch fields the Registry edit writes, so the student shows
      // under this centre + batch there, in rosters, attendance and finance.
      batch.update(doc(db, "users", p.uid), {
        centerId:      center.id,
        centre:        center.name,
        batchId:       b ? b.id : null,
        batch:         b ? b.name : null,
        status:        "active",
        studentStatus: "active",
        updatedAt:     serverTimestamp(),
      });
      // Keep the centres' roster mirrors in step when moving between centres.
      if (p.fromCenterId && p.fromCenterId !== center.id) {
        batch.update(doc(db, "centers", p.fromCenterId), { studentUids: arrayRemove(p.uid) });
      }
    });
    batch.update(doc(db, "centers", center.id), { studentUids: arrayUnion(...picked.map(p => p.uid)), updatedAt: serverTimestamp() });
    await batch.commit();
    // One active centre per person: any other record of the same student
    // (same admission no.) still active elsewhere is marked Inactive.
    await Promise.all(picked.map(p => enforceSingleActiveCentre({
      uid: p.uid, admissionNo: p.admissionNo, wing: wingOf(center), targetCenterId: center.id,
    }).catch(err => console.error("[centre] single-centre check:", err))));
    // Update the roster right away — students already listed (e.g. inactive here,
    // or moving batch) get their new status/batch too, not only new arrivals.
    const pickedById = new Map(picked.map(p => [p.uid, p]));
    setStudents(prev => {
      const existing = new Set(prev.map(s => s.uid));
      const updated = prev.map(s => {
        const p = pickedById.get(s.uid);
        return p ? { ...s, status: "active", batchId: p.batchId ?? null, admissionNo: p.admissionNo || s.admissionNo } : s;
      });
      const additions = picked
        .filter(p => !existing.has(p.uid))
        .map(p => ({ uid: p.uid, name: p.name, admissionNo: p.admissionNo, status: "active", createdAt: p.createdAt, photo: p.photo, instrument: p.instrument, batchId: p.batchId }));
      return [...updated, ...additions];
    });
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      {confirmDeactivate && (
        <div onClick={e => e.stopPropagation()}>
          <DeactivateCenterModal
            center={center}
            onClose={() => setConfirmDeactivate(false)}
            onConfirm={async ({ movedUids }) => {
              const moved = new Set(movedUids);
              setStudents(prev => prev
                .filter(s => !moved.has(s.uid))
                .map(s => s.status === "active" ? { ...s, status: "inactive" } : s));
              setConfirmDeactivate(false);
              await saveEdit();
            }}
          />
        </div>
      )}
      <div style={{ ...modalStyles.box, maxWidth: "min(1120px, 96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column" as const }} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <div>
            <div style={modalStyles.title}>{center.name}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" as const }}>
              <span style={styles.codeChip}>{(center as Center & { centerCode?: string }).centerCode || "-"}</span>
              <StatusBadge status={center.status} />
              {cancelledToday && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#4b5563", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 99, padding: "2px 9px" }}>🚫 Today&apos;s class cancelled</span>
              )}
              {cancelledToday && !editing && canCancelClass(viewerRole) && (
                <button type="button" onClick={undoTodaysCancel} disabled={cancellingToday}
                  title="Undo the cancellation — students get back the marks they had before"
                  style={{ fontSize: 11, fontWeight: 700, color: "#4338ca", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 99, padding: "2px 10px", cursor: "pointer" }}>
                  {cancellingToday ? "Undoing…" : "↩ Undo"}
                </button>
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            {!editing && (
              <button onClick={openEditMode} title="Edit center" style={viewStyles.editBtn}>✏ Edit</button>
            )}
            {!editing && classToday && !cancelledToday && canCancelClass(viewerRole) && center.status === "active" && (
              <CancelClassMenu label="Cancel today's class…" disabled={cancellingToday}
                onChoose={() => { setConfirmCancelToday(true); setCancelTodayMsg(""); }} />
            )}
            <button onClick={onClose} style={modalStyles.closeBtn}>×</button>
          </div>
        </div>

        {confirmCancelToday && (
          <CancelClassDialog
            title={`Cancel today's class — ${center.name}`}
            detail={<>Are you sure you want to cancel today&apos;s class (<b>{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</b>)? All {students.filter(st => countsAsActive(st)).length} active students are marked <b>Cancelled (Teacher)</b>; anyone already on Break stays on Break.</>}
            busy={cancellingToday}
            onConfirm={reason => cancelTodaysClass(reason)}
            onClose={() => setConfirmCancelToday(false)}
          />
        )}
        {cancelTodayMsg && !editing && (
          <div style={{ margin: "10px 20px 0", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 12px", fontSize: 12.5, color: "#374151" }}>
            {cancelTodayMsg}
          </div>
        )}

        {editing ? (
          <form onSubmit={handleSaveEdit} style={{ padding: "18px 20px", overflowY: "auto" as const, flex: 1 }}>
            <div style={formStyles.grid}>
              <FormField label="Name" required>
                <input name="name" value={editForm.name} onChange={handleEditChange} required
                  placeholder="e.g. Koramangala Center" style={formStyles.input} />
              </FormField>
              <FormField label="Subtitle / Identifier" fullWidth>
                <input name="subtitle" value={editForm.subtitle} onChange={handleEditChange} maxLength={40}
                  placeholder="e.g. Main Branch, Keyboard Division, Offline Campus" style={formStyles.input} />
                <span style={formStyles.helperText}>Optional — shown as a badge on the centre card to tell centres apart.</span>
              </FormField>
              <FormField label="Assigned Teacher">
                <select name="teacherUid" value={editForm.teacherUid} onChange={handleEditChange} style={formStyles.input}>
                  <option value="">— Unassigned —</option>
                  {teachers.map(t => (
                    <option key={t.uid} value={t.uid}>{getTeacherDisplayName(t)}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Status">
                <select name="status" value={editForm.status} onChange={handleEditChange} style={formStyles.input}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
              <FormField label="Assign Wing">
                <select name="wing" value={editForm.wing} onChange={handleEditChange} style={formStyles.input}>
                  <option value={WINGS.ROL_PLUS}>{WING_LABELS[WINGS.ROL_PLUS]}</option>
                  <option value={WINGS.SCHOOL_OF_MUSIC}>{WING_LABELS[WINGS.SCHOOL_OF_MUSIC]}</option>
                </select>
                {editForm.wing !== viewingWing && (
                  <span style={formStyles.helperText}>
                    Moving this centre out of the {WING_LABELS[viewingWing]} view.
                  </span>
                )}
              </FormField>
              {editForm.wing === WINGS.ROL_PLUS && (
                <FormField label="Class Type">
                  <select name="classType" value={editForm.classType} onChange={handleEditChange} style={formStyles.input}>
                    <option value="group">Group Class</option>
                    <option value="personal">Personal Class (1-on-1)</option>
                  </select>
                  <span style={formStyles.helperText}>Label on the centre card only — students&apos; class type and fees are unchanged.</span>
                </FormField>
              )}
              <FormField label="Start Time">
                <input name="startTime" type="time" value={editForm.startTime} onChange={handleEditChange}
                  style={formStyles.input} />
              </FormField>
              <FormField label="End Time">
                <input name="endTime" type="time" value={editForm.endTime} onChange={handleEditChange}
                  style={formStyles.input} />
              </FormField>
              <FormField label="Demo Class Date">
                <input name="demoClassDate" type="date" value={editForm.demoClassDate} onChange={handleEditChange}
                  style={formStyles.input} />
              </FormField>
              <FormField label="Date of First Class">
                <input name="firstClassDate" type="date" value={editForm.firstClassDate} onChange={handleEditChange}
                  style={formStyles.input} />
              </FormField>
              <FormField label="Days of Week" fullWidth>
                <DayChips selected={editForm.daysOfWeek} onChange={handleEditDaysChange} />
                {editDayError && <span style={formStyles.errorText}>{editDayError}</span>}
              </FormField>
              <FormField label="Batches" fullWidth>
                <BatchesEditor batches={editForm.batches} onChange={handleEditBatchesChange} teachers={teachers}
                  base={{ daysOfWeek: editForm.daysOfWeek, startTime: editForm.startTime, endTime: editForm.endTime, teacherUid: editForm.teacherUid }} />
              </FormField>
            </div>

            {editErr && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, color: "#dc2626", marginTop: 4 }}>
                {editErr}
              </div>
            )}

            <div style={{ ...formStyles.actions, gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => setEditing(false)} disabled={savingEdit} style={viewStyles.cancelBtn}>
                Cancel
              </button>
              <button type="submit" disabled={savingEdit} style={{ ...formStyles.submitBtn, opacity: savingEdit ? 0.6 : 1 }}>
                {savingEdit ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </form>
        ) : (
          <>
            {/* Quick facts */}
            <div style={viewStyles.quickFacts}>
              <QuickFact label="Wing"     value={WING_LABELS[wingOf(center)] ?? "-"} />
              <QuickFact label="Teacher"  value={teacherLabel} />
              {/* Primary metric = current strength; all-time registrations only as a subtle secondary line. */}
              <QuickFact label="Students" value={String(activeCount)} />
              {center.monthlyFee ? (
                <QuickFact label="Monthly Fee" value={`₹${center.monthlyFee.toLocaleString("en-IN")}`} />
              ) : null}
            </div>

            {/* Every batch as an equal card — teacher, days, time, students, actions */}
            {(() => {
              const all = getBatchGridItems();
              if (all.length < 2) return null;
              const tabBtn = (on: boolean): React.CSSProperties => ({
                padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit",
                background: on ? "#fff" : "transparent", color: on ? "#4338ca" : "#4b5563", boxShadow: on ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
              });
              return (
                <div role="tablist" aria-label="Batch" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const, marginBottom: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Batch view:</span>
                  <div style={{ display: "inline-flex", flexWrap: "wrap" as const, gap: 4, padding: 3, borderRadius: 10, background: "#f3f4f6" }}>
                    {all.map(it => (
                      <button key={it.id ?? "general"} type="button" role="tab" aria-selected={batchFilter === it.id}
                        onClick={() => { if (it.id) { setBatchFilter(it.id); setTab("students"); } }} style={tabBtn(batchFilter === it.id)}>
                        {it.name || "Unnamed batch"} ({it.students})
                      </button>
                    ))}
                    <button type="button" role="tab" aria-selected={batchFilter === "all"} onClick={() => setBatchFilter("all")} style={tabBtn(batchFilter === "all")}>
                      All batches ({activeCount})
                    </button>
                  </div>
                </div>
              );
            })()}
            <BatchGrid
              // Single-batch view: only the selected batch's card ("All batches" → every card).
              items={(() => { const all = getBatchGridItems(); const one = all.filter(it => it.id === batchFilter); return one.length ? one : all; })()}
              selectedId={batchFilter}
              onSelect={id => { setBatchFilter(prev => (prev === id ? "all" : id)); setTab("students"); }}
              teachers={teachers}
              centreActive={center.status === "active"}
            />

            {/* Sub-navigation tabs */}
            <div style={viewStyles.tabBar}>
              <button onClick={() => setTab("students")} style={{ ...viewStyles.tabBtn, ...(tab === "students" ? viewStyles.tabBtnActive : {}) }}>
                Students
              </button>
              <button onClick={() => setTab("attendance")} style={{ ...viewStyles.tabBtn, ...(tab === "attendance" ? viewStyles.tabBtnActive : {}) }}>
                Attendance History
              </button>
              <button onClick={() => setTab("insights")} style={{ ...viewStyles.tabBtn, ...(tab === "insights" ? viewStyles.tabBtnActive : {}) }}>
                Graphs &amp; Insights
              </button>
            </div>

            <div style={{ ...modalStyles.body, flex: 1, overflowY: "auto" as const }}>
              {loading ? (
                <div style={{ textAlign: "center" as const, padding: "48px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>
              ) : tab === "attendance" ? (
                <CenterAttendanceHistoryTab records={attRecs} studentMap={studentMap} centerName={center.name} />
              ) : tab === "students" ? (
                <>
                {hiddenDups.length > 0 && (
                  <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "9px 12px", marginBottom: 10, fontSize: 12.5, color: "#92400e" }}>
                    <span>
                      ⚠ {hiddenDups.length} duplicate record{hiddenDups.length !== 1 ? "s" : ""} hidden — same admission number as a student below
                      ({[...new Set(hiddenDups.map(d => d.name))].slice(0, 3).join(", ")}{new Set(hiddenDups.map(d => d.name)).size > 3 ? "…" : ""}).
                      {!canMergeDuplicates && " Ask a Director or Admin to merge them."}
                    </span>
                    {canMergeDuplicates && (
                      <button type="button" onClick={() => setShowMerge(true)}
                        style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: "#d97706", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                        Review &amp; merge
                      </button>
                    )}
                  </div>
                )}
                {showMerge && (
                  <MergeDuplicatesModal
                    onClose={() => setShowMerge(false)}
                    centreName={id => (id === center.id ? center.name : id ? "Another centre" : "")}
                  />
                )}
                <CenterStudentsTab
                  students={students}
                  onSetStatus={setStudentStatus}
                  onStatusChanged={patchStudentStatus}
                  onAdmissionNoAssigned={patchStudentAdmissionNo}
                  batches={explicitBatches(center as unknown as Record<string, unknown>)}
                  onAddStudents={addStudentsToCenter}
                  onRosterSaved={() => setReloadKey(k => k + 1)}
                  wing={center.wing}
                  centerId={center.id}
                  centerName={center.name}
                  batchFilter={batchFilter}
                  onBatchFilterChange={setBatchFilter}
                />
                </>
              ) : (
                <CenterInsightsTab records={attRecs} students={students} transactions={txs} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Batch grid (centre window) ───────────────────────────────────────────────
// Every batch as an equal, first-class card: name + status, teacher, days &
// time, enrolled students. Read-only — teacher, schedule and adding / removing
// batches are all changed through the window's ✏ Edit button. A centre with no
// batches shows its General Batch (the centre's own schedule) the same way.

interface BatchGridItem {
  /** null = the centre's implicit General Batch (no batches defined). */
  id:        string | null;
  name:      string;
  teacherUid: string;
  days:      string[];
  startTime: string;
  endTime:   string;
  students:  number;
}

function BatchGrid({ items, selectedId, onSelect, teachers, centreActive }: {
  items: BatchGridItem[];
  /** Batch currently filtering the roster ("all" when none). */
  selectedId?: string;
  /** Click a card → filter the roster to that batch (again → all batches). */
  onSelect?: (batchId: string) => void;
  teachers: TeacherUser[];
  centreActive: boolean;
}) {
  const keyOf = (id: string | null) => id ?? "__general__";

  return (
    <div style={{ margin: "0 0 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: "#4b5563", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
          Batches ({items.length})
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 250px), 1fr))", gap: 10 }}>
        {items.map((it, i) => {
          const k = keyOf(it.id);
          const time = formatTimeRange12(it.startTime, it.endTime);
          return (
            <div key={k}
              // Only real batches filter the roster (the implicit General Batch is the whole centre).
              onClick={e => {
                if (!it.id || !onSelect || items.length < 2) return;
                if ((e.target as HTMLElement).closest("select, button, input, a, label")) return;
                onSelect(it.id);
              }}
              title={it.id && onSelect && items.length >= 2 ? (selectedId === it.id ? "Showing this batch — click to show all batches" : "Show only this batch's students") : undefined}
              aria-pressed={it.id && items.length >= 2 ? selectedId === it.id : undefined}
              style={{
                border: selectedId === it.id ? "2px solid #4f46e5" : "1px solid #e0e7ff",
                background: selectedId === it.id ? "#f5f7ff" : "#fff",
                borderRadius: 12, padding: selectedId === it.id ? "11px 13px" : "12px 14px",
                boxShadow: selectedId === it.id ? "0 0 0 3px rgba(79,70,229,0.15)" : "0 1px 3px rgba(17,24,39,0.05)",
                cursor: it.id && onSelect && items.length >= 2 ? "pointer" : "default",
                display: "flex", flexDirection: "column" as const, gap: 8, minWidth: 0,
              }}>
              {/* Title row: name · status · students */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 8, borderBottom: "1px solid #eef2ff" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 800, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {it.name || "Unnamed batch"}
                  </div>
                  <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#6b7280", background: "#f3f4f6", borderRadius: 99, padding: "1px 7px" }}>Batch {i + 1}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 99, padding: "1px 7px", ...(centreActive ? { color: "#15803d", background: "#dcfce7" } : { color: "#6b7280", background: "#f3f4f6" }) }}>
                      {centreActive ? "● Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#4338ca", background: "#eef2ff", borderRadius: 8, padding: "4px 9px", flexShrink: 0, whiteSpace: "nowrap" as const }}>
                  🎓 {it.students} student{it.students !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Teacher */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ color: "#9ca3af", fontWeight: 600, width: 54, flexShrink: 0 }}>Teacher</span>
                <span style={{ fontWeight: 700, color: "#111827" }}>
                  {(() => { const t = teachers.find(x => x.uid === it.teacherUid); return t ? getTeacherDisplayName(t) : it.id ? "Same as centre teacher" : "Unassigned"; })()}
                </span>
              </div>

              {/* Schedule */}
              <div style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                <span style={{ color: "#9ca3af", fontWeight: 600, width: 54, flexShrink: 0 }}>Days</span>
                <span style={{ fontWeight: 600, color: "#374151" }}>{it.days.join(", ") || "Not set"}</span>
              </div>
              <div style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                <span style={{ color: "#9ca3af", fontWeight: 600, width: 54, flexShrink: 0 }}>Time</span>
                <span style={{ fontWeight: 700, color: "#111827" }}>{time || "Not set"}</span>
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuickFact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div style={viewStyles.quickFactLabel}>{label}</div>
      <div style={viewStyles.quickFactValue}>{value}</div>
      {hint && <div style={{ fontSize: 10.5, color: "#9ca3af", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// ─── Attendance History Tab ─────────────────────────────────────────────────

function CenterAttendanceHistoryTab({ records, studentMap, centerName }: {
  records: CenterAttRec[]; studentMap: Map<string, string>; centerName: string;
}) {
  const [month, setMonth] = useState(currentMonthStr());
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const monthRecs = useMemo(
    () => records.filter(r => r.date.startsWith(month)),
    [records, month]
  );

  const counts = useMemo(() => {
    const c = { present: 0, absent: 0, break: 0, cancelled: 0, total: monthRecs.length };
    monthRecs.forEach(r => {
      if (r.status === "present") c.present++;
      else if (r.status === "absent") c.absent++;
      else if (r.status === "break") c.break++;
      else if (r.status?.startsWith("cancelled")) c.cancelled++;
    });
    return c;
  }, [monthRecs]);

  const monthOptions = useMemo(() => {
    const set = new Set(records.map(r => r.date.slice(0, 7)));
    set.add(currentMonthStr());
    return Array.from(set).sort().reverse();
  }, [records]);

  // One row per session date — every student's mark that day rolled up into a
  // center-level summary. Individual marks are still available per row via
  // the expand toggle, but the aggregate is the default view.
  const sessions = useMemo(() => {
    const byDate = new Map<string, CenterAttRec[]>();
    monthRecs.forEach(r => {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r);
    });
    return Array.from(byDate.entries())
      .map(([date, recs]) => {
        const present = recs.filter(r => r.status === "present").length;
        const absent  = recs.filter(r => r.status === "absent").length;
        const total   = recs.length;
        return { date, recs, total, present, absent, pct: total > 0 ? (present / total) * 100 : 0 };
      })
      .sort((a, b) => safeCompare(b.date, a.date));
  }, [monthRecs]);

  if (records.length === 0) {
    return <div style={{ textAlign: "center" as const, padding: "48px 0", color: "#9ca3af", fontSize: 13 }}>No attendance history recorded for this centre yet.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap" as const, gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
          <span style={attChip("#16a34a", "#f0fdf4", "#bbf7d0")}>{counts.present} Present</span>
          <span style={attChip("#dc2626", "#fef2f2", "#fecaca")}>{counts.absent} Absent</span>
          <span style={attChip("#92400e", "#fffbeb", "#fde68a")}>{counts.break} Break</span>
          <span style={attChip("#6b7280", "#f9fafb", "#e5e7eb")}>{counts.cancelled} Cancelled</span>
          <span style={attChip("#1d4ed8", "#eff6ff", "#bfdbfe")}>{counts.total} Total</span>
        </div>
        <select value={month} onChange={e => setMonth(e.target.value)} style={{ ...formStyles.input, width: "auto" }}>
          {monthOptions.map(m => <option key={m} value={m}>{fmtMonthLong(m)}</option>)}
        </select>
      </div>

      {sessions.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>No attendance records for {fmtMonthLong(month)}.</div>
      ) : (
        <div style={{ maxHeight: 420, overflowY: "auto" as const, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={viewStyles.histTh}>Date</th>
                <th style={viewStyles.histTh}>Batch / Class</th>
                <th style={viewStyles.histTh}>Total Enrolled</th>
                <th style={viewStyles.histTh}>Present</th>
                <th style={viewStyles.histTh}>Absent</th>
                <th style={viewStyles.histTh}>Attendance %</th>
                <th style={{ ...viewStyles.histTh, width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => {
                const open = expandedDate === s.date;
                return (
                  <Fragment key={s.date}>
                    <tr
                      onClick={() => setExpandedDate(open ? null : s.date)}
                      style={{ background: i % 2 === 0 ? "#fff" : "#fafafa", cursor: "pointer" }}
                    >
                      <td style={viewStyles.histTd}>{fmtDateShort(s.date)}</td>
                      <td style={viewStyles.histTd}>{centerName}</td>
                      <td style={viewStyles.histTd}>{s.total}</td>
                      <td style={{ ...viewStyles.histTd, color: "#16a34a", fontWeight: 700 }}>{s.present}</td>
                      <td style={{ ...viewStyles.histTd, color: "#dc2626", fontWeight: 700 }}>{s.absent}</td>
                      <td style={viewStyles.histTd}>
                        {s.total > 0 ? `${s.present}/${s.total} (${s.pct.toFixed(1)}%)` : "—"}
                      </td>
                      <td style={{ ...viewStyles.histTd, textAlign: "center" as const, color: "#9ca3af" }}>
                        <span style={{ display: "inline-block", transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0, background: "#f9fafb" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
                            <thead>
                              <tr>
                                <th style={{ ...viewStyles.histTh, background: "#f3f4f6" }}>Student</th>
                                <th style={{ ...viewStyles.histTh, background: "#f3f4f6" }}>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {s.recs.map(r => {
                                const sc = ATT_STATUS_COLOR[r.status] ?? { bg: "#f3f4f6", fg: "#374151" };
                                return (
                                  <tr key={r.id}>
                                    <td style={viewStyles.histTd}>{studentMap.get(r.studentUid) ?? r.studentUid ?? "—"}</td>
                                    <td style={viewStyles.histTd}>
                                      <span style={{ ...styles.badge, background: sc.bg, color: sc.fg }}>{r.status.replace(/_/g, " ") || "—"}</span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Students Tab (roster + active/inactive management) ────────────────────

/** The centre's Inactive tab only lists students made inactive this recently. */

function CenterStudentsTab({ students, batches, onSetStatus, onStatusChanged, onAdmissionNoAssigned, onAddStudents, onRosterSaved, wing, centerId, centerName, batchFilter, onBatchFilterChange: setBatchFilter }: {
  /** Selected batch ("all" | batch id | "none") — owned by the modal so the batch cards and pills stay in sync. */
  batchFilter: string;
  onBatchFilterChange: (id: string) => void;
  students: CenterStudentRec[];
  /** Persist one student's status (and update the roster). */
  onSetStatus: (uid: string, status: string) => Promise<void>;
  /** Status already persisted by the inactivation service — just update the roster. */
  onStatusChanged: (uid: string, status: string) => void;
  onAdmissionNoAssigned: (uid: string, admissionNo: string) => void;
  /** This centre's named batches — resolves each student's batchId to a name. */
  batches: CenterBatch[];
  onAddStudents: (picked: PickedStudent[]) => Promise<void>;
  /** Called once a Manage Active Students save has fully finished — the modal re-syncs the roster. */
  onRosterSaved?: () => void;
  wing: Wing | undefined;
  centerId: string;
  centerName: string;
}) {
  const [search, setSearch]     = useState("");
  const [msg, setMsg]           = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showAdd, setShowAdd]   = useState(false);
  const [view, setView]         = useState<"active" | "needsAdmNo">("active");
  // Active students switched off but not yet saved — "Save Active Roster" commits them.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [savingRoster, setSavingRoster] = useState(false);
  const [preview, setPreview]   = useState<CenterStudentRec | null>(null);
  // Batch filter — only offered when the centre runs more than one batch.
  // Teachers can only request an inactivation; leadership inactivates directly.
  const { user: me, role: myRole } = useAuth();
  const canApprove = canApproveDeactivation(myRole, wing);

  // Banners auto-dismiss.
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(next: NonNullable<typeof msg>) {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(next);
    msgTimer.current = setTimeout(() => setMsg(null), 4000);
  }
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  const activeStudents   = useMemo(() => students.filter(countsAsActive), [students]);
  // Active status but no admission number — held out of the active roster until assigned.
  const needsAdmNo       = useMemo(() => students.filter(s => isActiveStudentStatus(s.status) && !hasAdmissionNo(s.admissionNo)), [students]);
  // Inactive students are never listed here — the centre roster shows only
  // students manually added as Active. Inactive records live in the Master Registry.
  const listed = view === "active" ? activeStudents : needsAdmNo;

  const inBatch = (s: CenterStudentRec) =>
    batchFilter === "all" ? true
    : batchFilter === "none" ? !batches.some(b => b.id === s.batchId)
    : s.batchId === batchFilter;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return listed
      .filter(inBatch)
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.admissionNo.toLowerCase().includes(q))
      .sort((a, b) => safeCompare(a.name, b.name));
  }, [listed, search, batchFilter, batches]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (view === "needsAdmNo" && needsAdmNo.length === 0) setView("active"); }, [view, needsAdmNo.length]);

  // Only already-active students are hidden from the picker — inactive ones
  // registered here are exactly who "+ Add Active Students" should offer.
  const activeUids = useMemo(() => new Set([...activeStudents, ...needsAdmNo].map(s => s.uid)), [activeStudents, needsAdmNo]);

  // No named batches → everyone is in the implicit General Batch (see lib/batches).
  function batchLabel(id: string | null | undefined): string {
    if (batches.length === 0) return DEFAULT_BATCH_NAME;
    return batches.find(b => b.id === id)?.name ?? "—";
  }

  async function handleAssign(picked: PickedStudent[], deactivate: { uid: string; name: string }[]) {
    setMsg(null);
    if (picked.length) await onAddStudents(picked);
    // Unticked current students: approvers inactivate them; teachers send them for review.
    if (deactivate.length) {
      if (canApprove) {
        await Promise.all(deactivate.map(d => onSetStatus(d.uid, "inactive")));
      } else {
        if (!me) throw new Error("Not signed in.");
        await Promise.all(deactivate.map(d =>
          requestStudentDeactivation(d.uid, { uid: me.uid, role: myRole, name: me.displayName, wing })
            .then(() => onStatusChanged(d.uid, DEACTIVATION_REQUESTED))));
      }
    }
    setShowAdd(false);
    onRosterSaved?.();   // re-sync the roster from Firestore (quietly)
    const parts = [
      picked.length ? `${picked.length} added as Active` : "",
      deactivate.length ? (canApprove ? `${deactivate.length} moved to Inactive` : `${deactivate.length} sent for inactivation review`) : "",
    ].filter(Boolean);
    flash({ type: "success", text: `Roster saved — ${parts.join(", ")}.` });
  }

  // Switched-off students still on the active roster (a pending-review row can't be toggled).
  const pendingOff = useMemo(
    () => activeStudents.filter(s => unticked.has(s.uid) && s.status !== DEACTIVATION_REQUESTED),
    [activeStudents, unticked]);

  function toggleActive(uid: string) {
    setUnticked(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  /** Commits the switches: every switched-off student goes Inactive (or to review for teachers). */
  async function saveActiveRoster() {
    if (pendingOff.length === 0) return;
    setSavingRoster(true);
    try {
      await handleAssign([], pendingOff.map(s => ({ uid: s.uid, name: s.name })));
      setUnticked(new Set());
    } catch (err) {
      flash({ type: "error", text: err instanceof Error ? err.message : "Failed to save roster." });
    } finally {
      setSavingRoster(false);
    }
  }

  const pill = (on: boolean): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer",
    border: on ? "1.5px solid #4f46e5" : "1px solid #e5e7eb",
    background: on ? "#eef2ff" : "#fff", color: on ? "#4338ca" : "#6b7280",
  });
  const rowBtn = (tone: "neutral" | "restore", disabled: boolean): React.CSSProperties => ({
    background: tone === "restore" ? "#f0fdf4" : "none",
    border: `1px solid ${tone === "restore" ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 6,
    padding: "3px 9px", fontSize: 11, fontWeight: tone === "restore" ? 700 : 400,
    color: tone === "restore" ? "#15803d" : "#6b7280", cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap" as const,
  });

  return (
    <div>
      {preview && (
        <StudentPreviewModal
          student={preview}
          centerName={centerName}
          batchName={batchLabel(preview.batchId)}
          wing={wing}
          onClose={() => setPreview(null)}
          onStatusChanged={(uid, st) => { onStatusChanged(uid, st); setPreview(p => (p && p.uid === uid ? { ...p, status: st } : p)); }}
          onAdmissionNoAssigned={(uid, no) => { onAdmissionNoAssigned(uid, no); setPreview(p => (p && p.uid === uid ? { ...p, admissionNo: no } : p)); }}
        />
      )}
      {showAdd && (
        <AddStudentsModal
          wing={wing}
          centerId={centerId}
          centerName={centerName}
          batches={batches}
          excludeUids={new Set(needsAdmNo.map(s => s.uid))}
          canApprove={canApprove}
          onClose={() => setShowAdd(false)}
          onAssign={handleAssign}
        />
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
          <div role="tablist" aria-label="Student status" style={{ display: "flex", gap: 6 }}>
            <button role="tab" aria-selected={view === "active"} onClick={() => setView("active")} style={pill(view === "active")}>
              Active ({activeStudents.length})
            </button>
            {needsAdmNo.length > 0 && (
              <button role="tab" aria-selected={view === "needsAdmNo"} onClick={() => setView("needsAdmNo")}
                title="Active students with no admission number — not counted as active until one is assigned"
                style={{ ...pill(view === "needsAdmNo"), ...(view === "needsAdmNo" ? { borderColor: "#dc2626", background: "#fef2f2", color: "#b91c1c" } : { color: "#b91c1c", borderColor: "#fecaca" }) }}>
                ⚠ Needs Adm. No. ({needsAdmNo.length})
              </button>
            )}
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or ID…"
            style={{ ...formStyles.input, width: 200 }}
          />
        </div>
        <button onClick={() => setShowAdd(true)} title="Manage active students — add or remove from the roster" aria-label="Manage active students"
          style={{
            width: 36, height: 36, borderRadius: "50%", border: "none", background: "#4f46e5", color: "#fff",
            fontSize: 22, fontWeight: 600, lineHeight: 1, cursor: "pointer", flexShrink: 0,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 8px rgba(79,70,229,0.35)",
          }}>
          +
        </button>
      </div>

      {batches.length >= 2 && (() => {
        const unassigned = listed.filter(s => !batches.some(b => b.id === s.batchId)).length;
        const bp = (on: boolean): React.CSSProperties => ({
          padding: "4px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const,
          border: on ? "1.5px solid #6366f1" : "1px solid #e5e7eb", background: on ? "#eef2ff" : "#fff", color: on ? "#4338ca" : "#4b5563",
        });
        return (
          <div role="group" aria-label="Filter by batch" style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, marginBottom: 10, alignItems: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginRight: 2 }}>🗂 Batch:</span>
            <button type="button" onClick={() => setBatchFilter("all")} style={bp(batchFilter === "all")}>All Batches ({listed.length})</button>
            {batches.map(b => (
              <button key={b.id} type="button" onClick={() => setBatchFilter(b.id)} style={bp(batchFilter === b.id)}>
                {b.name || "Unnamed"} ({listed.filter(s => s.batchId === b.id).length})
              </button>
            ))}
            {unassigned > 0 && (
              <button type="button" onClick={() => setBatchFilter("none")} style={{ ...bp(batchFilter === "none"), color: batchFilter === "none" ? "#b45309" : "#b45309" }}>
                No batch ({unassigned})
              </button>
            )}
          </div>
        );
      })()}

      {msg && (
        <div style={{
          marginBottom: 12, fontSize: 12.5, padding: "9px 12px", borderRadius: 8,
          background: msg.type === "success" ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${msg.type === "success" ? "#bbf7d0" : "#fecaca"}`,
          color: msg.type === "success" ? "#16a34a" : "#dc2626",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        }} role="status">
          <span>{msg.text}</span>
        </div>
      )}

      {view === "active" && activeStudents.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" as const,
          marginBottom: 10, padding: "9px 12px", borderRadius: 8, fontSize: 12.5,
          background: pendingOff.length ? "#fffbeb" : "#f8fafc",
          border: `1px solid ${pendingOff.length ? "#fde68a" : "#e2e8f0"}`,
          color: pendingOff.length ? "#92400e" : "#475569",
        }}>
          <span>
            {pendingOff.length === 0
              ? <>Switch a student <b>off</b> and save to remove them from the active roster.</>
              : canApprove
                ? <><b>{pendingOff.length}</b> switched off — they&apos;ll be marked <b>Inactive</b> on save (still in the Master Registry).</>
                : <><b>{pendingOff.length}</b> switched off — they&apos;ll be <b>sent for inactivation review</b> on save.</>}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {pendingOff.length > 0 && (
              <button type="button" onClick={() => setUnticked(new Set())} disabled={savingRoster}
                style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                Discard
              </button>
            )}
            <button type="button" onClick={saveActiveRoster} disabled={savingRoster || pendingOff.length === 0}
              style={{
                background: "#4f46e5", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, color: "#fff",
                cursor: savingRoster || pendingOff.length === 0 ? "default" : "pointer",
                opacity: savingRoster || pendingOff.length === 0 ? 0.5 : 1,
              }}>
              {savingRoster ? "Saving…" : "Save Active Roster"}
            </button>
          </div>
        </div>
      )}

      {listed.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "48px 0", color: "#9ca3af", fontSize: 13 }}>
          {view === "active"
            ? <>No active students at this centre yet. Use the <strong>+</strong> button to add some.</>
            : <>Every active student has an admission number.</>}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>
          {search.trim() || batchFilter === "all"
            ? "No students match."
            : batchFilter === "none"
              ? "No students without a batch."
              : <>No {view === "needsAdmNo" ? "students needing an admission no." : "active students"} in <b>{batches.find(b => b.id === batchFilter)?.name || "this batch"}</b> yet.{view === "active" && <> Use the <strong>+</strong> button to add some.</>}</>}
        </div>
      ) : (
        <>
        {view === "needsAdmNo" && (
          <div role="alert" style={{ marginBottom: 10, fontSize: 12.5, padding: "9px 12px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }}>
            <b>Missing Admission Number</b> — these students can&apos;t be classified as Active until one is assigned.
            Click a student to enter it.
          </div>
        )}
        <div style={{ maxHeight: 520, overflowY: "auto" as const, border: "1px solid #e5e7eb", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...rosterTh, width: 64 }}><span className="sr-only">Photo</span></th>
                <th style={{ ...rosterTh, width: "38%" }}>Student</th>
                <th style={rosterTh}>Course</th>
                <th style={rosterTh}>Batch</th>
                <th style={{ ...rosterTh, width: 160 }}>{view === "active" ? "Active" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.uid}
                  onClick={() => setPreview(s)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPreview(s); } }}
                  tabIndex={0}
                  title="View student details"
                  aria-label={`View details for ${s.name}`}
                  className="hover:bg-indigo-50 focus:bg-indigo-50 focus:outline-none"
                  style={{
                    background: view === "active" && unticked.has(s.uid) ? "#fef2f2" : i % 2 === 0 ? "#fff" : "#fafafa",
                    opacity: view === "active" && unticked.has(s.uid) ? 0.7 : 1,
                    cursor: "pointer",
                  }}>
                  <td style={{ ...rosterTd, paddingRight: 0, verticalAlign: "middle" as const }}>
                    <StudentAvatar name={s.name} photo={s.photo} />
                  </td>
                  <td style={{ ...rosterTd, verticalAlign: "middle" as const }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{s.name}</div>
                    {hasAdmissionNo(s.admissionNo)
                      ? <div style={{ fontSize: 11.5, color: "#9ca3af", fontFamily: "monospace", marginTop: 2 }}>{s.admissionNo}</div>
                      : <div style={{ fontSize: 11.5, color: "#b91c1c", fontWeight: 700, marginTop: 2 }}>⚠ Missing admission no.</div>}
                  </td>
                  <td style={{ ...rosterTd, verticalAlign: "middle" as const }}>{s.instrument && s.instrument !== "-" ? s.instrument : "—"}</td>
                  <td style={{ ...rosterTd, verticalAlign: "middle" as const }}>{batchLabel(s.batchId)}</td>
                  <td style={{ ...rosterTd, verticalAlign: "middle" as const }}>
                    {view === "needsAdmNo" ? (
                      <button onClick={e => { e.stopPropagation(); setPreview(s); }}
                        style={{ ...rowBtn("restore", false), background: "#fef2f2", borderColor: "#fecaca", color: "#b91c1c" }}>
                        Assign No.
                      </button>
                    ) : s.status === DEACTIVATION_REQUESTED ? (
                        <span title={wing === WINGS.ROL_PLUS ? "Inactivation requested — waiting for an Admin" : "Inactivation requested — waiting for a Chief Teacher / Director"}
                          style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3c7", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" as const }}>
                          ⏳ Pending review
                        </span>
                      ) : (
                        <ActiveSwitch on={!unticked.has(s.uid)} disabled={savingRoster} label={s.name}
                          onToggle={() => toggleActive(s.uid)} />
                    )}
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

// ─── Active on/off switch for a roster row ─────────────────────────────────────

function ActiveSwitch({ on, disabled, label, onToggle }: {
  on: boolean; disabled?: boolean; label: string; onToggle: () => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={`${label} active`} disabled={disabled}
      title={on ? "Active — switch off to remove from the roster" : "Will be removed on save — switch on to keep"}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      onKeyDown={e => e.stopPropagation()}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 0,
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
      }}>
      <span aria-hidden style={{
        position: "relative", width: 36, height: 20, borderRadius: 999, flexShrink: 0,
        background: on ? "#16a34a" : "#d1d5db", transition: "background 0.15s",
      }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: "50%",
          background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left 0.15s",
        }} />
      </span>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: on ? "#15803d" : "#b91c1c" }}>{on ? "Active" : "Inactive"}</span>
    </button>
  );
}

// ─── Student avatar — photo, or initials when there is none ────────────────────

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(p => p && p !== "-");
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last  = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function StudentAvatar({ name, photo, size = 36 }: { name: string; photo?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const box: React.CSSProperties = {
    width: size, height: size, borderRadius: "50%", flexShrink: 0, display: "block",
    border: "1px solid #e5e7eb",
  };
  if (photo && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data URLs / arbitrary storage URLs
      <img src={photo} alt={name} loading="lazy" onError={() => setBroken(true)}
        style={{ ...box, objectFit: "cover" as const, background: "#f3f4f6" }} />
    );
  }
  return (
    <div aria-hidden title={name} style={{
      ...box, background: "#e0e7ff", color: "#4338ca", fontWeight: 600,
      fontSize: Math.round(size * 0.36), display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {initialsOf(name)}
    </div>
  );
}

// ─── Student preview (click a roster row) ─────────────────────────────────────
// Opens over the centre modal. Loads the student doc + their ledger on open;
// balance and month status use the same finance helpers as the Finance page.

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtYM = (ym: string) => { const [y, m] = ym.split("-"); return `${SHORT_MONTHS[Number(m) - 1] ?? m} ${y}`; };
const fmtLongDate = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); };

/** Age from a stored age, or from a DD/MM/YYYY / ISO date of birth. */
function ageOf(st: Record<string, unknown>): string {
  if (st.age !== undefined && st.age !== null && String(st.age).trim()) return String(st.age).trim();
  const dob = typeof st.dob === "string" ? st.dob.trim() : typeof st.dateOfBirth === "string" ? st.dateOfBirth.trim() : "";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dob);
  const d = m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : new Date(dob);
  if (!dob || isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 120 ? String(age) : "";
}

function StudentPreviewModal({ student, centerName, batchName, wing, onClose, onStatusChanged, onAdmissionNoAssigned }: {
  student: CenterStudentRec; centerName: string; batchName: string; wing: Wing | undefined; onClose: () => void;
  onStatusChanged: (uid: string, status: string) => void;
  onAdmissionNoAssigned: (uid: string, admissionNo: string) => void;
}) {
  const { user: me, role: myRole } = useAuth();
  const canApprove = canApproveDeactivation(myRole, wing);
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing]         = useState(false);
  const [note, setNote]             = useState<{ ok: boolean; text: string } | null>(null);
  const missingAdmNo = !hasAdmissionNo(student.admissionNo);
  const canAssign    = canAssignAdmissionNo(myRole, wing);
  const [admInput, setAdmInput]     = useState("");
  const [admBusy, setAdmBusy]       = useState(false);
  const [admErr, setAdmErr]         = useState("");

  async function assignAdmissionNo() {
    const no = admInput.trim();
    if (no.length < 4) { setAdmErr("At least 4 characters."); return; }
    setAdmBusy(true); setAdmErr("");
    try {
      if (await isAdmissionNoTaken(no)) throw new Error(`Admission number ${no} is already in use. Please enter a different one.`);
      await claimAdmissionNo(String(wing || "rol_plus"), no, student.uid);   // one student per number in the wing
      await updateDoc(doc(db, "users", student.uid), {
        admissionNumber: no, admissionNo: no, studentID: no,
        admissionNoAutoGenerated: false,
        admissionNoEnteredBy: me?.uid ?? "", admissionNoEnteredAt: new Date().toISOString(),
        updatedAt: serverTimestamp(),
      });
      onAdmissionNoAssigned(student.uid, no);
      setAdmInput("");
      setNote({ ok: true, text: `Admission number ${no} assigned — ${student.name} is now on the active roster.` });
    } catch (e) {
      setAdmErr(e instanceof Error ? e.message : "Could not save the admission number.");
    } finally {
      setAdmBusy(false);
    }
  }
  const [doc_, setDoc_] = useState<Record<string, unknown> | null>(null);
  const [txs, setTxs]   = useState<Transaction[]>([]);
  const [err, setErr]   = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [snap, txSnap] = await Promise.all([
          getDoc(doc(db, "users", student.uid)),
          getDocs(query(collection(db, "transactions"), where("studentUid", "==", student.uid))),
        ]);
        if (!live) return;
        setDoc_(snap.exists() ? snap.data() : {});
        setTxs(txSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction));
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : "Could not load this student.");
      }
    })();
    return () => { live = false; };
  }, [student.uid]);

  // Escape closes just this preview (capture phase, so the centre modal underneath stays open).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const str = (k: string) => (doc_ && typeof doc_[k] === "string" ? (doc_[k] as string).trim() : "");
  const fin = useMemo(() => {
    const balance = computeStudentBalances(txs).get(student.uid) ?? 0;
    const settlements = computeDueSettlements(txs);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const current = Array.from(settlements.values()).find(x => x.studentUid === student.uid && x.billingMonth === thisMonth) ?? null;
    const dueTx = current ? txs.find(t => t.id === current.dueId) : undefined;
    const overdue = outstandingDuesForStudent(settlements, student.uid).filter(x => x.billingMonth < thisMonth);
    return { balance, current, dueDate: dueTx?.date ?? "", overdue, thisMonth };
  }, [txs, student.uid]);

  const loading = !doc_ && !err;
  const pending   = student.status === DEACTIVATION_REQUESTED;
  const isActive  = isActiveStudentStatus(student.status) && !pending;
  const requester = doc_ ? ((doc_.deactivationRequestedByName as string) || "") : "";
  const requestedAt = doc_ && typeof doc_.deactivationRequestedAt === "string" ? doc_.deactivationRequestedAt : "";
  const requestedBy = doc_ && typeof doc_.deactivationRequestedBy === "string" ? doc_.deactivationRequestedBy : null;
  const duesNote = fin.balance > 0 ? ` ${INR(fin.balance)} outstanding stays on the Finance page (Pending balance) until paid.` : "";

  async function act(kind: "request" | "approve" | "reject") {
    if (!me) return;
    setActing(true); setNote(null);
    const by = { uid: me.uid, role: myRole, name: me.displayName, wing };
    try {
      if (kind === "request") {
        await requestStudentDeactivation(student.uid, by);
        onStatusChanged(student.uid, DEACTIVATION_REQUESTED);
        setNote({ ok: true, text: "Your request has been sent for review." });
      } else if (kind === "approve") {
        await approveStudentDeactivation(student.uid, by, requestedBy);
        onStatusChanged(student.uid, "inactive");
        setNote({ ok: true, text: `${student.name} is now inactive.${duesNote}` });
      } else {
        await rejectStudentDeactivation(student.uid, by, requestedBy);
        onStatusChanged(student.uid, "active");
        setNote({ ok: true, text: "Request rejected — the student stays active." });
      }
      setConfirming(false);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setActing(false);
    }
  }
  const monthlyFee = doc_ ? Number(doc_.monthlyFee ?? 0) : 0;
  const perClass   = doc_ ? Number(doc_.feePerClass ?? 0) : 0;
  const feeLabel = doc_?.feeCycle === "per_class" && perClass > 0 ? `${INR(perClass)} / class` : monthlyFee > 0 ? `${INR(monthlyFee)} / month` : "—";
  const course = (doc_ ? courseLabel(doc_ as Record<string, unknown>) : "") || student.instrument || "";

  const monthState = fin.current
    ? fin.current.state === "paid"
      ? { label: "Paid", color: "#15803d", bg: "#dcfce7" }
      : fin.current.state === "partial"
        ? { label: `Partly paid · ${INR(fin.current.remaining)} left`, color: "#b45309", bg: "#fef3c7" }
        : { label: "Pending", color: "#b91c1c", bg: "#fee2e2" }
    : { label: "Not billed yet", color: "#6b7280", bg: "#f3f4f6" };

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8, fontSize: 13, padding: "3px 0" }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ color: "#111827", fontWeight: 500, minWidth: 0, overflowWrap: "anywhere" as const }}>{value || "—"}</span>
    </div>
  );
  const section = (title: string, children: React.ReactNode) => (
    <div style={{ borderTop: "1px solid #f3f4f6", padding: "12px 20px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
  const linkBtn: React.CSSProperties = {
    flex: "1 1 150px", textAlign: "center" as const, padding: "8px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600,
    textDecoration: "none", border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca",
  };

  return (
    <div
      onClick={e => { e.stopPropagation(); if (!boxRef.current?.contains(e.target as Node)) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(17,24,39,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div ref={boxRef} role="dialog" aria-modal="true" aria-label={`${student.name} — student details`}
        style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 460, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 16px 48px rgba(0,0,0,0.22)" }}>
        {/* Header */}
        <div style={{ display: "flex", gap: 14, alignItems: "center", padding: "18px 20px" }}>
          <StudentAvatar name={student.name} photo={student.photo || str("photo") || str("photoURL")} size={64} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>{student.name}</div>
            {missingAdmNo
              ? <div style={{ fontSize: 12, color: "#b91c1c", fontWeight: 700, marginTop: 2 }}>⚠ No admission number</div>
              : <div style={{ fontSize: 12, fontFamily: "monospace", color: "#4f46e5", fontWeight: 700, marginTop: 2 }}>{student.admissionNo}</div>}
            <div style={{ marginTop: 6 }}>
              {student.status === DEACTIVATION_REQUESTED
                ? <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3c7", borderRadius: 999, padding: "2px 9px" }}>⏳ Inactivation pending review</span>
                : <StatusBadge status={isActiveStudentStatus(student.status) ? "active" : (student.status || "inactive")} />}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close student details" title="Close (Esc)"
            className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            style={{ border: "none", background: "transparent", cursor: "pointer", alignSelf: "flex-start", lineHeight: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>

        {missingAdmNo && isActiveStudentStatus(student.status) && (
          <div role="alert" style={{ margin: "0 20px 12px", background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: "#991b1b" }}>
              ⚠ Missing Admission Number — cannot be classified as Active until assigned
            </div>
            {canAssign ? (
              <>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input value={admInput} onChange={e => { setAdmInput(cleanAdmissionNo(e.target.value)); setAdmErr(""); }}
                    onKeyDown={e => { if (e.key === "Enter") assignAdmissionNo(); }}
                    placeholder="Enter admission number" aria-label="Admission number" autoComplete="off"
                    style={{ flex: 1, minWidth: 0, border: "1.5px solid #fca5a5", borderRadius: 8, padding: "7px 10px", fontSize: 13, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.04em" }} />
                  <button type="button" onClick={assignAdmissionNo} disabled={admBusy || admInput.trim().length < 4}
                    style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const, opacity: admBusy || admInput.trim().length < 4 ? 0.55 : 1 }}>
                    {admBusy ? "Saving…" : "Assign Admission Number"}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: admErr ? "#dc2626" : "#991b1b", marginTop: 5, opacity: admErr ? 1 : 0.75 }}>
                  {admErr || "Entered manually · checked for duplicates."}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "#991b1b", marginTop: 4 }}>{wing === WINGS.ROL_PLUS ? "Ask an Admin to enter it." : "Ask a Chief Teacher or Director to enter it."}</div>
            )}
          </div>
        )}
        {err && <div style={{ margin: "0 20px 12px", fontSize: 12.5, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px" }}>{err}</div>}
        {loading ? (
          <div style={{ padding: "28px 20px", textAlign: "center" as const, fontSize: 13, color: "#9ca3af", borderTop: "1px solid #f3f4f6" }}>Loading details…</div>
        ) : (
          <>
            {section("Contact", <>
              {row("Phone", str("phone") ? <a href={`tel:${str("phone")}`} style={{ color: "#4f46e5", textDecoration: "none" }}>{str("phone")}</a> : "")}
              {row("Email", str("email") ? <a href={`mailto:${str("email")}`} style={{ color: "#4f46e5", textDecoration: "none" }}>{str("email")}</a> : "")}
              {row("Parent", str("parentName"))}
            </>)}
            {section("Academic", <>
              {row("Age", doc_ ? (ageOf(doc_) ? `${ageOf(doc_)} yrs` : "") : "")}
              {row("Course", course)}
              {row("Centre", centerName)}
              {row("Batch", batchName)}
            </>)}
            {section("Fees", <>
              {row("Fee", feeLabel)}
              {row(`${fmtYM(fin.thisMonth)}`, <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: monthState.color, background: monthState.bg, borderRadius: 999, padding: "2px 9px" }}>{monthState.label}</span>
                {fin.current && fin.current.state !== "paid" && fin.dueDate && <span style={{ fontSize: 12, color: "#6b7280" }}>due {fmtLongDate(fin.dueDate)}</span>}
              </span>)}
              {row("Outstanding", fin.balance > 0
                ? <span style={{ color: "#b91c1c", fontWeight: 700 }}>{INR(fin.balance)} due</span>
                : fin.balance < 0
                  ? <span style={{ color: "#15803d", fontWeight: 700 }}>{INR(-fin.balance)} credit</span>
                  : <span style={{ color: "#15803d", fontWeight: 700 }}>₹0</span>)}
              {fin.overdue.length > 0 && row("Unpaid months",
                <span style={{ color: "#b91c1c" }}>{fin.overdue.map(o => `${fmtYM(o.billingMonth)} (${INR(o.remaining)})`).join(", ")}</span>)}
            </>)}
          </>
        )}

        {/* Status: request / approve / reject inactivation */}
        {!loading && (pending || isActive) && (
          <div style={{ borderTop: "1px solid #f3f4f6", padding: "12px 20px" }}>
            {pending && (
              <div style={{ fontSize: 12.5, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", marginBottom: canApprove ? 10 : 0 }}>
                <b>Inactivation requested</b>{requester ? ` by ${requester}` : ""}{requestedAt ? ` on ${fmtLongDate(requestedAt)}` : ""}.
                {canApprove ? (fin.balance > 0 ? ` ${INR(fin.balance)} is outstanding — it stays on Finance after approval.` : "") : (wing === WINGS.ROL_PLUS ? " Waiting for an Admin to review." : " Waiting for a Chief Teacher / Director to review.")}
              </div>
            )}
            {pending && canApprove && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                <button type="button" disabled={acting} onClick={() => act("approve")}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: acting ? 0.6 : 1 }}>
                  {acting ? "…" : "Approve inactivation"}
                </button>
                <button type="button" disabled={acting} onClick={() => act("reject")}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: acting ? 0.6 : 1 }}>
                  Reject request
                </button>
              </div>
            )}
            {isActive && !confirming && (
              <button type="button" disabled={acting} onClick={() => (canApprove ? setConfirming(true) : act("request"))}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", color: "#b91c1c", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: acting ? 0.6 : 1 }}>
                {acting ? "…" : canApprove ? "Mark inactive" : "Mark inactive (send for review)"}
              </button>
            )}
            {isActive && confirming && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 12.5, color: "#7f1d1d", marginBottom: 8 }}>
                  Mark <b>{student.name}</b> inactive? They leave this centre&apos;s roster and attendance.{duesNote}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" disabled={acting} onClick={() => act("approve")}
                    style={{ flex: 1, padding: "7px 12px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: acting ? 0.6 : 1 }}>
                    {acting ? "…" : "Yes, mark inactive"}
                  </button>
                  <button type="button" disabled={acting} onClick={() => setConfirming(false)}
                    style={{ flex: 1, padding: "7px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {note && (
          <div role="status" style={{ margin: "0 20px 10px", fontSize: 12.5, borderRadius: 8, padding: "8px 12px",
            color: note.ok ? "#15803d" : "#dc2626", background: note.ok ? "#f0fdf4" : "#fef2f2", border: `1px solid ${note.ok ? "#bbf7d0" : "#fecaca"}` }}>
            {note.text}
          </div>
        )}

        {/* Quick actions — the student profile holds the per-student ledger, attendance and edit form */}
        <div style={{ borderTop: "1px solid #f3f4f6", padding: "14px 20px 18px", display: "flex", gap: 8, flexWrap: "wrap" as const }}>
          <Link href={`/dashboard/students/${student.uid}?tab=financial`} style={linkBtn}>₹ Financial ledger</Link>
          <Link href={`/dashboard/students/${student.uid}?tab=attendance`} style={linkBtn}>✓ Attendance record</Link>
          <Link href={`/dashboard/students/${student.uid}`} style={{ ...linkBtn, background: "#4f46e5", color: "#fff", border: "1px solid #4f46e5" }}>✏ Edit student</Link>
        </div>
      </div>
    </div>
  );
}

// ─── Add Active Students modal (students registered at this centre only) ──────

// A student belongs to the centre if their `centerId` matches, any entry of a
// multi-centre `centerIds` array matches, or — for registry imports whose
// centre name never resolved to a doc id — their raw `centre` name matches.
function isRegisteredAtCenter(st: Record<string, unknown>, centerId: string, centerName: string): boolean {
  if (st.centerId === centerId) return true;
  if (Array.isArray(st.centerIds) && st.centerIds.includes(centerId)) return true;
  const raw = typeof st.centre === "string" ? st.centre.trim().toLowerCase() : "";
  return !!raw && raw === centerName.trim().toLowerCase();
}

// Directors / Chief Teachers / Founder / Admin search the wing's whole student
// register (the same `users` records /dashboard/registry shows); teachers only
// see students already registered at this centre.
const REGISTRY_SEARCH_ROLES: string[] = [ROLES.FOUNDER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.ADMIN];

type AddCandidate = PickedStudent & {
  status: string; hereRegistered: boolean; currentCentre: string; activeElsewhere: boolean;
  /** Other records of the same person (same admission no.) folded into this row. */
  dupCount: number;
};

/**
 * One row per person: records sharing an admission number (duplicate student
 * docs) collapse to the one the roster would keep — registered at this centre
 * first, then byRosterPreference (active → in a batch → oldest). The folded
 * copies are never ticked, activated or inactivated from here; merge them in
 * Registry → Scan & Merge Duplicates.
 */
function onePerPerson(list: AddCandidate[]): AddCandidate[] {
  const groups = new Map<string, AddCandidate[]>();
  for (const c of list) {
    const k = normAdmNo(c.admissionNo) || `uid:${c.uid}`;
    const g = groups.get(k);
    if (g) g.push(c); else groups.set(k, [c]);
  }
  const prefer = byRosterPreference(new Map());
  const out: AddCandidate[] = [];
  groups.forEach(g => {
    const best = g.length === 1 ? g[0]
      : [...g].sort((a, b) => Number(b.hereRegistered) - Number(a.hereRegistered) || prefer(a, b))[0];
    out.push({ ...best, dupCount: g.length - 1 });
  });
  return out;
}

function AddStudentsModal({ wing, centerId, centerName, batches, excludeUids, canApprove, onClose, onAssign }: {
  wing: Wing | undefined;
  centerId: string;
  centerName: string;
  /** The centre's named batches ([] → everyone joins the implicit General Batch). */
  batches: CenterBatch[];
  excludeUids: Set<string>;
  /** Approvers inactivate unticked students; teachers send them for review. */
  canApprove: boolean;
  onClose: () => void;
  /** `picked` → make Active here; `deactivate` → this centre's actives left unticked. */
  onAssign: (picked: PickedStudent[], deactivate: { uid: string; name: string }[]) => Promise<void>;
}) {
  const { role } = useAuth();
  const registryWide = !!role && REGISTRY_SEARCH_ROLES.includes(role);
  const [loading, setLoading]       = useState(true);
  const [candidates, setCandidates] = useState<AddCandidate[]>([]);
  const [search, setSearch]         = useState("");
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [batchId, setBatchId]       = useState<string>(batches[0]?.id ?? "");
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  /** This centre's students who are Active right now — shown ticked; unticking one makes them Inactive on save. */
  const isActiveHere = (c: AddCandidate) => c.hereRegistered && isActiveStudentStatus(c.status);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [stuSnap, ctrSnap] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
          getDocs(collection(db, "centers")),
        ]);
        if (cancelled) return;
        const centreNames = new Map(ctrSnap.docs.map(d => [d.id, String(d.data().name ?? d.id)]));
        const rows: AddCandidate[] = stuSnap.docs
          .filter(d => {
            const st = d.data();
            if (wing && !inWing(st, wing)) return false;
            if (st.status === "deleted" || st.studentStatus === "deleted") return false;
            return registryWide || isRegisteredAtCenter(st, centerId, centerName);
          })
          .map(d => {
            const st = d.data();
            const cid = typeof st.centerId === "string" ? st.centerId : "";
            const status = (st.status ?? st.studentStatus ?? "") as string;
            const here = isRegisteredAtCenter(st, centerId, centerName);
            const freeText = typeof st.centre === "string" && st.centre.trim() && !centreNames.has(st.centre) ? st.centre.trim() : "";
            const currentCentre = here ? centerName : (cid && centreNames.get(cid)) || freeText;
            return {
              uid:          d.id,
              name:         (st.displayName ?? st.name ?? "-") as string,
              admissionNo:  (st.admissionNo ?? st.admissionNumber ?? "") as string,
              createdAt:    toISODateLocal(st.createdAt),
              status,
              photo:        studentPhoto(st),
              instrument:   courseLabel(st),
              batchId:      (st.batchId ?? null) as string | null,
              fromCenterId: here ? null : (cid || null),
              hereRegistered: here,
              currentCentre,
              activeElsewhere: !here && !!currentCentre && isActiveStudentStatus(status),
              dupCount:     0,
            };
          })
          .filter(s => !excludeUids.has(s.uid));
        const list = onePerPerson(rows)
          // This centre's active roster first, then its inactive students, then the rest of the register.
          .sort((a, b) =>
            Number(b.hereRegistered && isActiveStudentStatus(b.status)) - Number(a.hereRegistered && isActiveStudentStatus(a.status))
            || Number(b.hereRegistered) - Number(a.hereRegistered) || safeCompare(a.name, b.name));
        setCandidates(list);
        // Current actives start ticked — the roster is saved as a whole.
        setSelected(new Set(list.filter(c => c.hereRegistered && isActiveStudentStatus(c.status)).map(c => c.uid)));
      } catch (err) {
        console.error("[AddStudentsModal] load error:", err);
        setError("Failed to load students.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wing, centerId, centerName, registryWide]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // With no query, registry-wide search lists only this centre's own students
    // (plus anything already ticked) — the whole register appears as you type.
    if (!q) return registryWide ? candidates.filter(c => c.hereRegistered || selected.has(c.uid)) : candidates;
    return candidates.filter(s => s.name.toLowerCase().includes(q) || s.admissionNo.toLowerCase().includes(q));
  }, [candidates, search, registryWide, selected]);

  function toggle(uid: string) {
    setConfirmOff(false);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  const movingCount = candidates.filter(c => selected.has(c.uid) && c.activeElsewhere).length;

  // Newly activated = ticked and not already active here; turned off = active here but unticked.
  const toActivate   = candidates.filter(c => selected.has(c.uid) && !isActiveHere(c) && hasAdmissionNo(c.admissionNo));
  const toInactivate = candidates.filter(c => isActiveHere(c) && !selected.has(c.uid));
  const hasChanges   = toActivate.length > 0 || toInactivate.length > 0;

  async function handleAssign() {
    if (!hasChanges) return;
    if (toInactivate.length > 0 && !confirmOff) { setConfirmOff(true); return; }
    setSaving(true);
    setError("");
    try {
      await onAssign(
        toActivate.map(({ uid, name, admissionNo, createdAt, photo, instrument, fromCenterId }) => ({
          uid, name, admissionNo, createdAt, photo, instrument, fromCenterId,
          // New arrivals join the chosen batch (null = the centre's General Batch);
          // students already active here keep theirs.
          batchId: batches.length ? batchId || null : null,
        })),
        toInactivate.map(c => ({ uid: c.uid, name: c.name })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign students.");
      setSaving(false);
    }
  }

  const emptyText = candidates.length === 0
    ? registryWide ? "No students found in the register." : `No unassigned/inactive students found for ${centerName}.`
    : search.trim() ? "No students match." : `No inactive students registered at ${centerName} — type a name or admission no. to search the whole register.`;

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={{ ...modalStyles.box, maxWidth: 560, maxHeight: "84vh", display: "flex", flexDirection: "column" as const }} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Manage Active Students</span>
          <button onClick={onClose} style={modalStyles.closeBtn}>×</button>
        </div>

        <div style={{ padding: "14px 20px 0" }}>
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or admission no…"
            style={{ ...formStyles.input, width: "100%", boxSizing: "border-box" as const }}
          />
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>
            Ticked = Active at {centerName}. Untick a current student to move them to Inactive on save.
            {registryWide ? " Type to search the whole register." : ""}
          </div>
        </div>

        <div style={{ padding: "12px 20px", flex: 1, overflowY: "auto" as const }}>
          {loading ? (
            <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>{emptyText}</div>
          ) : (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 8 }}>
              {filtered.map((s, i) => {
                const isSelected = selected.has(s.uid);
                // No admission number → can't become an active student yet.
                const blocked = !hasAdmissionNo(s.admissionNo);
                const initials = s.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join("") || "?";
                return (
                  <label key={s.uid} title={blocked ? "Assign an admission number before adding as Active" : undefined} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", fontSize: 12.5, cursor: blocked ? "not-allowed" : "pointer",
                    opacity: blocked ? 0.6 : 1,
                    background: isSelected ? "#eef2ff" : i % 2 === 0 ? "#fff" : "#fafafa",
                    borderBottom: "1px solid #f3f4f6",
                  }}>
                    <input type="checkbox" checked={isSelected && !blocked} disabled={blocked} onChange={() => toggle(s.uid)} />
                    <div style={{ width: 32, height: 32, borderRadius: "50%", overflow: "hidden", flexShrink: 0, background: "#e0e7ff", color: "#4338ca", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 700 }}>
                      {s.photo ? <img src={s.photo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {s.name}
                        {s.dupCount > 0 && (
                          <span title={`This student has ${s.dupCount + 1} records with the same admission number — shown once here. Merge them in Registry → Scan & Merge Duplicates.`}
                            style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#92400e", background: "#fef3c7", borderRadius: 99, padding: "1px 7px" }}>
                            {s.dupCount + 1} records
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>
                        {blocked
                          ? <span style={{ color: "#b91c1c", fontWeight: 700 }}>⚠ no adm. no. — assign one first</span>
                          : <span style={{ fontFamily: "monospace" }}>{s.admissionNo}</span>}
                        {" · "}
                        {isActiveHere(s)
                          ? (isSelected
                              ? <span style={{ color: "#15803d", fontWeight: 600 }}>Active here</span>
                              : <span style={{ color: "#b91c1c", fontWeight: 700 }}>→ will become Inactive</span>)
                          : s.hereRegistered
                          ? <span>This centre · {s.status || "not active"}</span>
                          : s.currentCentre
                            ? <span style={{ color: s.activeElsewhere ? "#b45309" : undefined }}>
                                {s.currentCentre}{s.activeElsewhere ? " (active — will be moved)" : ` · ${s.status || "not active"}`}
                              </span>
                            : <span style={{ color: "#059669" }}>Unassigned</span>}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <div style={{ margin: "0 20px 10px", fontSize: 12, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "7px 10px" }}>
            {error}
          </div>
        )}

        <div style={{ ...modalStyles.body, borderTop: "1px solid #e5e7eb", flexDirection: "row" as const, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              {selected.size} active
              {toActivate.length > 0 ? ` · +${toActivate.length} new` : ""}
              {toInactivate.length > 0 ? <b style={{ color: "#b91c1c" }}>{` · ${toInactivate.length} → Inactive`}</b> : null}
              {movingCount > 0 ? ` · ${movingCount} moving from another centre` : ""}
            </span>
            {batches.length > 0 ? (
              <select value={batchId} onChange={e => setBatchId(e.target.value)} aria-label="Batch"
                style={{ ...formStyles.input, width: "auto", padding: "6px 8px", fontSize: 12 }}>
                {batches.map(b => <option key={b.id} value={b.id}>{b.name || "Unnamed batch"}</option>)}
              </select>
            ) : (
              <span style={{ fontSize: 11.5, color: "#9ca3af" }}>Batch: {DEFAULT_BATCH_NAME}</span>
            )}
          </div>
          <button
            onClick={handleAssign}
            disabled={!hasChanges || saving}
            style={{ ...formStyles.submitBtn, opacity: !hasChanges || saving ? 0.5 : 1 }}
          >
            {saving ? "Saving…" : "Save roster"}
          </button>
        </div>
        {confirmOff && toInactivate.length > 0 && (
          <div role="alertdialog" aria-label="Confirm inactivation" style={{ margin: "0 20px 16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#7f1d1d" }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {canApprove
                ? `${toInactivate.length} student${toInactivate.length !== 1 ? "s" : ""} will be marked Inactive:`
                : `${toInactivate.length} student${toInactivate.length !== 1 ? "s" : ""} will be sent for inactivation review:`}
            </div>
            <div style={{ marginBottom: 6 }}>{toInactivate.map(c => c.name).join(", ")}</div>
            <div style={{ fontSize: 11.5, opacity: 0.85, marginBottom: 8 }}>
              {canApprove
                ? "They leave this centre's roster, batches and attendance. Any outstanding fees stay on Finance until paid."
                : "They stay active until a Chief Teacher / Director / Admin approves."}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={handleAssign} disabled={saving}
                style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: "#dc2626", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                {saving ? "Saving…" : "Confirm & save"}
              </button>
              <button type="button" onClick={() => setConfirmOff(false)} disabled={saving}
                style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Graphs & Insights Tab ──────────────────────────────────────────────────

function CenterInsightsTab({ records, students, transactions }: {
  records: CenterAttRec[]; students: CenterStudentRec[]; transactions: CenterTxRec[];
}) {
  const activeStudents = students.filter(countsAsActive).length;

  const attTrend = useMemo(() => Array.from({ length: 14 }, (_, i) => {
    const date    = isoDaysAgo(13 - i);
    const dayRecs = records.filter(r => r.date === date);
    const pct     = dayRecs.length > 0 ? Math.round((dayRecs.filter(r => r.status === "present").length / dayRecs.length) * 100) : 0;
    return { label: new Date(date + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }), value: pct };
  }), [records]);

  const revTrend = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const ym  = monthsAgoStr(5 - i);
    const amt = transactions.filter(t => isManualPayment(t) && t.date?.startsWith(ym)).reduce((s, t) => s + t.amount, 0);
    return { label: fmtMonthShort(ym), value: amt };
  }), [transactions]);

  const growthTrend = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const ym    = monthsAgoStr(5 - i);
    const count = students.filter(s => s.createdAt?.slice(0, 7) === ym).length;
    return { label: fmtMonthShort(ym), value: count };
  }), [students]);

  const thisMonth  = currentMonthStr();
  const monthAtt   = records.filter(r => r.date.startsWith(thisMonth));
  const monthAttPct = monthAtt.length > 0 ? Math.round((monthAtt.filter(r => r.status === "present").length / monthAtt.length) * 100) : null;
  const monthRevenue = revTrend[revTrend.length - 1]?.value ?? 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const, marginBottom: 20 }}>
        <InsightKpi label="Active Students"    value={String(activeStudents)} color="#4f46e5" />
        <InsightKpi label="Attendance · Month" value={monthAttPct !== null ? `${monthAttPct}%` : "—"} color={monthAttPct !== null && monthAttPct < 60 ? "#dc2626" : "#16a34a"} />
        <InsightKpi label="Revenue · Month"    value={`₹${(monthRevenue / 1000).toFixed(1)}k`} color="#0891b2" />
      </div>

      <ChartPanel title="Attendance Trend" sub="daily % present · last 14 days">
        <MiniLineChart data={attTrend} color="#16a34a" formatValue={v => `${v}%`} />
      </ChartPanel>
      <ChartPanel title="Revenue Trend" sub="collected · last 6 months">
        <MiniBarChart data={revTrend} color="#4f46e5" formatValue={v => `₹${(v / 1000).toFixed(1)}k`} />
      </ChartPanel>
      <ChartPanel title="Student Growth" sub="new enrollments · last 6 months">
        <MiniBarChart data={growthTrend} color="#0891b2" formatValue={v => String(v)} />
      </ChartPanel>
    </div>
  );
}

function InsightKpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderTop: `3px solid ${color}`, borderRadius: 10, padding: "10px 16px", minWidth: 130, flex: 1 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function ChartPanel({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#111" }}>{title}</div>
        {sub && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Chart primitives (pure SVG, no library) ──────────────────────────────────

function MiniLineChart({ data, color, formatValue }: {
  data: { label: string; value: number }[]; color: string; formatValue: (v: number) => string;
}) {
  const W = 760, H = 110, PL = 10, PR = 10, PT = 20, PB = 24;
  const vals  = data.map(d => d.value);
  const maxV  = Math.max(...vals, 1);
  const minV  = Math.min(...vals, 0);
  const range = maxV - minV || 1;
  const xStep = (W - PL - PR) / Math.max(data.length - 1, 1);
  const y = (v: number) => PT + ((maxV - v) / range) * (H - PT - PB);
  const x = (i: number) => PL + i * xStep;
  const pts = data.map((_, i) => `${x(i)},${y(vals[i])}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(vals[i])} r={2.5} fill={color} />
          {(i === 0 || i === data.length - 1 || i % 3 === 0) && (
            <text x={x(i)} y={H - PB + 13} textAnchor="middle" fontSize={9} fill="#9ca3af">{d.label}</text>
          )}
        </g>
      ))}
      {data.length > 0 && (
        <text x={x(data.length - 1)} y={y(vals[vals.length - 1]) - 8} textAnchor="end" fontSize={10} fill={color} fontWeight={700}>
          {formatValue(vals[vals.length - 1])}
        </text>
      )}
    </svg>
  );
}

function MiniBarChart({ data, color, formatValue }: {
  data: { label: string; value: number }[]; color: string; formatValue: (v: number) => string;
}) {
  const W = 760, H = 120, PL = 4, PR = 4, PT = 20, PB = 24;
  const maxV = Math.max(...data.map(d => d.value), 1);
  const bW   = (W - PL - PR) / data.length;
  const gap  = bW * 0.24;
  const bW2  = bW - gap;
  const bH   = (v: number) => Math.max(3, (v / maxV) * (H - PT - PB));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }}>
      <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="#e5e7eb" />
      {data.map((d, i) => {
        const barH = bH(d.value);
        const bx   = PL + i * bW + gap / 2;
        const by   = H - PB - barH;
        return (
          <g key={i}>
            <rect x={bx} y={by} width={bW2} height={barH} rx={3} fill={color} opacity={0.85} />
            <text x={bx + bW2 / 2} y={by - 5} textAnchor="middle" fontSize={9} fill={color} fontWeight={700}>{formatValue(d.value)}</text>
            <text x={bx + bW2 / 2} y={H - PB + 13} textAnchor="middle" fontSize={9} fill="#9ca3af">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CentersPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]}>
      <CentersContent />
    </ProtectedRoute>
  );
}

function CentersContent() {
  const { user, role }              = useAuth();
  const { wing }                    = useWing();
  // Seed from the last visit's cache so switching back to Centers renders
  // instantly instead of a blank loading state — fetchCenters() below still
  // always re-fetches to stay fresh.
  const [centers, setCenters]       = useState<Center[]>(() => getCached(`centers:${wing}:centers`) ?? []);
  const [teachers, setTeachers]     = useState<TeacherUser[]>(() => getCached(`centers:${wing}:teachers`) ?? []);
  const [activeCounts, setActiveCounts] = useState<Map<string, number>>(
    () => getCached(`centers:${wing}:activeCounts`) ?? new Map(),
  );
  // centreId → earliest student admission date ("YYYY-MM-DD").
  const [earliestAdmissions, setEarliestAdmissions] = useState<Map<string, string>>(
    () => getCached(`centers:${wing}:earliestAdmissions`) ?? new Map(),
  );
  const [loading, setLoading]       = useState(() => !getCached<Center[]>(`centers:${wing}:centers`));
  const [showForm, setShowForm]     = useState(false);
  const [editTarget, setEditTarget] = useState<Center | null>(null);
  const [viewTarget, setViewTarget] = useState<Center | null>(null);
  // Batch card that opened the modal ("all" for a whole-centre card).
  const [viewBatch, setViewBatch] = useState<string>("all");
  const [deleteTarget, setDeleteTarget] = useState<Center | null>(null);
  const [showMatrix, setShowMatrix] = useState(false);

  // Deep link: ?centerId=…&openModal=true (e.g. a dashboard "Today's Classes"
  // card) opens that centre's detail modal once the centres have loaded. The
  // params are then dropped so closing the modal / refreshing doesn't reopen it.
  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const deepCentreId = searchParams.get("openModal") === "true" ? searchParams.get("centerId") ?? "" : "";
  useEffect(() => {
    if (!deepCentreId || centers.length === 0) return;
    const target = centers.find(c => c.id === deepCentreId);
    if (!target) return;
    setViewTarget(target);
    const q = new URLSearchParams(searchParams.toString());
    q.delete("centerId");
    q.delete("openModal");
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepCentreId, centers]);
  const [form, setForm]           = useState({ ...EMPTY_FORM });
  const [saving, setSaving]         = useState(false);
  const [dayError, setDayError]     = useState("");
  // "Select existing" name mode — new batches are appended to a registered centre (by id)
  // instead of typing a centre name, so no duplicate / mistyped centre is created.
  const [useExisting, setUseExisting]       = useState(false);
  const [existingId, setExistingId]         = useState("");
  const [existingSearch, setExistingSearch] = useState("");
  const [nameError, setNameError]           = useState("");
  // Edit panel: the name is locked until "✏ Edit Name" — a rename cascades to rosters and admissions.
  const [renaming, setRenaming]             = useState(false);
  const { toasts, toast, remove }   = useToast();

  // Oldest centre first, by effective demo date (manual override, else the
  // earliest student admission). Undated centres go last, by creation time.
  const sortedCenters = useMemo(() => [...centers].sort((a, b) => {
    const da = effectiveDemoDate(a, earliestAdmissions);
    const db = effectiveDemoDate(b, earliestAdmissions);
    if (da !== db) return !da ? 1 : !db ? -1 : safeCompare(da, db);
    // createdAt is a Firestore Timestamp on centres created in-app — never assume a string.
    return safeCompare(a.createdAt, b.createdAt);
  }), [centers, earliestAdmissions]);
  const activeCentersList   = useMemo(() => sortedCenters.filter(c => c.status === "active"), [sortedCenters]);
  const inactiveCentersList = useMemo(() => sortedCenters.filter(c => c.status !== "active"), [sortedCenters]);
  // Inactive centres stay folded away until the header is clicked.
  const [isInactiveExpanded, setIsInactiveExpanded] = useState(false);
  const pendingFirstClass   = useMemo(() => activeCentersList.filter(needsFirstClassDate), [activeCentersList]);
  const firstClassInputRef  = useRef<HTMLInputElement>(null);

  // Bumped per fetch so a slow response for a wing the user has already
  // switched away from can never overwrite the current wing's centres.
  const fetchSeq = useRef(0);

  async function fetchCenters() {
    const seq = ++fetchSeq.current;
    const cachedCenters = getCached<Center[]>(`centers:${wing}:centers`);
    // Seed from this wing's cache, or clear — never keep showing another wing's centres.
    setCenters(cachedCenters ?? []);
    setTeachers(getCached(`centers:${wing}:teachers`) ?? []);
    setActiveCounts(getCached(`centers:${wing}:activeCounts`) ?? new Map());
    setEarliestAdmissions(getCached(`centers:${wing}:earliestAdmissions`) ?? new Map());
    if (!cachedCenters) setLoading(true);
    try {
      const [data, teacherList, studentSnap] = await Promise.all([
        getCenters(wing),
        getTeachers(wing),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
      ]);
      if (seq !== fetchSeq.current) return;
      setCenters(data);
      setCached(`centers:${wing}:centers`, data);
      const sortedTeachers = teacherList.sort((a, b) => safeCompare(getTeacherDisplayName(a), getTeacherDisplayName(b)));
      setTeachers(sortedTeachers);
      setCached(`centers:${wing}:teachers`, sortedTeachers);

      const counts = new Map<string, number>();
      const people = new Map<string, { uid: string; cid: string; status: string; batchId: string | null; createdAt: string }[]>();   // centre|admission no. → that person's active records
      const earliest = new Map<string, string>();
      studentSnap.docs.forEach(d => {
        const st = d.data();
        const cid = (st.centerId ?? "") as string;
        if (!cid) return;
        // Earliest admission counts every student ever at the centre, not just
        // active ones — same precedence as the registry's "Admitted on".
        const admitted = toLocalYMD(st.dateOfAdmission ?? st.admissionDate ?? st.createdAt);
        if (admitted && (!earliest.has(cid) || admitted < earliest.get(cid)!)) earliest.set(cid, admitted);
        if (!isActiveStudentStatus((st.status ?? st.studentStatus ?? "") as string)) return;
        if (!hasAdmissionNo(st.admissionNo ?? st.admissionNumber)) return;   // held until assigned
        if (st.status === "merged") return;
        const personKey = `${cid}|${normAdmNo(String(st.admissionNo ?? st.admissionNumber ?? ""))}`;
        const rec = { uid: d.id, cid, status: String(st.status ?? st.studentStatus ?? ""), batchId: (st.batchId ?? null) as string | null, createdAt: toISODateLocal(st.createdAt) };
        const g = people.get(personKey);
        if (g) g.push(rec); else people.set(personKey, [rec]);
      });
      // One count per person. When a person has duplicate records, keep the same
      // record the centre modal keeps (byRosterPreference) — that needs their
      // attendance here, fetched only for those few duplicate records.
      const dupRecs = [...people.values()].filter(g => g.length > 1).flat();
      const dupAtt = new Map<string, number>();
      for (let i = 0; i < dupRecs.length; i += 30) {
        const chunk = dupRecs.slice(i, i + 30);
        const centreOf = new Map(chunk.map(r => [r.uid, r.cid]));
        const snap = await getDocs(query(collection(db, "attendance"), where("studentUid", "in", chunk.map(r => r.uid)))).catch(() => null);
        snap?.docs.forEach(a => {
          const uid = a.data().studentUid as string;
          if (a.data().centerId === centreOf.get(uid)) dupAtt.set(uid, (dupAtt.get(uid) ?? 0) + 1);
        });
      }
      people.forEach(g => {
        const best = g.length > 1 ? [...g].sort(byRosterPreference(dupAtt))[0] : g[0];
        counts.set(best.cid, (counts.get(best.cid) ?? 0) + 1);
        if (best.batchId) counts.set(`${best.cid}|${best.batchId}`, (counts.get(`${best.cid}|${best.batchId}`) ?? 0) + 1);
      });
      setActiveCounts(counts);
      setCached(`centers:${wing}:activeCounts`, counts);
      setEarliestAdmissions(earliest);
      setCached(`centers:${wing}:earliestAdmissions`, earliest);
    } catch (err) {
      console.error("Failed to fetch centers:", err);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }

  // Switching wings closes any open centre modal/form — it belongs to the old wing.
  useEffect(() => {
    setViewTarget(null);
    setEditTarget(null);
    setDeleteTarget(null);
    setShowForm(false);
    setShowMatrix(false);
    fetchCenters();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wing]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    if (e.target.name === "name") setNameError("");
  }

  const existingCenter = useMemo(() => centers.find(c => c.id === existingId) ?? null, [centers, existingId]);
  const existingBatchIds = useMemo(
    () => new Set(existingCenter ? explicitBatches(existingCenter as unknown as Record<string, unknown>).map(b => b.id) : []),
    [existingCenter]);
  const existingMatches = useMemo(() => {
    const q = existingSearch.trim().toLowerCase();
    return [...centers]
      .filter(c => c.status === "active" && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => safeCompare(a.name, b.name));
  }, [centers, existingSearch]);

  /** Bind the form to a registered centre: it inherits the centre's wing, teacher, schedule and batches. */
  function pickExisting(c: Center) {
    const raw = c as Center & { daysOfWeek?: Day[]; startTime?: string; endTime?: string };
    setExistingId(c.id);
    setForm({
      ...EMPTY_FORM,
      name:       c.name,
      teacherUid: c.teacherUid,
      status:     c.status as "active" | "inactive",
      wing:       wingOf(c),
      daysOfWeek: raw.daysOfWeek ?? [],
      startTime:  raw.startTime  ?? "",
      endTime:    raw.endTime    ?? "",
      batches:    explicitBatches(c as unknown as Record<string, unknown>),
    });
  }

  function toggleUseExisting(on: boolean) {
    setUseExisting(on);
    setExistingId("");
    setExistingSearch("");
    setNameError("");
    setForm({ ...EMPTY_FORM, wing });
  }

  function handleDaysChange(days: Day[]) {
    setForm(prev => ({ ...prev, daysOfWeek: days }));
    if (days.length > 0) setDayError("");
  }
  function handleBatchesChange(batches: CenterBatch[]) {
    setForm(prev => ({ ...prev, batches }));
  }

  function openCreate() {
    setEditTarget(null);
    // Default to the wing currently being viewed — still explicit/overridable,
    // just a sane starting point instead of forcing a blank pick every time.
    setForm({ ...EMPTY_FORM, wing });
    setDayError("");
    setShowForm(true);
  }

  function openEdit(center: Center) {
    const raw = center as Center & { daysOfWeek?: Day[]; startTime?: string; endTime?: string };
    setEditTarget(center);
    setRenaming(false);
    setForm({
      name:       center.name,
      teacherUid: center.teacherUid,
      status:     center.status as "active" | "inactive",
      wing:       wingOf(center),
      daysOfWeek: raw.daysOfWeek ?? [],
      startTime:  raw.startTime  ?? "",
      endTime:    raw.endTime    ?? "",
      batches:    center.batches ?? [],
      demoClassDate:  center.demoClassDate  ?? "",
      firstClassDate: center.firstClassDate ?? "",
      subtitle:       center.subtitle ?? "",
      classType:      (center.classType === "personal" ? "personal" : "group") as "group" | "personal",
    });
    setDayError("");
    setShowForm(true);
  }

  /** Opens the edit panel for `center` and focuses its first-class date picker. */
  function setFirstClassFor(center: Center) {
    openEdit(center);
    setTimeout(() => {
      const el = firstClassInputRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus();
    }, 280); // after the drawer slide-in
  }

  function closeForm() {
    setShowForm(false);
    setEditTarget(null);
    setForm({ ...EMPTY_FORM });
    setDayError("");
    setUseExisting(false);
    setExistingId("");
    setExistingSearch("");
    setNameError("");
    setRenaming(false);
  }

  const [deactivateTarget, setDeactivateTarget] = useState<Center | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Active → Inactive goes through the transfer/cancel step first.
    if (editTarget && editTarget.status === "active" && form.status === "inactive") { setDeactivateTarget(editTarget); return; }
    if (!editTarget && useExisting) { await appendToExisting(); return; }
    // A typed name that matches a registered centre would make a second card — point to "Select existing".
    if (!editTarget && form.wing === wing) {
      const typed = form.name.trim().toLowerCase();
      if (centers.some(c => c.name.trim().toLowerCase() === typed)) {
        setNameError("A centre with this name is already registered — switch to \"📋 Select existing\" to add a batch to it.");
        return;
      }
    }
    await saveForm();
  }

  /** Appends the new batches to the selected centre's batches[] — same centerId, no new card. */
  async function appendToExisting() {
    if (!existingCenter) { toast("Select a registered centre first.", "error"); return; }
    const added = form.batches.filter(b => !existingBatchIds.has(b.id));
    // A batch-less centre gets its schedule turned into Batch 1 as well — only count the user's new ones.
    const newCount = existingBatchIds.size === 0 ? Math.max(0, added.length - 1) : added.length;
    if (newCount === 0) { toast("Add at least one new batch.", "error"); return; }
    setSaving(true);
    try {
      // Re-read: if the centre's batches changed since this list loaded, don't overwrite them.
      const fresh = await getDoc(doc(db, "centers", existingCenter.id));
      if (!fresh.exists()) throw new Error("This centre no longer exists.");
      const prev = explicitBatches(fresh.data());
      if (prev.length !== existingBatchIds.size || prev.some(b => !existingBatchIds.has(b.id))) {
        throw new Error("This centre's batches were changed elsewhere — close and try again.");
      }
      // Existing batches are always kept exactly as saved.
      const next = [...prev, ...added];
      await updateCenter(existingCenter.id, { batches: next });
      await syncStudentsToBatches(existingCenter.id, prev, next)
        .catch(err => console.error("[centre] batch sync:", err));
      const w = wingOf(existingCenter);
      invalidateCache(`registry:${w}:entries`);
      invalidateCache(`students:${w}:students`);
      toast(`${newCount} batch${newCount !== 1 ? "es" : ""} added to ${existingCenter.name}.`, "success");
      closeForm();
      setLoading(true);
      await fetchCenters();
    } catch (err) {
      console.error("Failed to add batch:", err);
      toast(err instanceof Error && err.message ? err.message : "Failed to add batch.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveForm() {
    setSaving(true);
    const timeSlot = buildTimeSlot(form.daysOfWeek, form.startTime, form.endTime);
    try {
      if (editTarget) {
        const rename = await updateCenter(editTarget.id, {
          name:       form.name.trim(),
          teacherUid: form.teacherUid.trim(),
          status:     form.status,
          timeSlot,
          batches:    form.batches,
          demoClassDate:  form.demoClassDate,
          firstClassDate: form.firstClassDate,
          subtitle:       form.subtitle.trim(),
          classType:      form.wing === WINGS.ROL_PLUS ? form.classType : "group",
        });
        // patch extra fields directly since updateCenter whitelists known Center fields
        const { doc: fsDoc, updateDoc, serverTimestamp } = await import("firebase/firestore");
        const { db } = await import("@/config/firebase");
        await updateDoc(fsDoc(db, "centers", editTarget.id), {
          wing:       form.wing,
          daysOfWeek: form.daysOfWeek,
          startTime:  form.startTime,
          endTime:    form.endTime,
        });
        // First batches → current students go into Batch 1; renames follow onto students.
        await syncStudentsToBatches(editTarget.id, explicitBatches(editTarget as unknown as Record<string, unknown>), form.batches)
          .catch(err => console.error("[centre] batch sync:", err));
        invalidateCache(`registry:${form.wing}:entries`);
        invalidateCache(`students:${form.wing}:students`);
        toast(
          form.wing !== wing
            ? `Center updated and moved to ${WING_LABELS[form.wing]} — it won't appear in this ${WING_LABELS[wing]} view.`
            : rename ? renameMessage(rename) : "Center updated successfully.",
          "success",
        );
      } else {
        await createCenter({
          name:        form.name.trim(),
          location:    "",
          timeSlot,
          teacherUid:  form.teacherUid.trim(),
          studentUids: [],
          status:      form.status,
          wing:        form.wing,
          batches:     form.batches,
          demoClassDate:  form.demoClassDate,
          firstClassDate: form.firstClassDate,
          subtitle:       form.subtitle.trim(),
          classType:      form.wing === WINGS.ROL_PLUS ? form.classType : "group",
          ...(({ daysOfWeek: form.daysOfWeek, startTime: form.startTime, endTime: form.endTime }) as object),
        } as Parameters<typeof createCenter>[0]);
        toast(
          form.wing !== wing
            ? `Center created under ${WING_LABELS[form.wing]} — switch wings to see it.`
            : "Center created successfully.",
          "success",
        );
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
  const nameMissing = useExisting && !isEditing ? !existingCenter : !form.name.trim();

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />
      {viewTarget && (
        <ViewModal
          center={viewTarget}
          onClose={() => { setViewTarget(null); setViewBatch("all"); }}
          teachers={teachers}
          initialBatch={viewBatch}
          onActiveCount={(cid, n, perBatch) => setActiveCounts(prev => {
            const next = new Map(prev);
            next.set(cid, n);
            // Replace this centre's per-batch counts so each batch card updates on its own.
            [...next.keys()].forEach(k => { if (k.startsWith(`${cid}|`)) next.delete(k); });
            perBatch.forEach((c, bid) => next.set(`${cid}|${bid}`, c));
            setCached(`centers:${wing}:activeCounts`, next);
            return next;
          })}
          onSaved={(updated, rename) => {
            setCenters(prev => prev.map(c => c.id === updated.id ? updated : c));
            toast(rename ? renameMessage(rename) : "Center updated successfully.", "success");
            fetchCenters();
          }}
        />
      )}
      {showMatrix && (
        <ScheduleMatrixModal centers={centers} teachers={teachers} onClose={() => setShowMatrix(false)} />
      )}
      {deactivateTarget && (
        <DeactivateCenterModal
          center={deactivateTarget}
          onClose={() => setDeactivateTarget(null)}
          onConfirm={async ({ movedUids, cancelled }) => {
            setDeactivateTarget(null);
            await saveForm();
            if (movedUids.length || cancelled) {
              toast(`${movedUids.length} student${movedUids.length !== 1 ? "s" : ""} transferred, ${cancelled} admission${cancelled !== 1 ? "s" : ""} cancelled.`, "success");
            }
          }}
        />
      )}
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => setShowMatrix(true)}
            style={{ ...styles.addBtn, background: "#fff", color: "#4338ca", border: "1px solid #c7d2fe" }}>
            ▦ Teacher Availability
          </button>
          <button onClick={showForm ? closeForm : openCreate} style={styles.addBtn}>
            + Add Center
          </button>
        </div>
      </div>

      {/* Add / Edit Center — slide-over drawer */}
      <div onClick={closeForm} style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000,
        opacity: showForm ? 1 : 0, pointerEvents: showForm ? "auto" : "none", transition: "opacity 0.2s",
      }} />
      <form
        onSubmit={handleSubmit}
        className="center-drawer"
        aria-hidden={!showForm}
        style={{
          ...drawerStyles.panel,
          transform: showForm ? "translateX(0)" : "translateX(100%)",
          pointerEvents: showForm ? "auto" : "none",
        }}
      >
        <style>{`.center-drawer input:focus, .center-drawer select:focus { outline: none; border-color: #f59e0b; box-shadow: 0 0 0 2px rgba(245,158,11,0.45); }`}</style>
        <div style={drawerStyles.header}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>
              {isEditing ? "Edit Center" : "New Center"}
            </div>
            {isEditing && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{editTarget!.name}</div>}
          </div>
          <button type="button" onClick={closeForm} aria-label="Close" style={drawerStyles.closeBtn}>✕</button>
        </div>

        <div style={drawerStyles.body}>
          {useExisting && !isEditing ? (
            <section style={drawerStyles.section}>
              <div style={drawerStyles.sectionTitle}>Basic Information</div>
              <FormField label="Center Name" required fullWidth
                action={<NameModeToggle existing onChange={toggleUseExisting} />}>
              {existingCenter ? (
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid #c7d2fe", background: "#f5f7ff" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>🔒 {existingCenter.name}</div>
                    <div style={{ fontSize: 12, color: "#4b5563", marginTop: 3 }}>
                      {WING_LABELS[wingOf(existingCenter)]}
                      {" · 👤 "}{(() => { const t = teachers.find(x => x.uid === existingCenter.teacherUid); return t ? getTeacherDisplayName(t) : "No teacher"; })()}
                      {batchSummary({ id: "", name: "", daysOfWeek: form.daysOfWeek, startTime: form.startTime, endTime: form.endTime })
                        ? ` · ${batchSummary({ id: "", name: "", daysOfWeek: form.daysOfWeek, startTime: form.startTime, endTime: form.endTime })}` : ""}
                    </div>
                    <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 3 }}>
                      New batches inherit this centre&apos;s wing and teacher; set each batch&apos;s own days &amp; time below.
                    </div>
                  </div>
                  <button type="button" onClick={() => toggleUseExisting(true)} style={drawerStyles.cancelBtn}>Change</button>
                </div>
              ) : (
                <div>
                  <input value={existingSearch} onChange={e => setExistingSearch(e.target.value)} autoFocus={showForm}
                    placeholder="Search active centres…" aria-label="Search registered centres" style={formStyles.input} />
                  <div role="listbox" aria-label="Registered centres"
                    style={{ marginTop: 6, maxHeight: 260, overflowY: "auto" as const, border: "1px solid #e5e7eb", borderRadius: 8 }}>
                    {existingMatches.length === 0 ? (
                      <div style={{ padding: 12, fontSize: 12.5, color: "#9ca3af" }}>
                        {centers.length === 0 ? `No centres registered in ${WING_LABELS[wing]} yet.` : "No active centres match."}
                      </div>
                    ) : existingMatches.map(c => (
                      <button key={c.id} type="button" role="option" aria-selected={false} onClick={() => pickExisting(c)}
                        style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 8, padding: "9px 12px", border: "none",
                          borderBottom: "1px solid #f3f4f6", background: "#fff", cursor: "pointer", textAlign: "left" as const, fontSize: 13 }}>
                        <span style={{ fontWeight: 600, color: "#111827" }}>{c.name}</span>
                        <span style={{ fontSize: 11.5, color: c.status === "active" ? "#15803d" : "#9ca3af" }}>
                          {explicitBatches(c as unknown as Record<string, unknown>).length || 1} batch{explicitBatches(c as unknown as Record<string, unknown>).length > 1 ? "es" : ""}
                          {c.status !== "active" ? " · inactive" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              </FormField>
            </section>
          ) : (<>
          <section style={drawerStyles.section}>
            <div style={drawerStyles.sectionTitle}>Basic Information</div>
            <div style={drawerStyles.grid}>
              <FormField label="Center Name" required fullWidth
                action={isEditing
                  ? (renaming
                      ? <button type="button" onClick={() => { setRenaming(false); setNameError(""); setForm(f => ({ ...f, name: editTarget!.name })); }}
                          style={nameModeStyles.link}>Cancel rename</button>
                      : <button type="button" onClick={() => setRenaming(true)} style={nameModeStyles.link}>✏ Edit Name</button>)
                  : <NameModeToggle existing={false} onChange={toggleUseExisting} />}>
                <input name="name" value={form.name} onChange={handleChange} required
                  readOnly={isEditing && !renaming} autoFocus={renaming}
                  placeholder="e.g. Koramangala Center"
                  style={{ ...formStyles.input, ...(isEditing && !renaming ? nameModeStyles.locked : {}) }} />
                {nameError
                  ? <span style={formStyles.errorText}>{nameError}</span>
                  : !form.name.trim()
                    ? <span style={formStyles.errorText}>Center name is required.</span>
                    : isEditing && renaming && form.name.trim() !== editTarget!.name.trim()
                      ? <span style={formStyles.helperText}>The new name is updated on this centre&apos;s students, admissions and rosters when you save.</span>
                      : null}
              </FormField>
              <FormField label="Subtitle / Identifier" fullWidth>
                <input name="subtitle" value={form.subtitle} onChange={handleChange} maxLength={40}
                  placeholder="e.g. Main Branch, Keyboard Division, Offline Campus" style={formStyles.input} />
                <span style={formStyles.helperText}>Optional — shown as a badge on the centre card to tell centres apart.</span>
              </FormField>
              <FormField label="Status">
                <select name="status" value={form.status} onChange={handleChange} style={formStyles.input}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
              <FormField label="Assign Wing">
                <select name="wing" value={form.wing} onChange={handleChange} style={formStyles.input}>
                  <option value={WINGS.ROL_PLUS}>{WING_LABELS[WINGS.ROL_PLUS]}</option>
                  <option value={WINGS.SCHOOL_OF_MUSIC}>{WING_LABELS[WINGS.SCHOOL_OF_MUSIC]}</option>
                </select>
                {isEditing && form.wing !== wing && (
                  <span style={formStyles.helperText}>
                    Moving this centre out of the {WING_LABELS[wing]} view.
                  </span>
                )}
              </FormField>
              {form.wing === WINGS.ROL_PLUS && (
                <FormField label="Class Type">
                  <select name="classType" value={form.classType} onChange={handleChange} style={formStyles.input}>
                    <option value="group">Group Class</option>
                    <option value="personal">Personal Class (1-on-1)</option>
                  </select>
                  <span style={formStyles.helperText}>Label on the centre card only — students&apos; class type and fees are unchanged.</span>
                </FormField>
              )}
            </div>
          </section>

          <section style={drawerStyles.section}>
            <div style={drawerStyles.sectionTitle}>Personnel &amp; Dates</div>
            <div style={drawerStyles.grid}>
              <FormField label="Assigned Teacher" fullWidth>
                <select name="teacherUid" value={form.teacherUid} onChange={handleChange} style={formStyles.input}>
                  <option value="">— Unassigned —</option>
                  {teachers.map(t => (
                    <option key={t.uid} value={t.uid}>{getTeacherDisplayName(t)}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Demo Class Date">
                <input name="demoClassDate" type="date" value={form.demoClassDate} onChange={handleChange}
                  style={formStyles.input} />
              </FormField>
              <FormField label="Date of First Class">
                <input ref={firstClassInputRef} name="firstClassDate" type="date" value={form.firstClassDate} onChange={handleChange}
                  style={formStyles.input} />
                {form.demoClassDate && !form.firstClassDate && (
                  <span style={formStyles.helperText}>Optional — a reminder shows on the dashboard until it&apos;s set.</span>
                )}
              </FormField>
            </div>
          </section>

          <section style={drawerStyles.section}>
            <div style={drawerStyles.sectionTitle}>Schedule &amp; Timings</div>
            <div style={drawerStyles.grid}>
              <FormField label="Days of Week" fullWidth>
                <DayChips selected={form.daysOfWeek} onChange={handleDaysChange} />
                {dayError && <span style={formStyles.errorText}>{dayError}</span>}
                {form.daysOfWeek.length > 0 && (
                  <span style={formStyles.helperText}>
                    {form.daysOfWeek.join(", ")} · {form.daysOfWeek.length} day{form.daysOfWeek.length !== 1 ? "s" : ""} selected
                  </span>
                )}
              </FormField>
              <FormField label="Start Time">
                <input name="startTime" type="time" value={form.startTime} onChange={handleChange}
                  style={formStyles.input} />
              </FormField>
              <FormField label="End Time">
                <input name="endTime" type="time" value={form.endTime} onChange={handleChange}
                  style={formStyles.input} />
              </FormField>
            </div>
          </section>

          </>)}

          {(!useExisting || isEditing || existingCenter) && (
            <section style={{ ...drawerStyles.section, borderBottom: "none", marginBottom: 0 }}>
              <div style={drawerStyles.sectionTitle}>Batches Setup</div>
              <BatchesEditor key={useExisting && !isEditing ? existingId : "form"}
                batches={form.batches} onChange={handleBatchesChange} teachers={teachers}
                base={{ daysOfWeek: form.daysOfWeek, startTime: form.startTime, endTime: form.endTime, teacherUid: form.teacherUid }}
                lockedIds={useExisting && !isEditing ? existingBatchIds : undefined} />
            </section>
          )}
        </div>

        <div style={drawerStyles.footer}>
          <button type="button" onClick={closeForm} style={drawerStyles.cancelBtn}>Cancel</button>
          <button type="submit" disabled={saving || nameMissing}
            title={nameMissing ? (useExisting && !isEditing ? "Select a centre first" : "Enter a centre name first") : undefined}
            style={{ ...drawerStyles.primaryBtn, opacity: saving || nameMissing ? 0.6 : 1, cursor: saving || nameMissing ? "not-allowed" : "pointer" }}>
            {saving ? "Saving…" : isEditing ? "Update Center" : useExisting ? "Add Batch to Center" : "Create Center"}
          </button>
        </div>
      </form>

      {/* Reminders — centres with a demo date but no first-class date yet */}
      {!loading && pendingFirstClass.length > 0 && (
        <div style={reminderStyles.wrapper} role="alert">
          {pendingFirstClass.map(c => (
            <div key={c.id} style={reminderStyles.row}>
              <span style={{ flex: 1, minWidth: 200 }}>
                <b>Action Required:</b> Please set the Date of First Class for <b>{c.name}</b>.
                <span style={{ opacity: 0.75 }}> (Demo: {fmtDMY(c.demoClassDate ?? "")})</span>
              </span>
              <button type="button" onClick={() => setFirstClassFor(c)} style={reminderStyles.btn}>
                Set First Class Date
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Grid — active centres are the primary view; inactive ones live in
          their own list below rather than mixed in with a status badge. */}
      {loading ? (
        <div style={styles.stateRow}>Loading…</div>
      ) : centers.length === 0 ? (
        <div style={styles.stateRow}>No centers available.</div>
      ) : (
        <>
          {activeCentersList.length === 0 ? (
            <div style={styles.stateRow}>No active centers.</div>
          ) : (() => {
            const renderCards = (list: Center[]) => list.flatMap(center => {
                const handlers = {
                  onView: () => { setViewBatch("all"); setViewTarget(center); },
                  onEdit: () => openEdit(center),
                  onDelete: () => setDeleteTarget(center),
                };
                // Centre + batch = one operational card when a centre runs 2+ batches
                // (lib/batchUnits); each shows its own batch, teacher and students.
                const batches = center.batches ?? [];
                if (batches.length < 2) {
                  return [<CenterCard key={center.id} center={center} teachers={teachers}
                    activeCount={activeCounts.get(center.id) ?? 0} {...handlers} />];
                }
                const perBatch = batches.map(b => activeCounts.get(`${center.id}|${b.id}`) ?? 0);
                const noBatch = Math.max(0, (activeCounts.get(center.id) ?? 0) - perBatch.reduce((a, n) => a + n, 0));
                return [
                  ...batches.map((b, i) => (
                    <CenterCard key={`${center.id}|${b.id}`} center={center} batch={b} teachers={teachers}
                      activeCount={perBatch[i]} {...handlers}
                      onView={() => { setViewBatch(b.id); setViewTarget(center); }} />
                  )),
                  ...(noBatch > 0 ? [
                    <CenterCard key={`${center.id}|none`} center={center} batch={{ id: "", name: "No batch", daysOfWeek: [], startTime: "", endTime: "" }}
                      teachers={teachers} activeCount={noBatch} {...handlers}
                      onView={() => { setViewBatch("none"); setViewTarget(center); }} />,
                  ] : []),
                ];
              });
            // ROL+ only: 1-on-1 classes set up as their own centre get their own section
            // (centre label only — students' class type / fees are never touched).
            const isPersonal = (c: Center) => wingOf(c) === WINGS.ROL_PLUS && c.classType === "personal";
            const personal = activeCentersList.filter(isPersonal);
            const group    = activeCentersList.filter(c => !isPersonal(c));
            if (personal.length === 0) return <div style={styles.grid}>{renderCards(group)}</div>;
            const sectionHead = (label: string, n: number, hint: string, tone: { fg: string; bg: string; border: string }) => (
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 12px" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: tone.fg, letterSpacing: 0.4, textTransform: "uppercase" as const }}>{label}</span>
                <span style={{ fontSize: 11.5, fontWeight: 800, color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 999, padding: "1px 9px" }}>{n}</span>
                <span style={{ fontSize: 12, color: "#9ca3af" }}>{hint}</span>
                <span aria-hidden style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
              </div>
            );
            return (
              <>
                {group.length > 0 && (
                  <section aria-label="Group classes" style={{ marginBottom: 26 }}>
                    {sectionHead("Group Classes", group.length, "centres & branches", { fg: "#4338ca", bg: "#eef2ff", border: "#c7d2fe" })}
                    <div style={styles.grid}>{renderCards(group)}</div>
                  </section>
                )}
                <section aria-label="Personal classes"
                  style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 14, padding: "14px 14px 16px" }}>
                  {sectionHead("Personal Classes", personal.length, "1-on-1 sessions", { fg: "#7e22ce", bg: "#f3e8ff", border: "#e9d5ff" })}
                  <div style={styles.grid}>{renderCards(personal)}</div>
                </section>
              </>
            );
          })()}

          {inactiveCentersList.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <button type="button" onClick={() => setIsInactiveExpanded(v => !v)}
                aria-expanded={isInactiveExpanded} aria-controls="inactive-centres"
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                  background: isInactiveExpanded ? "#f3f4f6" : "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10,
                  cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  marginBottom: isInactiveExpanded ? 14 : 0, transition: "background 0.15s" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#f3f4f6")}
                onMouseLeave={e => (e.currentTarget.style.background = isInactiveExpanded ? "#f3f4f6" : "#f9fafb")}>
                <span aria-hidden style={{ fontSize: 11, color: "#6b7280", display: "inline-block",
                  transform: isInactiveExpanded ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "#6b7280", letterSpacing: 0.5, textTransform: "uppercase" as const }}>
                  Inactive Centers ({inactiveCentersList.length})
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af" }}>{isInactiveExpanded ? "Hide" : "Show"}</span>
              </button>
              {isInactiveExpanded && (
                <div id="inactive-centres" style={styles.grid}>
                  {inactiveCentersList.map(center => (
                    <CenterCard key={center.id} center={center}
                      teachers={teachers}
                      activeCount={activeCounts.get(center.id) ?? 0}
                      onView={() => setViewTarget(center)}
                      onEdit={() => openEdit(center)}
                      onDelete={() => setDeleteTarget(center)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────────────

/** An active centre whose demo class is scheduled but whose first class date isn't set yet. */
/** Manually entered demo date wins; otherwise the centre's earliest student admission. */
function effectiveDemoDate(center: Center, earliestAdmissions: Map<string, string>): string {
  return toLocalYMD(center.demoClassDate) || earliestAdmissions.get(center.id) || "";
}

function needsFirstClassDate(center: Center): boolean {
  return center.status === "active" && !!center.demoClassDate && !center.firstClassDate;
}

/** "2026-09-24" → "24/09/2026". */
function fmtDMY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

const reminderStyles: Record<string, React.CSSProperties> = {
  wrapper: { background: "#fffbeb", border: "1px solid #fcd34d", borderLeft: "4px solid #f59e0b", borderRadius: 10, padding: "10px 14px", marginBottom: 18, display: "flex", flexDirection: "column", gap: 8 },
  row:     { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 13.5, color: "#78350f" },
  btn:     { background: "#f59e0b", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
};

/** Deterministic 0–7 hue index from the centre name → .center-hue-N in globals.css. */
function getCenterHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  return Math.abs(hash) % 8;
}

// Minimal card: name, teacher, wing tag and active-student count. Schedule,
// batches, demo / first-class dates and the roster live in the detail modal
// (click the card). Edit / Delete stay behind the ⋮ menu. Both wings.
function CenterCard({ center, batch, teachers, activeCount, onView, onEdit, onDelete }: {
  center: Center; teachers: TeacherUser[]; activeCount: number;
  /** Set for a centre with 2+ batches: this card is that one batch. */
  batch?: CenterBatch;
  onView: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const [hover, setHover]     = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Centre teacher, else the batch teachers (a centre can be run by batch teachers only).
  const teacherNames = (batch ? [batch.teacherUid || center.teacherUid] : [...centreTeacherUids(center.teacherUid, center.batches)])
    .map(uid => teachers.find(t => t.uid === uid))
    .filter((t): t is TeacherUser => !!t)
    .map(t => getTeacherDisplayName(t));
  // The view is already wing-filtered, so the card names the batch instead of the wing.
  // No batches → the implicit General Batch that runs on the centre schedule.
  const cardBatches = explicitBatches(center as unknown as Record<string, unknown>);
  const batchLabel = cardBatches.length === 0
    ? DEFAULT_BATCH_NAME
    : `${cardBatches[0].name || "Unnamed batch"}${cardBatches.length > 1 ? ` (+${cardBatches.length - 1})` : ""}`;
  // Every card shows one batch with equal weight: the split batch, the centre's
  // only batch, or its General Batch (the centre's own schedule). An unsplit
  // centre with several batches (inactive list) keeps the summary label.
  const rawC = center as Center & { daysOfWeek?: string[]; startTime?: string; endTime?: string };
  const shown: { name: string; days: string[]; start: string; end: string; teacherUid: string } | null =
    batch ? { name: batch.name || "Unnamed batch", days: batch.daysOfWeek ?? [], start: batch.startTime, end: batch.endTime, teacherUid: batch.teacherUid || center.teacherUid }
    : cardBatches.length === 1 ? { name: cardBatches[0].name || "Unnamed batch", days: cardBatches[0].daysOfWeek ?? [], start: cardBatches[0].startTime, end: cardBatches[0].endTime, teacherUid: cardBatches[0].teacherUid || center.teacherUid }
    : cardBatches.length === 0 ? { name: DEFAULT_BATCH_NAME, days: rawC.daysOfWeek ?? [], start: rawC.startTime ?? "", end: rawC.endTime ?? "", teacherUid: center.teacherUid }
    : null;
  const shownTeacher = shown ? teachers.find(t => t.uid === shown.teacherUid) : undefined;
  const shownTime = shown ? formatTimeRange12(shown.start, shown.end) : "";

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
      role="button" tabIndex={0}
      onClick={onView}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onView(); } }}
      className={`center-hue-${getCenterHue(center.name.trim().toLowerCase())}`}
      style={{ ...styles.card, ...(hover ? styles.cardHover : {}), cursor: "pointer", position: "relative", borderTop: "3px solid var(--center-hue)" }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title="Open centre details"
    >
      <div style={styles.cardHeader}>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...styles.cardName, color: "var(--center-hue)" }}>{center.name}</div>
          {(batch ? batch.name : center.subtitle?.trim()) && (
            <span title={batch ? "Batch" : "Centre identifier"}
              style={{ display: "inline-block", marginTop: 4, fontSize: 11.5, fontWeight: 800, color: "#fff", background: "#4f46e5", borderRadius: 6, padding: "2px 9px" }}>
              {batch ? batch.name : center.subtitle!.trim()}
            </span>
          )}
        </div>
        <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
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
      {shown ? (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12.5 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: shownTeacher ? "var(--color-text-primary)" : "#9ca3af", minWidth: 0 }}>
            <span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: "#e0e7ff", color: "#4338ca", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 800, flexShrink: 0 }}>
              {shownTeacher ? getTeacherDisplayName(shownTeacher).trim().charAt(0).toUpperCase() : "?"}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{shownTeacher ? getTeacherDisplayName(shownTeacher) : "Unassigned"}</span>
          </span>
          <span style={{ color: "var(--color-text-secondary)" }}>
            📅 {shown.days.join(", ") || "No days set"}{shownTime ? <> · ⏰ {shownTime}</> : null}
          </span>
        </div>
      ) : (
        <div style={styles.cardMeta} title={cardBatches.map(b => b.name).filter(Boolean).join(", ") || undefined}>
          {teacherNames.length
            ? <span style={styles.cardTeacher} title={teacherNames.join(", ")}>
                {teacherNames[0]}{teacherNames.length > 1 && <span style={{ color: "var(--color-text-secondary)" }}> +{teacherNames.length - 1}</span>}
              </span>
            : <span style={{ color: "#9ca3af", flexShrink: 0 }}>Unassigned</span>}
          <span style={{ color: "var(--color-text-secondary)", flexShrink: 0 }}>•</span>
          <span style={styles.cardBatch}>{batchLabel}</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const }}>
        <span style={styles.activeStudentsBadge}>👤 {activeCount} Active</span>
        {wingOf(center) === WINGS.ROL_PLUS && (center.classType === "personal"
          ? <span title="Personal Class (1-on-1)" style={{ fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 99, padding: "2px 9px" }}>Personal</span>
          : <span title="Group Class" style={{ fontSize: 11, fontWeight: 700, color: "#3730a3", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 99, padding: "2px 9px" }}>Group</span>)}
      </div>
    </div>
  );
}

// ─── Teacher Schedule & Availability Matrix ─────────────────────────────────────

type SlotEntry = { teacherUid: string; teacherName: string; centerName: string; batchName: string; time: string };

function toMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function ScheduleMatrixModal({ centers, teachers, onClose }: {
  centers: Center[]; teachers: TeacherUser[]; onClose: () => void;
}) {
  const [teacherFilter, setTeacherFilter] = useState("all");

  const teacherName = useMemo(() => {
    const m = new Map(teachers.map(t => [t.uid, getTeacherDisplayName(t) || t.uid]));
    return (uid: string) => (uid ? m.get(uid) ?? "Unknown teacher" : "Unassigned");
  }, [teachers]);

  // Every active centre's batches (or its implicit General Batch) as timed blocks.
  const blocks = useMemo(() => centers
    .filter(c => c.status === "active")
    .flatMap(c => effectiveBatches(c.id, c as unknown as Record<string, unknown>).map(b => ({
      center: c, batch: b, start: toMinutes(b.startTime), end: toMinutes(b.endTime),
    })))
    .filter((x): x is typeof x & { start: number; end: number } =>
      x.start !== null && x.end !== null && x.end > x.start && x.batch.daysOfWeek.length > 0),
  [centers]);

  // Hourly rows: 09:00–18:00 by default, widened to cover any class outside that range.
  const hours = useMemo(() => {
    let lo = 9, hi = 18;
    for (const b of blocks) { lo = Math.min(lo, Math.floor(b.start / 60)); hi = Math.max(hi, Math.ceil(b.end / 60) - 1); }
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [blocks]);

  const visible = teacherFilter === "all" ? blocks : blocks.filter(b => b.center.teacherUid === teacherFilter);

  function cellEntries(day: Day, hour: number): SlotEntry[] {
    const s = hour * 60, e = s + 60;
    return visible
      .filter(b => b.batch.daysOfWeek.includes(day) && b.start < e && b.end > s)
      .map(b => ({
        teacherUid:  b.center.teacherUid,
        teacherName: teacherName(b.center.teacherUid),
        centerName:  b.center.name,
        batchName:   b.batch.name,
        time:        formatTimeRange12(b.batch.startTime, b.batch.endTime),
      }));
  }

  // A conflict is one teacher booked at two or more classes overlapping this hour.
  function isConflict(entries: SlotEntry[]): boolean {
    const seen = new Set<string>();
    for (const x of entries) {
      if (!x.teacherUid) continue;
      if (seen.has(x.teacherUid)) return true;
      seen.add(x.teacherUid);
    }
    return false;
  }

  // One tab per active teacher, each tagged with their weekly class count.
  const teacherTabs = useMemo(() => teachers
    .filter(t => t.status === "active")
    .map(t => ({
      uid:     t.uid,
      name:    getTeacherDisplayName(t) || t.uid,
      classes: blocks.filter(b => b.center.teacherUid === t.uid).reduce((n, b) => n + b.batch.daysOfWeek.length, 0),
    }))
    .sort((a, b) => safeCompare(a.name, b.name)),
  [teachers, blocks]);

  const isAll = teacherFilter === "all";
  const tabs = [{ uid: "all", name: "All Teachers", classes: null as number | null }, ...teacherTabs];

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={{ ...modalStyles.box, maxWidth: 1100, width: "calc(100% - 32px)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Teacher Schedule &amp; Availability Matrix</span>
          <button onClick={onClose} style={modalStyles.closeBtn}>×</button>
        </div>

        {/* Tab bar + legend stay put; only the grid below scrolls. */}
        <div style={{ flexShrink: 0, borderBottom: "1px solid #e5e7eb", background: "#fafafa" }}>
          <div role="tablist" style={matrixStyles.tabBar}>
            {tabs.map(t => {
              const active = teacherFilter === t.uid;
              return (
                <button key={t.uid} role="tab" aria-selected={active} onClick={() => setTeacherFilter(t.uid)}
                  style={{ ...matrixStyles.tab, ...(active ? matrixStyles.tabActive : {}) }}>
                  {t.name}
                  {t.classes !== null && (
                    <span style={{ ...matrixStyles.tabCount, ...(active ? { background: "#4f46e5", color: "#fff" } : {}) }}>{t.classes}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: "#6b7280", flexWrap: "wrap", padding: "0 20px 10px" }}>
            <span><span style={{ ...matrixStyles.swatch, background: isAll ? "#e0e7ff" : "#4f46e5" }} />{isAll ? "Assigned" : "Busy"}</span>
            {isAll && <span><span style={{ ...matrixStyles.swatch, background: "#fee2e2" }} />Conflict</span>}
            <span><span style={{ ...matrixStyles.swatch, background: "rgba(236,253,245,0.5)", border: "1px solid #a7f3d0" }} />{isAll ? "Available" : "Free"}</span>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 20px 20px" }}>
          {(isAll ? blocks : visible).length === 0 && (
            <div style={{ fontSize: 12.5, color: "#9ca3af", margin: "12px 0 0" }}>
              {isAll
                ? "No active centre has days & times set yet — every slot shows as available."
                : "No classes assigned to this teacher — the whole week is free."}
            </div>
          )}
          <table style={{ borderCollapse: "separate", borderSpacing: 4, width: "100%", minWidth: 760, tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ ...matrixStyles.th, width: 76 }}>Time</th>
                {DAYS.map(d => <th key={d} style={matrixStyles.th}>{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {hours.map(h => (
                <tr key={h}>
                  <td style={matrixStyles.timeCell}>{formatTime12(`${h}:00`)}</td>
                  {DAYS.map(d => {
                    const entries = cellEntries(d, h);
                    if (entries.length === 0) {
                      return <td key={d} style={{ ...matrixStyles.cell, background: "rgba(236,253,245,0.5)", color: "#059669", textAlign: "center" }}>{isAll ? "Available" : "Free"}</td>;
                    }
                    // Single-teacher view: solid accent block naming the centre, no conflict styling.
                    if (!isAll) {
                      return (
                        <td key={d}
                          title={entries.map(x => `${x.centerName} · ${x.batchName} (${x.time})`).join("\n")}
                          style={{ ...matrixStyles.cell, background: "#4f46e5", color: "#fff" }}>
                          {entries.map((x, i) => (
                            <div key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              <div style={{ fontWeight: 700 }}>{x.centerName}</div>
                              <div style={{ fontSize: 10.5, opacity: 0.85 }}>{x.time}</div>
                            </div>
                          ))}
                        </td>
                      );
                    }
                    const conflict = isConflict(entries);
                    return (
                      <td key={d}
                        title={entries.map(x => `${x.teacherName} @ ${x.centerName} · ${x.batchName} (${x.time})`).join("\n")}
                        style={{ ...matrixStyles.cell, background: conflict ? "#fee2e2" : "#e0e7ff", color: conflict ? "#991b1b" : "#3730a3" }}>
                        {conflict && <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>⚠ Conflict</div>}
                        {entries.map((x, i) => (
                          <div key={i} style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {x.teacherName} @ {x.centerName}
                          </div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const matrixStyles: Record<string, React.CSSProperties> = {
  th:       { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", padding: "10px 4px 6px", textAlign: "center", position: "sticky", top: 0, background: "#fff", zIndex: 1 },
  tabBar:   { display: "flex", gap: 4, overflowX: "auto", padding: "10px 20px 8px", scrollbarWidth: "thin" },
  tab:      { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, border: "1px solid #e5e7eb", background: "#fff", color: "#374151", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
  tabActive:{ background: "#eef2ff", borderColor: "#a5b4fc", color: "#4338ca" },
  tabCount: { fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999, background: "#f3f4f6", color: "#6b7280" },
  timeCell: { fontSize: 12, fontWeight: 600, color: "#374151", padding: "6px 4px", verticalAlign: "top", whiteSpace: "nowrap" },
  cell:     { fontSize: 11.5, padding: "6px 8px", borderRadius: 6, verticalAlign: "top", height: 40 },
  swatch:   { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 5, verticalAlign: "middle" },
};

// ─── Deactivate Center Modal ───────────────────────────────────────────────────

interface DeactivateStudent { uid: string; name: string; admissionNo: string }
interface DeactivateDest { id: string; name: string; wing: Wing; batches: CenterBatch[] }

/**
 * Shown when a centre is switched Active → Inactive. Lists the centre's active
 * students so each can be moved to another active centre (optionally into one
 * of its batches); everyone left unmoved has their admission cancelled
 * (status "inactive" — the Registry shows it as "Cancelled"). `onConfirm`
 * runs after the student writes and is what actually saves the centre.
 */
function DeactivateCenterModal({ center, onClose, onConfirm }: {
  center:    Center;
  onClose:   () => void;
  onConfirm: (summary: { movedUids: string[]; cancelled: number }) => Promise<void>;
}) {
  const { wing: viewingWing } = useWing();
  const [students, setStudents] = useState<DeactivateStudent[]>([]);
  const [dests, setDests]       = useState<DeactivateDest[]>([]);
  const [loading, setLoading]   = useState(true);
  const [moveTo, setMoveTo]     = useState<Record<string, string>>({});   // uid → centreId
  const [moveBatch, setMoveBatch] = useState<Record<string, string>>({}); // uid → batchId
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDest, setBulkDest] = useState("");
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [stuSnap, cenSnap] = await Promise.all([
          getDocs(query(collection(db, "users"), where("role", "==", "student"), where("centerId", "==", center.id))),
          getDocs(query(collection(db, "centers"), where("status", "==", "active"))),
        ]);
        if (cancelled) return;
        setStudents(stuSnap.docs
          .filter(d => (d.data().status ?? "active") === "active")
          .map(d => ({
            uid: d.id,
            name: (d.data().displayName ?? d.data().name ?? "-") as string,
            admissionNo: (d.data().admissionNo ?? d.data().admissionNumber ?? "") as string,
          }))
          .sort((a, b) => safeCompare(a.name, b.name)));
        // Transfers stay inside the centre's own wing — never across wings.
        setDests(cenSnap.docs
          .filter(d => d.id !== center.id && inWing(d.data(), wingOf(center)))
          .map(d => ({ id: d.id, name: (d.data().name ?? d.id) as string, wing: wingOf(d.data()), batches: explicitBatches(d.data()) }))
          .sort((a, b) => Number(b.wing === viewingWing) - Number(a.wing === viewingWing) || safeCompare(a.name, b.name)));
      } catch (err) {
        console.error("[DeactivateCenterModal] load error:", err);
        if (!cancelled) setError("Failed to load students.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [center.id, viewingWing]);

  const destById = useMemo(() => new Map(dests.map(d => [d.id, d])), [dests]);
  const toMove   = students.filter(s => selected.has(s.uid) && moveTo[s.uid]);
  const toCancel = students.length - toMove.length;

  function pickDest(uid: string, centreId: string) {
    setMoveTo(prev => ({ ...prev, [uid]: centreId }));
    setMoveBatch(prev => ({ ...prev, [uid]: "" }));
    setSelected(prev => {
      const next = new Set(prev);
      if (centreId) next.add(uid); else next.delete(uid);
      return next;
    });
  }
  function toggle(uid: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }
  function applyBulkDest() {
    if (!bulkDest) return;
    const targets = selected.size > 0 ? students.filter(s => selected.has(s.uid)) : students;
    targets.forEach(s => pickDest(s.uid, bulkDest));
  }

  async function run(cancelAll: boolean) {
    setBusy(true);
    setError("");
    const movers = cancelAll ? [] : toMove;
    const moverIds = new Set(movers.map(s => s.uid));
    try {
      // Firestore batches cap at 500 writes — each mover needs up to 3.
      const writes: ((b: ReturnType<typeof writeBatch>) => void)[] = [];
      for (const s of movers) {
        const dest  = destById.get(moveTo[s.uid])!;
        const batch = dest.batches.find(b => b.id === moveBatch[s.uid]);
        writes.push(b => b.update(doc(db, "users", s.uid), {
          centerId:  dest.id,
          batchId:   batch?.id ?? null,
          batch:     batch?.name ?? null,
          updatedAt: serverTimestamp(),
        }));
        writes.push(b => b.update(doc(db, "centers", dest.id), { studentUids: arrayUnion(s.uid), updatedAt: serverTimestamp() }));
      }
      if (movers.length > 0) {
        writes.push(b => b.update(doc(db, "centers", center.id), { studentUids: arrayRemove(...movers.map(s => s.uid)) }));
      }
      for (const s of students) {
        if (moverIds.has(s.uid)) continue;
        writes.push(b => b.update(doc(db, "users", s.uid), {
          status:        "inactive",
          studentStatus: "inactive",
          inactivatedAt: new Date().toISOString(),
          updatedAt:     serverTimestamp(),
        }));
      }
      for (let i = 0; i < writes.length; i += 450) {
        const b = writeBatch(db);
        writes.slice(i, i + 450).forEach(w => w(b));
        await b.commit();
      }
      await onConfirm({ movedUids: movers.map(s => s.uid), cancelled: students.length - movers.length });
    } catch (err) {
      console.error("[DeactivateCenterModal] error:", err);
      setError(err instanceof Error ? err.message : "Failed to deactivate center.");
      setBusy(false);
    }
  }

  const btn = (bg: string, fg: string, enabled: boolean): React.CSSProperties => ({
    background: enabled ? bg : "#f3f4f6", color: enabled ? fg : "#9ca3af", border: "none",
    padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: enabled ? "pointer" : "not-allowed",
  });

  return (
    <div style={{ ...modalStyles.overlay, zIndex: 1100 }} onClick={busy ? undefined : onClose}>
      <div style={{ ...modalStyles.box, maxWidth: 720, maxHeight: "90vh", display: "flex", flexDirection: "column", margin: "0 16px" }}
        onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={{ ...modalStyles.title, color: "#9a3412" }}>Deactivate {center.name}</span>
          <button onClick={onClose} disabled={busy} style={modalStyles.closeBtn}>×</button>
        </div>
        <div style={{ ...modalStyles.body, overflowY: "auto" as const }}>
          {loading ? (
            <div style={{ fontSize: 13, color: "#6b7280" }}>Loading students…</div>
          ) : students.length === 0 ? (
            <div style={{ fontSize: 13, color: "#374151" }}>
              This centre has no active students. It will simply be marked Inactive.
            </div>
          ) : (
            <>
              <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#9a3412" }}>
                <strong>Do you want to keep any active students confirmed by transferring them to another center?</strong>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Students you don&rsquo;t transfer will have their admission <strong>Cancelled</strong> (Enrollments and Registry).
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const }}>
                <span style={{ fontSize: 12, color: "#374151" }}>
                  {selected.size > 0 ? `Move ${selected.size} selected to` : "Move all to"}
                </span>
                <select value={bulkDest} onChange={e => setBulkDest(e.target.value)} style={{ ...formStyles.input, minWidth: 180 }}>
                  <option value="">— Select center —</option>
                  {dests.map(d => (
                    <option key={d.id} value={d.id}>{d.name}{d.wing !== viewingWing ? ` (${WING_LABELS[d.wing]})` : ""}</option>
                  ))}
                </select>
                <button type="button" onClick={applyBulkDest} disabled={!bulkDest}
                  style={{ ...btn("#e0e7ff", "#3730a3", !!bulkDest), padding: "7px 12px", fontWeight: 600 }}>
                  Apply
                </button>
              </div>

              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflowX: "auto" as const }}>
                <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f9fafb", textAlign: "left" as const, color: "#6b7280", fontSize: 11, textTransform: "uppercase" as const }}>
                      <th style={{ padding: "8px 10px", width: 28 }}>
                        <input type="checkbox"
                          checked={selected.size === students.length}
                          onChange={e => setSelected(e.target.checked ? new Set(students.map(s => s.uid)) : new Set())} />
                      </th>
                      <th style={{ padding: "8px 10px" }}>Student</th>
                      <th style={{ padding: "8px 10px" }}>Move to</th>
                      <th style={{ padding: "8px 10px" }}>Batch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map(s => {
                      const dest = destById.get(moveTo[s.uid] ?? "");
                      const willMove = selected.has(s.uid) && !!dest;
                      return (
                        <tr key={s.uid} style={{ borderTop: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "8px 10px" }}>
                            <input type="checkbox" checked={selected.has(s.uid)} onChange={() => toggle(s.uid)} />
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <div style={{ fontWeight: 600, color: "#111827" }}>{s.name}</div>
                            <div style={{ fontSize: 11, color: willMove ? "#16a34a" : "#dc2626" }}>
                              {s.admissionNo ? `${s.admissionNo} · ` : ""}{willMove ? "Will transfer" : "Will be cancelled"}
                            </div>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <select value={moveTo[s.uid] ?? ""} onChange={e => pickDest(s.uid, e.target.value)}
                              style={{ ...formStyles.input, width: "100%", minWidth: 150 }}>
                              <option value="">— Select center —</option>
                              {dests.map(d => (
                                <option key={d.id} value={d.id}>{d.name}{d.wing !== viewingWing ? ` (${WING_LABELS[d.wing]})` : ""}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <select value={moveBatch[s.uid] ?? ""} disabled={!dest}
                              onChange={e => setMoveBatch(prev => ({ ...prev, [s.uid]: e.target.value }))}
                              style={{ ...formStyles.input, width: "100%", minWidth: 120 }}>
                              <option value="">{DEFAULT_BATCH_NAME}</option>
                              {dest?.batches.map(b => <option key={b.id} value={b.id}>{b.name || "Unnamed batch"}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {dests.length === 0 && (
                <div style={{ fontSize: 12, color: "#6b7280" }}>No other active centres to transfer to.</div>
              )}
            </>
          )}

          {error && (
            <div style={{ fontSize: 12, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "7px 10px" }}>
              ✕ {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" as const, marginTop: 4 }}>
            <button onClick={onClose} disabled={busy}
              style={{ background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Keep Active
            </button>
            {students.length === 0 ? (
              <button onClick={() => run(true)} disabled={busy || loading} style={btn("#ea580c", "#fff", !busy && !loading)}>
                {busy ? "Saving…" : "Mark Inactive"}
              </button>
            ) : (
              <>
                <button onClick={() => run(true)} disabled={busy} style={btn("#dc2626", "#fff", !busy)}>
                  {busy ? "Saving…" : `Cancel All Admissions (${students.length})`}
                </button>
                <button onClick={() => run(false)} disabled={busy || toMove.length === 0} style={btn("#4f46e5", "#fff", !busy && toMove.length > 0)}>
                  {busy ? "Saving…" : `Transfer Selected (${toMove.length})${toCancel > 0 ? ` · cancel ${toCancel}` : ""}`}
                </button>
              </>
            )}
          </div>
        </div>
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
  grid:        { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 },
  card:        { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8, transition: "box-shadow 0.15s, border-color 0.15s" },
  cardHover:   { boxShadow: "0 4px 14px rgba(0,0,0,0.08)", borderColor: "#6366f1" },
  cardHeader:  { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 },
  cardName:    { fontSize: 15, fontWeight: 800, color: "var(--color-text-primary)", lineHeight: 1.25, minWidth: 0, wordBreak: "break-word" },
  cardTeacher: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-primary)" },
  cardBatch:   { minWidth: 0, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardMeta:    { display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" },
  cardMetaLabel:{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  codeChip:    { fontFamily: "monospace", fontSize: 11, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4, fontWeight: 600 },
  activeStudentsBadge: {
    alignSelf: "flex-start", background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0",
    borderRadius: 99, padding: "3px 10px", fontSize: 12, fontWeight: 700,
  },
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

const batchStyles: Record<string, React.CSSProperties> = {
  card:      { display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #e5e7eb", borderLeft: "3px solid #6366f1", borderRadius: 8, padding: "10px 12px" },
  draft:     { display: "flex", flexDirection: "column", gap: 10, background: "#eef2ff", border: "1.5px solid #c7d2fe", borderRadius: 10, padding: 12 },
  field:     { display: "flex", flexDirection: "column", gap: 4 },
  label:     { fontSize: 11, fontWeight: 700, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.04em" },
  iconBtn:   { background: "#fff", color: "#4f46e5", border: "1px solid #c7d2fe", borderRadius: 6, width: 30, height: 30, fontSize: 13, cursor: "pointer" },
  removeBtn: { background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, width: 30, height: 30, fontSize: 13, cursor: "pointer", flexShrink: 0 },
  cancelBtn: { background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: 7, padding: "7px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  saveBtn:   { background: "#4f46e5", color: "#fff", border: "none", borderRadius: 7, padding: "7px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  addBtn:    { width: "100%", background: "#f5f3ff", color: "#4338ca", border: "1.5px dashed #a5b4fc", borderRadius: 10, padding: "11px 14px", fontSize: 13.5, fontWeight: 700, cursor: "pointer" },
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
};

// Active/Inactive student roster in the centre detail view — roomier than the
// history tables (viewStyles.histTh/histTd).
const rosterTh: React.CSSProperties = {
  textAlign: "left", padding: "12px 18px", fontSize: 11, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280",
  borderBottom: "1px solid #e5e7eb", background: "#f9fafb", position: "sticky", top: 0, zIndex: 1,
};
const rosterTd: React.CSSProperties = { padding: "14px 18px", fontSize: 13, color: "#111827", borderBottom: "1px solid #f3f4f6" };

const viewStyles: Record<string, React.CSSProperties> = {
  quickFacts: {
    display: "flex", flexWrap: "wrap" as const, gap: 20,
    padding: "14px 20px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", flexShrink: 0,
  },
  quickFactLabel: { fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
  quickFactValue: { fontSize: 13, fontWeight: 600, color: "#111827", marginTop: 2 },

  tabBar: { display: "flex", gap: 4, padding: "0 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  tabBtn: {
    padding: "10px 16px", background: "none", border: "none", borderBottom: "2px solid transparent",
    marginBottom: -1, fontSize: 13, fontWeight: 600, color: "#6b7280", cursor: "pointer",
  },
  tabBtnActive: { color: "#4f46e5", borderBottomColor: "#4f46e5" },

  histTh: {
    textAlign: "left" as const, padding: "8px 12px", fontSize: 11, fontWeight: 700,
    textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "#6b7280",
    borderBottom: "1px solid #e5e7eb", background: "#f9fafb", position: "sticky" as const, top: 0,
  },
  histTd: { padding: "9px 12px", fontSize: 12, color: "#111827", borderBottom: "1px solid #f3f4f6" },

  editBtn: {
    background: "#fff", color: "#4f46e5", border: "1px solid #c7d2fe", borderRadius: 8,
    padding: "6px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  },
  cancelBtn: {
    background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", borderRadius: 6,
    padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
};

const drawerStyles: Record<string, React.CSSProperties> = {
  panel:        {
    position: "fixed", top: 0, right: 0, height: "100dvh", width: "min(560px, 100vw)",
    background: "#fff", zIndex: 1001, display: "flex", flexDirection: "column",
    boxShadow: "-8px 0 32px rgba(0,0,0,0.18)", transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
  },
  header:       { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  closeBtn:     { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 },
  body:         { padding: 20, overflowY: "auto", flex: 1 },
  section:      { paddingBottom: 20, marginBottom: 20, borderBottom: "1px solid #f3f4f6" },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#92400e", marginBottom: 14 },
  grid:         { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 },
  footer:       { display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 20px", borderTop: "1px solid #e5e7eb", background: "#f9fafb", flexShrink: 0 },
  cancelBtn:    { background: "#fff", color: "#374151", border: "1px solid #d1d5db", padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  primaryBtn:   { background: "#4f46e5", color: "#fff", border: "none", padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 700 },
};
