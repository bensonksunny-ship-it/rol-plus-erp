"use client";

// Registry — the master register of Rol's School of Music. A single flat table
// of every School-of-Music student, newest uploads first. Per-student Edit
// Details modal, inline status changes, and an Excel/CSV bulk import.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  collection, getDocs, onSnapshot, query, where, writeBatch, doc, updateDoc, serverTimestamp, Timestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { useWing } from "@/hooks/useWing";
import { wingOf } from "@/lib/wing";
import type { Wing } from "@/types";
import { DEFAULT_BATCH_NAME, explicitBatches } from "@/lib/batches";
import { parseFile, normalizeHeader } from "@/lib/xlsx-parser";
import { logAction } from "@/services/audit/audit.service";
import { getCached, setCached } from "@/lib/dataCache";
import { normName, normPhone } from "@/lib/dedup";
import MergeDuplicatesModal from "@/components/dedup/MergeDuplicatesModal";
import { SYLLABUS_INSTRUMENT_LABELS, type SyllabusInstrument } from "@/types/lesson";

// The register shows the wing currently selected (ROL+ or School of Music) —
// same system for both, each wing's students kept separate.

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
  // Raw values backing the Edit Details modal.
  centerId:    string;   // centre doc id (either wing), or "" when the centre is free text
  batchId:     string;
  email:       string;
  courseRaw:   string;   // stored `course` only — no instrument fallback
  addedAt:     number;   // ms when the record was imported/created — newest sorts first
}

type RegistryCentre = { id: string; name: string; code: string; wing?: Wing; batches?: { id: string; name: string }[] };

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

// The `status` field on a student doc is shared verbatim with the Students
// page (values: active / inactive / deactivation_requested / break_requested /
// on_break). These two translate between that vocabulary and the Registry's
// own Confirm / Cancelled / Hold labels, so a status change on either page
// shows up correctly on the other without stranding the student in a status
// the other page doesn't recognise.
function toRegistryStatus(status: string): string {
  const v = status.trim().toLowerCase();
  if (v === "active") return "Confirm";
  if (v === "inactive") return "Cancelled";
  return status; // Hold, and any other free-text status, pass through as-is
}
/**
 * An admission number is the prerequisite for being an active student: a
 * "Confirm" (active) row without one is held under this label instead — it
 * isn't counted in the Confirm filter until the number is entered.
 */
const NEEDS_ADM_NO = "Needs Adm. No.";
function filterStatus(e: { status: string; admissionNo: string }): string {
  const st = toRegistryStatus(e.status);
  return st === "Confirm" && (!e.admissionNo || e.admissionNo === "—") ? NEEDS_ADM_NO : st;
}
function fromRegistryStatus(label: string): string {
  if (label === "Confirm") return "active";
  if (label === "Cancelled") return "inactive";
  return label; // "Hold" and anything else pass through unchanged
}

/** Firestore auto-IDs are long base62 strings ("0vaLT30ROyvq…") — never a
 *  human centre name. Used so a failed name lookup never leaks a raw ID into
 *  the CENTRE column; it falls back to a plain placeholder instead. */
function looksLikeDocId(v: string): boolean {
  return /^[A-Za-z0-9]{15,}$/.test(v.trim());
}

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

/** Firestore Timestamp / ISO string → epoch ms; 0 when missing or unparseable. */
function toMillis(v: unknown): number {
  const iso = toISO(v);
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
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
// Wing and Batch are deliberately not paste columns: the wing follows the
// centre, and batches are picked per row after parsing (see ImportModal).
const REGISTRY_COLUMNS = [
  "name", "dateofadmission", "centre",
  "phonenumber", "admissionno", "course", "status", "screeninggrade",
];
const HEADER_WORDS = /name|centre|center|admission|phone|mobile|course|instrument|status|date|screening|grade/i;

// Fields for the "paste by column" mode.
const COL_FIELDS: { key: string; label: string }[] = [
  { key: "name",            label: "Name" },
  { key: "dateofadmission", label: "Date Of Admission" },
  { key: "centre",          label: "Centre" },
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
 * Admission no. · Course · Status · Screening) is assumed. Header-matched
 * Wing / Batch columns are ignored.
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

// ─── Paste format guide ───────────────────────────────────────────────────────

// Same column order as REGISTRY_COLUMNS; `keys` mirror buildPreview()'s header aliases.
const GUIDE_COLUMNS: { label: string; keys: string[]; example: string; note?: string; required?: boolean }[] = [
  { label: "Name",              keys: ["name", "studentname", "fullname"], example: "Priya Nair", required: true },
  { label: "Date Of Admission", keys: ["dateofadmission", "admissiondate", "doa", "date"], example: "24/09/2026", note: "DD/MM/YYYY" },
  { label: "Centre",            keys: ["centre", "center", "centrename", "centername", "branch", "location"], example: "Cinnamon", note: "exact name" },
  { label: "Phone number",      keys: ["phonenumber", "phoneno", "phone", "mobilenumber", "mobileno", "mobile", "contactnumber", "contactno", "contact"], example: "9876543210" },
  { label: "Admission no.",     keys: ["admissionno", "admissionnumber", "admissionnumberno", "admno", "admissionid"], example: "", note: "required" },
  { label: "Course",            keys: ["course", "instrument"], example: "Keyboard" },
  { label: "Status",            keys: ["status"], example: "", note: "leave blank" },
  { label: "Screening Grade",   keys: ["screeninggrade", "screeningscore", "grade", "screening"], example: "" },
];

/** Column-order reference for pasting. Given pasted text, shows its first rows
 *  under the columns they'll land in, so a shifted column is obvious. */
function PasteFormatGuide({ pasted }: { pasted?: string }) {
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => (pasted?.trim() ? parsePastedTable(pasted).slice(0, 3) : []), [pasted]);
  const live = rows.length > 0;

  async function copyHeader() {
    try {
      await navigator.clipboard.writeText(GUIDE_COLUMNS.map(c => c.label).join("\t"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the header is visible to copy by hand */ }
  }

  const cell: React.CSSProperties = { padding: "5px 8px", borderRight: "1px solid var(--color-border)", whiteSpace: "nowrap", fontSize: 11.5 };
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg)", marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 10px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-primary)" }}>
          {live ? "Check your columns — each value should sit under the right heading" : "Paste format — columns in this order (copy from Excel / Google Sheets)"}
        </span>
        <button type="button" onClick={copyHeader} style={{ ...s.printBtn, fontSize: 11.5, padding: "4px 10px" }}
          title="Copies the headers tab-separated — paste into row 1 of your spreadsheet">
          {copied ? "✓ Copied" : "📋 Copy Template Headers"}
        </button>
      </div>
      {/* Expected header row as pill tags, in paste order A → H. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "0 10px 8px" }}>
        {GUIDE_COLUMNS.map((c, i) => (
          <Fragment key={c.label}>
            {i > 0 && <span className="text-slate-300 text-xs">|</span>}
            <span
              className="bg-slate-100 text-slate-700 font-mono text-xs px-2 py-1 rounded border border-slate-200"
              title={c.note ? `${c.label} — ${c.note}` : c.label}
            >
              {c.label}{c.required && <span className="text-red-600">*</span>}
            </span>
          </Fragment>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ background: "var(--color-surface-2)" }}>
              <td style={{ ...cell, color: "var(--color-text-muted)", fontWeight: 600 }}>#</td>
              {GUIDE_COLUMNS.map((c, i) => (
                <td key={c.label} style={{ ...cell, fontWeight: 700, color: "var(--color-text-primary)" }}>
                  <span style={{ color: "var(--color-text-muted)", fontWeight: 500 }}>{String.fromCharCode(65 + i)} · </span>
                  {c.label}{c.required && <span style={{ color: "#dc2626" }}> *</span>}
                  {c.note && <div style={{ fontSize: 10, fontWeight: 500, color: "var(--color-text-muted)" }}>{c.note}</div>}
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {(live ? rows : [null]).map((r, ri) => (
              <tr key={ri} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ ...cell, color: "var(--color-text-muted)" }}>{live ? ri + 1 : "e.g."}</td>
                {GUIDE_COLUMNS.map(c => {
                  const v = r ? (c.keys.map(k => r[k]?.trim()).find(Boolean) ?? "") : c.example;
                  const missing = live && c.required && !v;
                  return (
                    <td key={c.label} style={{
                      ...cell,
                      color: missing ? "#dc2626" : live ? "var(--color-text-primary)" : "var(--color-text-muted)",
                      fontStyle: live ? "normal" : "italic",
                      maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {v || (missing ? "missing!" : "—")}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-muted)", padding: "6px 10px" }}>
        {live
          ? "Showing your first rows. If values look shifted, add the header row to your paste (📋 Copy header row) so columns are matched by name."
          : "With a header row, columns can be in any order and extra/missing ones are fine. Without one, use exactly this order A → H (blank cells are OK, but keep the column)."}
      </div>
    </div>
  );
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
  const { user, role, can, isChiefTeacher, isDirector, isFounder } = useAuth();
  const { wing: WING } = useWing();
  const canImport = can(CAPABILITIES.STUDENTS_MANAGE);
  // Reactivating a student (Cancelled/Inactive/Hold → Confirm) is restricted
  // to Chief Teacher / Director — Founder included as the super-admin role
  // that already has every other capability in this app. Other status moves
  // (e.g. Confirm → Hold) stay open to anyone with canImport, as before.
  // ROL+ is run by its Admin (no Chief Teacher / Director there).
  // Merging records rewrites fee / attendance history — leadership only.
  const canMergeDuplicates = isFounder || role === ROLES.ADMIN || isDirector;
  const canReactivate = WING === WINGS.ROL_PLUS
    ? role === ROLES.ADMIN || isFounder
    : isChiefTeacher || isDirector || isFounder;

  // Seed from the last visit's cache so revisiting this page via the sidebar
  // renders instantly instead of a blank loading state — the effect below
  // still always re-fetches/re-subscribes to stay fresh.
  // Cache keys are per wing so switching wings never flashes the other wing's register.
  const [entries, setEntries] = useState<Entry[]>(() => getCached<Entry[]>(`registry:${WING}:entries`) ?? []);
  const [centres, setCentres] = useState<RegistryCentre[]>(
    () => getCached(`registry:${WING}:centres`) ?? [],
  );
  const [existingAdmNos, setExistingAdmNos] = useState<Set<string>>(
    () => getCached<Set<string>>(`registry:${WING}:admNos`) ?? new Set(),
  );
  const [loading, setLoading] = useState(() => !getCached<Entry[]>(`registry:${WING}:entries`));
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showImport, setShowImport] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [pastedText, setPastedText] = useState("");

  // ── Row expansion (accordion detail drawer) ─────────────────────────────
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  function toggleExpanded(uid: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  // Paste row shows the column-format guide while focused.
  const [pasteFocused, setPasteFocused] = useState(false);

  // ── Edit Details modal ──────────────────────────────────────────────────
  const [editing, setEditing] = useState<Entry | null>(null);

  // ── Bulk delete ──────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<null | "selected" | "all">(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Post-import feedback: once the import modal closes, jump to the top of the
  // table (newest rows sort first) and tint the just-imported rows for 5 s.
  const scrollRef = useRef<HTMLDivElement>(null);
  const justImported = useRef<string[]>([]);
  const [newUids, setNewUids] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (newUids.size === 0) return;
    const t = setTimeout(() => setNewUids(new Set()), 5000);
    return () => clearTimeout(t);
  }, [newUids]);

  function closeImport() {
    setShowImport(false);
    setPastedText("");
    if (justImported.current.length === 0) return;
    setNewUids(new Set(justImported.current));
    justImported.current = [];
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Centres change rarely — fetch once. Students, and in particular their
  // `status` field (written from this page, the Students page, and the
  // Centers "Add Active Students" picker alike) are watched live so a status
  // change anywhere shows up here immediately, without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const centreSnap = await getDocs(collection(db, "centers"));
        if (cancelled) return;

        // The registry is shared by both wings, so `centreList`/`centreName`
        // (the centre picker, import matching and name resolution) cover every
        // centre regardless of wing. School-of-Music centres are listed first
        // so a name that exists in both wings matches the SoM one on import.
        const centreName = new Map<string, string>();
        const centreNameAll = new Map<string, string>();
        const centreList: RegistryCentre[] = [];
        // Batch ids are client-generated and unique across every centre, so a
        // flat id → name map (no centreId needed to disambiguate) is enough to
        // resolve a student's assigned batch regardless of wing.
        const batchName = new Map<string, string>();
        // Centres with no explicit batches run on their main schedule as a
        // single implicit "General Batch" — their students fall back to it.
        const defaultBatchCentres = new Set<string>();
        centreSnap.docs.forEach(d => {
          const nm = (d.data().name as string) ?? d.id;
          centreNameAll.set(d.id, nm);
          const batches = explicitBatches(d.data());
          batches.forEach(b => batchName.set(String(b.id), String(b.name ?? "") || "Unnamed batch"));
          if (batches.length === 0) defaultBatchCentres.add(d.id);
          centreName.set(d.id, nm);
          centreList.push({
            id: d.id, name: nm, code: (d.data().centerCode as string) ?? "",
            wing: wingOf(d.data()),
            batches: batches.map(b => ({ id: String(b.id), name: String(b.name ?? "") || "Unnamed batch" })),
          });
        });
        centreList.sort((a, b) =>
          Number(b.wing === WING) - Number(a.wing === WING) || a.name.localeCompare(b.name));
        setCentres(centreList);
        setCached(`registry:${WING}:centres`, centreList);

        unsubscribe = onSnapshot(
          query(collection(db, "users"), where("role", "==", "student")),
          studSnap => {
            const admNos = new Set<string>();
            const list: Entry[] = studSnap.docs
              .filter(d => wingOf(d.data()) === WING && d.data().status !== "merged")
              .map(d => {
                // "estimate" so a just-written serverTimestamp() reads as ~now
                // instead of null while the write is still pending.
                const s = d.data({ serverTimestamps: "estimate" });
                // `centerId` may be "" for records whose centre was entered as free
                // text (e.g. "ROLCC"). Resolve the name against every centre in
                // either wing. If it doesn't
                // resolve and the stored value is a raw Firestore doc ID, show a
                // plain placeholder instead of leaking the hash into the table.
                const centreRef = String(s.centerId || s.centre || "");
                const resolvedCentreName = centreName.get(centreRef) || centreNameAll.get(centreRef);
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
                  centre:      resolvedCentreName || (centreRef && !looksLikeDocId(centreRef) ? centreRef : "—"),
                  // Synced batch (from a centre's Batches list) wins when set;
                  // otherwise the free-text value captured at import, then the
                  // centre's default batch if it has no batches of its own.
                  batch:       batchName.get(String(s.batchId ?? "")) || String(s.batch ?? "").trim()
                    || (defaultBatchCentres.has(centreRef) ? DEFAULT_BATCH_NAME : "—"),
                  phone:       phone || "—",
                  admissionNo,
                  course,
                  status:      (s.status ?? s.studentStatus ?? "active") as string,
                  screening:   screeningGradeOf(s),
                  centerId:    centreName.has(centreRef) ? centreRef : "",
                  batchId:     String(s.batchId ?? ""),
                  email:       String(s.email ?? "").trim(),
                  courseRaw:   typeof s.course === "string" ? s.course : "",
                  // Imports back-date `createdAt` to the admission date, so the
                  // upload time lives in `importedAt`; other records use createdAt.
                  addedAt:     toMillis(s.importedAt) || toMillis(s.createdAt),
                };
              })
              .sort((a, b) => {
                // Ascending by the last 3 digits of the admission number
                // (…005, …210, …346, …347, …348); rows with no admission number
                // fall to the bottom. Ties: newest upload first, then by date.
                const ka = admTail(a.admissionNo), kb = admTail(b.admissionNo);
                if (ka !== kb) return ka - kb;
                if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt;
                return (a.admittedOn || "9999").localeCompare(b.admittedOn || "9999");
              });

            setExistingAdmNos(admNos);
            setEntries(list);
            setLoading(false);
            setCached(`registry:${WING}:admNos`, admNos);
            setCached(`registry:${WING}:entries`, list);
          },
          err => {
            console.error("Registry live update failed:", err);
            setLoading(false);
          },
        );
      } catch (err) {
        console.error("Registry load failed:", err);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; if (unsubscribe) unsubscribe(); };
  }, [WING]);

  // Wing switched → show that wing's cached register (or a loading state) at once.
  const shownWing = useRef(WING);
  useEffect(() => {
    if (shownWing.current === WING) return;
    shownWing.current = WING;
    const cached = getCached<Entry[]>(`registry:${WING}:entries`);
    setEntries(cached ?? []);
    setCentres(getCached(`registry:${WING}:centres`) ?? []);
    setExistingAdmNos(getCached<Set<string>>(`registry:${WING}:admNos`) ?? new Set());
    setLoading(!cached);
  }, [WING]);

  // Centres that run more than one batch — their rows show which batch.
  const multiBatchCentres = useMemo(
    () => new Set(centres.filter(c => (c.batches?.length ?? 0) >= 2).map(c => c.id)),
    [centres],
  );

  const statuses = useMemo(() => {
    const found = new Set(entries.map(filterStatus));
    const others = Array.from(found).filter(s => !STATUS_OPTIONS.includes(s as typeof STATUS_OPTIONS[number])).sort();
    return [...STATUS_OPTIONS, ...others];
  }, [entries]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter(e => {
      if (statusFilter !== "all" && filterStatus(e) !== statusFilter) return false;
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

  async function changeStatus(uid: string, label: string) {
    // `label` is a Registry-vocabulary choice (Confirm / Cancelled / Hold).
    // Write back the canonical Students-page status so the Students page
    // keeps recognising this student in its own status filters.
    const prev = entries.find(e => e.uid === uid)?.status;
    const next = fromRegistryStatus(label);
    if (next === prev) return;
    // Reactivation (anything → active) is gated to Chief Teacher / Director /
    // Founder — enforced primarily by hiding "Confirm" from the dropdown for
    // everyone else; this is the same check as a safety net against any other
    // call path reaching here.
    if (next === "active" && prev !== "active" && !canReactivate) {
      console.warn("[Registry] reactivation blocked — requires Chief Teacher, Director, or Founder.");
      return;
    }
    setEntries(cur => cur.map(e => e.uid === uid ? { ...e, status: next } : e));
    try {
      await updateDoc(doc(db, "users", uid), { status: next, studentStatus: next, updatedAt: serverTimestamp() });
      logAction({
        action: "REGISTRY_STATUS_CHANGE",
        initiatorId:   user?.uid ?? "unknown",
        initiatorRole: user?.role ?? ROLES.FOUNDER,
        approverId: null, approverRole: null, reason: null,
        metadata: { uid, from: prev ?? null, to: next },
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
      // The live student subscription picks up the deletions automatically.
    } catch (err) {
      console.error("Registry bulk delete failed:", err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[794px]">
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
          {canMergeDuplicates && (
            <button style={{ ...s.printBtn, color: "#3730a3", borderColor: "#c7d2fe", background: "#eef2ff" }} onClick={() => setShowMerge(true)}>
              🔍 Scan &amp; Merge Duplicates
            </button>
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
          <div ref={scrollRef} className="registry-scroll" style={{ overflow: "auto", maxHeight: "calc(100vh - 210px)" }}>
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
                  {["SL", "Name", "Status"].map(h => <th key={h} style={s.th}>{h}</th>)}
                  <th style={{ ...s.th, width: canImport ? 72 : 34 }} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={canImport ? 5 : 4} style={{ ...s.td, textAlign: "center", color: "var(--color-text-muted)", padding: "28px 0" }}>
                    {entries.length === 0 ? "No students on the register yet." : "No matches."}
                  </td></tr>
                )}
                {rows.map((e, i) => {
                  const open = expandedRows.has(e.uid);
                  return (
                  <Fragment key={e.uid}>
                  <tr onClick={() => toggleExpanded(e.uid)}
                    style={{
                      ...s.tr, cursor: "pointer", transition: "background 0.6s",
                      ...(newUids.has(e.uid) ? { background: "rgba(238,242,255,0.8)" } : {}),
                      ...(selected.has(e.uid) ? { background: "#fef2f2" } : {}),
                    }}>
                    {canImport && (
                      <td style={s.td} onClick={ev => ev.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(e.uid)}
                          onChange={() => toggleRow(e.uid)} style={{ cursor: "pointer" }} />
                      </td>
                    )}
                    <td style={{ ...s.td, color: "var(--color-text-muted)" }}>{i + 1}</td>
                    <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>
                      {e.name}
                      {multiBatchCentres.has(e.centerId) && e.batch && e.batch !== "—" && (
                        <span title="Batch" style={{ marginLeft: 8, padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 600, background: "#eef2ff", color: "#4338ca" }}>
                          🗂 {e.batch}
                        </span>
                      )}
                      {e.admissionNo !== "—" ? (
                        <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 400, color: "var(--color-text-muted)", fontFamily: "ui-monospace, monospace" }}>
                          {e.admissionNo}
                        </span>
                      ) : filterStatus(e) === NEEDS_ADM_NO && (
                        <span title="Missing Admission Number — not counted as active until one is entered (Edit this row)"
                          style={{ marginLeft: 8, padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, background: "#fee2e2", color: "#b91c1c" }}>
                          ⚠ No adm. no.
                        </span>
                      )}
                      {newUids.has(e.uid) && (
                        <span style={{ marginLeft: 8, padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, background: "#e0e7ff", color: "#4338ca" }}>
                          New
                        </span>
                      )}
                    </td>
                    <td style={s.td} onClick={ev => ev.stopPropagation()}>
                      {(() => {
                        const displayStatus = toRegistryStatus(e.status);
                        // Reactivating (moving into Confirm from anything else) needs
                        // Chief Teacher / Director / Founder — everyone else with
                        // canImport can still make every other status change.
                        const options = displayStatus === "Confirm" || canReactivate
                          ? STATUS_OPTIONS
                          : STATUS_OPTIONS.filter(o => o !== "Confirm");
                        return canImport ? (
                          <select
                            value={STATUS_OPTIONS.includes(displayStatus as typeof STATUS_OPTIONS[number]) ? displayStatus : "__current"}
                            onChange={ev => changeStatus(e.uid, ev.target.value)}
                            title={options.length < STATUS_OPTIONS.length ? "Only Chief Teacher, Director, or Founder can reactivate a student." : undefined}
                            style={{
                              ...statusStyle(displayStatus),
                              border: "1px solid var(--color-border)", cursor: "pointer",
                              fontSize: 12, padding: "3px 6px", textTransform: "none",
                            }}
                          >
                            {!STATUS_OPTIONS.includes(displayStatus as typeof STATUS_OPTIONS[number]) && (
                              <option value="__current" disabled>{displayStatus}</option>
                            )}
                            {options.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <span style={statusStyle(displayStatus)}>{displayStatus}</span>
                        );
                      })()}
                    </td>
                    <td style={{ ...s.td, color: "var(--color-text-muted)", textAlign: "center", whiteSpace: "nowrap" }}>
                      {canImport && (
                        <button
                          onClick={ev => { ev.stopPropagation(); setEditing(e); }}
                          title="Edit details" aria-label={`Edit details for ${e.name}`}
                          style={s.iconBtn}
                        >
                          ✏
                        </button>
                      )}
                      <span style={{ display: "inline-block", transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
                    </td>
                  </tr>
                  {open && (
                    <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td colSpan={canImport ? 5 : 4} style={{ padding: 0, background: "var(--color-surface-2)" }}>
                        <div style={{
                          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                          gap: "10px 24px", padding: "14px 20px",
                        }}>
                          <DetailField label="Date of Admission" value={fmtDate(e.admittedOn)} />
                          <DetailField label="Centre" value={e.centre} />
                          <DetailField label="Batch" value={e.batch} />
                          <DetailField label="Phone Number" value={e.phone} />
                          <DetailField label="Admission Number" value={e.admissionNo} emphasize />
                          <DetailField label="Course" value={e.course} />
                          <DetailField label="Screening Grade" value={e.screening} />
                          {e.email && <DetailField label="Email" value={e.email} />}
                        </div>
                        {canImport && (
                          <div style={{ padding: "0 20px 14px" }}>
                            <button onClick={() => setEditing(e)} style={{ ...s.printBtn, fontSize: 12, padding: "6px 12px" }}>
                              ✏ Edit Details
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
                {canImport && (
                  <tr style={s.pasteTr}>
                    <td style={s.td} />
                    <td style={{ ...s.td, color: "var(--color-text-muted)" }}>＋</td>
                    <td colSpan={3} style={{ padding: 0 }}
                      onFocus={() => setPasteFocused(true)}
                      onBlur={ev => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setPasteFocused(false); }}>
                      {pasteFocused && (
                        // Header template sits above the input. mouseDown is swallowed so
                        // clicking the guide (e.g. Copy) never blurs the input and hides it.
                        <div style={{ padding: "10px 12px 0" }} onMouseDown={ev => ev.preventDefault()}>
                          <PasteFormatGuide />
                        </div>
                      )}
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

      {showMerge && (
        <MergeDuplicatesModal
          onClose={() => setShowMerge(false)}
          centreName={id => centres.find(c => c.id === id)?.name ?? (id ? "Unknown centre" : "")}
        />
      )}
      {showImport && (
        <ImportModal
          centres={centres}
          existingAdmNos={existingAdmNos}
          existingPeople={entries}
          initiatorId={user?.uid ?? "unknown"}
          initiatorRole={user?.role ?? ROLES.FOUNDER}
          wing={WING}
          initialPaste={pastedText}
          onClose={closeImport}
          onDone={closeImport}
          onImported={uids => { justImported.current = uids; }}
        />
      )}

      {editing && (
        <EditStudentModal
          entry={editing}
          centres={centres}
          existingAdmNos={existingAdmNos}
          canReactivate={canReactivate}
          initiatorId={user?.uid ?? "unknown"}
          initiatorRole={user?.role ?? ROLES.FOUNDER}
          onClose={() => setEditing(null)}
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

// ─── Edit Student Details modal ───────────────────────────────────────────────

/** ISO timestamp → local "YYYY-MM-DD" for a date input ("" when blank/invalid). */
function isoToDateInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const blankDash = (v: string) => (v === "—" ? "" : v);

function EditStudentModal({ entry, centres, existingAdmNos, canReactivate, initiatorId, initiatorRole, onClose }: {
  entry:          Entry;
  centres:        RegistryCentre[];
  existingAdmNos: Set<string>;
  canReactivate:  boolean;
  initiatorId:    string;
  initiatorRole:  string;
  onClose:        () => void;
}) {
  const initial = useMemo(() => ({
    name:        blankDash(entry.name),
    admissionNo: blankDash(entry.admissionNo),
    phone:       blankDash(entry.phone),
    email:       entry.email,
    centerId:    entry.centerId,
    batchId:     entry.batchId,
    course:      entry.courseRaw || blankDash(entry.course),
    admittedOn:  isoToDateInput(entry.admittedOn),
    status:      toRegistryStatus(entry.status),
  }), [entry]);
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(prev => ({ ...prev, [k]: v }));

  const centre = centres.find(c => c.id === f.centerId);
  const centreBatches = centre?.batches ?? [];
  // Free-text centre from an import that never matched a centre doc — kept
  // unless the user explicitly picks a real centre.
  const freeTextCentre = !entry.centerId && entry.centre !== "—" ? entry.centre : "";

  const statusOptions: string[] = initial.status === "Confirm" || canReactivate
    ? [...STATUS_OPTIONS]
    : STATUS_OPTIONS.filter(o => o !== "Confirm");
  if (!statusOptions.includes(initial.status)) statusOptions.unshift(initial.status);

  async function handleSave(ev: React.FormEvent) {
    ev.preventDefault();
    const name = f.name.trim();
    const admNo = f.admissionNo.trim();
    const email = f.email.trim().toLowerCase();
    if (!name) return setError("Full name is required.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("Enter a valid email address.");
    const admKey = admNo.replace(/\s+/g, "").toUpperCase();
    const ownKey = initial.admissionNo.replace(/\s+/g, "").toUpperCase();
    if (admKey && admKey !== ownKey && existingAdmNos.has(admKey)) {
      return setError(`Admission number ${admNo} is already used by another student.`);
    }
    const nextStatus = fromRegistryStatus(f.status);
    if (nextStatus === "active" && entry.status !== "active" && !canReactivate) {
      return setError("Only Chief Teacher, Director, or Founder can reactivate a student.");
    }

    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    if (name !== initial.name) {
      const [first, ...rest] = name.split(/\s+/);
      Object.assign(patch, { displayName: name, name, firstName: first ?? "", lastName: rest.join(" ") });
      changed.push("name");
    }
    if (admNo !== initial.admissionNo) {
      // All three fields are read as the admission number elsewhere — keep them in step.
      Object.assign(patch, { admissionNumber: admNo, admissionNo: admNo, studentID: admNo, admissionNoAutoGenerated: false });
      changed.push("admissionNumber");
    }
    if (f.phone.trim() !== initial.phone) { patch.phone = f.phone.trim(); changed.push("phone"); }
    if (email !== initial.email.toLowerCase()) { patch.email = email; changed.push("email"); }
    if (f.centerId !== initial.centerId && f.centerId) {
      Object.assign(patch, { centerId: f.centerId, centre: centre?.name ?? "" });
      changed.push("centre");
    }
    if (f.batchId !== initial.batchId || f.centerId !== initial.centerId) {
      const b = centreBatches.find(x => x.id === f.batchId);
      Object.assign(patch, { batchId: b ? b.id : null, batch: b ? b.name : null });
      if (f.batchId !== initial.batchId) changed.push("batch");
    }
    if (f.course.trim() !== initial.course) { patch.course = f.course.trim(); changed.push("course"); }
    if (f.admittedOn !== initial.admittedOn) {
      patch.dateOfAdmission = f.admittedOn ? new Date(`${f.admittedOn}T00:00:00`).toISOString() : null;
      changed.push("dateOfAdmission");
    }
    if (f.status !== initial.status) {
      Object.assign(patch, { status: nextStatus, studentStatus: nextStatus });
      changed.push("status");
    }

    if (Object.keys(patch).length === 0) { onClose(); return; }

    setSaving(true);
    setError("");
    try {
      await updateDoc(doc(db, "users", entry.uid), { ...patch, updatedAt: serverTimestamp() });
      logAction({
        action: "REGISTRY_STUDENT_EDIT",
        initiatorId, initiatorRole: initiatorRole as Parameters<typeof logAction>[0]["initiatorRole"],
        approverId: null, approverRole: null, reason: null,
        metadata: { uid: entry.uid, fields: changed },
      });
      // The registry's live student subscription refreshes the table.
      onClose();
    } catch (err) {
      console.error("Registry student edit failed:", err);
      setError(err instanceof Error ? err.message : "Failed to save changes.");
      setSaving(false);
    }
  }

  const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" };
  const input: React.CSSProperties = { ...s.search, minWidth: 0, width: "100%", boxSizing: "border-box", fontWeight: 400 };

  return (
    <div style={dm.overlay} onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <form onSubmit={handleSave} style={{ ...dm.box, maxWidth: 560, textAlign: "left", maxHeight: "90vh", overflowY: "auto", padding: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 22px", borderBottom: "1px solid #e5e7eb" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>Edit Student Details</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{entry.name}</div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close"
            style={{ background: "none", border: "none", fontSize: 22, color: "#9ca3af", cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, padding: "18px 22px" }}>
          <label style={label}>Full Name
            <input style={input} value={f.name} onChange={e => set("name", e.target.value)} required autoFocus />
          </label>
          <label style={label}>Admission Number
            <input style={input} value={f.admissionNo} onChange={e => set("admissionNo", e.target.value)} placeholder="e.g. ROLCC02092025103" />
          </label>
          <label style={label}>Phone Number
            <input style={input} type="tel" value={f.phone} onChange={e => set("phone", e.target.value)} />
          </label>
          <label style={label}>Email
            <input style={input} type="email" value={f.email} onChange={e => set("email", e.target.value)} placeholder="optional" />
          </label>
          <label style={label}>Centre
            <select style={input} value={f.centerId}
              onChange={e => setF(prev => ({ ...prev, centerId: e.target.value, batchId: "" }))}>
              <option value="" disabled={!!initial.centerId}>
                {freeTextCentre ? `${freeTextCentre} (unmatched)` : "— Select a centre —"}
              </option>
              {[WINGS.SCHOOL_OF_MUSIC, WINGS.ROL_PLUS].map(w => {
                const inW = centres.filter(c => (c.wing ?? WINGS.ROL_PLUS) === w);
                return inW.length > 0 && (
                  <optgroup key={w} label={WING_LABELS[w]}>
                    {inW.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </label>
          <label style={label}>Batch
            {centreBatches.length > 0 ? (
              <select style={input} value={f.batchId} onChange={e => set("batchId", e.target.value)}>
                <option value="">— No batch —</option>
                {centreBatches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : (
              <select style={{ ...input, color: "#6b7280" }} disabled value="">
                <option value="">{f.centerId ? `${DEFAULT_BATCH_NAME} (centre schedule)` : entry.batch}</option>
              </select>
            )}
          </label>
          <label style={label}>Instrument / Course
            <input style={input} list="registry-course-options" value={f.course} onChange={e => set("course", e.target.value)} />
            <datalist id="registry-course-options">
              {Object.values(SYLLABUS_INSTRUMENT_LABELS).map(l => <option key={l} value={l} />)}
            </datalist>
          </label>
          <label style={label}>Date of Admission
            <input style={input} type="date" value={f.admittedOn} onChange={e => set("admittedOn", e.target.value)} />
          </label>
          <label style={label}>Status
            <select style={input} value={f.status} onChange={e => set("status", e.target.value)}
              title={!canReactivate && initial.status !== "Confirm" ? "Only Chief Teacher, Director, or Founder can reactivate a student." : undefined}>
              {statusOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        </div>

        {error && (
          <div style={{ margin: "0 22px 12px", fontSize: 12.5, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "14px 22px", borderTop: "1px solid #e5e7eb" }}>
          <button type="button" onClick={onClose} disabled={saving} style={s.printBtn}>Cancel</button>
          <button type="submit" disabled={saving} style={{ ...s.importBtn, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Import modal ─────────────────────────────────────────────────────────────

interface PreviewRow {
  sl:          number;
  name:        string;
  admittedOn:  string | null;
  centreRaw:   string;
  centreId:    string | null;
  centreCode:  string;
  centreUnmatched: boolean;
  batchId:     string;    // picked after parsing from the matched centre's batches; "" = none / General Batch
  phone:       string;
  admissionNo: string;    // from the sheet — required; never auto-generated
  course:      string;
  status:      string;
  screening:   string;
  error:       string | null;
  duplicate:   boolean;
}

function DetailField({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: "var(--color-text-primary)", fontWeight: emphasize ? 700 : 400 }}>
        {value || "—"}
      </div>
    </div>
  );
}

function ImportModal({
  centres, existingAdmNos, existingPeople, initiatorId, initiatorRole, wing: WING, initialPaste, onClose, onDone, onImported,
}: {
  centres: RegistryCentre[];
  /** Students already on the register — a row with the same name + phone is a duplicate. */
  existingPeople: { name: string; phone: string }[];
  /** Wing the imported students are created in. */
  wing: string;
  existingAdmNos: Set<string>;
  initiatorId: string;
  initiatorRole: string;
  initialPaste?: string;
  onClose: () => void;
  onDone: () => void;
  onImported: (uids: string[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"file" | "paste" | "columns">(initialPaste ? "paste" : "file");
  const [fileName, setFileName] = useState("");
  const [pasteText, setPasteText] = useState(initialPaste ?? "");
  const [cols, setCols] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [parseErr, setParseErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: number; blocked: number; centres: string[] } | null>(null);

  const centreByName = useMemo(() => {
    const m = new Map<string, { id: string; code: string }>();
    // First wins — `centres` lists School-of-Music centres first, so a name
    // shared by both wings resolves to the SoM centre.
    centres.forEach(c => {
      const key = c.name.trim().toLowerCase();
      if (!m.has(key)) m.set(key, { id: c.id, code: c.code });
    });
    return m;
  }, [centres]);
  const centreById = useMemo(() => {
    const m = new Map<string, RegistryCentre>();
    centres.forEach(c => m.set(c.id, c));
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
    // Same person = same name + same phone (siblings share a phone, so phone alone isn't enough).
    const personKey = (name: string, phone: string) => {
      const n = normName(name), ph = normPhone(phone);
      return n && ph ? `${n}|${ph}` : "";
    };
    const existingPeopleKeys = new Set(existingPeople.map(e => personKey(e.name, e.phone)).filter(Boolean));
    const seenPeople = new Set<string>();
    return rows.map((r, i) => {
      const name        = pick(r, "name", "studentname", "fullname");
      const admittedOn  = parseSheetDate(pick(r, "dateofadmission", "admissiondate", "doa", "date"));
      const centreRaw   = pick(r, "centre", "center", "centrename", "centername", "branch", "location");
      const phone       = pick(r, "phonenumber", "phoneno", "phone", "mobilenumber", "mobileno", "mobile", "contactnumber", "contactno", "contact");
      const admissionNo = pick(r, "admissionno", "admissionnumber", "admissionnumberno", "admno", "admissionid");
      const course      = pick(r, "course", "instrument");
      const status      = pick(r, "status");
      const screening   = pick(r, "screeninggrade", "screeningscore", "grade", "screening");

      // Match a centre name to a centre doc for display only — an unmatched
      // centre is kept as free text, never rejected.
      const nameMatch = centreRaw ? centreByName.get(centreRaw.trim().toLowerCase()) : undefined;
      const centreId  = nameMatch?.id ?? null;

      const key  = admissionNo.replace(/\s+/g, "").toUpperCase();
      const dupInFile = key && seen.has(key);
      if (key) seen.add(key);
      const pk = personKey(name, phone);
      const personDup = !!pk && (existingPeopleKeys.has(pk) || seenPeople.has(pk));
      if (pk) seenPeople.add(pk);
      const duplicate = (!!key && (existingAdmNos.has(key) || !!dupInFile)) || personDup;

      return {
        sl: i + 1,
        name,
        admittedOn,
        centreRaw,
        centreId,
        centreCode: nameMatch?.code ?? "",
        centreUnmatched: !!centreRaw && !centreId,
        batchId: "",
        phone,
        admissionNo,
        course,
        status: status || "active",
        screening,
        // Admission numbers are manual-only: a row without one is blocked, not auto-numbered.
        error: !name ? "Name is required" : !admissionNo ? "No Admission Number Given" : null,
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

  // Batch is chosen here, after parsing — per row, or for every row at a centre.
  function setRowBatch(sl: number, batchId: string) {
    setPreview(p => p.map(r => r.sl === sl ? { ...r, batchId } : r));
  }
  function setCentreBatch(centreId: string, batchId: string) {
    setPreview(p => p.map(r => r.centreId === centreId ? { ...r, batchId } : r));
  }
  // Matched centres in the preview that have batches to choose from.
  const batchCentres = useMemo(() => {
    const ids = Array.from(new Set(preview.map(r => r.centreId).filter((id): id is string => !!id)));
    return ids.map(id => centreById.get(id)).filter((c): c is RegistryCentre => !!c && (c.batches?.length ?? 0) > 0);
  }, [preview, centreById]);

  const importable = preview.filter(r => !r.error && !r.duplicate);
  const skipCount = preview.filter(r => r.duplicate && !r.error).length;
  const errorCount = preview.filter(r => r.error).length;

  async function runImport() {
    if (importable.length === 0 || busy) return;
    setBusy(true);
    let imported = 0, failed = 0;
    const newIds: string[] = [];
    try {
      for (let i = 0; i < importable.length; i += 400) {
        const chunk = importable.slice(i, i + 400);
        const batch = writeBatch(db);
        const chunkIds: string[] = [];
        for (const r of chunk) {
          const admNo = r.admissionNo;
          const pickedBatch = r.centreId ? centreById.get(r.centreId)?.batches?.find(b => b.id === r.batchId) : undefined;
          const [first, ...rest] = r.name.trim().split(/\s+/);
          const ref = doc(collection(db, "users"));
          chunkIds.push(ref.id);
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
            admissionNoAutoGenerated: false,
            studentID:      admNo,
            // Keep the human-readable name (exactly as typed) in `centre` and the
            // matched Firestore doc id separately in `centerId` — never collapse
            // the two, or every centre-name lookup downstream has to fall back
            // to a raw id whenever this record's name can't be resolved another way.
            centre:         r.centreRaw,
            centerId:       r.centreId ?? "",
            batchId:        pickedBatch?.id ?? null,
            batch:          pickedBatch?.name ?? null,
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
            createdVia:     "import",
          });
        }
        try {
          await batch.commit();
          imported += chunk.length;
          newIds.push(...chunkIds);
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
        metadata: { imported, skipped: skipCount, failed, blocked: errorCount, source: mode === "file" ? (fileName || "file") : mode },
      }).catch(() => {});
      onImported(newIds);
      setResult({
        imported, skipped: skipCount, failed, blocked: errorCount,
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
                {result.imported} added · {result.skipped} skipped (duplicates) · {result.blocked} blocked (no name / admission number) · {result.failed} failed
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
                their header name — <code style={s.cols}>Name · Date Of Admission · Centre · Phone number · Admission number · Course · Status · Screening grade</code> — in any order; unknown columns are ignored.
                Leave out <strong>Wing</strong> and <strong>Batch</strong>: the wing comes from the centre, and you pick each
                student&apos;s batch after pressing <strong>Parse</strong>.
                <br />
                Every cell is stored exactly as written — nothing is reformatted, merged, or moved
                between columns. Each field comes only from its own column: <code style={{ fontSize: 11 }}>Centre</code> from the Centre column,
                <code style={{ fontSize: 11 }}>Phone number</code> from the Phone column, and so on. A centre that isn&apos;t in the system is kept
                as plain text.
                <strong>Every row needs its admission number</strong> — numbers are entered manually and never generated.
                Rows with no name or no admission number are blocked; rows whose admission number, or name + phone, is already on the register are skipped.
              </p>

              {preview.length === 0 && (<>
              <div style={s.modeTabs}>
                {([
                  ["file", "📄 Upload file"],
                  ["paste", "📋 Copy & paste"],
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
                  <PasteFormatGuide pasted={pasteText} />
                  <textarea
                    value={pasteText}
                    onChange={e => setPasteText(e.target.value)}
                    placeholder={"Paste rows copied from Excel / Google Sheets (header row recommended), then press Parse:\n\nName\tDate Of Admission\tCentre\tPhone number\tAdmission no.\tCourse\tStatus\tScreening Grade\nPriya Nair\t24/09/2026\tCinnamon\t9876543210\t\tKeyboard\t\t"}
                    rows={7}
                    style={s.textarea}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    <button style={s.primaryBtn} onClick={handlePasteParse} disabled={!pasteText.trim()}>
                      Parse
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
                      Parse
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

              {batchCentres.length > 0 && (
                <div style={s.confirmBox}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 6 }}>
                    Batches <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>— set for every student at a centre, or per row below</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                    {batchCentres.map(c => {
                      const ids = new Set(preview.filter(r => r.centreId === c.id).map(r => r.batchId));
                      return (
                        <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-secondary)" }}>
                          {c.name}
                          <select value={ids.size === 1 ? [...ids][0] : "__mixed"} onChange={e => setCentreBatch(c.id, e.target.value)} style={s.batchSelect}>
                            {ids.size > 1 && <option value="__mixed" disabled>Mixed</option>}
                            <option value="">— No batch —</option>
                            {c.batches!.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {preview.length > 0 && (
                <>
                  <div style={{ display: "flex", gap: 14, margin: "14px 0 8px", fontSize: 12, fontWeight: 700, flexWrap: "wrap" as const }}>
                    <span style={{ color: "#16a34a" }}>{importable.length} to import</span>
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
                            <td style={s.td}>{r.admissionNo || <em style={{ color: "#dc2626" }}>missing</em>}</td>
                            <td style={s.td}>{r.centreRaw || "—"}</td>
                            <td style={s.td}>
                              {(() => {
                                const c = r.centreId ? centreById.get(r.centreId) : undefined;
                                if (!c) return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
                                if (!c.batches?.length) return <span style={{ color: "var(--color-text-muted)" }}>{DEFAULT_BATCH_NAME}</span>;
                                return (
                                  <select value={r.batchId} onChange={e => setRowBatch(r.sl, e.target.value)} style={s.batchSelect}>
                                    <option value="">— No batch —</option>
                                    {c.batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                  </select>
                                );
                              })()}
                            </td>
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
  iconBtn: { background: "none", border: "1px solid var(--color-border)", borderRadius: 6, padding: "2px 7px", marginRight: 8, fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" },
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
  batchSelect: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)" },
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
