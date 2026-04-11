"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection, getDocs, query, where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import {
  saveCentreAttendance,
  saveExtraClass,
  getExtraClassesByCentre,
} from "@/services/attendance/attendance.service";
import type { AttendanceStatus } from "@/services/attendance/attendance.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CentreRow {
  id:         string;
  name:       string;
  code:       string;
  daysOfWeek: string[];   // ["Mon","Wed","Fri"]
  teacherUid: string;
}

interface StudentRow {
  uid:            string;
  name:           string;
  instrument:     string;
  classType:      "group" | "personal";
  classDays:      string[];    // personal only
  breakStartDate: string | null;
}

interface AttRec {
  id:         string;
  studentUid: string;
  date:       string;
  status:     AttendanceStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function minMonth(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[parseInt(m,10)-1]} ${y}`;
}
function datesInMonth(month: string): string[] {
  const [yr, mo] = month.split("-").map(Number);
  const days     = new Date(yr, mo, 0).getDate();
  return Array.from({ length: days }, (_, i) =>
    `${month}-${String(i+1).padStart(2,"0")}`);
}
const DAY_ABBR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function dowOf(iso: string): string {
  return DAY_ABBR[new Date(iso + "T00:00:00").getDay()];
}
function dayNum(iso: string): number {
  return new Date(iso + "T00:00:00").getDate();
}

// Is this date a scheduled class for a centre (regular schedule or extra class)?
function isScheduled(date: string, centre: CentreRow, extraDates: Set<string>): boolean {
  if (extraDates.has(date)) return true;
  if (centre.daysOfWeek.length === 0) return false;
  return centre.daysOfWeek.includes(dowOf(date));
}

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present:            "Present",
  absent:             "Absent",
  break:              "Break",
  cancelled_teacher:  "Cancelled (Teacher)",
  cancelled_student:  "Cancelled (Student)",
};
const STATUS_COLOR: Record<AttendanceStatus, { bg: string; fg: string }> = {
  present:           { bg: "#dcfce7", fg: "#16a34a" },
  absent:            { bg: "#fee2e2", fg: "#dc2626" },
  break:             { bg: "#e0f2fe", fg: "#0369a1" },
  cancelled_teacher: { bg: "#fef3c7", fg: "#92400e" },
  cancelled_student: { bg: "#ede9fe", fg: "#6d28d9" },
};
const STATUS_SHORT: Record<AttendanceStatus, string> = {
  present:           "P",
  absent:            "A",
  break:             "☕",
  cancelled_teacher: "CT",
  cancelled_student: "CS",
};
const ALL_STATUSES: AttendanceStatus[] = [
  "present","absent","break","cancelled_teacher","cancelled_student",
];

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function AttendancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <AttendanceContent />
    </ProtectedRoute>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface ModalState {
  centreId:   string;
  studentUid: string;
  studentName:string;
  date:       string;
  current:    AttendanceStatus | null;
}

function CellModal({
  state,
  onSave,
  onClose,
  saving,
}: {
  state:   ModalState;
  onSave:  (status: AttendanceStatus) => void;
  onClose: () => void;
  saving:  boolean;
}) {
  const [pick, setPick] = useState<AttendanceStatus>(state.current ?? "present");

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4 }}>
          {state.studentName}
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>
          {new Date(state.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ALL_STATUSES.map(s => {
            const { bg, fg } = STATUS_COLOR[s];
            const active     = pick === s;
            return (
              <button key={s} onClick={() => setPick(s)} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                border: active ? `2px solid ${fg}` : "2px solid transparent",
                background: active ? bg : "#f9fafb", color: active ? fg : "#374151",
                fontWeight: active ? 700 : 500, fontSize: 13, textAlign: "left",
              }}>
                <span style={{ fontSize: 16, minWidth: 24, textAlign: "center" }}>{STATUS_SHORT[s]}</span>
                {STATUS_LABEL[s]}
                {state.current === s && <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af" }}>current</span>}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={btnGhost} disabled={saving}>Cancel</button>
          <button onClick={() => onSave(pick)} style={btnPrimary} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Extra Class Modal ────────────────────────────────────────────────────────

function ExtraClassModal({
  centreId,
  month,
  existingDates,
  onSave,
  onClose,
  saving,
}: {
  centreId:      string;
  month:         string;
  existingDates: Set<string>;
  onSave:        (date: string, note: string) => void;
  onClose:       () => void;
  saving:        boolean;
}) {
  const [yr, mo] = month.split("-").map(Number);
  const maxDate  = `${month}-${String(new Date(yr, mo, 0).getDate()).padStart(2,"0")}`;
  const [date, setDate] = useState(`${month}-01`);
  const [note, setNote] = useState("");
  const already = existingDates.has(date);

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16 }}>
          Add Extra Class
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={labelStyle}>
            Date
            <input
              type="date"
              value={date}
              min={`${month}-01`}
              max={maxDate}
              onChange={e => setDate(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Note (optional)
            <input
              type="text"
              value={note}
              placeholder="e.g. Makeup class"
              onChange={e => setNote(e.target.value)}
              style={inputStyle}
            />
          </label>
          {already && (
            <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", padding: "8px 12px", borderRadius: 7 }}>
              ⚠ This date is already a scheduled class day.
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={btnGhost} disabled={saving}>Cancel</button>
          <button onClick={() => onSave(date, note)} style={btnPrimary} disabled={saving || already}>
            {saving ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Centre Calendar Card ─────────────────────────────────────────────────────

function CentreCard({
  centre,
  students,
  attendance,
  extraDates,
  month,
  today,
  onCellClick,
  onAddExtra,
}: {
  centre:      CentreRow;
  students:    StudentRow[];
  attendance:  AttRec[];
  extraDates:  Set<string>;
  month:       string;
  today:       string;
  onCellClick: (m: ModalState) => void;
  onAddExtra:  () => void;
}) {
  const allDates    = useMemo(() => datesInMonth(month), [month]);
  const scheduledDates = useMemo(
    () => allDates.filter(d => isScheduled(d, centre, extraDates)),
    [allDates, centre, extraDates],
  );

  // attMap: `${studentUid}|${date}` → status
  const attMap = useMemo(() => {
    const m = new Map<string, AttendanceStatus>();
    attendance.forEach(r => m.set(`${r.studentUid}|${r.date}`, r.status));
    return m;
  }, [attendance]);

  if (students.length === 0) return null;

  return (
    <div style={card}>
      {/* Centre header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>
            {centre.code ? `[${centre.code}] ` : ""}{centre.name}
          </span>
          {centre.daysOfWeek.length > 0 && (
            <span style={{ marginLeft: 10, fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: 99 }}>
              {centre.daysOfWeek.join(" · ")}
            </span>
          )}
        </div>
        <button onClick={onAddExtra} style={btnSmall}>+ Extra Class</button>
      </div>

      {scheduledDates.length === 0 ? (
        <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>
          No scheduled classes in {fmtMonth(month)}.
          {centre.daysOfWeek.length === 0 && " Centre has no class days configured."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
            <thead>
              <tr>
                <th style={th}>Student</th>
                {scheduledDates.map(date => {
                  const isExtra = extraDates.has(date) && !centre.daysOfWeek.includes(dowOf(date));
                  const isToday = date === today;
                  return (
                    <th key={date} style={{
                      ...th, textAlign: "center", minWidth: 38, padding: "5px 3px",
                      borderLeft: "1px solid #e5e7eb",
                      background: isToday ? "#fef3c7" : isExtra ? "#f0fdf4" : "#f9fafb",
                      color: isToday ? "#92400e" : isExtra ? "#166534" : "#6b7280",
                    }}>
                      <div style={{ fontWeight: 700 }}>{dayNum(date)}</div>
                      <div style={{ fontSize: 9 }}>{dowOf(date)}</div>
                      {isExtra && <div style={{ fontSize: 8, color: "#16a34a" }}>+extra</div>}
                    </th>
                  );
                })}
                {/* Summary */}
                <th style={{ ...th, textAlign: "center", background: "#dcfce7", color: "#166534", minWidth: 36 }}>P</th>
                <th style={{ ...th, textAlign: "center", background: "#fee2e2", color: "#991b1b", minWidth: 36 }}>A</th>
                <th style={{ ...th, textAlign: "center", background: "#f9fafb", color: "#6b7280", minWidth: 36 }}>%</th>
              </tr>
            </thead>
            <tbody>
              {students.map((st, i) => {
                let p = 0, a = 0;
                return (
                  <tr key={st.uid} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={{ ...td, minWidth: 140, whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 600, color: "#111827" }}>{st.name}</div>
                      {st.instrument && <div style={{ fontSize: 10, color: "#9ca3af" }}>{st.instrument}</div>}
                    </td>
                    {scheduledDates.map(date => {
                      const onBreak    = !!st.breakStartDate && date >= st.breakStartDate;
                      const isFuture   = date > today;
                      const statusKey  = `${st.uid}|${date}`;
                      const status     = attMap.get(statusKey) ?? null;

                      // Count for summary
                      if (status === "present") p++;
                      else if (status === "absent") a++;

                      if (isFuture) {
                        return <td key={date} style={{ ...td, textAlign: "center", padding: "5px 3px", minWidth: 38, background: "#fafafa", color: "#e5e7eb", borderLeft: "1px solid #f3f4f6" }}>·</td>;
                      }
                      if (onBreak && !status) {
                        return (
                          <td key={date} onClick={() => onCellClick({ centreId: centre.id, studentUid: st.uid, studentName: st.name, date, current: "break" })}
                            style={{ ...td, textAlign: "center", padding: "5px 3px", minWidth: 38, cursor: "pointer", borderLeft: "1px solid #f3f4f6", ...STATUS_COLOR.break }}>
                            {STATUS_SHORT.break}
                          </td>
                        );
                      }

                      const sc = status ? STATUS_COLOR[status] : { bg: "#f9fafb", fg: "#d1d5db" };
                      return (
                        <td key={date}
                          onClick={() => onCellClick({ centreId: centre.id, studentUid: st.uid, studentName: st.name, date, current: status })}
                          style={{
                            ...td, textAlign: "center", padding: "5px 3px", minWidth: 38,
                            cursor: "pointer", borderLeft: "1px solid #f3f4f6",
                            background: sc.bg, color: sc.fg,
                          }}
                          title={status ? STATUS_LABEL[status] : "Click to mark"}
                        >
                          {status ? STATUS_SHORT[status] : <span style={{ color: "#d1d5db" }}>·</span>}
                        </td>
                      );
                    })}
                    {/* Summary */}
                    <td style={{ ...td, textAlign: "center", fontWeight: 700, color: "#16a34a", minWidth: 36 }}>{p}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 700, color: "#dc2626", minWidth: 36 }}>{a}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 700, fontSize: 12, color: p + a > 0 ? (p / (p+a) >= 0.75 ? "#16a34a" : p / (p+a) >= 0.5 ? "#d97706" : "#dc2626") : "#9ca3af", minWidth: 36 }}>
                      {p + a > 0 ? `${Math.round(p/(p+a)*100)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        {ALL_STATUSES.map(s => (
          <span key={s} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4, color: STATUS_COLOR[s].fg, background: STATUS_COLOR[s].bg, padding: "2px 8px", borderRadius: 99 }}>
            <b>{STATUS_SHORT[s]}</b> {STATUS_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function AttendanceContent() {
  const { user, loading: authLoading } = useAuthContext();
  const { filterCentres }              = useCentreAccess();

  const [month,   setMonth]   = useState<string>(currentMonth());
  const [centres, setCentres] = useState<CentreRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-centre data
  const [studentMap,    setStudentMap]    = useState<Map<string, StudentRow[]>>(new Map());
  const [attMap,        setAttMap]        = useState<Map<string, AttRec[]>>(new Map());
  const [extraMap,      setExtraMap]      = useState<Map<string, Set<string>>>(new Map());

  // Modal state
  const [modal,       setModal]       = useState<ModalState | null>(null);
  const [saving,      setSaving]      = useState(false);
  const [extraTarget, setExtraTarget] = useState<string | null>(null);   // centreId
  const [savingExtra, setSavingExtra] = useState(false);

  const today = todayISO();

  // ── Load centres ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !user) return;
    (async () => {
      const snap = await getDocs(collection(db, "centers"));
      const all: CentreRow[] = snap.docs.map(d => {
        const data = d.data() as Record<string, unknown>;
        return {
          id:         d.id,
          name:       (data.name       as string) || d.id,
          code:       (data.centerCode as string) || "",
          daysOfWeek: Array.isArray(data.daysOfWeek) ? (data.daysOfWeek as string[]) : [],
          teacherUid: (data.teacherUid as string) || "",
        };
      });
      setCentres(filterCentres(all));
    })().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  // ── Load students + attendance for all centres when month changes ─────────
  const loadAll = useCallback(async (centreList: CentreRow[], m: string) => {
    if (!centreList.length) return;
    setLoading(true);
    try {
      const [yr, mo] = m.split("-").map(Number);
      const daysInM  = new Date(yr, mo, 0).getDate();
      const mStart   = `${m}-01`;
      const mEnd     = `${m}-${String(daysInM).padStart(2,"0")}`;

      // Batch load students and attendance for each centre
      const centreIds = centreList.map(c => c.id);

      // Students: one query per centre (Firestore limitation)
      const stuPromises = centreIds.map(cid =>
        getDocs(query(collection(db, "users"), where("role","==","student"), where("centerId","==",cid)))
      );
      // Attendance: one query per centre
      const attPromises = centreIds.map(cid =>
        getDocs(query(collection(db, "attendance"), where("centerId","==",cid)))
      );
      // Extra classes: use service function
      const extraPromises = centreIds.map(cid => getExtraClassesByCentre(cid, m));

      const [stuResults, attResults, extraResults] = await Promise.all([
        Promise.all(stuPromises),
        Promise.all(attPromises),
        Promise.all(extraPromises),
      ]);

      const newStudentMap = new Map<string, StudentRow[]>();
      const newAttMap     = new Map<string, AttRec[]>();
      const newExtraMap   = new Map<string, Set<string>>();

      centreIds.forEach((cid, i) => {
        const students: StudentRow[] = stuResults[i].docs
          .filter(d => {
            const st = ((d.data().status ?? d.data().studentStatus ?? "active") as string);
            return st !== "inactive" && st !== "deactivation_requested";
          })
          .map(d => {
            const data = d.data() as Record<string, unknown>;
            const st   = ((data.status ?? data.studentStatus ?? "active") as string);
            return {
              uid:            d.id,
              name:           (data.displayName as string) || (data.name as string) || d.id,
              instrument:     (data.instrument  as string) || "",
              classType:      ((data.classType as string) === "personal" ? "personal" : "group") as "group" | "personal",
              classDays:      Array.isArray(data.classDays) ? (data.classDays as string[]) : [],
              breakStartDate: (st === "on_break" || st === "break_requested")
                ? ((data.breakStartDate as string) ?? null) : null,
            };
          })
          .sort((a, b) => {
            if (a.classType !== b.classType) return a.classType === "group" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

        const attRecs: AttRec[] = attResults[i].docs
          .map(d => {
            const r = d.data() as Record<string, unknown>;
            return {
              id:         d.id,
              studentUid: r.studentUid as string,
              date:       (r.date as string) ?? "",
              status:     (r.status as AttendanceStatus) ?? "absent",
            };
          })
          .filter(r => r.date >= mStart && r.date <= mEnd);

        const extraSet = new Set(extraResults[i].map(e => e.date));

        newStudentMap.set(cid, students);
        newAttMap.set(cid, attRecs);
        newExtraMap.set(cid, extraSet);
      });

      setStudentMap(newStudentMap);
      setAttMap(newAttMap);
      setExtraMap(newExtraMap);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (centres.length > 0) loadAll(centres, month);
  }, [centres, month, loadAll]);

  // ── Save attendance ───────────────────────────────────────────────────────
  async function handleSave(status: AttendanceStatus) {
    if (!modal || !user) return;
    setSaving(true);
    try {
      await saveCentreAttendance({
        studentUid: modal.studentUid,
        centerId:   modal.centreId,
        date:       modal.date,
        status,
        markedBy:   user.uid,
      });
      // Update local attMap
      setAttMap(prev => {
        const next    = new Map(prev);
        const recs    = [...(next.get(modal.centreId) ?? [])];
        const idx     = recs.findIndex(r => r.studentUid === modal.studentUid && r.date === modal.date);
        if (idx >= 0) recs[idx] = { ...recs[idx], status };
        else recs.push({ id: `${modal.studentUid}|${modal.date}`, studentUid: modal.studentUid, date: modal.date, status });
        next.set(modal.centreId, recs);
        return next;
      });
      setModal(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Save extra class ──────────────────────────────────────────────────────
  async function handleSaveExtra(date: string, note: string) {
    if (!extraTarget || !user) return;
    setSavingExtra(true);
    try {
      await saveExtraClass(extraTarget, date, user.uid, note);
      setExtraMap(prev => {
        const next = new Map(prev);
        const set  = new Set(next.get(extraTarget) ?? []);
        set.add(date);
        next.set(extraTarget, set);
        return next;
      });
      setExtraTarget(null);
    } finally {
      setSavingExtra(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (authLoading) return null;

  return (
    <div style={{ fontFamily: "inherit" }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 }}>Attendance</h1>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4, margin: 0 }}>
            All centres · click any cell to mark or edit
          </p>
        </div>
        {/* Month picker */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="month"
            value={month}
            min={minMonth()}
            max={currentMonth()}
            onChange={e => setMonth(e.target.value)}
            style={inputStyle}
          />
          {month !== currentMonth() && (
            <button onClick={() => setMonth(currentMonth())} style={btnGhost}>
              ← Today
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "64px 0", color: "#9ca3af", fontSize: 14 }}>
          Loading…
        </div>
      )}

      {!loading && centres.length === 0 && (
        <div style={{ textAlign: "center", padding: "64px 0" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🏫</div>
          <p style={{ color: "#6b7280", fontSize: 14 }}>No centres available.</p>
        </div>
      )}

      {!loading && centres.map(centre => (
        <CentreCard
          key={centre.id}
          centre={centre}
          students={studentMap.get(centre.id) ?? []}
          attendance={attMap.get(centre.id) ?? []}
          extraDates={extraMap.get(centre.id) ?? new Set()}
          month={month}
          today={today}
          onCellClick={setModal}
          onAddExtra={() => setExtraTarget(centre.id)}
        />
      ))}

      {/* Cell modal */}
      {modal && (
        <CellModal
          state={modal}
          onSave={handleSave}
          onClose={() => setModal(null)}
          saving={saving}
        />
      )}

      {/* Extra class modal */}
      {extraTarget && (
        <ExtraClassModal
          centreId={extraTarget}
          month={month}
          existingDates={(() => {
            const c   = centres.find(c => c.id === extraTarget)!;
            const all = datesInMonth(month);
            const ex  = extraMap.get(extraTarget) ?? new Set<string>();
            // All already-scheduled dates (regular + extra)
            return new Set(all.filter(d => isScheduled(d, c, ex)));
          })()}
          onSave={handleSaveExtra}
          onClose={() => setExtraTarget(null)}
          saving={savingExtra}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
  padding: "16px 20px", marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};
const th: React.CSSProperties = {
  padding: "7px 10px", textAlign: "left", fontSize: 11, fontWeight: 700,
  color: "#6b7280", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap",
  background: "#f9fafb",
};
const td: React.CSSProperties = {
  padding: "8px 10px", verticalAlign: "middle", borderBottom: "1px solid #f3f4f6",
};
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const modal: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: "24px", width: 340, maxWidth: "90vw",
  boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 7,
  fontSize: 13, outline: "none", color: "#111827", background: "#fff",
  cursor: "pointer",
};
const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 5,
  fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5,
};
const btnPrimary: React.CSSProperties = {
  flex: 1, padding: "10px 0", borderRadius: 8, border: "none",
  background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 7, border: "1px solid #d1d5db",
  background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer",
};
const btnSmall: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db",
  background: "#fff", color: "#374151", fontSize: 12, fontWeight: 600, cursor: "pointer",
};
