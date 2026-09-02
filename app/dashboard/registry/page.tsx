"use client";

// Registry — the master register of Rol's School of Music. A single flat table
// of every School-of-Music student, in admission order. Read-only, plus an
// Excel/CSV bulk import.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection, getDocs, query, where, writeBatch, doc, serverTimestamp, Timestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { wingOf } from "@/lib/wing";
import { parseFile } from "@/lib/xlsx-parser";
import { formatAdmissionNo, looksLikeAdmissionNo, reserveAdmissionSeq } from "@/lib/admissionNumber";
import { logAction } from "@/services/audit/audit.service";
import { SYLLABUS_INSTRUMENT_LABELS, type SyllabusInstrument } from "@/types/lesson";

const WING = WINGS.SCHOOL_OF_MUSIC;

interface Entry {
  uid:         string;
  name:        string;
  admittedOn:  string;   // ISO date or ""
  centre:      string;
  teacher:     string;   // free-text name as recorded at admission time
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [studSnap, centreSnap] = await Promise.all([
        getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        getDocs(collection(db, "centers")),
      ]);

      const centreName = new Map<string, string>();
      const centreList: { id: string; name: string; code: string }[] = [];
      centreSnap.docs.forEach(d => {
        const nm = (d.data().name as string) ?? d.id;
        centreName.set(d.id, nm);
        if (wingOf(d.data()) === WING) {
          centreList.push({ id: d.id, name: nm, code: (d.data().centerCode as string) ?? "" });
        }
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
          if (admissionNo !== "—") admNos.add(admissionNo);
          return {
            uid:         d.id,
            name:        (s.displayName ?? s.name ?? "—") as string,
            admittedOn:  toISO(s.dateOfAdmission ?? s.admissionDate ?? s.createdAt),
            centre:      centreName.get(centreRef) || centreRef || "—",
            teacher:     String(s.teacherName ?? s.teacher ?? "").trim() || "—",
            phone:       phone || "—",
            admissionNo,
            course,
            status:      (s.status ?? s.studentStatus ?? "active") as string,
            screening:   screeningGradeOf(s),
          };
        })
        .sort((a, b) => (a.admittedOn || "9999").localeCompare(b.admittedOn || "9999"));

      setExistingAdmNos(admNos);
      setEntries(list);
    } catch (err) {
      console.error("Registry load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const statuses = useMemo(
    () => Array.from(new Set(entries.map(e => e.status))).sort(),
    [entries],
  );

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
        e.course.toLowerCase().includes(needle) ||
        e.screening.toLowerCase().includes(needle)
      );
    });
  }, [entries, q, statusFilter]);

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
          <button style={s.printBtn} onClick={() => window.print()}>🖨 Print</button>
        </div>
      </div>

      <div style={s.card}>
        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={s.empty}>{entries.length === 0 ? "No students on the register yet." : "No matches."}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["SL", "Name", "Date Of Admission", "Centre", "Phone number", "Admission number", "Course", "Status", "Screening grade"]
                    .map(h => <th key={h} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={e.uid} style={s.tr}>
                    <td style={{ ...s.td, color: "var(--color-text-muted)" }}>{i + 1}</td>
                    <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>{e.name}</td>
                    <td style={s.td}>{fmtDate(e.admittedOn)}</td>
                    <td style={s.td}>{e.centre}</td>
                    <td style={s.td}>{e.phone}</td>
                    <td style={s.td}><span style={s.code}>{e.admissionNo}</span></td>
                    <td style={s.td}>{e.course}</td>
                    <td style={s.td}>
                      <span style={statusStyle(e.status)}>{e.status}</span>
                    </td>
                    <td style={s.td}>{e.screening}</td>
                  </tr>
                ))}
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
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); load(); }}
        />
      )}
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
  centres, existingAdmNos, initiatorId, initiatorRole, onClose, onDone,
}: {
  centres: { id: string; name: string; code: string }[];
  existingAdmNos: Set<string>;
  initiatorId: string;
  initiatorRole: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [parseErr, setParseErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: number; generated: number } | null>(null);

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

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setFileName(f.name);
    setParseErr(""); setResult(null); setPreview([]);

    const res = await parseFile(f);
    if (res.error) { setParseErr(res.error); return; }
    if (res.rows.length === 0) { setParseErr("The file has no data rows."); return; }

    const seen = new Set<string>();
    const out: PreviewRow[] = res.rows.map((r, i) => {
      const name = pick(r, "name", "studentname", "fullname");
      // Distinct columns — phone never feeds the admission number and vice versa.
      const phone = pick(r, "phonenumber", "phoneno", "phone", "mobilenumber", "mobileno", "mobile", "contactnumber", "contactno", "contact");
      let admissionNo = pick(r, "admissionnumber", "admissionno", "admissionnumberno", "admno", "admissionid");
      let centreRaw = pick(r, "centre", "center", "branch", "location");

      // Salvage: sometimes the admission code sits in another column (often the
      // Centre column). If admission number is blank but a cell holds an
      // admission-code-shaped value that isn't the phone, use it.
      if (!admissionNo) {
        if (looksLikeAdmissionNo(centreRaw) && centreRaw !== phone) {
          admissionNo = centreRaw;
          centreRaw = "";
        } else {
          const salvaged = Object.values(r).find(
            v => v && v.trim() !== phone && looksLikeAdmissionNo(v),
          );
          if (salvaged) admissionNo = salvaged.trim();
        }
      }

      const centreMatch = centreRaw ? centreByName.get(centreRaw.toLowerCase()) ?? null : null;
      const centreId = centreMatch?.id ?? null;
      const centreCode = centreMatch?.code ?? "";

      const auto = !admissionNo;
      const dupInFile = admissionNo && seen.has(admissionNo);
      if (admissionNo) seen.add(admissionNo);
      const duplicate = !!admissionNo && (existingAdmNos.has(admissionNo) || !!dupInFile);

      // Only a missing name blocks a row. An unmatched centre is kept as free
      // text; the admission number, status and phone are stored exactly as given.
      let error: string | null = null;
      if (!name) error = "Name is required";
      else if (phone && admissionNo && phone === admissionNo) error = "Phone number and admission number are the same";

      return {
        sl: i + 1,
        name,
        admittedOn: parseSheetDate(pick(r, "dateofadmission", "admissiondate", "doa", "date")),
        centreRaw,
        centreId,
        centreCode,
        centreUnmatched: !!centreRaw && !centreId,
        phone,
        admissionNo,
        auto,
        course: pick(r, "course", "instrument"),
        status: pick(r, "status") || "active",
        screening: pick(r, "screeninggrade", "screeningscore", "grade", "screening"),
        error,
        duplicate,
      };
    });
    setPreview(out);
  }

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
        metadata: { imported, skipped: skipCount, failed, generated: autoRows.length, file: fileName },
      }).catch(() => {});
      setResult({ imported, skipped: skipCount, failed, generated: autoRows.length });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div style={s.modal}>
        <div style={s.modalHead}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text-primary)" }}>Import students from Excel</div>
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
              <button style={{ ...s.primaryBtn, marginTop: 20 }} onClick={onDone}>Done</button>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 0, lineHeight: 1.6 }}>
                Upload a <strong>.xlsx</strong> or <strong>.csv</strong> file with these column headers:
                <br />
                <code style={s.cols}>Name · Date Of Admission · Centre · Phone number · Admission number · Course · Status · Screening grade</code>
                <br />
                Every value is stored exactly as written — centre, admission number and status are
                kept verbatim (a centre that isn't in the system is just free text). If a row has no
                admission number one is generated as <code style={{ fontSize: 11 }}>ROLCC + DDMMYYYY + sequence</code>.
                Only rows with no name, or an admission number already on the register, are skipped.
              </p>

              <input ref={fileRef} type="file" accept=".xlsx,.csv" onChange={handleFile} style={s.fileInput} />
              {fileName && <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 6 }}>📄 {fileName}</div>}
              {parseErr && <div style={s.err}>{parseErr}</div>}

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
                        <tr>{["#", "Name", "Adm no.", "Centre", "Phone", "Course", "Date", "Screening", ""].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {preview.map(r => (
                          <tr key={r.sl} style={s.tr}>
                            <td style={{ ...s.td, color: "var(--color-text-muted)" }}>{r.sl}</td>
                            <td style={s.td}>{r.name || <em style={{ color: "#dc2626" }}>missing</em>}</td>
                            <td style={s.td}>{r.admissionNo || <em style={{ color: "#4f46e5" }}>auto</em>}</td>
                            <td style={s.td}>{r.centreRaw || "—"}</td>
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
  th: { textAlign: "left", padding: "10px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "2px solid var(--color-border)", background: "var(--color-bg)", whiteSpace: "nowrap" },
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
  cols: { display: "inline-block", marginTop: 6, fontSize: 11.5, background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "4px 8px" },
  err: { background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, color: "#991b1b", marginTop: 10 },
  pill: { display: "inline-block", padding: "2px 8px", borderRadius: 99, fontSize: 10.5, fontWeight: 700 },
  primaryBtn: { padding: "9px 18px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  ghostBtn: { padding: "9px 18px", background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },
};
