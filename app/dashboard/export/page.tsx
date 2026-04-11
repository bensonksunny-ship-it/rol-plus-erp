"use client";

import { useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = "monthly" | "quarterly" | "yearly" | "all";
type Quarter = "Q1" | "Q2" | "Q3" | "Q4";

interface FilterState {
  range:    Range;
  year:     number;
  month:    number;   // 1-12
  quarter:  Quarter;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function currentYear()  { return new Date().getFullYear(); }
function currentMonth() { return new Date().getMonth() + 1; }

function getDateBounds(f: FilterState): { start: string; end: string } | null {
  const { range, year, month, quarter } = f;
  if (range === "all") return null;

  if (range === "monthly") {
    const mm = String(month).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${lastDay}` };
  }

  if (range === "quarterly") {
    const qMap: Record<Quarter, [number, number]> = {
      Q1: [1, 3], Q2: [4, 6], Q3: [7, 9], Q4: [10, 12],
    };
    const [startMo, endMo] = qMap[quarter];
    const endDay = new Date(year, endMo, 0).getDate();
    const sm = String(startMo).padStart(2, "0");
    const em = String(endMo).padStart(2, "0");
    return { start: `${year}-${sm}-01`, end: `${year}-${em}-${endDay}` };
  }

  // yearly
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function inRange(dateStr: string | undefined, bounds: { start: string; end: string } | null): boolean {
  if (!bounds || !dateStr) return true;
  const d = typeof dateStr === "string" ? dateStr.slice(0, 10) : "";
  return d >= bounds.start && d <= bounds.end;
}

function tsToDate(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val.slice(0, 10);
  if (typeof val === "object" && val !== null && "toDate" in val) {
    return (val as { toDate: () => Date }).toDate().toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchStudents() {
  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
  return snap.docs.map(d => {
    const u = d.data();
    return {
      ID:         d.id,
      Name:       u.displayName ?? u.name ?? "",
      Email:      u.email ?? "",
      Instrument: u.instrument ?? "",
      Centre:     u.centerId ?? "",
      Status:     u.status ?? u.studentStatus ?? "active",
      Balance:    u.currentBalance ?? 0,
      JoinedDate: tsToDate(u.createdAt),
    };
  });
}

async function fetchCentres() {
  const snap = await getDocs(collection(db, "centers"));
  return snap.docs.map(d => {
    const c = d.data();
    return {
      ID:          d.id,
      Code:        c.centerCode ?? "",
      Name:        c.name ?? "",
      Location:    c.location ?? "",
      TimeSlot:    c.timeSlot ?? "",
      TeacherUID:  c.teacherUid ?? "",
      Status:      c.status ?? "",
      CreatedDate: tsToDate(c.createdAt),
    };
  });
}

async function fetchAttendance(bounds: ReturnType<typeof getDateBounds>) {
  const snap = await getDocs(collection(db, "attendance"));
  return snap.docs
    .map(d => {
      const a = d.data();
      return {
        ID:          d.id,
        StudentUID:  a.studentUid ?? "",
        CentreID:    a.centerId ?? "",
        Date:        a.date ?? tsToDate(a.createdAt),
        Status:      a.status ?? "",
        MarkedBy:    a.markedBy ?? "",
        Method:      a.method ?? "",
        CreatedDate: tsToDate(a.createdAt),
      };
    })
    .filter(r => inRange(r.Date, bounds));
}

async function fetchTransactions(bounds: ReturnType<typeof getDateBounds>) {
  const snap = await getDocs(collection(db, "transactions"));
  return snap.docs
    .map(d => {
      const t = d.data();
      return {
        ID:          d.id,
        StudentUID:  t.studentUid ?? "",
        CentreID:    t.centerId ?? "",
        Amount:      t.amount ?? 0,
        Method:      t.method ?? "",
        Status:      t.status ?? "",
        ReceivedBy:  t.receivedBy ?? "",
        Date:        t.date ?? tsToDate(t.createdAt),
        CreatedDate: tsToDate(t.createdAt),
      };
    })
    .filter(r => inRange(r.Date, bounds));
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function runExport(filter: FilterState, setStatus: (s: string) => void) {
  setStatus("Fetching data…");
  const bounds = getDateBounds(filter);

  const [students, centres, attendance, fees] = await Promise.all([
    fetchStudents(),
    fetchCentres(),
    fetchAttendance(bounds),
    fetchTransactions(bounds),
  ]);

  setStatus("Building workbook…");
  const wb = XLSX.utils.book_new();

  const addSheet = (name: string, rows: Record<string, unknown>[]) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "(no data)": "" }]);
    // Auto column width
    const cols = rows.length ? Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length, 14) })) : [];
    ws["!cols"] = cols;
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet("Students",   students   as Record<string, unknown>[]);
  addSheet("Centres",    centres    as Record<string, unknown>[]);
  addSheet("Attendance", attendance as Record<string, unknown>[]);
  addSheet("Fees",       fees       as Record<string, unknown>[]);

  const rangeLabel =
    filter.range === "all"       ? "All"
    : filter.range === "monthly"  ? `${filter.year}-${String(filter.month).padStart(2,"0")}`
    : filter.range === "quarterly"? `${filter.year}-${filter.quarter}`
    : String(filter.year);

  XLSX.writeFile(wb, `rol-export-${rangeLabel}.xlsx`);
  setStatus("done");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const QUARTERS: Quarter[] = ["Q1","Q2","Q3","Q4"];
const YEARS = Array.from({ length: 5 }, (_, i) => currentYear() - i);

function ExportContent() {
  const [filter, setFilter] = useState<FilterState>({
    range:   "monthly",
    year:    currentYear(),
    month:   currentMonth(),
    quarter: "Q1",
  });
  const [status, setStatus] = useState<string>("");

  const exporting = status !== "" && status !== "done";

  function set<K extends keyof FilterState>(k: K, v: FilterState[K]) {
    setFilter(prev => ({ ...prev, [k]: v }));
    setStatus("");
  }

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", paddingBottom: 48 }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#111", marginBottom: 4 }}>
          Export Data
        </div>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          Download Students, Centres, Attendance and Fees as an Excel workbook.
        </div>
      </div>

      {/* Card */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "24px 28px" }}>

        {/* Range selector */}
        <Label>Time Range</Label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {(["monthly","quarterly","yearly","all"] as Range[]).map(r => (
            <button key={r} onClick={() => set("range", r)}
              style={{
                padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                border: "1px solid " + (filter.range === r ? "#4f46e5" : "#e5e7eb"),
                background: filter.range === r ? "#ede9fe" : "#f9fafb",
                color: filter.range === r ? "#4f46e5" : "#374151",
                cursor: "pointer",
              }}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>

        {/* Year picker (all ranges except "all") */}
        {filter.range !== "all" && (
          <>
            <Label>Year</Label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
              {YEARS.map(y => (
                <button key={y} onClick={() => set("year", y)}
                  style={{
                    padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    border: "1px solid " + (filter.year === y ? "#4f46e5" : "#e5e7eb"),
                    background: filter.year === y ? "#ede9fe" : "#f9fafb",
                    color: filter.year === y ? "#4f46e5" : "#374151",
                    cursor: "pointer",
                  }}>
                  {y}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Month picker */}
        {filter.range === "monthly" && (
          <>
            <Label>Month</Label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 20 }}>
              {MONTHS.map((m, i) => (
                <button key={m} onClick={() => set("month", i + 1)}
                  style={{
                    padding: "6px 0", borderRadius: 8, fontSize: 12, fontWeight: 600,
                    border: "1px solid " + (filter.month === i + 1 ? "#4f46e5" : "#e5e7eb"),
                    background: filter.month === i + 1 ? "#ede9fe" : "#f9fafb",
                    color: filter.month === i + 1 ? "#4f46e5" : "#374151",
                    cursor: "pointer",
                  }}>
                  {m}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Quarter picker */}
        {filter.range === "quarterly" && (
          <>
            <Label>Quarter</Label>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {QUARTERS.map(q => (
                <button key={q} onClick={() => set("quarter", q)}
                  style={{
                    flex: 1, padding: "7px 0", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    border: "1px solid " + (filter.quarter === q ? "#4f46e5" : "#e5e7eb"),
                    background: filter.quarter === q ? "#ede9fe" : "#f9fafb",
                    color: filter.quarter === q ? "#4f46e5" : "#374151",
                    cursor: "pointer",
                  }}>
                  {q}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Summary line */}
        <div style={{ fontSize: 12, color: "#6b7280", background: "#f9fafb", borderRadius: 8, padding: "10px 14px", marginBottom: 20 }}>
          <strong>Sheets:</strong> Students · Centres · Attendance · Fees
          {filter.range !== "all" && (
            <> &nbsp;·&nbsp; <strong>Filter:</strong>{" "}
              {filter.range === "monthly"
                ? `${MONTHS[filter.month - 1]} ${filter.year}`
                : filter.range === "quarterly"
                ? `${filter.quarter} ${filter.year}`
                : `Full year ${filter.year}`}
            </>
          )}
        </div>

        {/* Export button */}
        <button
          onClick={() => runExport(filter, setStatus)}
          disabled={exporting}
          style={{
            width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
            background: exporting ? "#a5b4fc" : "#4f46e5",
            color: "#fff", fontSize: 15, fontWeight: 700, cursor: exporting ? "default" : "pointer",
            transition: "background 0.15s",
          }}>
          {exporting ? status : "⬇ Download Excel"}
        </button>

        {status === "done" && (
          <div style={{ marginTop: 12, textAlign: "center", fontSize: 13, color: "#16a34a", fontWeight: 600 }}>
            ✓ File downloaded
          </div>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase",
                  letterSpacing: "0.05em", marginBottom: 8 }}>
      {children}
    </div>
  );
}

export default function ExportPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <ExportContent />
    </ProtectedRoute>
  );
}
