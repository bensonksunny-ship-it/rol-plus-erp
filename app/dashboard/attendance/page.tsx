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
import { useWing } from "@/hooks/useWing";
import { inWing, isSchoolOfMusic } from "@/lib/wing";
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
// Furthest future date that can be marked as Break (90-day cap).
function maxBreakDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
// Month corresponding to maxBreakDate — used to cap the month picker.
function maxBreakMonth(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
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
  // Stored value stays "cancelled_student" for backward compatibility with
  // existing records, but the option now represents a day the student had
  // no scheduled class at all (e.g. enrolled for only 1 of a centre's 2
  // weekly slots) — not an actual cancellation.
  cancelled_student:  "Not Assigned",
};
const STATUS_COLOR: Record<AttendanceStatus, { bg: string; fg: string }> = {
  present:           { bg: "#dcfce7", fg: "#16a34a" },
  absent:            { bg: "#fee2e2", fg: "#dc2626" },
  break:             { bg: "#e0f2fe", fg: "#0369a1" },
  cancelled_teacher: { bg: "#fef3c7", fg: "#92400e" },
  cancelled_student: { bg: "#f3f4f6", fg: "#6b7280" },
};
const STATUS_SHORT: Record<AttendanceStatus, string> = {
  present:           "P",
  absent:            "A",
  break:             "☕",
  cancelled_teacher: "CT",
  cancelled_student: "NA",
};
const ALL_STATUSES: AttendanceStatus[] = [
  "present","absent","break","cancelled_teacher","cancelled_student",
];

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function AttendancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER]}>
      <AttendanceContent />
    </ProtectedRoute>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface ModalState {
  centreId:      string;
  studentUid:    string;
  studentName:   string;
  date:          string;
  current:       AttendanceStatus | null;
  futureOnly:    boolean;
  upcomingDates: string[]; // scheduled class dates from today → maxBreakDate
  pastBreakDates?: string[]; // unrecorded past break dates for this student
}

function CellModal({
  state,
  onSave,
  onClose,
  saving,
}: {
  state:   ModalState;
  onSave:  (status: AttendanceStatus, dates: string[]) => void;
  onClose: () => void;
  saving:  boolean;
}) {
  const allowed: AttendanceStatus[] = state.futureOnly ? ["break"] : ALL_STATUSES;
  const [pick, setPick] = useState<AttendanceStatus>(
    state.current && allowed.includes(state.current) ? state.current : allowed[0],
  );
  // Pre-select past unrecorded breaks if available, otherwise just the clicked date.
  const [breakDates, setBreakDates] = useState<Set<string>>(
    new Set(state.pastBreakDates?.length ? state.pastBreakDates : [state.date])
  );

  const toggleDate = (d: string) => setBreakDates(prev => {
    const next = new Set(prev);
    if (next.has(d)) { next.delete(d); } else { next.add(d); }
    return next;
  });

  const handleSaveClick = () => {
    if (pick === "break" && state.pastBreakDates?.length) {
      // Save all selected past break dates (breakDates already seeded from pastBreakDates)
      onSave(pick, Array.from(breakDates).length > 0 ? Array.from(breakDates) : [state.date]);
    } else if (pick === "break" && state.upcomingDates.length > 0) {
      const selected = new Set([state.date, ...Array.from(breakDates)]);
      onSave(pick, Array.from(selected));
    } else {
      onSave(pick, [state.date]);
    }
  };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...modal, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4 }}>
          {state.studentName}
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
          {new Date(state.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
        </div>
        {state.futureOnly && (
          <div style={{ fontSize: 11, color: "#0369a1", background: "#e0f2fe", padding: "6px 10px", borderRadius: 6, marginBottom: 12 }}>
            Future date — only Break can be marked in advance.
          </div>
        )}
        {!state.futureOnly && <div style={{ marginBottom: 12 }} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {allowed.map(s => {
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

        {/* Past unrecorded break dates — shown when teacher clicks a faded ☕ cell */}
        {pick === "break" && state.pastBreakDates && state.pastBreakDates.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#b45309", marginBottom: 4 }}>
              Unrecorded past break dates
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
              These classes were not recorded yet. Uncheck any you don&apos;t want to save.
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, border: "1px solid #fcd34d", borderRadius: 8, padding: 8 }}>
              {state.pastBreakDates.map(d => {
                const checked = breakDates.has(d);
                return (
                  <label key={d} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer", padding: "5px 8px", borderRadius: 6, background: checked ? "#fef3c7" : "transparent", color: checked ? "#92400e" : "#374151" }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleDate(d)} style={{ cursor: "pointer", accentColor: "#b45309" }} />
                    {new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                    {d === state.date && <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ca3af" }}>this class</span>}
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
              {breakDates.size} date{breakDates.size !== 1 ? "s" : ""} will be saved as Break
            </div>
          </div>
        )}

        {/* Multi-date break selector for upcoming classes */}
        {pick === "break" && state.upcomingDates.length > 0 && !state.pastBreakDates?.length && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#0369a1", marginBottom: 8 }}>
              Also mark break for upcoming classes:
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, border: "1px solid #bae6fd", borderRadius: 8, padding: 8 }}>
              {state.upcomingDates.map(d => {
                const checked = breakDates.has(d);
                const isClicked = d === state.date;
                return (
                  <label key={d} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer", padding: "5px 8px", borderRadius: 6, background: checked ? "#e0f2fe" : "transparent", color: checked ? "#0369a1" : "#374151" }}>
                    <input type="checkbox" checked={checked} onChange={() => { if (!isClicked) toggleDate(d); }} style={{ cursor: isClicked ? "default" : "pointer", accentColor: "#0369a1" }} />
                    {new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                    {isClicked && <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ca3af" }}>this class</span>}
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
              {breakDates.size} class{breakDates.size !== 1 ? "es" : ""} selected
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={btnGhost} disabled={saving}>Cancel</button>
          <button onClick={handleSaveClick} style={btnPrimary} disabled={saving || (pick === "break" && (state.pastBreakDates?.length ? breakDates.size === 0 : state.upcomingDates.length > 0 && breakDates.size === 0))}>
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

  // upcoming scheduled class dates from today → 90 days ahead (for break multi-select)
  const upcomingDates = useMemo(() => {
    const maxD  = maxBreakDate();
    const dates: string[] = [];
    const d     = new Date(today + "T00:00:00");
    const end   = new Date(maxD  + "T00:00:00");
    while (d <= end) {
      const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      if (centre.daysOfWeek.includes(DAY_ABBR[d.getDay()]) || extraDates.has(iso)) {
        dates.push(iso);
      }
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }, [today, centre.daysOfWeek, extraDates]);

  if (students.length === 0) return null;

  return (
    <div style={card}>
      {/* Centre header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>
            {centre.name}
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
              {students.flatMap((st, i) => {
                let p = 0, a = 0;
                const colCount  = scheduledDates.length + 4;
                const prevType  = i > 0 ? students[i - 1].classType : null;
                const headers   = [];
                if (i === 0 && st.classType === "group") {
                  headers.push(
                    <tr key="section-group">
                      <td colSpan={colCount} style={{ background: "#f0fdf4", color: "#166534", fontSize: 11, fontWeight: 700, padding: "4px 10px", letterSpacing: "0.04em" }}>
                        Group Classes
                      </td>
                    </tr>
                  );
                } else if (st.classType === "personal" && prevType !== "personal") {
                  headers.push(
                    <tr key="section-personal">
                      <td colSpan={colCount} style={{ background: "#f5f3ff", color: "#6d28d9", fontSize: 11, fontWeight: 700, padding: "4px 10px", letterSpacing: "0.04em" }}>
                        Individual Classes
                      </td>
                    </tr>
                  );
                }
                return [
                  ...headers,
                  <tr key={st.uid} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={{ ...td, minWidth: 140, whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 600, color: "#111827" }}>{st.name}</div>
                      {st.instrument && <div style={{ fontSize: 10, color: "#9ca3af" }}>{st.instrument}</div>}
                    </td>
                    {(() => {
                      // Bug 1 fix: personal students use their own classDays for
                      // the multi-date break selector, not the center's schedule.
                      const studentUpcoming =
                        st.classType === "personal" && st.classDays.length > 0
                          ? upcomingDates.filter(d => st.classDays.includes(dowOf(d)))
                          : upcomingDates;

                      // Bug 2 fix: collect all past unrecorded break dates for this
                      // student so the modal can offer to save them all at once.
                      const pastUnrecordedBreaks = st.breakStartDate
                        ? scheduledDates.filter(d =>
                            d <= today &&
                            d >= st.breakStartDate! &&
                            !attMap.has(`${st.uid}|${d}`)
                          )
                        : [];

                      return scheduledDates.map(date => {
                        const onBreak   = !!st.breakStartDate && date >= st.breakStartDate;
                        const isFuture  = date > today;
                        const statusKey = `${st.uid}|${date}`;
                        const status    = attMap.get(statusKey) ?? null;

                        // Count for summary — Break and Not Assigned ("cancelled_student")
                        // are intentionally excluded from both the P/A counts and the %
                        // column, so non-class days never drag down a student's attendance.
                        if (status === "present") p++;
                        else if (status === "absent") a++;

                        if (isFuture) {
                          if (date <= maxBreakDate()) {
                            return (
                              <td key={date}
                                onClick={() => onCellClick({ centreId: centre.id, studentUid: st.uid, studentName: st.name, date, current: onBreak ? "break" : null, futureOnly: true, upcomingDates: studentUpcoming })}
                                style={{ ...td, textAlign: "center", padding: "5px 3px", minWidth: 38, cursor: "pointer", borderLeft: "1px solid #f3f4f6", ...(onBreak ? STATUS_COLOR.break : { background: "#f0f9ff", color: "#bae6fd" }) }}
                                title="Mark break for this date"
                              >
                                {onBreak ? STATUS_SHORT.break : "·"}
                              </td>
                            );
                          }
                          return <td key={date} style={{ ...td, textAlign: "center", padding: "5px 3px", minWidth: 38, background: "#fafafa", color: "#e5e7eb", borderLeft: "1px solid #f3f4f6" }}>·</td>;
                        }

                        // Bug 2 fix: past break cell with no record — show faded
                        // indicator and pass all unrecorded past break dates so
                        // the modal can save them all at once.
                        if (onBreak && !status) {
                          return (
                            <td key={date}
                              onClick={() => onCellClick({ centreId: centre.id, studentUid: st.uid, studentName: st.name, date, current: "break", futureOnly: false, upcomingDates: studentUpcoming, pastBreakDates: pastUnrecordedBreaks })}
                              style={{ ...td, textAlign: "center", padding: "5px 3px", minWidth: 38, cursor: "pointer", borderLeft: "1px solid #f3f4f6", ...STATUS_COLOR.break, opacity: 0.5 }}
                              title="Break (unsaved — click to record)"
                            >
                              {STATUS_SHORT.break}
                            </td>
                          );
                        }

                        const sc = status ? STATUS_COLOR[status] : { bg: "#f9fafb", fg: "#d1d5db" };
                        return (
                          <td key={date}
                            onClick={() => onCellClick({ centreId: centre.id, studentUid: st.uid, studentName: st.name, date, current: status, futureOnly: false, upcomingDates: studentUpcoming })}
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
                      });
                    })()}
                    {/* Summary */}
                    <td style={{ ...td, textAlign: "center", fontWeight: 700, color: "#16a34a", minWidth: 36 }}>{p}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 700, color: "#dc2626", minWidth: 36 }}>{a}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 700, fontSize: 12, color: p + a > 0 ? (p / (p+a) >= 0.75 ? "#16a34a" : p / (p+a) >= 0.5 ? "#d97706" : "#dc2626") : "#9ca3af", minWidth: 36 }}>
                      {p + a > 0 ? `${Math.round(p/(p+a)*100)}%` : "—"}
                    </td>
                  </tr>
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}

// ─── Today view — quick mark the batches that have class on a chosen day ──────

const QUICK_STATUSES: AttendanceStatus[] = ["present", "absent", "break"];

function shiftDay(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function TodayView({
  date, setDate, centres, studentMap, attMap, extraMap, userUid, onSaved,
}: {
  date:       string;
  setDate:    (d: string) => void;
  centres:    CentreRow[];
  studentMap: Map<string, StudentRow[]>;
  attMap:     Map<string, AttRec[]>;
  extraMap:   Map<string, Set<string>>;
  userUid:    string;
  onSaved:    (centreId: string, changes: { uid: string; date: string; status: AttendanceStatus }[]) => void;
}) {
  // draft: `${centreId}|${uid}` -> status (unsaved picks)
  const [draft, setDraft]     = useState<Map<string, AttendanceStatus>>(new Map());
  const [savingId, setSavingId] = useState<string | null>(null);

  // Reset drafts whenever the day changes.
  useEffect(() => { setDraft(new Map()); }, [date]);

  const isToday   = date === todayISO();
  const dow       = new Date(date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long" });
  const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  const todaysCentres = centres.filter(c =>
    (studentMap.get(c.id)?.length ?? 0) > 0 &&
    isScheduled(date, c, extraMap.get(c.id) ?? new Set()),
  );

  const savedStatus = (centreId: string, uid: string): AttendanceStatus | null =>
    (attMap.get(centreId) ?? []).find(r => r.studentUid === uid && r.date === date)?.status ?? null;

  const effective = (centreId: string, uid: string): AttendanceStatus | null =>
    draft.get(`${centreId}|${uid}`) ?? savedStatus(centreId, uid);

  function pick(centreId: string, uid: string, status: AttendanceStatus) {
    setDraft(prev => {
      const next = new Map(prev);
      const key  = `${centreId}|${uid}`;
      if (savedStatus(centreId, uid) === status) next.delete(key);   // back to saved = no draft
      else next.set(key, status);
      return next;
    });
  }

  function markAllPresent(centreId: string) {
    const students = studentMap.get(centreId) ?? [];
    setDraft(prev => {
      const next = new Map(prev);
      for (const s of students) {
        if (savedStatus(centreId, s.uid) === "present") next.delete(`${centreId}|${s.uid}`);
        else next.set(`${centreId}|${s.uid}`, "present");
      }
      return next;
    });
  }

  function pendingFor(centreId: string): { uid: string; status: AttendanceStatus }[] {
    const students = studentMap.get(centreId) ?? [];
    return students
      .map(s => ({ uid: s.uid, status: draft.get(`${centreId}|${s.uid}`) }))
      .filter((x): x is { uid: string; status: AttendanceStatus } => !!x.status);
  }

  async function save(centreId: string) {
    const pending = pendingFor(centreId);
    if (pending.length === 0) return;
    setSavingId(centreId);
    try {
      await Promise.all(pending.map(p =>
        saveCentreAttendance({ studentUid: p.uid, centerId: centreId, date, status: p.status, markedBy: userUid }),
      ));
      onSaved(centreId, pending.map(p => ({ uid: p.uid, date, status: p.status })));
      setDraft(prev => {
        const next = new Map(prev);
        for (const p of pending) next.delete(`${centreId}|${p.uid}`);
        return next;
      });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      {/* Day navigator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => setDate(shiftDay(date, -1))} style={btnGhost}>‹</button>
        <input type="date" value={date} min={minMonth() + "-01"} max={shiftDay(todayISO(), 7)}
          onChange={e => e.target.value && setDate(e.target.value)} style={inputStyle} />
        <button onClick={() => setDate(shiftDay(date, 1))} style={btnGhost}>›</button>
        {!isToday && <button onClick={() => setDate(todayISO())} style={btnGhost}>Today</button>}
        <span style={{ fontSize: 13, color: "#6b7280" }}>{dow}, {dateLabel}</span>
      </div>

      {todaysCentres.length === 0 ? (
        <div style={{ textAlign: "center", padding: "56px 0", color: "#6b7280" }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🎵</div>
          <p style={{ fontSize: 14, margin: 0 }}>No batches have a class on {dow}.</p>
          <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>Pick another day, or check the batch class-days in Centres.</p>
        </div>
      ) : (
        todaysCentres.map(centre => {
          const students = studentMap.get(centre.id) ?? [];
          const pending  = pendingFor(centre.id).length;
          const counts   = students.reduce((a, s) => {
            const st = effective(centre.id, s.uid);
            if (st === "present") a.present++;
            else if (st === "absent") a.absent++;
            else if (st) a.other++;
            else a.unmarked++;
            return a;
          }, { present: 0, absent: 0, other: 0, unmarked: 0 });
          const isExtra = !centre.daysOfWeek.includes(dowOf(date));

          return (
            <div key={centre.id} style={{ ...card, padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{centre.name}</span>
                  <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: 99 }}>
                    {centre.daysOfWeek.join(" · ") || "no days"}
                  </span>
                  {isExtra && <span style={{ marginLeft: 6, fontSize: 11, color: "#166534", background: "#dcfce7", padding: "2px 8px", borderRadius: 99 }}>extra class</span>}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => markAllPresent(centre.id)} style={btnSmall}>All present</button>
                  <button onClick={() => save(centre.id)} disabled={pending === 0 || savingId === centre.id}
                    style={{ ...btnPrimary, flex: "none", padding: "7px 16px", opacity: pending === 0 ? 0.5 : 1, cursor: pending === 0 ? "not-allowed" : "pointer" }}>
                    {savingId === centre.id ? "Saving…" : pending > 0 ? `Save ${pending}` : "Saved"}
                  </button>
                </div>
              </div>

              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>
                {counts.present} present · {counts.absent} absent
                {counts.other > 0 && ` · ${counts.other} other`}
                {counts.unmarked > 0 && ` · ${counts.unmarked} unmarked`}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {students.map(s => {
                  const eff = effective(centre.id, s.uid);
                  const dirty = draft.has(`${centre.id}|${s.uid}`);
                  return (
                    <div key={s.uid} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 8px", borderRadius: 8,
                      background: dirty ? "#eff6ff" : "transparent",
                    }}>
                      <span style={{ flex: 1, fontSize: 13, color: "#111827", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.name}
                        {s.instrument && <span style={{ color: "#9ca3af", fontSize: 11 }}> · {s.instrument}</span>}
                      </span>
                      {QUICK_STATUSES.map(st => {
                        const on = eff === st;
                        const { bg, fg } = STATUS_COLOR[st];
                        return (
                          <button key={st} onClick={() => pick(centre.id, s.uid, st)} style={{
                            minWidth: 34, padding: "6px 8px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 700,
                            border: on ? `2px solid ${fg}` : "1px solid #e5e7eb",
                            background: on ? bg : "#fff", color: on ? fg : "#9ca3af",
                          }}>
                            {STATUS_SHORT[st]}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function AttendanceContent() {
  const { user, loading: authLoading } = useAuthContext();
  const { filterCentres }              = useCentreAccess();
  const { wing }                       = useWing();

  const [tab,     setTab]     = useState<"today" | "history">("today");
  const [dayDate, setDayDate] = useState<string>(todayISO());
  const [month,   setMonth]   = useState<string>(currentMonth());
  const [centres, setCentres] = useState<CentreRow[]>([]);
  const [centresLoaded, setCentresLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  // Keep the loaded month in sync with whichever day the "Today" view is showing.
  useEffect(() => {
    const m = dayDate.slice(0, 7);
    if (m !== month) setMonth(m);
  }, [dayDate]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const snap = await getDocs(query(collection(db, "centers"), where("status", "==", "active")));
      const all: CentreRow[] = snap.docs
        .filter(d => inWing(d.data(), wing))
        .map(d => {
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
    })()
      .catch(console.error)
      .finally(() => setCentresLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, wing]);

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
    if (!centresLoaded) return;
    if (centres.length > 0) loadAll(centres, month);
    else setLoading(false);   // no centres in this wing — don't hang on the spinner
  }, [centresLoaded, centres, month, loadAll]);

  // ── Save attendance ───────────────────────────────────────────────────────
  async function handleSave(status: AttendanceStatus, dates: string[]) {
    if (!modal || !user) return;
    setSaving(true);
    const datesToSave = dates.length > 0 ? dates : [modal.date];
    try {
      await Promise.all(datesToSave.map(date =>
        saveCentreAttendance({
          studentUid: modal.studentUid,
          centerId:   modal.centreId,
          date,
          status,
          markedBy:   user.uid,
        })
      ));
      setAttMap(prev => {
        const next = new Map(prev);
        const recs = [...(next.get(modal.centreId) ?? [])];
        datesToSave.forEach(date => {
          const idx = recs.findIndex(r => r.studentUid === modal.studentUid && r.date === date);
          if (idx >= 0) recs[idx] = { ...recs[idx], status };
          else recs.push({ id: `${modal.studentUid}|${date}`, studentUid: modal.studentUid, date, status });
        });
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

  const tabBtn = (key: "today" | "history", label: string): React.CSSProperties => ({
    padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
    border: tab === key ? "2px solid #4f46e5" : "1px solid #e5e7eb",
    background: tab === key ? "#ede9fe" : "#fafafa",
    color: tab === key ? "#4f46e5" : "#374151",
  });

  return (
    <div style={{ fontFamily: "inherit" }}>
      {/* Header */}
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 }}>Attendance</h1>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4, margin: 0 }}>
            {tab === "today" ? "Mark the batches that have class on a given day" : "Month grid — review and correct any date"}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setTab("today")} style={tabBtn("today", "Today")}>Today</button>
          <button onClick={() => setTab("history")} style={tabBtn("history", "History")}>History</button>
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
          <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 4 }}>
            No {isSchoolOfMusic(wing) ? "Rol's School of Music " : ""}batches yet.
          </p>
          <p style={{ color: "#9ca3af", fontSize: 12 }}>
            Create a centre with class-days and enrol students into it to start marking attendance.
          </p>
        </div>
      )}

      {/* ── Today tab ── */}
      {!loading && centres.length > 0 && tab === "today" && (
        <TodayView
          date={dayDate}
          setDate={setDayDate}
          centres={centres}
          studentMap={studentMap}
          attMap={attMap}
          extraMap={extraMap}
          userUid={user?.uid ?? ""}
          onSaved={(centreId, changes) => {
            setAttMap(prev => {
              const next = new Map(prev);
              const recs = [...(next.get(centreId) ?? [])];
              for (const ch of changes) {
                const idx = recs.findIndex(r => r.studentUid === ch.uid && r.date === ch.date);
                if (idx >= 0) recs[idx] = { ...recs[idx], status: ch.status };
                else recs.push({ id: `${ch.uid}|${ch.date}`, studentUid: ch.uid, date: ch.date, status: ch.status });
              }
              next.set(centreId, recs);
              return next;
            });
          }}
        />
      )}

      {/* ── History tab (month grid) ── */}
      {!loading && centres.length > 0 && tab === "history" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <input type="month" value={month} min={minMonth()} max={maxBreakMonth()}
              onChange={e => setMonth(e.target.value)} style={inputStyle} />
            {month !== currentMonth() && (
              <button onClick={() => setMonth(currentMonth())} style={btnGhost}>← This month</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
            {ALL_STATUSES.map(s => (
              <span key={s} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4, color: STATUS_COLOR[s].fg, background: STATUS_COLOR[s].bg, padding: "2px 8px", borderRadius: 99 }}>
                <b>{STATUS_SHORT[s]}</b> {STATUS_LABEL[s]}
              </span>
            ))}
          </div>
          {centres.map(centre => (
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
        </>
      )}

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
