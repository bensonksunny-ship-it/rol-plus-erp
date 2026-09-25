"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getDocs, collection, query, where, doc, writeBatch, serverTimestamp, arrayUnion, arrayRemove } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { getCenters, createCenter, updateCenter } from "@/services/center/center.service";
import { getTeachers } from "@/services/teacher/teacher.service";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import type { Center, CenterBatch, Wing } from "@/types";
import { DEFAULT_BATCH_NAME, effectiveBatches, explicitBatches } from "@/lib/batches";
import { formatTime12, formatTimeRange12, formatTimesIn12h } from "@/lib/timeFormat";
import { getTeacherDisplayName } from "@/lib/teacherName";
import type { TeacherUser } from "@/types";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { useAuth } from "@/hooks/useAuth";
import { useWing } from "@/hooks/useWing";
import { isSchoolOfMusic, inWing, wingOf } from "@/lib/wing";
import { getCached, setCached } from "@/lib/dataCache";
import { deleteCenter } from "@/services/admin/delete.service";
import { parseFile } from "@/lib/xlsx-parser";
import { safeCompare, sortKey } from "@/lib/sortKey";

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

function BatchesEditor({ batches, onChange }: { batches: CenterBatch[]; onChange: (b: CenterBatch[]) => void }) {
  function addBatch() {
    onChange([...batches, { id: newBatchId(), name: "", daysOfWeek: [], startTime: "", endTime: "" }]);
  }
  function updateBatch(id: string, patch: Partial<CenterBatch>) {
    onChange(batches.map(b => b.id === id ? { ...b, ...patch } : b));
  }
  function removeBatch(id: string) {
    onChange(batches.filter(b => b.id !== id));
  }
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
      {batches.length === 0 && (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          No batches yet — the centre&apos;s days &amp; time above act as its single {DEFAULT_BATCH_NAME}, and every
          student here is in it. Adding a batch replaces the {DEFAULT_BATCH_NAME}.
        </div>
      )}
      {batches.map(b => (
        <div key={b.id} style={batchStyles.row}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
            <input
              value={b.name}
              onChange={e => updateBatch(b.id, { name: e.target.value })}
              placeholder="e.g. Batch A, Weekend Morning"
              style={{ ...formStyles.input, flex: "1 1 180px" }}
            />
            <input type="time" value={b.startTime} onChange={e => updateBatch(b.id, { startTime: e.target.value })}
              style={{ ...formStyles.input, width: 110 }} />
            <span style={{ fontSize: 12, color: "#9ca3af" }}>to</span>
            <input type="time" value={b.endTime} onChange={e => updateBatch(b.id, { endTime: e.target.value })}
              style={{ ...formStyles.input, width: 110 }} />
            <button type="button" onClick={() => removeBatch(b.id)} style={batchStyles.removeBtn} title="Remove batch">✕</button>
          </div>
          <DayChips selected={b.daysOfWeek as Day[]} onChange={days => updateBatch(b.id, { daysOfWeek: days })} />
        </div>
      ))}
      <button type="button" onClick={addBatch} style={batchStyles.addBtn}>+ Add Batch</button>
    </div>
  );
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
  /** Profile photo (admission `photo` data URL, or an uploaded photoURL) — "" when none. */
  photo?: string;
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
interface PickedStudent { uid: string; name: string; admissionNo: string; createdAt: string; photo?: string; instrument?: string; batchId?: string | null; }

/** A student counts as "active" whether their `status` field carries the
 *  Students page's own vocabulary ("active") or the Registry's ("confirm" /
 *  "confirmed") — matches the definition used everywhere else in the app. */
function isActiveStudentStatus(status: string): boolean {
  return /^(active|confirm|confirmed)$/i.test((status || "").trim());
}

function isManualPayment(t: CenterTxRec): boolean {
  return t.status === "completed" && t.type !== "fee_due" && t.type !== "charge" && t.method !== "auto" && t.method !== "auto-monthly";
}

// ─── View Modal (tabbed: Attendance History / Graphs & Insights) ───────────────

type ViewTab = "attendance" | "students" | "insights";

function ViewModal({ center: centerProp, onClose, teachers, onSaved }: {
  center: Center; onClose: () => void; teachers: TeacherUser[]; onSaved?: (updated: Center) => void;
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
      await updateCenter(center.id, {
        name:       editForm.name.trim(),
        teacherUid: editForm.teacherUid.trim(),
        status:     editForm.status,
        timeSlot,
        batches:    editForm.batches,
        demoClassDate:  editForm.demoClassDate,
        firstClassDate: editForm.firstClassDate,
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
        daysOfWeek: editForm.daysOfWeek,
        startTime:  editForm.startTime,
        endTime:    editForm.endTime,
      } as Center & { daysOfWeek: Day[]; startTime: string; endTime: string };
      setCenter(updated);
      setEditing(false);
      onSaved?.(updated);
    } catch (err) {
      console.error("[ViewModal] update error:", err);
      setEditErr(err instanceof Error ? err.message : "Failed to update center.");
    } finally {
      setSavingEdit(false);
    }
  }

  const [tab, setTab] = useState<ViewTab>("students");
  const [attRecs,  setAttRecs]  = useState<CenterAttRec[]>([]);
  const [students, setStudents] = useState<CenterStudentRec[]>([]);
  const [txs,      setTxs]      = useState<CenterTxRec[]>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
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
        setStudents(stuSnap.docs.map(d => {
          const st = d.data();
          return {
            uid: d.id,
            name: (st.displayName ?? st.name ?? "-") as string,
            admissionNo: (st.admissionNo ?? st.admissionNumber ?? "") as string,
            status: (st.status ?? st.studentStatus ?? "active") as string,
            createdAt: toISODateLocal(st.createdAt),
            photo: studentPhoto(st),
            instrument: (st.instrument ?? "") as string,
            batchId: (st.batchId ?? null) as string | null,
          };
        }));
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
  }, [center.id]);

  const studentMap = useMemo(() => {
    const m = new Map<string, string>();
    students.forEach(s => m.set(s.uid, s.name));
    return m;
  }, [students]);

  // Sets exactly `activeUids` active and every other student at this centre
  // inactive — the "active roster" for the centre.
  async function updateActiveRoster(activeUids: Set<string>) {
    const batch = writeBatch(db);
    let changed = 0;
    students.forEach(s => {
      const newStatus = activeUids.has(s.uid) ? "active" : "inactive";
      if (s.status === newStatus) return;
      changed++;
      batch.update(doc(db, "users", s.uid), {
        status:        newStatus,
        studentStatus: newStatus,
        updatedAt:     serverTimestamp(),
      });
    });
    if (changed > 0) await batch.commit();
    setStudents(prev => prev.map(s => ({ ...s, status: activeUids.has(s.uid) ? "active" : "inactive" })));
  }

  // Assigns existing/new students to this centre and marks them Active —
  // updates their `centerId` (the source of truth for centre membership) and
  // folds them straight into local state so the roster/count reflect it immediately.
  async function addStudentsToCenter(picked: PickedStudent[]) {
    const batch = writeBatch(db);
    picked.forEach(p => {
      batch.update(doc(db, "users", p.uid), {
        centerId:      center.id,
        status:        "active",
        studentStatus: "active",
        updatedAt:     serverTimestamp(),
      });
    });
    await batch.commit();
    setStudents(prev => {
      const existing = new Set(prev.map(s => s.uid));
      const additions = picked
        .filter(p => !existing.has(p.uid))
        .map(p => ({ uid: p.uid, name: p.name, admissionNo: p.admissionNo, status: "active", createdAt: p.createdAt, photo: p.photo, instrument: p.instrument, batchId: p.batchId }));
      return [...prev, ...additions];
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
      <div style={{ ...modalStyles.box, maxWidth: 880, maxHeight: "88vh", display: "flex", flexDirection: "column" as const }} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <div>
            <div style={modalStyles.title}>{center.name}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" as const }}>
              <span style={styles.codeChip}>{(center as Center & { centerCode?: string }).centerCode || "-"}</span>
              <StatusBadge status={center.status} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            {!editing && (
              <button onClick={openEditMode} title="Edit center" style={viewStyles.editBtn}>✏ Edit</button>
            )}
            <button onClick={onClose} style={modalStyles.closeBtn}>×</button>
          </div>
        </div>

        {editing ? (
          <form onSubmit={handleSaveEdit} style={{ padding: "18px 20px", overflowY: "auto" as const, flex: 1 }}>
            <div style={formStyles.grid}>
              <FormField label="Name" required>
                <input name="name" value={editForm.name} onChange={handleEditChange} required
                  placeholder="e.g. Koramangala Center" style={formStyles.input} />
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
                <BatchesEditor batches={editForm.batches} onChange={handleEditBatchesChange} />
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
              <QuickFact label="Days"     value={raw.daysOfWeek?.join(", ") || formatTimesIn12h(center.timeSlot) || "-"} />
              <QuickFact label="Time"     value={formatTimeRange12(raw.startTime, raw.endTime) || "-"} />
              <QuickFact label="Students" value={String(students.length)} />
              {isSchoolOfMusic(center.wing) && center.monthlyFee ? (
                <QuickFact label="Monthly Fee" value={`₹${center.monthlyFee.toLocaleString("en-IN")}`} />
              ) : null}
              <QuickFact label="Batches" value={(center.batches ?? []).length > 0
                ? (center.batches ?? []).map(b => b.name || "Unnamed").join(", ")
                : `${DEFAULT_BATCH_NAME} (centre schedule)`} />
            </div>

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
                <CenterStudentsTab
                  students={students}
                  batches={explicitBatches(center as unknown as Record<string, unknown>)}
                  onUpdateStatuses={updateActiveRoster}
                  onAddStudents={addStudentsToCenter}
                  wing={center.wing}
                  centerId={center.id}
                  centerName={center.name}
                />
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

function QuickFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={viewStyles.quickFactLabel}>{label}</div>
      <div style={viewStyles.quickFactValue}>{value}</div>
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

function CenterStudentsTab({ students, batches, onUpdateStatuses, onAddStudents, wing, centerId, centerName }: {
  students: CenterStudentRec[];
  /** This centre's named batches — resolves each student's batchId to a name. */
  batches: CenterBatch[];
  onUpdateStatuses: (activeUids: Set<string>) => Promise<void>;
  onAddStudents: (picked: PickedStudent[]) => Promise<void>;
  wing: Wing | undefined;
  centerId: string;
  centerName: string;
}) {
  const [search, setSearch]     = useState("");
  const [msg, setMsg]           = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showAdd, setShowAdd]   = useState(false);
  const [removingUid, setRemovingUid] = useState<string | null>(null);

  // Primary view is a strict Active-only roster — Inactive/Cancelled rows
  // never load here at all. Attaching/activating a student happens exclusively
  // through "+ Add Active Students" below.
  const activeStudents = useMemo(() => students.filter(s => s.status === "active"), [students]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeStudents
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.admissionNo.toLowerCase().includes(q))
      .sort((a, b) => safeCompare(a.name, b.name));
  }, [activeStudents, search]);

  // Only already-active students are hidden from the picker — inactive ones
  // registered here are exactly who "+ Add Active Students" should offer.
  const activeUids = useMemo(() => new Set(activeStudents.map(s => s.uid)), [activeStudents]);

  // No named batches → everyone is in the implicit General Batch (see lib/batches).
  function batchLabel(id: string | null | undefined): string {
    if (batches.length === 0) return DEFAULT_BATCH_NAME;
    return batches.find(b => b.id === id)?.name ?? "—";
  }

  async function handleAssign(picked: PickedStudent[]) {
    setMsg(null);
    await onAddStudents(picked);
    setShowAdd(false);
    setMsg({ type: "success", text: `${picked.length} student${picked.length !== 1 ? "s" : ""} added as Active.` });
  }

  // Removes one student from the active roster — the only way left to take a
  // student out of Active from this tab, now that bulk checkboxes are gone.
  async function handleDeactivate(uid: string) {
    setRemovingUid(uid);
    setMsg(null);
    try {
      const nextActive = new Set(activeStudents.filter(s => s.uid !== uid).map(s => s.uid));
      await onUpdateStatuses(nextActive);
      setMsg({ type: "success", text: "Student marked inactive." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Failed to update." });
    } finally {
      setRemovingUid(null);
    }
  }

  return (
    <div>
      {showAdd && (
        <AddStudentsModal
          wing={wing}
          centerId={centerId}
          centerName={centerName}
          excludeUids={activeUids}
          onClose={() => setShowAdd(false)}
          onAssign={handleAssign}
        />
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or ID…"
          style={{ ...formStyles.input, width: 200 }}
        />
        <button onClick={() => setShowAdd(true)} style={{ ...formStyles.submitBtn, background: "#fff", color: "#4338ca", border: "1px solid #c7d2fe" }}>
          + Add Active Students
        </button>
      </div>

      {msg && (
        <div style={{
          marginBottom: 12, fontSize: 12.5, padding: "9px 12px", borderRadius: 8,
          background: msg.type === "success" ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${msg.type === "success" ? "#bbf7d0" : "#fecaca"}`,
          color: msg.type === "success" ? "#16a34a" : "#dc2626",
        }}>
          {msg.text}
        </div>
      )}

      {activeStudents.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "48px 0", color: "#9ca3af", fontSize: 13 }}>
          No active students at this centre yet. Use &ldquo;+ Add Active Students&rdquo; to attach some.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>No students match.</div>
      ) : (
        <div style={{ maxHeight: 420, overflowY: "auto" as const, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...viewStyles.histTh, width: 52 }}><span className="sr-only">Photo</span></th>
                <th style={viewStyles.histTh}>Student</th>
                <th style={viewStyles.histTh}>Instrument</th>
                <th style={viewStyles.histTh}>Batch</th>
                <th style={{ ...viewStyles.histTh, width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.uid} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                  <td style={{ ...viewStyles.histTd, paddingRight: 0, verticalAlign: "middle" as const }}>
                    <StudentAvatar name={s.name} photo={s.photo} />
                  </td>
                  <td style={{ ...viewStyles.histTd, verticalAlign: "middle" as const }}>
                    <div style={{ fontWeight: 600, color: "#111827" }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", marginTop: 1 }}>{s.admissionNo || "No admission no."}</div>
                  </td>
                  <td style={{ ...viewStyles.histTd, verticalAlign: "middle" as const }}>{s.instrument && s.instrument !== "-" ? s.instrument : "—"}</td>
                  <td style={{ ...viewStyles.histTd, verticalAlign: "middle" as const }}>{batchLabel(s.batchId)}</td>
                  <td style={{ ...viewStyles.histTd, verticalAlign: "middle" as const }}>
                    <button
                      onClick={() => handleDeactivate(s.uid)}
                      disabled={removingUid === s.uid}
                      style={{
                        background: "none", border: "1px solid #e5e7eb", borderRadius: 6,
                        padding: "3px 9px", fontSize: 11, color: "#6b7280", cursor: "pointer",
                        opacity: removingUid === s.uid ? 0.5 : 1,
                      }}
                    >
                      {removingUid === s.uid ? "…" : "Deactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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

function AddStudentsModal({ wing, centerId, centerName, excludeUids, onClose, onAssign }: {
  wing: Wing | undefined;
  centerId: string;
  centerName: string;
  excludeUids: Set<string>;
  onClose: () => void;
  onAssign: (picked: PickedStudent[]) => Promise<void>;
}) {
  const [loading, setLoading]     = useState(true);
  const [candidates, setCandidates] = useState<(PickedStudent & { status: string })[]>([]);
  const [search, setSearch]       = useState("");
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const stuSnap = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
        if (cancelled) return;
        const list = stuSnap.docs
          .filter(d => (!wing || inWing(d.data(), wing)) && isRegisteredAtCenter(d.data(), centerId, centerName))
          .map(d => {
            const st = d.data();
            return {
              uid:         d.id,
              name:        (st.displayName ?? st.name ?? "-") as string,
              admissionNo: (st.admissionNo ?? st.admissionNumber ?? "") as string,
              createdAt:   toISODateLocal(st.createdAt),
              status:      (st.status ?? st.studentStatus ?? "active") as string,
              photo:       studentPhoto(st),
              instrument:  (st.instrument ?? "") as string,
              batchId:     (st.batchId ?? null) as string | null,
            };
          })
          .filter(s => !excludeUids.has(s.uid))
          .sort((a, b) => safeCompare(a.name, b.name));
        setCandidates(list);
      } catch (err) {
        console.error("[AddStudentsModal] load error:", err);
        setError("Failed to load students.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wing, centerId, centerName]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(s => s.name.toLowerCase().includes(q) || s.admissionNo.toLowerCase().includes(q));
  }, [candidates, search]);

  function toggle(uid: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  async function handleAssign() {
    const picked = candidates.filter(c => selected.has(c.uid));
    if (picked.length === 0) return;
    setSaving(true);
    setError("");
    try {
      await onAssign(picked.map(({ uid, name, admissionNo, createdAt, photo, instrument, batchId }) => ({ uid, name, admissionNo, createdAt, photo, instrument, batchId })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign students.");
      setSaving(false);
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={{ ...modalStyles.box, maxWidth: 520, maxHeight: "80vh", display: "flex", flexDirection: "column" as const }} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Add Active Students</span>
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
        </div>

        <div style={{ padding: "12px 20px", flex: 1, overflowY: "auto" as const }}>
          {loading ? (
            <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center" as const, padding: "32px 0", color: "#9ca3af", fontSize: 13 }}>
              {candidates.length === 0 ? `No unassigned/inactive students found for ${centerName}.` : "No students match."}
            </div>
          ) : (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 8 }}>
              {filtered.map((s, i) => {
                const isSelected = selected.has(s.uid);
                return (
                  <label key={s.uid} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", fontSize: 12.5, cursor: "pointer",
                    background: isSelected ? "#eef2ff" : i % 2 === 0 ? "#fff" : "#fafafa",
                    borderBottom: "1px solid #f3f4f6",
                  }}>
                    <input type="checkbox" checked={isSelected} onChange={() => toggle(s.uid)} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: "#111827" }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>
                        {s.admissionNo || "no adm. no."}{s.status !== "active" ? ` · ${s.status}` : ""}
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

        <div style={{ ...modalStyles.body, borderTop: "1px solid #e5e7eb", flexDirection: "row" as const, justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{selected.size} selected</span>
          <button
            onClick={handleAssign}
            disabled={selected.size === 0 || saving}
            style={{ ...formStyles.submitBtn, opacity: selected.size === 0 || saving ? 0.5 : 1 }}
          >
            {saving ? "Assigning…" : `Assign ${selected.size || ""} as Active`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Graphs & Insights Tab ──────────────────────────────────────────────────

function CenterInsightsTab({ records, students, transactions }: {
  records: CenterAttRec[]; students: CenterStudentRec[]; transactions: CenterTxRec[];
}) {
  const activeStudents = students.filter(s => s.status === "active").length;

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
  const [deleteTarget, setDeleteTarget] = useState<Center | null>(null);
  const [showMatrix, setShowMatrix] = useState(false);
  const [form, setForm]           = useState({ ...EMPTY_FORM });
  const [saving, setSaving]         = useState(false);
  const [dayError, setDayError]     = useState("");
  const { toasts, toast, remove }   = useToast();

  // ── Bulk import (names only) ──────────────────────────────────────────────
  const [showImport, setShowImport]   = useState(false);
  const [importNames, setImportNames] = useState<string[]>([]);
  const [importErr, setImportErr]     = useState("");
  const [importing, setImporting]     = useState(false);
  const importFileRef                 = useRef<HTMLInputElement>(null);

  const existingNamesLC = useMemo(
    () => new Set(centers.map(c => sortKey(c.name).trim().toLowerCase())),
    [centers],
  );
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
  const pendingFirstClass   = useMemo(() => activeCentersList.filter(needsFirstClassDate), [activeCentersList]);
  const firstClassInputRef  = useRef<HTMLInputElement>(null);
  const newImportNames = useMemo(
    () => importNames.filter(n => !existingNamesLC.has(n.toLowerCase())),
    [importNames, existingNamesLC],
  );

  function openImport() {
    setShowForm(false);
    setImportNames([]);
    setImportErr("");
    setShowImport(true);
  }
  function closeImport() {
    setShowImport(false);
    setImportNames([]);
    setImportErr("");
    if (importFileRef.current) importFileRef.current.value = "";
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportErr("");
    setImportNames([]);
    const { rows, error } = await parseFile(file);
    if (error) { setImportErr(error); return; }
    // Accept a "name" column (also centre/center/centername), else the first column.
    const pick = (r: Record<string, string>) =>
      (r.name ?? r.centrename ?? r.centername ?? r.centre ?? r.center ?? Object.values(r)[0] ?? "").trim();
    const seen = new Set<string>();
    const names: string[] = [];
    for (const r of rows) {
      const n = pick(r);
      if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
    }
    if (names.length === 0) { setImportErr("No centre names found. Put one name per row (a header like \"Name\" is fine)."); return; }
    setImportNames(names);
  }

  async function handleImportRun() {
    if (newImportNames.length === 0 || importing) return;
    setImporting(true);
    let created = 0;
    try {
      for (const name of newImportNames) {
        try {
          await createCenter({
            name, location: "", timeSlot: "", teacherUid: "",
            studentUids: [], status: "active", wing,
          } as Parameters<typeof createCenter>[0]);
          created++;
        } catch (err) {
          console.error(`Failed to create center "${name}":`, err);
        }
      }
      toast(`Imported ${created} centre${created !== 1 ? "s" : ""}. Add teacher, days & times on each.`, created > 0 ? "success" : "error");
      closeImport();
      setLoading(true);
      await fetchCenters();
    } finally {
      setImporting(false);
    }
  }

  async function fetchCenters() {
    const cachedCenters = getCached<Center[]>(`centers:${wing}:centers`);
    if (cachedCenters) {
      setCenters(cachedCenters);
      setTeachers(getCached(`centers:${wing}:teachers`) ?? []);
      setActiveCounts(getCached(`centers:${wing}:activeCounts`) ?? new Map());
      setEarliestAdmissions(getCached(`centers:${wing}:earliestAdmissions`) ?? new Map());
    }
    try {
      const [data, teacherList, studentSnap] = await Promise.all([
        getCenters(wing),
        getTeachers(wing),
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
      ]);
      setCenters(data);
      setCached(`centers:${wing}:centers`, data);
      const sortedTeachers = teacherList.sort((a, b) => safeCompare(getTeacherDisplayName(a), getTeacherDisplayName(b)));
      setTeachers(sortedTeachers);
      setCached(`centers:${wing}:teachers`, sortedTeachers);

      const counts = new Map<string, number>();
      const earliest = new Map<string, string>();
      studentSnap.docs.forEach(d => {
        const st = d.data();
        const cid = (st.centerId ?? "") as string;
        if (!cid) return;
        // Earliest admission counts every student ever at the centre, not just
        // active ones — same precedence as the registry's "Admitted on".
        const admitted = toLocalYMD(st.dateOfAdmission ?? st.admissionDate ?? st.createdAt);
        if (admitted && (!earliest.has(cid) || admitted < earliest.get(cid)!)) earliest.set(cid, admitted);
        if (!isActiveStudentStatus((st.status ?? st.studentStatus ?? "active") as string)) return;
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
      });
      setActiveCounts(counts);
      setCached(`centers:${wing}:activeCounts`, counts);
      setEarliestAdmissions(earliest);
      setCached(`centers:${wing}:earliestAdmissions`, earliest);
    } catch (err) {
      console.error("Failed to fetch centers:", err);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchCenters(); }, [wing]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
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
    setShowImport(false);
    setShowForm(true);
  }

  function openEdit(center: Center) {
    const raw = center as Center & { daysOfWeek?: Day[]; startTime?: string; endTime?: string };
    setEditTarget(center);
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
  }

  const [deactivateTarget, setDeactivateTarget] = useState<Center | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Active → Inactive goes through the transfer/cancel step first.
    if (editTarget && editTarget.status === "active" && form.status === "inactive") { setDeactivateTarget(editTarget); return; }
    await saveForm();
  }

  async function saveForm() {
    setSaving(true);
    const timeSlot = buildTimeSlot(form.daysOfWeek, form.startTime, form.endTime);
    try {
      if (editTarget) {
        await updateCenter(editTarget.id, {
          name:       form.name.trim(),
          teacherUid: form.teacherUid.trim(),
          status:     form.status,
          timeSlot,
          batches:    form.batches,
          demoClassDate:  form.demoClassDate,
          firstClassDate: form.firstClassDate,
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
        toast(
          form.wing !== wing
            ? `Center updated and moved to ${WING_LABELS[form.wing]} — it won't appear in this ${WING_LABELS[wing]} view.`
            : "Center updated successfully.",
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

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />
      {viewTarget && (
        <ViewModal
          center={viewTarget}
          onClose={() => setViewTarget(null)}
          teachers={teachers}
          onSaved={updated => {
            setCenters(prev => prev.map(c => c.id === updated.id ? updated : c));
            toast("Center updated successfully.", "success");
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
          <button onClick={showImport ? closeImport : openImport}
            style={{ ...styles.addBtn, background: showImport ? "#f3f4f6" : "#fff", color: "#4338ca", border: "1px solid #c7d2fe" }}>
            {showImport ? "Cancel" : "⬆ Import names"}
          </button>
          <button onClick={showForm ? closeForm : openCreate} style={styles.addBtn}>
            + Add Center
          </button>
        </div>
      </div>

      {/* Bulk import — names only */}
      {showImport && (
        <div style={formStyles.wrapper}>
          <div style={formStyles.sectionTitle}>Import centre names from Excel / CSV</div>
          <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 12 }}>
            One centre name per row (a header row like <b>Name</b> is fine, or just a plain list).
            Each centre is created as <b>Active</b> with no teacher, days or times — fill those in
            afterwards by editing the centre.
          </div>
          <input
            ref={importFileRef}
            type="file"
            accept=".xlsx,.csv"
            onChange={handleImportFile}
            style={{ fontSize: 13, marginBottom: 10 }}
          />
          {importErr && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, color: "#dc2626", marginBottom: 10 }}>
              {importErr}
            </div>
          )}
          {importNames.length > 0 && (
            <>
              <div style={{ fontSize: 12, color: "#374151", marginBottom: 6 }}>
                {importNames.length} name{importNames.length !== 1 ? "s" : ""} found ·{" "}
                <b style={{ color: "#16a34a" }}>{newImportNames.length} new</b>
                {importNames.length - newImportNames.length > 0 && (
                  <span style={{ color: "#9ca3af" }}> · {importNames.length - newImportNames.length} already exist</span>
                )}
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {importNames.map(n => {
                  const dup = existingNamesLC.has(n.toLowerCase());
                  return (
                    <span key={n} style={{
                      fontSize: 12, padding: "3px 10px", borderRadius: 99,
                      background: dup ? "#f3f4f6" : "#dcfce7",
                      color: dup ? "#9ca3af" : "#15803d",
                      textDecoration: dup ? "line-through" : "none",
                    }}>
                      {n}
                    </span>
                  );
                })}
              </div>
            </>
          )}
          <div style={formStyles.actions}>
            <button
              onClick={handleImportRun}
              disabled={newImportNames.length === 0 || importing}
              style={{ ...formStyles.submitBtn, opacity: newImportNames.length === 0 || importing ? 0.5 : 1 }}
            >
              {importing ? "Importing…" : `Import ${newImportNames.length} centre${newImportNames.length !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      )}

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
          <section style={drawerStyles.section}>
            <div style={drawerStyles.sectionTitle}>Basic Information</div>
            <div style={drawerStyles.grid}>
              <FormField label="Center Name" required fullWidth>
                <input name="name" value={form.name} onChange={handleChange} required
                  placeholder="e.g. Koramangala Center" style={formStyles.input} />
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

          <section style={{ ...drawerStyles.section, borderBottom: "none", marginBottom: 0 }}>
            <div style={drawerStyles.sectionTitle}>Batches Setup</div>
            <BatchesEditor batches={form.batches} onChange={handleBatchesChange} />
          </section>
        </div>

        <div style={drawerStyles.footer}>
          <button type="button" onClick={closeForm} style={drawerStyles.cancelBtn}>Cancel</button>
          <button type="submit" disabled={saving}
            style={{ ...drawerStyles.primaryBtn, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}>
            {saving ? "Saving…" : isEditing ? "Update Center" : "Create Center"}
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
          ) : (
            <div style={styles.grid}>
              {activeCentersList.map(center => (
                <CenterCard key={center.id} center={center}
                  teachers={teachers}
                  activeCount={activeCounts.get(center.id) ?? 0}
                  autoDemoDate={earliestAdmissions.get(center.id) ?? ""}
                  onView={() => setViewTarget(center)}
                  onEdit={() => openEdit(center)}
                  onDelete={() => setDeleteTarget(center)} />
              ))}
            </div>
          )}

          {inactiveCentersList.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", letterSpacing: 0.5, textTransform: "uppercase" as const, marginBottom: 14, paddingBottom: 6, borderBottom: "2px solid #e5e7eb" }}>
                Inactive Centers ({inactiveCentersList.length})
              </div>
              <div style={styles.grid}>
                {inactiveCentersList.map(center => (
                  <CenterCard key={center.id} center={center}
                    teachers={teachers}
                    activeCount={activeCounts.get(center.id) ?? 0}
                    autoDemoDate={earliestAdmissions.get(center.id) ?? ""}
                    onView={() => setViewTarget(center)}
                    onEdit={() => openEdit(center)}
                    onDelete={() => setDeleteTarget(center)} />
                ))}
              </div>
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

/** Card schedule as two lines: days ("Mon/Wed") and time ("5:00 PM – 6:00 PM"). */
function splitSchedule(center: Center): { days: string; time: string } {
  const raw = center as Center & { daysOfWeek?: string[]; startTime?: string; endTime?: string };
  if (raw.daysOfWeek?.length || raw.startTime) {
    return {
      days: (raw.daysOfWeek ?? []).join("/"),
      time: formatTimeRange12(raw.startTime, raw.endTime),
    };
  }
  // Legacy docs only carry the combined "Mon/Wed 17:00–18:30" string.
  const m = /^(.*?)\s*(\d{1,2}:\d{2}.*)$/.exec(center.timeSlot ?? "");
  return m ? { days: m[1].trim(), time: formatTimesIn12h(m[2].trim()) } : { days: center.timeSlot ?? "", time: "" };
}

/** Deterministic 0–7 hue index from the centre name → .center-hue-N in globals.css. */
function getCenterHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  return Math.abs(hash) % 8;
}

function CenterCard({ center, teachers, activeCount, autoDemoDate, onView, onEdit, onDelete }: {
  center: Center; teachers: TeacherUser[]; activeCount: number; autoDemoDate: string;
  onView: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const router = useRouter();
  const [hover, setHover]     = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const teacher = teachers.find(t => t.uid === center.teacherUid);
  const schedule = splitSchedule(center);
  const pendingFirst = needsFirstClassDate(center);

  function goToActiveStudents(e: React.MouseEvent) {
    e.stopPropagation();
    router.push(`/dashboard/enrollments?view=students&center=${encodeURIComponent(center.id)}&status=active`);
  }

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
      className={`center-hue-${getCenterHue(center.name.trim().toLowerCase())}`}
      style={{ ...styles.card, ...(hover ? styles.cardHover : {}), cursor: "pointer", position: "relative", borderTop: "3px solid var(--center-hue)" }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    >
      <div style={{ ...styles.cardHeader, justifyContent: "flex-end" as const }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
      <div style={{ ...styles.cardName, color: "var(--center-hue)", fontWeight: 700 }}>{center.name}</div>
      <div style={styles.cardMeta}>
        {teacher
          ? <span>{getTeacherDisplayName(teacher)}</span>
          : <span style={{ color: "#9ca3af", fontSize: 12 }}>Unassigned</span>}
      </div>
      {pendingFirst && (
        <span style={styles.pendingBadge}>⏳ Pending First Class Date</span>
      )}
      <div style={styles.cardMeta}>
        <span>{schedule.days || "-"}</span>
        {schedule.time && <span style={{ fontSize: 12, fontWeight: 500, color: "#4f46e5" }}>{schedule.time}</span>}
      </div>
      {(center.demoClassDate || autoDemoDate || center.firstClassDate) && (
        <div style={{ fontSize: 11.5, color: "#6b7280" }}>
          Demo:{" "}
          {center.demoClassDate
            ? fmtDMY(center.demoClassDate)
            : autoDemoDate
              ? <span title="Earliest student admission at this centre — set a Demo Class Date to override">{fmtDMY(autoDemoDate)} (auto)</span>
              : "—"}
          {" | "}
          First Class:{" "}
          {center.firstClassDate
            ? fmtDMY(center.firstClassDate)
            : <span style={{ color: "#b45309", fontWeight: 600 }}>Pending</span>}
        </div>
      )}
      <button
        onClick={goToActiveStudents}
        style={styles.activeStudentsBadge}
        title={`${activeCount} active student${activeCount !== 1 ? "s" : ""} — view them`}
      >
        🎓 {activeCount} →
      </button>
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
        // Same-wing centres first — a transfer normally stays within the wing.
        setDests(cenSnap.docs
          .filter(d => d.id !== center.id)
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
  grid:        { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 },
  card:        { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 },
  cardHover:   { boxShadow: "0 4px 14px rgba(0,0,0,0.08)" },
  cardHeader:  { display: "flex", alignItems: "center", justifyContent: "space-between" },
  cardName:    { fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" },
  pendingBadge: { alignSelf: "flex-start", fontSize: 11, fontWeight: 600, color: "#b45309", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 99, padding: "2px 8px" },
  cardMeta:    { display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: "var(--color-text-primary)" },
  cardMetaLabel:{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" },
  codeChip:    { fontFamily: "monospace", fontSize: 11, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4, fontWeight: 600 },
  activeStudentsBadge: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8,
    padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", textAlign: "left",
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
  row:       { display: "flex", flexDirection: "column", gap: 8, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 },
  removeBtn: { background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, width: 28, height: 28, fontSize: 13, cursor: "pointer", flexShrink: 0 },
  addBtn:    { alignSelf: "flex-start", background: "#fff", color: "#4f46e5", border: "1px solid #c7d2fe", borderRadius: 6, padding: "6px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
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
