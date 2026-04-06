"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import { bulkImportLessons } from "@/services/lesson/lesson.service";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { ExcelImportRow } from "@/types/lesson";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function LessonImportPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <Suspense fallback={null}>
        <LessonImportContent />
      </Suspense>
    </ProtectedRoute>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_COLUMNS = ["lessonnumber", "lessonname", "itemtype", "itemtitle"] as const;
const VALID_ITEM_TYPES = ["concept", "exercise", "songsheet"] as const;

type RequiredColumn = typeof REQUIRED_COLUMNS[number];

// ─── Native XLSX parser ───────────────────────────────────────────────────────

async function readZipEntry(buffer: ArrayBuffer, filename: string): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  let offset  = 0;

  while (offset < bytes.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;

    const flags          = view.getUint16(offset + 6, true);
    const compression    = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen        = view.getUint16(offset + 26, true);
    const extraLen       = view.getUint16(offset + 28, true);
    const name           = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLen));
    const dataStart      = offset + 30 + nameLen + extraLen;
    const dataEnd        = dataStart + compressedSize;

    if (name === filename) {
      const compressed = bytes.slice(dataStart, dataEnd);
      if (compression === 0) {
        return new TextDecoder().decode(compressed);
      } else if (compression === 8) {
        const ds     = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(compressed);
        writer.close();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
          const { value, done: d } = await reader.read();
          if (value) chunks.push(value);
          done = d;
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) { merged.set(c, pos); pos += c.length; }
        return new TextDecoder().decode(merged);
      }
    }

    const descriptorExtra = (flags & 0x0008) ? 12 : 0;
    offset = dataEnd + descriptorExtra;
  }
  return null;
}

function parseXmlText(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "gs");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function stripXmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function parseXlsxBuffer(buffer: ArrayBuffer): Promise<{ rows: Record<string, string>[]; error: string | null }> {
  try {
    const sharedXml  = await readZipEntry(buffer, "xl/sharedStrings.xml");
    const sharedStrings: string[] = [];
    if (sharedXml) {
      const siMatches = sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
      for (const si of siMatches) {
        sharedStrings.push(stripXmlTags(si.replace(/<si>/g, "").replace(/<\/si>/g, "")));
      }
    }

    const sheetXml = await readZipEntry(buffer, "xl/worksheets/sheet1.xml");
    if (!sheetXml) return { rows: [], error: "Could not read sheet1 from the Excel file." };

    const rowMatches = sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
    if (rowMatches.length < 2) return { rows: [], error: "File has no data rows." };

    const headerRow     = rowMatches[0] ?? "";
    const cellsInHeader = headerRow.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) ?? [];
    const headers: string[] = cellsInHeader.map(cell => {
      const tAttr  = cell.match(/t="([^"]+)"/);
      const vMatch = parseXmlText(cell, "v");
      const raw    = vMatch[0] ?? "";
      if (tAttr?.[1] === "s") return sharedStrings[parseInt(raw)] ?? raw;
      if (tAttr?.[1] === "inlineStr") { const t = parseXmlText(cell, "t"); return stripXmlTags(t[0] ?? ""); }
      return stripXmlTags(raw);
    });

    const normalizedHeaders = headers.map(h => h.trim().toLowerCase().replace(/[_\s]+/g, ""));

    const dataRows: Record<string, string>[] = [];
    for (let ri = 1; ri < rowMatches.length; ri++) {
      const rowXml = rowMatches[ri];
      const cells  = rowXml.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) ?? [];
      const rowObj: Record<string, string> = {};

      for (let ci = 0; ci < cells.length; ci++) {
        const cell   = cells[ci];
        const tAttr  = cell.match(/t="([^"]+)"/);
        const vMatch = parseXmlText(cell, "v");
        const raw    = vMatch[0] ?? "";
        let value: string;

        if (tAttr?.[1] === "s") value = sharedStrings[parseInt(raw)] ?? "";
        else if (tAttr?.[1] === "inlineStr") { const t = parseXmlText(cell, "t"); value = stripXmlTags(t[0] ?? ""); }
        else value = stripXmlTags(raw);

        const colIdx = cellColIndex(cell);
        const hdr    = normalizedHeaders[colIdx] ?? normalizedHeaders[ci];
        if (hdr) rowObj[hdr] = value;
      }
      dataRows.push(rowObj);
    }

    return { rows: dataRows, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], error: `Failed to parse file: ${msg}` };
  }
}

function cellColIndex(cellXml: string): number {
  const rAttr = cellXml.match(/r="([A-Z]+)\d+"/);
  if (!rAttr) return 0;
  const col = rAttr[1];
  let idx   = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}

// ─── Row mapping + validation ─────────────────────────────────────────────────

function mapToImportRows(raw: Record<string, string>[]): ExcelImportRow[] {
  return raw.map((r, i) => ({
    lessonNumber: Number(r["lessonnumber"] ?? i + 1),
    lessonName:   r["lessonname"]  ?? "",
    itemType:     (r["itemtype"]   ?? "").trim().toLowerCase(),
    itemTitle:    r["itemtitle"]   ?? "",
  }));
}

interface ValidationResult {
  columnErrors: string[];
  rowErrors:    string[];
  valid:        boolean;
}

function validateImport(headers: string[], rows: ExcelImportRow[]): ValidationResult {
  const normalised    = headers.map(h => h.trim().toLowerCase().replace(/[_\s]+/g, ""));
  const columnErrors: string[] = [];
  const rowErrors:    string[] = [];

  for (const col of REQUIRED_COLUMNS) {
    if (!normalised.includes(col)) columnErrors.push(`Missing required column: "${col}"`);
  }
  if (columnErrors.length > 0) return { columnErrors, rowErrors, valid: false };

  rows.forEach((r, i) => {
    const rowNum = i + 2;
    if (!r.lessonName?.trim()) rowErrors.push(`Row ${rowNum}: lessonName is required`);
    if (!r.itemTitle?.trim())  rowErrors.push(`Row ${rowNum}: itemTitle is required`);
    if (!VALID_ITEM_TYPES.includes(r.itemType?.trim().toLowerCase() as typeof VALID_ITEM_TYPES[number])) {
      rowErrors.push(`Row ${rowNum}: invalid itemType "${r.itemType}" — must be concept, exercise, or songsheet`);
    }
    if (isNaN(r.lessonNumber) || r.lessonNumber < 1) {
      rowErrors.push(`Row ${rowNum}: lessonNumber must be a positive number`);
    }
  });

  return { columnErrors, rowErrors, valid: columnErrors.length === 0 && rowErrors.length === 0 };
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

function getUniqueLessonNumbers(rows: ExcelImportRow[]): number[] {
  return Array.from(new Set(rows.map(r => r.lessonNumber))).sort((a, b) => a - b);
}

// ─── Content ───────────────────────────────────────────────────────────────────

interface CenterOption  { id: string; name: string; centerCode: string; }
interface StudentOption { uid: string; displayName: string; studentID: string; admissionNo: string; centerId: string; }

function LessonImportContent() {
  const { user, role }              = useAuth();
  const searchParams                = useSearchParams();
  const [file, setFile]             = useState<File | null>(null);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [preview, setPreview]       = useState<ExcelImportRow[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  // Scope — pre-populated from URL params: ?scope=center&id=<centerId>
  //                                     or ?scope=student&id=<studentId>
  const [scopeType, setScopeType]   = useState<"center" | "student">(
    searchParams.get("scope") === "student" ? "student" : "center"
  );
  const [scopeId, setScopeId]       = useState(searchParams.get("id") ?? "");
  const [centers, setCenters]       = useState<CenterOption[]>([]);
  const [centersLoading, setCentersLoading] = useState(true);
  const [students, setStudents]     = useState<StudentOption[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(true);

  // Overwrite toggle
  const [overwrite, setOverwrite]   = useState(false);
  const [existingCount, setExistingCount] = useState<number | null>(null);
  const [checkingExisting, setCheckingExisting] = useState(false);

  const [importing, setImporting]   = useState(false);
  const [result, setResult]         = useState<{ created: number; skipped: number; errors: string[] } | null>(null);
  const fileRef                     = useRef<HTMLInputElement>(null);
  const { toasts, toast, remove }   = useToast();

  // Load centers + students on mount
  useEffect(() => {
    getDocs(collection(db, "centers"))
      .then(snap => setCenters(snap.docs.map(d => ({
        id:         d.id,
        name:       (d.data().name as string) ?? d.id,
        centerCode: (d.data().centerCode as string) ?? "—",
      }))))
      .catch(() => {})
      .finally(() => setCentersLoading(false));

    getDocs(query(collection(db, "users"), where("role", "==", "student")))
      .then(snap => setStudents(snap.docs.map(d => {
        const dt = d.data();
        return {
          uid:         d.id,
          displayName: (dt.displayName as string) ?? (dt.name as string) ?? "",
          studentID:   (dt.studentID  as string) ?? "",
          admissionNo: (dt.admissionNo as string) ?? (dt.admissionNumber as string) ?? "",
          centerId:    (dt.centerId   as string) ?? "",
        };
      })))
      .catch(() => {})
      .finally(() => setStudentsLoading(false));
  }, []);

  // When scope changes + file loaded, check existing lesson count
  useEffect(() => {
    if (!scopeId.trim() || preview.length === 0) { setExistingCount(null); return; }
    const uniqueNums = getUniqueLessonNumbers(preview);
    if (uniqueNums.length === 0) { setExistingCount(null); return; }

    setCheckingExisting(true);
    const scopeField = scopeType === "center" ? "centerId" : "studentId";
    getDocs(query(collection(db, "lessons"), where(scopeField, "==", scopeId.trim())))
      .then(snap => {
        const existingNums = new Set(snap.docs.map(d => d.data().lessonNumber as number));
        const overlap = uniqueNums.filter(n => existingNums.has(n));
        setExistingCount(overlap.length);
      })
      .catch(() => setExistingCount(null))
      .finally(() => setCheckingExisting(false));
  }, [scopeId, scopeType, preview]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    setFile(f);
    setResult(null);
    setValidation(null);
    setPreview([]);
    setRawHeaders([]);
    setExistingCount(null);

    if (!f.name.match(/\.xlsx$/i)) {
      setValidation({ columnErrors: ["Only .xlsx files are supported."], rowErrors: [], valid: false });
      return;
    }

    try {
      const buffer = await f.arrayBuffer();
      const { rows: rawRows, error } = await parseXlsxBuffer(buffer);

      if (error) { setValidation({ columnErrors: [error], rowErrors: [], valid: false }); return; }
      if (rawRows.length === 0) { setValidation({ columnErrors: ["File has no data rows."], rowErrors: [], valid: false }); return; }

      const headers = Object.keys(rawRows[0]);
      setRawHeaders(headers);

      const importRows = mapToImportRows(rawRows);
      setPreview(importRows);
      setValidation(validateImport(headers, importRows));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error parsing file.";
      setValidation({ columnErrors: [msg], rowErrors: [], valid: false });
    }
  }

  async function handleImport() {
    if (!user || !scopeId.trim()) { toast("Select a center or enter a student UID first.", "error"); return; }
    if (!validation?.valid)       { toast("Fix all validation errors before importing.", "error"); return; }
    if (preview.length === 0)     { toast("No rows to import.", "error"); return; }

    setImporting(true);
    try {
      const scope = scopeType === "center"
        ? { centerId: scopeId.trim(), studentId: null as null }
        : { centerId: null as null,   studentId: scopeId.trim() };

      const res = await bulkImportLessons(preview, scope, user.uid, role ?? "admin", overwrite);
      setResult(res);
      setExistingCount(null);
      toast(
        `Import complete. Created: ${res.created}, Skipped: ${res.skipped}.`,
        res.errors.length > 0 ? "error" : "success"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Import failed: ${msg}`, "error");
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setFile(null); setPreview([]); setValidation(null); setResult(null);
    setRawHeaders([]); setScopeId(""); setExistingCount(null); setOverwrite(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  const uniqueLessons  = getUniqueLessonNumbers(preview);
  const totalErrors    = (validation?.columnErrors.length ?? 0) + (validation?.rowErrors.length ?? 0);
  const canImport      = preview.length > 0 && validation?.valid && scopeId.trim() && !importing;

  return (
    <div>
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* Header */}
      <div style={s.header}>
        <h1 style={s.heading}>Import Lessons from Excel</h1>
      </div>

      {/* Instructions */}
      <div style={s.infoCard}>
        <div style={s.infoTitle}>Required columns (case-insensitive):</div>
        <div style={s.chipRow}>
          {(["lessonNumber", "lessonName", "itemType", "itemTitle"] as const).map(col => (
            <span key={col} style={s.chip}>{col}</span>
          ))}
        </div>
        <div style={s.infoNote}>
          <strong>One row = one item.</strong> Rows with the same <code>lessonNumber</code> are grouped into one lesson.
          Lesson order = <code>lessonNumber</code> rank. Item order = row sequence within lesson.
          {" "}<strong>itemType:</strong> <strong>concept</strong>, <strong>exercise</strong>, or <strong>songsheet</strong>.
        </div>
      </div>

      {/* Scope selector */}
      <div style={s.card}>
        <div style={s.cardTitle}>Import target</div>
        <div style={s.row}>
          <label style={s.radioLabel}>
            <input type="radio" checked={scopeType === "center"}
              onChange={() => { setScopeType("center"); setScopeId(""); setExistingCount(null); }}
              style={{ marginRight: 6 }} />
            Center (shared lessons)
          </label>
          <label style={s.radioLabel}>
            <input type="radio" checked={scopeType === "student"}
              onChange={() => { setScopeType("student"); setScopeId(""); setExistingCount(null); }}
              style={{ marginRight: 6 }} />
            Student (individual lessons)
          </label>
        </div>

        {scopeType === "center" ? (
          centersLoading ? (
            <div style={s.loadingText}>Loading centers…</div>
          ) : centers.length === 0 ? (
            <input value={scopeId} onChange={e => setScopeId(e.target.value)}
              placeholder="No centers found — enter Center ID manually" style={s.input} />
          ) : (
            <select value={scopeId} onChange={e => setScopeId(e.target.value)} style={s.select}>
              <option value="">— Select center —</option>
              {centers.map(c => (
                <option key={c.id} value={c.id}>
                  [{c.centerCode}] {c.name}
                </option>
              ))}
            </select>
          )
        ) : (
          studentsLoading ? (
            <div style={s.loadingText}>Loading students…</div>
          ) : students.length === 0 ? (
            <input value={scopeId} onChange={e => setScopeId(e.target.value)}
              placeholder="No students found — enter Student UID manually" style={s.input} />
          ) : (
            <select value={scopeId} onChange={e => setScopeId(e.target.value)} style={s.select}>
              <option value="">— Select student —</option>
              {students.map(st => {
                const label = st.studentID
                  ? `[${st.studentID}] ${st.displayName || st.uid}`
                  : st.admissionNo
                    ? `[${st.admissionNo}] ${st.displayName || st.uid}`
                    : st.displayName || st.uid;
                return (
                  <option key={st.uid} value={st.uid}>{label}</option>
                );
              })}
            </select>
          )
        )}

        {/* Existing lesson status */}
        {scopeId && preview.length > 0 && (
          <div style={s.existingStatus}>
            {checkingExisting ? (
              <span style={s.existingChecking}>Checking existing lessons…</span>
            ) : existingCount === null ? null : existingCount === 0 ? (
              <span style={s.existingNone}>✓ No conflicting lessons found — all {uniqueLessons.length} lesson{uniqueLessons.length !== 1 ? "s" : ""} are new</span>
            ) : (
              <span style={s.existingConflict}>
                ⚠ {existingCount} of {uniqueLessons.length} lesson{uniqueLessons.length !== 1 ? "s" : ""} already exist in this {scopeType}
              </span>
            )}
          </div>
        )}

        {/* Overwrite toggle — only show if there are conflicts */}
        {existingCount !== null && existingCount > 0 && (
          <label style={s.overwriteLabel}>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={e => setOverwrite(e.target.checked)}
              style={{ marginRight: 8, accentColor: "#dc2626" }}
            />
            <span>
              <strong style={{ color: overwrite ? "#dc2626" : "#374151" }}>
                {overwrite ? "⚠ Overwrite existing lessons" : "Skip existing lessons (default)"}
              </strong>
              {overwrite && (
                <span style={s.overwriteWarn}>
                  {" "}— existing lessons and all their items will be deleted and re-created
                </span>
              )}
            </span>
          </label>
        )}
      </div>

      {/* File upload */}
      <div style={s.card}>
        <div style={s.cardTitle}>Upload .xlsx file</div>
        <input ref={fileRef} type="file" accept=".xlsx" onChange={handleFile} style={s.fileInput} />
        {file && (
          <div style={s.fileName}>
            📄 {file.name} ({(file.size / 1024).toFixed(1)} KB)
            {preview.length > 0 && (
              <span style={s.fileSummary}>
                {" "}· {preview.length} rows · {uniqueLessons.length} lesson{uniqueLessons.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Detected headers */}
      {rawHeaders.length > 0 && (
        <div style={s.headersBox}>
          <span style={s.headersLabel}>Detected columns: </span>
          {rawHeaders.map(h => (
            <span key={h} style={{
              ...s.headerChip,
              ...(REQUIRED_COLUMNS.includes(h.toLowerCase().replace(/[_\s]+/g, "") as RequiredColumn)
                ? s.headerChipOk : s.headerChipExtra),
            }}>{h}</span>
          ))}
        </div>
      )}

      {/* Validation errors */}
      {validation && totalErrors > 0 && (
        <div style={s.errorBox}>
          <div style={s.errorTitle}>✕ {totalErrors} validation error{totalErrors !== 1 ? "s" : ""}</div>
          {validation.columnErrors.map((e, i) => (
            <div key={`col-${i}`} style={{ ...s.errorRow, fontWeight: 600 }}>⚠ {e}</div>
          ))}
          {validation.rowErrors.slice(0, 20).map((e, i) => (
            <div key={`row-${i}`} style={s.errorRow}>• {e}</div>
          ))}
          {validation.rowErrors.length > 20 && (
            <div style={s.errorRow}>…and {validation.rowErrors.length - 20} more row errors</div>
          )}
        </div>
      )}

      {/* Validation success */}
      {validation?.valid && preview.length > 0 && (
        <div style={s.successBox}>
          ✓ {preview.length} row{preview.length !== 1 ? "s" : ""} validated →
          {" "}{uniqueLessons.length} lesson{uniqueLessons.length !== 1 ? "s" : ""} ready to import
        </div>
      )}

      {/* Preview table */}
      {preview.length > 0 && validation?.valid && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Preview (first 20 rows)</div>
          <div style={s.tableWrapper}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["#", "Lesson No.", "Lesson Name", "Item Type", "Item Title"].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 20).map((row, i) => (
                  <tr key={i} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                    <td style={{ ...s.td, ...s.mono }}>{i + 1}</td>
                    <td style={{ ...s.td, ...s.mono }}>{row.lessonNumber}</td>
                    <td style={s.td}>{row.lessonName}</td>
                    <td style={s.td}>
                      <span style={{
                        ...s.typeBadge,
                        ...(TYPE_COLORS[row.itemType?.toLowerCase()] ?? TYPE_COLORS._other),
                      }}>{row.itemType}</span>
                    </td>
                    <td style={s.td}>{row.itemTitle}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.length > 20 && (
              <div style={s.moreRows}>…and {preview.length - 20} more rows not shown</div>
            )}
          </div>
        </div>
      )}

      {/* Import result */}
      {result && (
        <div style={{ ...s.resultBox, borderColor: result.errors.length > 0 ? "#fca5a5" : "#86efac" }}>
          <div style={s.resultRow}>
            <span style={{ color: "#16a34a", fontWeight: 700 }}>✓ Created: {result.created}</span>
            <span style={{ color: "#d97706", fontWeight: 700 }}>⚠ Skipped: {result.skipped}</span>
          </div>
          {result.errors.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {result.errors.map((e, i) => (
                <div key={i} style={s.errorRow}>• {e}</div>
              ))}
            </div>
          )}
          {result.created > 0 && result.errors.length === 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#166534" }}>
              All lessons imported successfully. Go to Syllabus to assign them to students.
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div style={s.actions}>
        <button onClick={reset} style={s.resetBtn}>Reset</button>
        <button
          onClick={handleImport}
          disabled={!canImport}
          style={{ ...s.importBtn, opacity: canImport ? 1 : 0.5, cursor: canImport ? "pointer" : "not-allowed" }}
        >
          {importing ? "Importing…" : `Import ${uniqueLessons.length} lesson${uniqueLessons.length !== 1 ? "s" : ""}`}
        </button>
      </div>

      {/* Hint when button is blocked */}
      {preview.length > 0 && !canImport && !importing && (
        <div style={s.hintBox}>
          {!scopeId.trim() && <div style={s.hintRow}>⚠ Select a center (or enter a student UID) to enable import.</div>}
          {totalErrors > 0 && <div style={s.hintRow}>⚠ Fix the {totalErrors} validation error{totalErrors !== 1 ? "s" : ""} shown above.</div>}
        </div>
      )}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, React.CSSProperties> = {
  concept:   { background: "#ede9fe", color: "#4f46e5" },
  exercise:  { background: "#dcfce7", color: "#15803d" },
  songsheet: { background: "#fef9c3", color: "#a16207" },
  _other:    { background: "#fee2e2", color: "#b91c1c" },
};

const s: Record<string, React.CSSProperties> = {
  header:       { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  heading:      { fontSize: 22, fontWeight: 600, color: "var(--color-text-primary)" },

  infoCard:     { background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "14px 18px", marginBottom: 16 },
  infoTitle:    { fontSize: 12, fontWeight: 700, color: "#1d4ed8", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 10 },
  chipRow:      { display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 },
  chip:         { background: "#dbeafe", color: "#1e40af", padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600, fontFamily: "monospace" },
  infoNote:     { fontSize: 12, color: "#3b82f6" },

  card:         { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "16px 20px", marginBottom: 14 },
  cardTitle:    { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 12 },
  row:          { display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" as const },
  radioLabel:   { display: "flex", alignItems: "center", fontSize: 13, fontWeight: 500, color: "#111827", cursor: "pointer" },
  input:        { width: "100%", maxWidth: 420, padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111827" },
  select:       { width: "100%", maxWidth: 420, padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", color: "#111827", cursor: "pointer" },
  loadingText:  { fontSize: 12, color: "#6b7280", fontStyle: "italic" as const },
  fileInput:    { fontSize: 13, cursor: "pointer" },
  fileName:     { marginTop: 8, fontSize: 12, color: "#6b7280" },
  fileSummary:  { color: "#4f46e5", fontWeight: 600 },

  existingStatus: { marginTop: 10, fontSize: 12 },
  existingChecking: { color: "#6b7280", fontStyle: "italic" as const },
  existingNone:    { color: "#16a34a", fontWeight: 600 },
  existingConflict:{ color: "#d97706", fontWeight: 600 },

  overwriteLabel: { display: "flex", alignItems: "flex-start", gap: 0, marginTop: 12, cursor: "pointer", fontSize: 13 },
  overwriteWarn:  { fontSize: 11, color: "#dc2626" },

  headersBox:   { background: "#f9fafb", border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: 6 },
  headersLabel: { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginRight: 4 },
  headerChip:   { padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 600, fontFamily: "monospace" },
  headerChipOk: { background: "#dcfce7", color: "#166534" },
  headerChipExtra: { background: "#f3f4f6", color: "#6b7280" },

  errorBox:     { background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", marginBottom: 14 },
  errorTitle:   { fontSize: 12, fontWeight: 700, color: "#dc2626", marginBottom: 8 },
  errorRow:     { fontSize: 12, color: "#b91c1c", marginBottom: 3 },

  successBox:   { background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 13, fontWeight: 600, color: "#16a34a" },

  section:      { marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 8 },
  tableWrapper: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" },
  table:        { width: "100%", borderCollapse: "collapse" as const },
  th:           { padding: "9px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.04em", borderBottom: "1px solid var(--color-border)", background: "#f9fafb" },
  td:           { padding: "9px 14px", fontSize: 12, color: "var(--color-text-primary)", borderBottom: "1px solid var(--color-border)" },
  rowEven:      { background: "var(--color-surface)" },
  rowOdd:       { background: "#fafafa" },
  mono:         { fontFamily: "monospace", fontSize: 11 },
  moreRows:     { padding: "8px 14px", fontSize: 11, color: "#9ca3af", textAlign: "center" as const },
  typeBadge:    { padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize" as const },

  resultBox:    { background: "#f9fafb", border: "1px solid", borderRadius: 8, padding: "14px 18px", marginBottom: 14 },
  resultRow:    { display: "flex", gap: 24, fontSize: 14 },

  actions:      { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 },
  hintBox:      { marginTop: 10, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px" },
  hintRow:      { fontSize: 12, color: "#92400e", fontWeight: 500 },
  resetBtn:     { background: "#f3f4f6", color: "#374151", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  importBtn:    { background: "#4f46e5", color: "#fff", border: "none", padding: "8px 22px", borderRadius: 6, fontSize: 13, fontWeight: 600 },
};
