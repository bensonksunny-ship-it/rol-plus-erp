"use client";

// Registry — the master register of Rol's School of Music. A single flat table
// of every School-of-Music student, in admission order. Read-only, plus an
// Excel/CSV bulk import.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection, getDocs, query, where, writeBatch, doc, updateDoc, serverTimestamp, Timestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { wingOf } from "@/lib/wing";
import { parseFile, normalizeHeader } from "@/lib/xlsx-parser";
import { formatAdmissionNo, reserveAdmissionSeq } from "@/lib/admissionNumber";
import { logAction } from "@/services/audit/audit.service";
import { SYLLABUS_INSTRUMENT_LABELS, type SyllabusInstrument } from "@/types/lesson";

const WING = WINGS.SCHOOL_OF_MUSIC;

interface Entry {
  uid:         string;
  name:        string;
  admittedOn:  string;   // ISO date or ""
  centre:      string;
  batch:       string;
  phone:       string;
  admissionNo: string;
  course:      string;
  status:      string;
  screening:   string;   // composite score / imported grade / "—"
}

/** Human-readable screening grade from a student doc. */
function screeningGradeOf(s: Record<string, unknown>): string {
  const sc = s.screening as { averageScore?: number; config?: { track?: string } } | null | undefined;
  if (sc && typeof sc.averageScore === "number") return `${sc.averageScore.toFixed(2)} / 5`;
  if (typeof s.screeningGrade === "string" && s.screeningGrade.trim()) return s.screeningGrade.trim();
  if (sc?.config?.track) return sc.config.track;
  return "—";
}

/** Sort key: the last 3 digits of an admission number, as a number.
 *  "ROLCC02092025103" → 103 · "—" / no digits → Infinity (sorts last). */
function admTail(admissionNo: string): number {
  const digits = (admissionNo || "").replace(/\D/g, "");
  return digits ? parseInt(digits.slice(-3), 10) : Number.POSITIVE_INFINITY;
}

// Editable status choices shown in the registry Status dropdown.
const STATUS_OPTIONS = ["Confirm", "Cancelled", "Hold"] as const;

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Badge colour for a free-text status (Confirm / Cancelled / active / …). */
function statusStyle(status: string): React.CSSProperties {
  const v = status.trim().toLowerCase();
  const base: React.CSSProperties = {
    display: "inline-block", padding: "2px 8px", borderRadius: 4,
    fontSize: 11, fontWeight: 600, textTransform: "capitalize",
  };
  if (/^(confirm|confirmed|active|enrolled|joined)$/.test(v)) return { ...base, background: "#f0fdf4", color: "#166534" };
  if (/^(cancel|cancelled|canceled|rejected|dropped|left|inactive|deactivated)$/.test(v)) return { ...base, background: "#fef2f2", color: "#991b1b" };
  if (/^(pending|hold|onhold|waitlist|break)$/.test(v)) return { ...base, background: "#fffbeb", color: "#92400e" };
  return { ...base, background: "#f3f4f6", color: "#6b7280" };
}

function toISO(v: unknown): string {
  if (v && typeof v === "object" && "toDate" in v) {
    try { return (v as { toDate(): Date }).toDate().toISOString(); } catch { return ""; }
  }
  return typeof v === "string" ? v : "";
}

/** Parse a spreadsheet date cell (DD/MM/YYYY, YYYY-MM-DD, "5 Jan 2025", Excel serial). */
function parseSheetDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  // Excel serial number (days since 1899-12-30)
  if (/^\d{4,6}$/.test(v)) {
    const serial = Number(v);
    if (serial > 20000 && serial < 80000) {
      const ms = (serial - 25569) * 86400 * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  let m = v.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    const d = new Date(year, Number(mm) - 1, Number(dd));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  m = v.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Column order assumed ONLY for a header-less paste. Columns are otherwise
// always mapped by their header name — no content guessing.
const REGISTRY_COLUMNS = [
  "name", "dateofadmission", "wing", "centre", "batch",
  "phonenumber", "admissionno", "course", "status", "screeninggrade",
];
const HEADER_WORDS = /name|wing|centre|center|batch|admission|phone|mobile|course|instrument|status|date|screening|grade/i;

// Fields for the "paste by column" mode.
const COL_FIELDS: { key: string; label: string }[] = [
  { key: "name",            label: "Name" },
  { key: "dateofadmission", label: "Date Of Admission" },
  { key: "wing",            label: "Wing" },
  { key: "centre",          label: "Centre" },
  { key: "batch",           label: "Batch" },
  { key: "phonenumber",     label: "Phone number" },
  { key: "admissionno",     label: "Admission no." },
  { key: "course",          label: "Course" },
  { key: "status",          label: "Status" },
  { key: "screeninggrade",  label: "Screening grade" },
];

/**
 * Parse tabular text pasted from Excel / Google Sheets (tab-delimited), CSV, or
 * a plain 2+-space-aligned table. If the first line doesn't look like a header
 * row, the canonical column order (Name · Date · Centre · Phone ·
 * Admission no. · Course · Status · Screening) is assumed.
 */
function parsePastedTable(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];

  const first = lines[0];
  const delim: string | RegExp = first.includes("\t") ? "\t" : first.includes(",") ? "," : /\s{2,}/;
  const cut = (l: string) => l.split(delim).map(c => c.trim());

  const looksLikeHeader = HEADER_WORDS.test(first) && !/\d{5,}/.test(first);
  let headers: string[];
  let dataLines: string[];
  if (looksLikeHeader) {
    headers = cut(first).map(normalizeHeader);
    dataLines = lines.slice(1);
  } else {
    headers = REGISTRY_COLUMNS;
    dataLines = lines;
  }

  const rows: Record<string, string>[] = [];
  for (const line of dataLines) {
    const cells = cut(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { if (h) row[h] = cells[idx] ?? ""; });
    if (Object.values(row).some(v => v)) rows.push(row);
  }
  return rows;
}

export default function RegistryPage() {
  return (
    <ProtectedRoute
      allowedRoles={[ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.TEACHER]}
      requiredCapability={CAPABILITIES.STUDENTS_VIEW_ALL}
    >
      <RegistryContent />
    </ProtectedRoute>
  );
}

function RegistryContent() {
  const { user, can } = useAuth();
  const canImport = can(CAPABILITIES.STUDENTS_MANAGE);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [centres, setCentres] = useState<{ id: string; name: string; code: string }[]>([]);
  const [existingAdmNos, setExistingAdmNos] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showImport, setShowImport] = useState(false);
  const [pastedText, setPastedText] = useState("");

  // ── Bulk delete ──────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<null | "selected" | "all">(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [studSnap, centreSnap] = await Promise.all([
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "centers")),
      ]);

      // Only School-of-Music centres — never surface a centre from the other wing.
      const centreName = new Map<string, string>();
      const centreList: { id: string; name: string; code: string }[] = [];
      centreSnap.docs.forEach(d => {
        if (wingOf(d.data()) !== WING) return;
        const nm = (d.data().name as string) ?? d.id;
        centreName.set(d.id, nm);
        centreList.push({ id: d.id, name: nm, code: (d.data().centerCode as string) ?? "" });
      });
      setCentres(centreList);

      const admNos = new Set<string>();
      const list: Entry[] = studSnap.docs
        .filter(d => wingOf(d.data()) === WING)
        .map(d => {
          const s = d.data();
          // `centerId` may be "" for records whose centre was entered as free
          // text (e.g. "ROLCC"). Show the centre name if we can resolve it,
          // otherwise the raw value exactly as stored.
          const centreRef = String(s.centerId || s.centre || "");
          const inst = s.syllabusInstrument as SyllabusInstrument | undefined;
          const course =
            (typeof s.course === "string" && s.course) ||
            (inst && SYLLABUS_INSTRUMENT_LABELS[inst]) ||
            (Array.isArray(s.instruments) ? s.instruments.map(String).join(", ") : "") ||
            "—";
          // Phone and admission number are separate fields. Guard against
          // legacy/dirty docs where one leaked into the other: never show a
          // value in the Admission-number column that is identical to the phone,
          // and don't fall back to studentID when it's just the phone again.
          const phone = String(s.phone ?? "").trim();
          const admCandidates = [s.admissionNumber, s.admissionNo, s.studentID]
            .map(v => String(v ?? "").trim())
            .filter(v => v && v !== "-" && v !== "—" && v !== phone);
          const admissionNo = admCandidates[0] || "—";
          // Store a spaces-stripped, upper-cased key so the importer can match
          // "ROLCC 20112017101" against "ROLCC20112017101".
          if (admissionNo !== "—") admNos.add(admissionNo.replace(/\s+/g, "").toUpperCase());
          return {
            uid:         d.id,
            name:        (s.displayName ?? s.name ?? "—") as string,
            admittedOn:  toISO(s.dateOfAdmission ?? s.admissionDate ?? s.createdAt),
            centre:      centreName.get(centreRef) || centreRef || "—",
            batch:       String(s.batch ?? "").trim() || "—",
            phone:       phone || "—",
            admissionNo,
            course,
            status:      (s.status ?? s.studentStatus ?? "active") as string,
            screening:   screeningGradeOf(s),
          };
        })
        .sort((a, b) => {
          // Ascending by the last 3 digits of the admission number (…101, …102, …103).
          // Rows with no admission number fall to the bottom, then ordered by date.
          const ka = admTail(a.admissionNo), kb = admTail(b.admissionNo);
          if (ka !== kb) return ka - kb;
          return (a.admittedOn || "9999").localeCompare(b.admittedOn || "9999");
        });

      setExistingAdmNos(admNos);
      setEntries(list);
    } catch (err) {
      console.error("Registry load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const statuses = useMemo(() => {
    const found = new Set(entries.map(e => e.status));
    const others = Array.from(found).filter(s => !STATUS_OPTIONS.includes(s as typeof STATUS_OPTIONS[number])).sort();
    return [...STATUS_OPTIONS, ...others];
  }, [entries]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter(e => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        e.name.toLowerCase().includes(needle) ||
        e.admissionNo.toLowerCase().includes(needle) ||
        e.phone.toLowerCase().includes(needle) ||
        e.centre.toLowerCase().includes(needle) ||
        e.batch.toLowerCase().includes(needle) ||
        e.course.toLowerCase().includes(needle) ||
        e.screening.toLowerCase().includes(needle)
      );
    });
  }, [entries, q, statusFilter]);

  // Keep the selection in sync with what's actually on the register.
  useEffect(() => {
    setSelected(prev => {
      const live = new Set(entries.map(e => e.uid));
      const next = new Set(Array.from(prev).filter(uid => live.has(uid)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const visibleUids  = useMemo(() => rows.map(r => r.uid), [rows]);
  const allVisibleSelected = visibleUids.length > 0 && visibleUids.every(uid => selected.has(uid));

  function toggleRow(uid: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleUids.forEach(uid => next.delete(uid));
      else visibleUids.forEach(uid => next.add(uid));
      return next;
    });
  }

  async function changeStatus(uid: string, status: string) {
    const prev = entries.find(e => e.uid === uid)?.status;
    if (status === prev) return;
    setEntries(cur => cur.map(e => e.uid === uid ? { ...e, status } : e));
    try {
      await updateDoc(doc(db, "users", uid), { status, updatedAt: serverTimestamp() });
      logAction({
        action: "REGISTRY_STATUS_CHANGE",
        initiatorId:   user?.uid ?? "unknown",
        initiatorRole: user?.role ?? ROLES.FOUNDER,
        approverId: null, approverRole: null, reason: null,
        metadata: { uid, from: prev ?? null, to: status },
      });
    } catch (err) {
      console.error("Registry status update failed:", err);
      setEntries(cur => cur.map(e => e.uid === uid ? { ...e, status: prev ?? e.status } : e));
    }
  }

  async function runDelete(uids: string[]) {
    if (uids.length === 0) return;
    setDeleting(true);
    try {
      for (let i = 0; i < uids.length; i += 400) {
        const batch = writeBatch(db);
        for (const uid of uids.slice(i, i + 400)) batch.delete(doc(db, "users", uid));
        await batch.commit();
      }
      logAction({
        action: "REGISTRY_BULK_DELETE",
        initiatorId:   user?.uid ?? "unknown",
        initiatorRole: user?.role ?? ROLES.FOUNDER,
        approverId: null, approverRole: null, reason: null,
        metadata: { count: uids.length, all: uids.length === entries.length },
      });
      setSelected(new Set());
      setConfirmDelete(null);
      setConfirmText("");
      await load();
    } catch (err) {
      console.error("Registry bulk delete failed:", err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>Registry</h1>
          <p style={s.subtitle}>{WING_LABELS[WING]} · master register ({entries.length})</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={s.search}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search name, admission no., phone…"
          />
          {statuses.length > 1 && (
            <select style={s.select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              {statuses.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
          )}
          {canImport && (
            <button style={s.importBtn} onClick={() => setShowImport(true)}>⬆ Import Excel</button>
          )}
          {canImport && entries.length > 0 && (
            <button
              style={{ ...s.printBtn, color: "#b91c1c", borderColor: "#fecaca", background: "#fef2f2" }}
              onClick={() => { setConfirmText(""); setConfirmDelete("all"); }}
            >
              🗑 Delete all
            </button>
          )}
          <button style={s.printBtn} onClick={() => window.print()}>🖨 Print</button>
        </div>
      </div>

      {canImport && selected.size > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12, marginBottom: 12,
          background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px",
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#991b1b" }}>{selected.size} selected</span>
          <button
            onClick={() => setConfirmDelete("selected")}
            style={{ ...s.printBtn, color: "#fff", background: "#dc2626", border: "none" }}
          >
            🗑 Delete {selected.size}
          </button>
          <button onClick={() => setSelected(new Set())} style={{ ...s.printBtn, fontSize: 12 }}>Clear</button>
        </div>
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : (
          <div className="registry-scroll" style={{ overflow: "auto", maxHeight: "calc(100vh - 210px)" }}>
            <style>{`
              .registry-scroll { scrollbar-width: auto; scrollbar-color: #9ca3af var(--color-bg); }
              .registry-scroll::-webkit-scrollbar { width: 18px; height: 18px; }
              .registry-scroll::-webkit-scrollbar-track { background: var(--color-bg); border-radius: 9px; }
              .registry-scroll::-webkit-scrollbar-thumb {
                background: #9ca3af; border-radius: 9px;
                border: 4px solid var(--color-bg);
              }
              .registry-scroll::-webkit-scrollbar-thumb:hover { background: #6b7280; }
              .registry-scroll::-webkit-scrollbar-corner { background: var(--color-bg); }
            `}</style>
            <table style={s.table}>
              <thead>
                <tr>
                  {canImport && (
                    <th style={{ ...s.th, width: 34 }}>
                      <input type="checkbox" checked={allVisibleSelected}
                        onChange={toggleAllVisible} style={{ cursor: "pointer" }} />
                    </th>
                  )}
                  {["SL", "Name", "Date Of Admission", "Centre", "Batch", "Phone number", "Admission number", "Course", "Status", "Screening grade"]
                    .map(h => <th key={h} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={canImport ? 11 : 10} style={{ ...s.td, textAlign: "center", color: "var(--color-text-muted)", padding: "28px 0" }}>
                    {entries.length === 0 ? "No students on the register yet." : "No matches."}
                  </td></tr>
                )}
                {rows.map((e, i) => (
                  <tr key={e.uid} style={{ ...s.tr, ...(selected.has(e.uid) ? { background: "#fef2f2" } : {}) }}>
                    {canImport && (
                      <td style={s.td}>
                        <input type="checkbox" checked={selected.has(e.uid)}
                          onChange={() => toggleRow(e.uid)} style={{ cursor: "pointer" }} />
                      </td>
                    )}
                    <td style={{ ...s.td, color: "var(--color-text-muted)" }}>{i + 1}</td>
                    <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>{e.name}</td>
                    <td style={s.td}>{fmtDate(e.admittedOn)}</td>
                    <td style={s.td}>{e.centre}</td>
                    <td style={s.td}>{e.batch}</td>
                    <td style={s.td}>{e.phone}</td>
                    <td style={{ ...s.td, fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>{e.admissionNo}</td>
                    <td style={s.td}>{e.course}</td>
                    <td style={s.td}>
                      {canImport ? (
                        <select
                          value={STATUS_OPTIONS.includes(e.status as typeof STATUS_OPTIONS[number]) ? e.status : "__current"}
                          onChange={ev => changeStatus(e.uid, ev.target.value)}
                          style={{
                            ...statusStyle(e.status),
                            border: "1px solid var(--color-border)", cursor: "pointer",
                            fontSize: 12, padding: "3px 6px", textTransform: "none",
                          }}
                        >
                          {!STATUS_OPTIONS.includes(e.status as typeof STATUS_OPTIONS[number]) && (
                            <option value="__current" disabled>{e.status}</option>
                          )}
                          {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <span style={statusStyle(e.status)}>{e.status}</span>
                      )}
                    </td>
                    <td style={s.td}>{e.screening}</td>
                  </tr>
                ))}
                {canImport && (
                  <tr style={s.pasteTr}>
                    <td style={s.td} />
                    <td style={{ ...s.td, color: "var(--color-text-muted)" }}>＋</td>
                    <td colSpan={9} style={{ padding: 0 }}>
                      <input
                        style={s.pasteCell}
                        value={pastedText}
                        onChange={ev => setPastedText(ev.target.value)}
                        onPaste={ev => {
                          const text = ev.clipboardData.getData("text");
                          if (text && (text.includes("\n") || text.includes("\t"))) {
                            ev.preventDefault();
                            setPastedText(text);
                            setShowImport(true);
                          }
                        }}
                        onKeyDown={ev => { if (ev.key === "Enter" && pastedText.trim()) setShowImport(true); }}
                        placeholder="Click here and paste rows from Excel / Google Sheets — as many lines as you like"
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showImport && (
        <ImportModal
          centres={centres}
          existingAdmNos={existingAdmNos}
          initiatorId={user?.uid ?? "unknown"}
          initiatorRole={user?.role ?? ROLES.FOUNDER}
          initialPaste={pastedText}
          onClose={() => { setShowImport(false); setPastedText(""); }}
          onDone={() => { setShowImport(false); setPastedText(""); load(); }}
        />
      )}

      {confirmDelete && (() => {
        const isAll  = confirmDelete === "all";
        const target = isAll ? entries.map(e => e.uid) : Array.from(selected);
        const ready  = !isAll || confirmText.trim().toUpperCase() === "DELETE";
        return (
          <div style={dm.overlay} onClick={e => { if (e.target === e.currentTarget && !deleting) { setConfirmDelete(null); setConfirmText(""); } }}>
            <div style={dm.box}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>🗑️</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#111", marginBottom: 6 }}>
                {isAll ? `Delete the entire register?` : `Delete ${target.length} student${target.length !== 1 ? "s" : ""}?`}
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 18, lineHeight: 1.5 }}>
                {isAll
                  ? `This permanently removes all ${target.length} students from the ${WING_LABELS[WING]} register. It cannot be undone.`
                  : `This permanently removes the selected records from the register. It cannot be undone.`}
              </div>
              {isAll && (
                <input
                  autoFocus
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="Type DELETE to confirm"
                  style={{ ...s.search, minWidth: 0, width: "100%", boxSizing: "border-box", marginBottom: 16 }}
                />
              )}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => { setConfirmDelete(null); setConfirmText(""); }} disabled={deleting}
                  style={{ ...s.printBtn }}>Cancel</button>
                <button onClick={() => runDelete(target)} disabled={deleting || !ready || target.length === 0}
                  style={{ ...s.printBtn, background: "#dc2626", border: "none", color: "#fff", opacity: deleting || !ready ? 0.5 : 1 }}>
                  {deleting ? "Deleting…" : isAll ? `Delete all ${target.length}` : `Delete ${target.length}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const dm: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  box: { background: "#fff", borderRadius: 16, padding: "26px 26px", maxWidth: 420, width: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", textAlign: "center" },
};

// ─── Import modal ─────────────────────────────────────────────────────────────

interface PreviewRow {
  sl:          number;
  name:        string;
  admittedOn:  string | null;
  centreRaw:   string;
  centreId:    string | null;
  centreCode:  string;
  centreUnmatched: boolean;
  batch:       string;
  phone:       string;
  admissionNo: string;    // explicit from the sheet; "" → auto-generate on import
  auto:        boolean;
  course:      string;
  status:      string;
  screening:   string;
  error:       string | null;
  duplicate:   boolean;
}

function ImportModal({
  centres, existingAdmNos, initiatorId, initiatorRole, initialPaste, onClose, onDone,
}: {
  centres: { id: string; name: string; code: string }[];
  existingAdmNos: Set<string>;
  initiatorId: string;
  initiatorRole: string;
  initialPaste?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"file" | "paste" | "columns">(initialPaste ? "paste" : "file");
  const [fileName, setFileName] = useState("");
  const [pasteText, setPasteText] = useState(initialPaste ?? "");
  const [cols, setCols] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [parseErr, setParseErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: number; generated: number; centres: string[] } | null>(null);

  const centreByName = useMemo(() => {
    const m = new Map<string, { id: string; code: string }>();
    centres.forEach(c => m.set(c.name.trim().toLowerCase(), { id: c.id, code: c.code }));
    return m;
  }, [centres]);
  const centreById = useMemo(() => {
    const m = new Map<string, { name: string; code: string }>();
    centres.forEach(c => m.set(c.id, { name: c.name, code: c.code }));
    return m;
  }, [centres]);

  function pick(row: Record<string, string>, ...keys: string[]): string {
    for (const k of keys) if (row[k]?.trim()) return row[k].trim();
    return "";
  }

  /** Map parsed rows (keyed by header name) straight to preview rows. Every
   *  value is kept EXACTLY as it appears in the sheet — no column guessing,
   *  no reformatting, no recombining. A row is only skipped when it has no
   *  name, or an admission number that's already on the register. */
  function buildPreview(rows: Record<string, string>[]): PreviewRow[] {
    const seen = new Set<string>();
    return rows.map((r, i) => {
      const name        = pick(r, "name", "studentname", "fullname");
      const admittedOn  = parseSheetDate(pick(r, "dateofadmission", "admissiondate", "doa", "date"));
      const centreRaw   = pick(r, "centre", "center", "centrename", "centername", "branch", "location");
      const batch       = pick(r, "batch", "batchname", "batchno", "batchnumber");
      const phone       = pick(r, "phonenumber", "phoneno", "phone", "mobilenumber", "mobileno", "mobile", "contactnumber", "contactno", "contact");
      const admissionNo = pick(r, "admissionno", "admissionnumber", "admissionnumberno", "admno", "admissionid");
      const course      = pick(r, "course", "instrument");
      const status      = pick(r, "status");
      const screening   = pick(r, "screeninggrade", "screeningscore", "grade", "screening");

      // Match a centre name to a centre doc for display only — an unmatched
      // centre is kept as free text, never rejected.
      const nameMatch = centreRaw ? centreByName.get(centreRaw.trim().toLowerCase()) : undefined;
      const centreId  = nameMatch?.id ?? null;

      const auto = !admissionNo;
      const key  = admissionNo.replace(/\s+/g, "").toUpperCase();
      const dupInFile = key && seen.has(key);
      if (key) seen.add(key);
      const duplicate = !!key && (existingAdmNos.has(key) || !!dupInFile);

      return {
        sl: i + 1,
        name,
        admittedOn,
        centreRaw,
        centreId,
        centreCode: nameMatch?.code ?? "",
        centreUnmatched: !!centreRaw && !centreId,
        batch,
        phone,
        admissionNo,
        auto,
        course,
        status: status || "active",
        screening,
        error: name ? null : "Name is required",
        duplicate,
      };
    });
  }

  function ingest(rows: Record<string, string>[]) {
    setResult(null);
    setPreview(buildPreview(rows));
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setFileName(f.name);
    setParseErr(""); setResult(null); setPreview([]);

    const res = await parseFile(f);
    if (res.error) { setParseErr(res.error); return; }
    if (res.rows.length === 0) { setParseErr("The file has no data rows."); return; }
    ingest(res.rows);
  }

  function parsePaste(text: string) {
    setParseErr(""); setResult(null); setPreview([]);
    const rows = parsePastedTable(text);
    if (rows.length === 0) {
      setParseErr("Paste rows copied straight from Excel or Google Sheets — one student per line.");
      return;
    }
    ingest(rows);
  }
  const handlePasteParse = () => parsePaste(pasteText);

  // Distinct centre names in the current preview, split into known / new.
  const centreSummary = useMemo(() => {
    const known = new Set<string>();
    const fresh = new Set<string>();
    for (const r of preview) {
      if (!r.centreRaw) continue;
      (r.centreId || centreByName.has(r.centreRaw.toLowerCase()) ? known : fresh)
        .add(r.centreId ? (centreById.get(r.centreId)?.name ?? r.centreRaw) : r.centreRaw);
    }
    return { known: [...known], fresh: [...fresh] };
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  /** "Paste by column" mode: zip the per-column lists together by row. A column
   *  with a single value is broadcast to every row (same centre / date). */
  function parseColumns() {
    setParseErr(""); setResult(null); setPreview([]);
    const lists: Record<string, string[]> = {};
    let maxLen = 0;
    for (const f of COL_FIELDS) {
      const arr = (cols[f.key] ?? "").replace(/\r\n?/g, "\n").split("\n").map(v => v.trim());
      while (arr.length && !arr[arr.length - 1]) arr.pop();
      lists[f.key] = arr;
      if (arr.length > 1) maxLen = Math.max(maxLen, arr.length);
    }
    if (maxLen === 0) { setParseErr("Paste at least one multi-line column (e.g. the Name list)."); return; }
    const rows: Record<string, string>[] = [];
    for (let i = 0; i < maxLen; i++) {
      const row: Record<string, string> = {};
      for (const f of COL_FIELDS) {
        const arr = lists[f.key];
        row[f.key] = arr.length === 1 ? arr[0] : (arr[i] ?? "");
      }
      if (Object.values(row).some(v => v)) rows.push(row);
    }
    ingest(rows);
  }

  // If the modal was opened by pasting into the on-page row, parse immediately.
  useEffect(() => {
    if (initialPaste) parsePaste(initialPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const importable = preview.filter(r => !r.error && !r.duplicate);
  const skipCount = preview.filter(r => r.duplicate && !r.error).length;
  const errorCount = preview.filter(r => r.error).length;

  async function runImport() {
    if (importable.length === 0 || busy) return;
    setBusy(true);
    let imported = 0, failed = 0;
    try {
      // Reserve one sequence per row that needs an auto-generated number.
      const autoRows = importable.filter(r => r.auto);
      let seq = autoRows.length ? await reserveAdmissionSeq(autoRows.length) : 0;
      const generated = new Map<number, string>(); // preview row sl → generated number
      for (const r of autoRows) {
        generated.set(r.sl, formatAdmissionNo({ prefix: r.centreCode, dateISO: r.admittedOn, seq: seq++ }));
      }

      for (let i = 0; i < importable.length; i += 400) {
        const chunk = importable.slice(i, i + 400);
        const batch = writeBatch(db);
        for (const r of chunk) {
          const admNo = r.admissionNo || generated.get(r.sl) || "";
          const [first, ...rest] = r.name.trim().split(/\s+/);
          const ref = doc(collection(db, "users"));
          batch.set(ref, {
            uid:            ref.id,
            role:           "student",
            wing:           WING,
            name:           r.name.trim(),
            displayName:    r.name.trim(),
            firstName:      first ?? "",
            lastName:       rest.join(" "),
            phone:          r.phone,
            admissionNumber: admNo,
            admissionNoAutoGenerated: r.auto,
            studentID:      admNo,
            centre:         r.centreId ?? r.centreRaw,
            centerId:       r.centreId ?? "",
            batch:          r.batch || null,
            course:         r.course,
            classType:      "group",
            billingMode:    "prepay",
            feeCycle:       "monthly",
            status:         r.status || "active",
            studentStatus:  r.status || "active",
            screeningGrade: r.screening || null,
            currentBalance: 0,
            dateOfAdmission: r.admittedOn ?? null,
            createdAt:      r.admittedOn ? Timestamp.fromDate(new Date(r.admittedOn)) : serverTimestamp(),
            importedAt:     serverTimestamp(),
            source:         "registry-import",
          });
        }
        try {
          await batch.commit();
          imported += chunk.length;
        } catch (err) {
          console.error("Registry import batch failed:", err);
          failed += chunk.length;
        }
      }
      logAction({
        action: "REGISTRY_IMPORT",
        initiatorId,
        initiatorRole: initiatorRole as never,
        approverId: null,
        approverRole: null,
        reason: null,
        metadata: { imported, skipped: skipCount, failed, generated: autoRows.length, source: mode === "file" ? (fileName || "file") : mode },
      }).catch(() => {});
      setResult({
        imported, skipped: skipCount, failed, generated: autoRows.length,
        centres: [...centreSummary.known, ...centreSummary.fresh],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div style={s.modal}>
        <div style={s.modalHead}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text-primary)" }}>Import students</div>
          <button onClick={onClose} disabled={busy} style={s.closeBtn}>✕</button>
        </div>

        <div style={s.modalBody}>
          {result ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#15803d", marginBottom: 8 }}>Import complete</div>
              <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                {result.imported} added · {result.generated} auto-numbered · {result.skipped} skipped (duplicates) · {result.failed} failed
              </div>
              {result.centres.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 8 }}>
                  Centres uploaded: {result.centres.join(" · ")}
                </div>
              )}
              <button style={{ ...s.primaryBtn, marginTop: 20 }} onClick={onDone}>Done</button>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 0, lineHeight: 1.6 }}>
                <strong>Keep the header row</strong> in your file or paste. Columns are matched by
                their header name — <code style={s.cols}>Name · Date Of Admission · Centre · Batch · Phone number · Admission number · Course · Status · Screening grade</code> — in any order; unknown columns are ignored.
                <br />
                Every cell is stored exactly as written — nothing is reformatted, merged, or moved
                between columns. Each field comes only from its own column: <code style={{ fontSize: 11 }}>Centre</code> from the Centre column,
                <code style={{ fontSize: 11 }}>Batch</code> from the Batch column, and so on. A centre that isn&apos;t in the system is kept
                as plain text.
                If a row has no admission number, one is generated as <code style={{ fontSize: 11 }}>ROLCC + DDMMYYYY + sequence</code>.
                Only rows with no name, or an admission number already on the register, are skipped.
              </p>

              {preview.length === 0 && (<>
              <div style={s.modeTabs}>
                {([
                  ["file", "📄 Upload file"],
                  ["paste", "📋 Paste table"],
                  ["columns", "🧬 Paste by column"],
                ] as const).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setParseErr(""); setPreview([]); }}
                    style={{ ...s.modeTab, ...(mode === m ? s.modeTabActive : {}) }}
                  >{label}</button>
                ))}
              </div>

              {mode === "file" && (
                <>
                  <input ref={fileRef} type="file" accept=".xlsx,.csv" onChange={handleFile} style={s.fileInput} />
                  {fileName && <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 6 }}>📄 {fileName}</div>}
                </>
              )}

              {mode === "paste" && (
                <>
                  <textarea
                    value={pasteText}
                    onChange={e => setPasteText(e.target.value)}
                    placeholder={"Paste rows copied from Excel / Google Sheets (header row optional):\n\nAdithya M\t20 November 2017\tROLCC\t\t20112017101\tDrums\tConfirm"}
                    rows={7}
                    style={s.textarea}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    <button style={s.primaryBtn} onClick={handlePasteParse} disabled={!pasteText.trim()}>
                      Preview rows
                    </button>
                  </div>
                </>
              )}

              {mode === "columns" && (
                <>
                  <p style={{ fontSize: 11.5, color: "var(--color-text-muted)", margin: "0 0 8px" }}>
                    Paste each column separately — one value per line. A column with a single value
                    (e.g. Centre or Date) is applied to every row.
                  </p>
                  <div style={s.colGrid}>
                    {COL_FIELDS.map(f => (
                      <div key={f.key}>
                        <label style={s.colLabel}>{f.label}</label>
                        <textarea
                          value={cols[f.key] ?? ""}
                          onChange={e => setCols(c => ({ ...c, [f.key]: e.target.value }))}
                          rows={4}
                          style={s.colBox}
                        />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    <button
                      style={s.primaryBtn}
                      onClick={parseColumns}
                      disabled={!Object.values(cols).some(v => (v ?? "").includes("\n"))}
                    >
                      Preview rows
                    </button>
                  </div>
                </>
              )}
              </>
              )}

              {parseErr && <div style={s.err}>{parseErr}</div>}

              {preview.length > 0 && (centreSummary.known.length > 0 || centreSummary.fresh.length > 0) && (
                <div style={s.confirmBox}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 6 }}>
                    Centres in this file
                  </div>
                  {centreSummary.known.length > 0 && (
                    <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
                      Matched: {centreSummary.known.join(" · ")}
                    </div>
                  )}
                  {centreSummary.fresh.length > 0 && (
                    <div style={{ fontSize: 12, color: "#1d4ed8" }}>
                      New (kept as typed): {centreSummary.fresh.join(" · ")}
                    </div>
                  )}
                </div>
              )}

              {preview.length > 0 && (
                <>
                  <div style={{ display: "flex", gap: 14, margin: "14px 0 8px", fontSize: 12, fontWeight: 700, flexWrap: "wrap" as const }}>
                    <span style={{ color: "#16a34a" }}>{importable.length} to import</span>
                    <span style={{ color: "#4f46e5" }}>{importable.filter(r => r.auto).length} auto-numbered</span>
                    <span style={{ color: "#d97706" }}>{skipCount} duplicate</span>
                    <span style={{ color: "#dc2626" }}>{errorCount} error</span>
                  </div>
                  <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--color-border)", borderRadius: 8 }}>
                    <table style={s.table}>
                      <thead>
                        <tr>{["#", "Name", "Adm no.", "Centre", "Batch", "Phone", "Course", "Date", "Screening", ""].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {preview.map(r => (
                          <tr key={r.sl} style={s.tr}>
                            <td style={{ ...s.td, color: "var(--color-text-muted)" }}>{r.sl}</td>
                            <td style={s.td}>{r.name || <em style={{ color: "#dc2626" }}>missing</em>}</td>
                            <td style={s.td}>{r.admissionNo || <em style={{ color: "#4f46e5" }}>auto</em>}</td>
                            <td style={s.td}>{r.centreRaw || "—"}</td>
                            <td style={s.td}>{r.batch || "—"}</td>
                            <td style={s.td}>{r.phone || "—"}</td>
                            <td style={s.td}>{r.course || "—"}</td>
                            <td style={s.td}>{r.admittedOn ? fmtDate(r.admittedOn) : "—"}</td>
                            <td style={s.td}>{r.screening || "—"}</td>
                            <td style={s.td}>
                              {r.error
                                ? <span style={{ ...s.pill, background: "#fef2f2", color: "#991b1b" }}>{r.error}</span>
                                : r.duplicate
                                  ? <span style={{ ...s.pill, background: "#fffbeb", color: "#92400e" }}>duplicate</span>
                                  : r.centreUnmatched
                                    ? <span style={{ ...s.pill, background: "#eff6ff", color: "#1d4ed8" }} title="Centre kept as free text">ok · new centre</span>
                                  : <span style={{ ...s.pill, background: "#f0fdf4", color: "#166534" }}>ok</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {!result && (
          <div style={s.modalFoot}>
            <button style={s.ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
            <button
              style={{ ...s.primaryBtn, opacity: importable.length === 0 || busy ? 0.5 : 1 }}
              onClick={runImport}
              disabled={importable.length === 0 || busy}
            >
              {busy ? "Importing…" : `Import ${importable.length} student${importable.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  headerRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 12, flexWrap: "wrap" },
  title: { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle: { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },
  search: { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "var(--color-text-primary)", outline: "none", minWidth: 240 },
  select: { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "var(--color-text-primary)", cursor: "pointer" },
  importBtn: { background: "var(--color-accent)", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer" },
  printBtn: { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)", cursor: "pointer" },
  card: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 20 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "10px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "2px solid var(--color-border)", background: "var(--color-bg)", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 2 },
  tr: { borderBottom: "1px solid var(--color-border)" },
  td: { padding: "11px 12px", color: "var(--color-text-secondary)", verticalAlign: "middle", whiteSpace: "nowrap" },
  code: { fontFamily: "monospace", fontSize: 12, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4 },
  badgeOk: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f0fdf4", color: "#166534" },
  badgeOff: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f3f4f6", color: "#6b7280", textTransform: "capitalize" },
  empty: { textAlign: "center", padding: "48px 0", color: "var(--color-text-secondary)", fontSize: 14 },

  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" },
  modal: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, width: "100%", maxWidth: 720, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)" },
  modalBody: { padding: "18px 20px" },
  modalFoot: { display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 20px", borderTop: "1px solid var(--color-border)" },
  closeBtn: { background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "var(--color-text-muted)", padding: 4 },
  fileInput: { display: "block", fontSize: 13, marginTop: 6 },
  pasteTr: { borderTop: "2px dashed var(--color-border)", background: "var(--color-surface-2)" },
  pasteCell: { width: "100%", boxSizing: "border-box", border: "none", background: "transparent", padding: "12px", fontSize: 13, color: "var(--color-text-primary)", outline: "none" },
  modeTabs: { display: "flex", gap: 6, margin: "12px 0" },
  modeTab: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  modeTabActive: { background: "#ede9fe", borderColor: "#4f46e5", color: "#4338ca" },
  textarea: { width: "100%", boxSizing: "border-box", minHeight: 140, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 12.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", outline: "none", resize: "vertical" as const, whiteSpace: "pre" as const },
  colGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 },
  colLabel: { display: "block", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: 3 },
  colBox: { width: "100%", boxSizing: "border-box", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", outline: "none", resize: "vertical" as const },
  confirmBox: { marginTop: 12, border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 10, padding: "12px 14px" },
  cols: { display: "inline-block", marginTop: 6, fontSize: 11.5, background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "4px 8px" },
  err: { background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, color: "#991b1b", marginTop: 10 },
  pill: { display: "inline-block", padding: "2px 8px", borderRadius: 99, fontSize: 10.5, fontWeight: 700 },
  primaryBtn: { padding: "9px 18px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  ghostBtn: { padding: "9px 18px", background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },
};
