"use client";

import { useState, useEffect, useMemo } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useCentreAccess } from "@/hooks/useCentreAccess";
import {
  getAttendanceByCentreDate,
  saveCentreAttendance,
} from "@/services/attendance/attendance.service";

// ─── Local types ──────────────────────────────────────────────────────────────

interface CentreOption {
  id:   string;
  name: string;
  code: string;
}

interface StudentRow {
  uid:        string;
  name:       string;
  instrument: string;
  classType:  string;  // "group" | "personal"
}

type MarkStatus = "present" | "absent";

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function AttendancePage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <AttendanceContent />
    </ProtectedRoute>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function AttendanceContent() {
  const { user, loading: authLoading } = useAuthContext();
  const { isAllowed, filterCentres, isTeacherRole } = useCentreAccess();

  // ── Top-bar ────────────────────────────────────────────────────────────────
  const [centres,        setCentres]        = useState<CentreOption[]>([]);
  const [selectedCentre, setSelectedCentre] = useState<string>("");
  const [date,           setDate]           = useState<string>(todayISO());

  // ── Data ───────────────────────────────────────────────────────────────────
  const [students,       setStudents]       = useState<StudentRow[]>([]);
  const [marks,          setMarks]          = useState<Record<string, MarkStatus>>({});
  const [existingIds,    setExistingIds]    = useState<Record<string, string>>({}); // studentUid → docId

  // ── UI ─────────────────────────────────────────────────────────────────────
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [feedback,        setFeedback]        = useState<{ ok: boolean; msg: string } | null>(null);

  // ── Load centres ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !user) return;

    async function load() {
      const snap = await getDocs(collection(db, "centers"));
      const all: CentreOption[] = snap.docs.map(d => ({
        id:   d.id,
        name: (d.data().name  as string) || d.id,
        code: (d.data().centerCode as string) || "",
      }));

      // filterCentres enforces teacher.centerIds; admins get all
      const visible = filterCentres(all);
      setCentres(visible);
      // Auto-select when only one centre (always true for single-centre teachers)
      if (visible.length === 1) setSelectedCentre(visible[0].id);
    }

    load().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  // ── Load students + existing attendance whenever centre or date changes ────
  useEffect(() => {
    if (!selectedCentre || !user) return;
    const currentUser = user;

    async function load() {
      setLoadingStudents(true);
      setStudents([]);
      setMarks({});
      setExistingIds({});
      setFeedback(null);

      try {
        // Students for this centre
        const q    = query(
          collection(db, "users"),
          where("role",     "==", "student"),
          where("centerId", "==", selectedCentre),
        );
        const snap = await getDocs(q);
        const rows: StudentRow[] = snap.docs.map(d => {
          const data = d.data() as Record<string, unknown>;
          return {
            uid:        d.id,
            name:       (data.displayName as string) || (data.name as string) || d.id,
            instrument: (data.instrument  as string) || "",
            classType:  (data.classType   as string) === "personal" ? "personal" : "group",
          };
        });
        // Sort: group first, then by name within each group
        rows.sort((a, b) => {
          if (a.classType !== b.classType) return a.classType === "group" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        // Existing attendance for this centre + date
        const existing = await getAttendanceByCentreDate(selectedCentre, date);
        const existingMap: Record<string, string>     = {}; // uid → docId
        const statusMap:   Record<string, MarkStatus> = {};

        existing.forEach(r => {
          existingMap[r.studentUid] = r.id;
          statusMap[r.studentUid]   = r.status as MarkStatus;
        });

        // Default: present for everyone not already recorded
        const defaultMarks: Record<string, MarkStatus> = {};
        rows.forEach(s => {
          defaultMarks[s.uid] = statusMap[s.uid] ?? "present";
        });

        setStudents(rows);
        setExistingIds(existingMap);
        setMarks(defaultMarks);
      } finally {
        setLoadingStudents(false);
      }
    }

    load().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCentre, date]);

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const total       = students.length;
    const present     = Object.values(marks).filter(m => m === "present").length;
    const groupCount  = students.filter(s => s.classType === "group").length;
    const personalCount = students.filter(s => s.classType === "personal").length;
    return { total, present, absent: total - present, groupCount, personalCount };
  }, [students, marks]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function toggle(uid: string) {
    setMarks(prev => ({ ...prev, [uid]: prev[uid] === "present" ? "absent" : "present" }));
  }

  function markAllPresent() {
    const next: Record<string, MarkStatus> = {};
    students.forEach(s => { next[s.uid] = "present"; });
    setMarks(next);
  }

  function markAllAbsent() {
    const next: Record<string, MarkStatus> = {};
    students.forEach(s => { next[s.uid] = "absent"; });
    setMarks(next);
  }

  async function handleSave() {
    if (!selectedCentre || !user || students.length === 0 || saving) return;
    setSaving(true);
    setFeedback(null);

    const results = await Promise.allSettled(
      students.map(s =>
        saveCentreAttendance({
          studentUid: s.uid,
          centerId:   selectedCentre,
          date,
          status:     marks[s.uid] ?? "present",
          markedBy:   user.uid,
        }),
      ),
    );

    const failed = results.filter(r => r.status === "rejected").length;
    setSaving(false);

    if (failed === 0) {
      // Refresh existing map so re-saves are updates, not creates
      const fresh = await getAttendanceByCentreDate(selectedCentre, date);
      const map: Record<string, string> = {};
      fresh.forEach(r => { map[r.studentUid] = r.id; });
      setExistingIds(map);

      setFeedback({
        ok:  true,
        msg: `Saved — ${summary.present} present, ${summary.absent} absent.`,
      });
    } else {
      setFeedback({
        ok:  false,
        msg: `${failed} record(s) failed to save. Check console for details.`,
      });
    }
  }

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (authLoading) return null;

  // Hard block: teacher attempting to access a centre outside their list
  if (selectedCentre && !isAllowed(selectedCentre)) {
    return (
      <div style={{ padding: "64px 0", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🚫</div>
        <p style={{ fontSize: 16, fontWeight: 700, color: "#dc2626" }}>Access Denied</p>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
          You are not assigned to this centre.
        </p>
      </div>
    );
  }

  const canSave = !!selectedCentre && students.length > 0 && !saving;
  // Teachers with a single centre: hide the dropdown (auto-selected already)
  const hideCentreDropdown = isTeacherRole && centres.length === 1;

  return (
    <div style={{ fontFamily: "inherit", maxWidth: 800, margin: "0 auto" }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 }}>
          Mark Attendance
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
          Select a centre and date. Toggle absentees, then save.
        </p>
      </div>

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>

          {!hideCentreDropdown && (
            <Field label="Centre">
              <select
                value={selectedCentre}
                onChange={e => setSelectedCentre(e.target.value)}
                style={input}
              >
                <option value="">— Select centre —</option>
                {centres.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.code ? `[${c.code}] ` : ""}{c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {hideCentreDropdown && centres[0] && (
            <Field label="Centre">
              <div style={{ ...input, background: "#f9fafb", cursor: "default", color: "#374151", fontWeight: 600 }}>
                {centres[0].code ? `[${centres[0].code}] ` : ""}{centres[0].name}
              </div>
            </Field>
          )}

          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              style={input}
            />
          </Field>

        </div>
      </div>

      {/* ── Quick actions + live summary ──────────────────────────────────── */}
      {students.length > 0 && (
        <div style={{
          ...card,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          flexWrap:       "wrap",
          gap:            12,
        }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={markAllPresent} style={btn("#16a34a", "#fff")}>✓ All Present</button>
            <button onClick={markAllAbsent}  style={btn("#dc2626", "#fff")}>✗ All Absent</button>
          </div>

          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <Chip label="Total"    value={summary.total}        color="#4f46e5" />
            <Chip label="Present"  value={summary.present}      color="#16a34a" />
            <Chip label="Absent"   value={summary.absent}       color="#dc2626" />
            <Chip label="Group"    value={summary.groupCount}   color="#166534" />
            <Chip label="Personal" value={summary.personalCount} color="#92400e" />

            <button
              onClick={handleSave}
              disabled={!canSave}
              style={{ ...btn("#4f46e5", "#fff"), minWidth: 130, opacity: canSave ? 1 : 0.45 }}
            >
              {saving ? "Saving…" : "💾 Save"}
            </button>
          </div>
        </div>
      )}

      {/* ── Feedback ──────────────────────────────────────────────────────── */}
      {feedback && (
        <div style={{
          ...card,
          padding:    "12px 16px",
          background: feedback.ok ? "#dcfce7" : "#fee2e2",
          border:     `1px solid ${feedback.ok ? "#86efac" : "#fca5a5"}`,
          color:      feedback.ok ? "#15803d" : "#dc2626",
          display:    "flex",
          alignItems: "center",
          gap:        8,
          fontSize:   13,
          fontWeight: 500,
        }}>
          <span>{feedback.ok ? "✓" : "✗"}</span>
          <span style={{ flex: 1 }}>{feedback.msg}</span>
          <button
            onClick={() => setFeedback(null)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "inherit", opacity: 0.6 }}
          >×</button>
        </div>
      )}

      {/* ── Empty states ──────────────────────────────────────────────────── */}
      {!selectedCentre && (
        <EmptyHint icon="🏫" text="Select a centre to begin." />
      )}

      {selectedCentre && loadingStudents && (
        <div style={{ ...card, textAlign: "center", padding: "48px 0", color: "#6b7280", fontSize: 14 }}>
          Loading students…
        </div>
      )}

      {selectedCentre && !loadingStudents && students.length === 0 && (
        <EmptyHint icon="👥" text="No students found for this centre." />
      )}

      {/* ── Student list ──────────────────────────────────────────────────── */}
      {selectedCentre && !loadingStudents && students.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          {students.map((s, i) => {
            const isPresent = (marks[s.uid] ?? "present") === "present";
            const hasRecord = !!existingIds[s.uid];

            return (
              <div
                key={s.uid}
                onClick={() => toggle(s.uid)}
                style={{
                  display:      "flex",
                  alignItems:   "center",
                  padding:      "14px 20px",
                  cursor:       "pointer",
                  borderBottom: i < students.length - 1 ? "1px solid #f3f4f6" : "none",
                  background:   isPresent ? "#f0fdf4" : "#fff1f2",
                  userSelect:   "none",
                }}
              >
                {/* Status dot */}
                <div style={{
                  width:        12,
                  height:       12,
                  borderRadius: "50%",
                  background:   isPresent ? "#22c55e" : "#ef4444",
                  marginRight:  14,
                  flexShrink:   0,
                  boxShadow:    isPresent
                    ? "0 0 0 3px rgba(34,197,94,0.18)"
                    : "0 0 0 3px rgba(239,68,68,0.18)",
                }} />

                {/* Name + instrument + class type */}
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>
                    {s.name}
                  </span>
                  {s.instrument && (
                    <span style={{ marginLeft: 8, fontSize: 12, color: "#6b7280" }}>
                      {s.instrument}
                    </span>
                  )}
                  <span style={{
                    marginLeft: 8, fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 99,
                    background: s.classType === "personal" ? "#fef9c3" : "#dcfce7",
                    color:      s.classType === "personal" ? "#92400e" : "#166534",
                  }}>
                    {s.classType === "personal" ? "Personal" : "Group"}
                  </span>
                </div>

                {/* Saved indicator */}
                {hasRecord && (
                  <span style={{ fontSize: 11, color: "#9ca3af", marginRight: 12 }}>saved</span>
                )}

                {/* Status badge */}
                <span style={{
                  padding:      "4px 14px",
                  borderRadius: 99,
                  fontSize:     12,
                  fontWeight:   700,
                  background:   isPresent ? "#dcfce7" : "#fee2e2",
                  color:        isPresent ? "#15803d" : "#dc2626",
                }}>
                  {isPresent ? "Present" : "Absent"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Bottom save (for long lists) ──────────────────────────────────── */}
      {students.length > 7 && (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{ ...btn("#4f46e5", "#fff"), opacity: canSave ? 1 : 0.45, padding: "10px 28px", fontSize: 14 }}
          >
            {saving ? "Saving…" : "💾 Save Attendance"}
          </button>
        </div>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Chip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center", minWidth: 36 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ ...card, textAlign: "center", padding: "52px 0" }}>
      <div style={{ fontSize: 36, marginBottom: 10 }}>{icon}</div>
      <p style={{ fontSize: 14, color: "#6b7280", margin: 0 }}>{text}</p>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background:   "#fff",
  border:       "1px solid #e5e7eb",
  borderRadius: 10,
  padding:      "16px 20px",
  marginBottom: 16,
  boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
};

const input: React.CSSProperties = {
  padding:      "8px 12px",
  border:       "1px solid #d1d5db",
  borderRadius: 7,
  fontSize:     13,
  outline:      "none",
  color:        "#111827",
  background:   "#fff",
  cursor:       "pointer",
  minWidth:     180,
};

function btn(bg: string, fg: string): React.CSSProperties {
  return {
    background:   bg,
    color:        fg,
    border:       "none",
    padding:      "8px 16px",
    borderRadius: 7,
    fontSize:     13,
    fontWeight:   600,
    cursor:       "pointer",
    whiteSpace:   "nowrap",
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
