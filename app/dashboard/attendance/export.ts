// Monthly attendance report — CSV and PDF downloads of the History grid
// (same rows / filters as on screen). One section per centre.

import type { AttendanceStatus } from "@/services/attendance/attendance.service";
import type { MatrixRow } from "./matrix";

export interface ReportSection { centreName: string; batchLabel: string; dates: string[]; rows: MatrixRow[] }

const CODE: Record<AttendanceStatus, string> = {
  present: "P", absent: "A", break: "B", cancelled_teacher: "CT", cancelled_student: "NA",
};
const cell = (c: AttendanceStatus | null | "off") => (c === "off" ? "-" : c ? CODE[c] : "");
const dayLabel = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
const monthLabel = (m: string) => new Date(m + "-01T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const fileBase = (m: string) => `attendance_${m}`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMonthlyCsv(month: string, sections: ReportSection[]): void {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const lines: string[] = [q(`Monthly Attendance Report — ${monthLabel(month)}`), q("P = Present, A = Absent, B = Break, CT = Cancelled (Teacher), NA = Not Assigned, - = not a class day")];
  for (const s of sections) {
    lines.push("", q(`${s.centreName}${s.batchLabel ? ` — ${s.batchLabel}` : ""}`));
    lines.push(["Student", "Admission No", "Batch", ...s.dates.map(dayLabel), "Total Classes", "Present", "Absent", "Attendance %"].map(q).join(","));
    for (const r of s.rows) {
      lines.push([r.student.name, r.student.admissionNo, r.batchName, ...r.cells.map(cell),
        r.total, r.present, r.absent, r.pct == null ? "" : `${r.pct}%`].map(q).join(","));
    }
  }
  save(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }), `${fileBase(month)}.csv`);
}

export async function exportMonthlyPdf(month: string, sections: ReportSection[]): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = 297, H = 210, M = 10, ROW = 5.2;
  const nameW = 46, admW = 26, sumW = 11;
  let y = M;

  const title = () => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text(`Monthly Attendance Report — ${monthLabel(month)}`, M, y + 5);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    doc.text("P Present · A Absent · B Break · CT Cancelled (Teacher) · NA Not Assigned · - not a class day", M, y + 10);
    y += 15;
  };
  title();

  for (const s of sections) {
    const dateW = Math.max(4.5, Math.min(9, (W - 2 * M - nameW - admW - 4 * sumW) / Math.max(1, s.dates.length)));
    const header = () => {
      doc.setFillColor(243, 244, 246); doc.rect(M, y, W - 2 * M, ROW, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5);
      let x = M + 1;
      doc.text("Student", x, y + 3.6); x = M + nameW;
      doc.text("Adm. No", x, y + 3.6); x += admW;
      for (const d of s.dates) { doc.text(d.slice(8), x + dateW / 2, y + 3.6, { align: "center" }); x += dateW; }
      for (const h of ["Total", "P", "A", "%"]) { doc.text(h, x + sumW / 2, y + 3.6, { align: "center" }); x += sumW; }
      y += ROW;
    };
    if (y > H - M - 3 * ROW) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text(`${s.centreName}${s.batchLabel ? ` — ${s.batchLabel}` : ""}`, M, y + 4);
    y += 6;
    header();
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
    s.rows.forEach((r, i) => {
      if (y > H - M - ROW) { doc.addPage(); y = M; header(); doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); }
      if (i % 2) { doc.setFillColor(250, 250, 250); doc.rect(M, y, W - 2 * M, ROW, "F"); }
      let x = M + 1;
      doc.setTextColor(17, 24, 39);
      doc.text(doc.splitTextToSize(r.student.name, nameW - 2)[0] ?? "", x, y + 3.6); x = M + nameW;
      doc.text(r.student.admissionNo || "—", x, y + 3.6); x += admW;
      for (const c of r.cells) {
        const t = cell(c);
        if (c === "present") doc.setTextColor(22, 163, 74);
        else if (c === "absent") doc.setTextColor(220, 38, 38);
        else doc.setTextColor(107, 114, 128);
        if (t) doc.text(t, x + dateW / 2, y + 3.6, { align: "center" });
        x += dateW;
      }
      doc.setTextColor(17, 24, 39);
      for (const v of [r.total, r.present, r.absent, r.pct == null ? "—" : `${r.pct}%`]) {
        doc.text(String(v), x + sumW / 2, y + 3.6, { align: "center" }); x += sumW;
      }
      y += ROW;
    });
    y += 6;
  }
  doc.save(`${fileBase(month)}.pdf`);
}
