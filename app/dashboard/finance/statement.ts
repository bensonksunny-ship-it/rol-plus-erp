// Monthly Financial Statement — a single A4 page built from the data already on
// the Finance page, so the PDF always agrees with the screen (same wing, month
// and centre filter). The page budget is enforced in code: see fitRows.

import type { Transaction } from "@/types/finance";
import { chargedAmountOf } from "@/lib/feeWaiver";

export interface StatementStudent {
  uid:        string;
  name:       string;
  centreKey:  string;
  centreName: string;
  classType:  string;   // "group" | "personal"
  active:     boolean;
}

export interface StatementRow {
  student:   string;
  centre:    string;
  classType: string;
  billed:    number;
  collected: number;
}

export interface StatementInput {
  brand:      string;
  month:      string;   // "YYYY-MM"
  monthLabel: string;
  scopeName:  string;
  kpis: {
    revenue:       number;
    activeCount:   number;
    overdueAmount: number;
    overdueCount:  number;
  };
  rows: StatementRow[];
}

/** Money actually received: the Finance "collected" total, admission fees included. */
export function isReceivedPayment(t: Transaction): boolean {
  return t.status === "completed"
    && t.type   !== "fee_due"  && t.type   !== "charge"
    && t.method !== "auto"     && t.method !== "auto-monthly";
}

/** A ledger charge — same definition as transactionBalanceEffect. */
function isBilled(t: Transaction): boolean {
  return t.type === "fee_due" || t.type === "charge" || t.method === "auto" || t.method === "auto-monthly";
}

const CLASS_ORDER = ["Group", "Personal", "Other"];
const byCentre = (a: StatementRow, b: StatementRow) =>
  a.centre.localeCompare(b.centre)
  || CLASS_ORDER.indexOf(a.classType) - CLASS_ORDER.indexOf(b.classType)
  || a.student.localeCompare(b.student);

/** Label for money that has no roster student to name. */
const NOT_ON_ROSTER = "Not on roster";

/**
 * One row per student: everyone active, plus anyone else billed or paying this
 * month. Money from people no longer on the roster (or an admission fee not yet
 * linked to a student) has no name, so it goes in one "Other" row per centre.
 * That keeps the table total equal to the Total Revenue KPI.
 */
export function buildStudentRows(
  month: string,
  students: StatementStudent[],
  transactions: Transaction[],
  centreName: (centerId: string) => string,
): StatementRow[] {
  const roster = new Map(students.map(s => [s.uid, s]));
  const rows   = new Map<string, StatementRow>();
  const rowForStudent = (s: StatementStudent) => {
    let r = rows.get(s.uid);
    if (!r) {
      r = { student: s.name, centre: s.centreName, classType: s.classType === "personal" ? "Personal" : "Group", billed: 0, collected: 0 };
      rows.set(s.uid, r);
    }
    return r;
  };
  const rowForTx = (t: Transaction) => {
    const s = roster.get(t.studentUid);
    if (s) return rowForStudent(s);
    const k = `other|${t.centerId ?? ""}`;
    let r = rows.get(k);
    if (!r) {
      r = { student: NOT_ON_ROSTER, centre: centreName(t.centerId ?? ""), classType: "Other", billed: 0, collected: 0 };
      rows.set(k, r);
    }
    return r;
  };

  for (const s of students) {
    if (s.active) rowForStudent(s);
  }
  for (const t of transactions) {
    const amount = t.type === "fee_due" ? chargedAmountOf(t) : t.amount ?? 0;
    if (isBilled(t)) {
      if ((t.billingMonth || (t.date ?? "").slice(0, 7)) === month) rowForTx(t).billed += amount;
    } else if (isReceivedPayment(t) && (t.date ?? "").startsWith(month)) {
      rowForTx(t).collected += amount;
    }
  }
  return Array.from(rows.values()).sort(byCentre);
}

/**
 * Holds the table to `capacity` lines so the page never overflows. Personal
 * students are named first, then the largest amounts; the rest fold into one
 * line, which keeps the totals exact.
 */
export function fitRows(rows: StatementRow[], capacity: number): StatementRow[] {
  if (rows.length <= capacity) return rows;
  const personal = (r: StatementRow) => (r.classType === "Personal" ? 0 : 1);
  const ranked = [...rows].sort((a, b) =>
    personal(a) - personal(b) || b.billed + b.collected - a.billed - a.collected || a.student.localeCompare(b.student));
  const rest = ranked.slice(capacity - 1);
  return [
    ...ranked.slice(0, capacity - 1).sort(byCentre),
    {
      student:   `${rest.length} more not listed`,
      centre:    "-",
      classType: "-",
      billed:    rest.reduce((n, r) => n + r.billed, 0),
      collected: rest.reduce((n, r) => n + r.collected, 0),
    },
  ];
}

// The built-in PDF fonts have no rupee glyph, so amounts print as "Rs."
const rupees = (n: number) => `Rs. ${Math.round(n).toLocaleString("en-IN")}`;

type RGB = [number, number, number];
const INK: RGB = [17, 24, 39], MUTED: RGB = [107, 114, 128], LINE: RGB = [229, 231, 235];
const PRIMARY: RGB = [79, 70, 229], SOFT: RGB = [243, 244, 246], GREEN: RGB = [5, 150, 105], AMBER: RGB = [180, 83, 9];

// Page budget, in mm. M is the 20px container padding.
const W = 210, H = 297, M = 7;
const TABLE_TOP = 54, TABLE_BOTTOM = 276;   // header + KPIs above, notes + footer below
const HEAD_ROW = 7, TOTAL_ROW = 7;
const ROW_ROOMY = 7, ROW_TIGHT = 5.6;       // 10pt and 9pt body rows
const BODY_SPACE = TABLE_BOTTOM - TABLE_TOP - HEAD_ROW - TOTAL_ROW;

export async function exportFinanceStatementPdf(input: StatementInput): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const { kpis } = input;
  const ink   = (c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
  const font  = (style: "normal" | "bold", size: number) => { doc.setFont("helvetica", style); doc.setFontSize(size); };
  const clip  = (text: string, width: number) => {
    if (doc.getTextWidth(text) <= width) return text;
    let t = text;
    while (t && doc.getTextWidth(`${t}...`) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
  };

  // ── Header ─────────────────────────────────────────────────────────────────
  ink(INK); font("bold", 14);
  doc.text(clip(`${input.brand} - Monthly Financial Statement`, 140), M, M + 5);
  ink(MUTED); font("normal", 9);
  doc.text(clip(input.scopeName, 140), M, M + 10.5);

  font("bold", 9);
  const tagW = doc.getTextWidth(input.monthLabel) + 6;
  doc.setFillColor(PRIMARY[0], PRIMARY[1], PRIMARY[2]);
  doc.roundedRect(W - M - tagW, M, tagW, 6, 1.5, 1.5, "F");
  ink([255, 255, 255]);
  doc.text(input.monthLabel, W - M - tagW / 2, M + 4.2, { align: "center" });
  const stamp = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  ink(MUTED); font("normal", 8);
  doc.text(`Generated ${stamp}`, W - M, M + 10.5, { align: "right" });

  doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
  doc.setLineWidth(0.3);
  doc.line(M, M + 14, W - M, M + 14);

  // ── KPI grid ───────────────────────────────────────────────────────────────
  const cards: { label: string; value: string; hint: string; color: RGB }[] = [
    { label: "Total Revenue Received", value: rupees(kpis.revenue),       hint: input.monthLabel, color: GREEN },
    { label: "Active Enrollments",     value: String(kpis.activeCount),   hint: "students on roster", color: PRIMARY },
    { label: "Overdue Balance",        value: rupees(kpis.overdueAmount), hint: `${kpis.overdueCount} student${kpis.overdueCount === 1 ? "" : "s"} with dues`, color: AMBER },
  ];
  const GAP = 3, cardW = (W - 2 * M - GAP * (cards.length - 1)) / cards.length, cardY = M + 18, cardH = 20;
  cards.forEach((c, i) => {
    const x = M + i * (cardW + GAP);
    doc.setFillColor(SOFT[0], SOFT[1], SOFT[2]);
    doc.roundedRect(x, cardY, cardW, cardH, 1.5, 1.5, "F");
    ink(MUTED); font("bold", 8);
    doc.text(clip(c.label, cardW - 5), x + 2.5, cardY + 5);
    ink(c.color); font("bold", 14);
    while (doc.getFontSize() > 9 && doc.getTextWidth(c.value) > cardW - 5) doc.setFontSize(doc.getFontSize() - 0.5);
    doc.text(c.value, x + 2.5, cardY + 12);
    ink(MUTED); font("normal", 8);
    doc.text(clip(c.hint, cardW - 5), x + 2.5, cardY + 17);
  });

  // ── Student breakdown table ─────────────────────────────────────────────────
  ink(INK); font("bold", 10);
  doc.text("Student Breakdown", M, TABLE_TOP - 2);

  const roomy = input.rows.length * ROW_ROOMY <= BODY_SPACE;
  const rowH  = roomy ? ROW_ROOMY : ROW_TIGHT;
  const size  = roomy ? 10 : 9;
  const rows  = fitRows(input.rows, Math.floor(BODY_SPACE / rowH));
  if (rows.length < input.rows.length) {
    ink(MUTED); font("normal", 8);
    doc.text(`Showing ${rows.length - 1} of ${input.rows.length}. Pick one centre for a fuller list.`, W - M, TABLE_TOP - 2, { align: "right" });
  }

  const R = W - M;   // right edge
  const cols = { student: M + 2, centre: 70, type: 128, billed: 172, collected: R - 2 };
  const line = (y: number, h: number, cells: { student: string; centre: string; type: string; billed: string; collected: string }) => {
    const base = y + h / 2 + size * 0.125;
    doc.text(clip(cells.student, cols.centre - cols.student - 3), cols.student, base);
    doc.text(clip(cells.centre, cols.type - cols.centre - 3), cols.centre, base);
    doc.text(cells.type, cols.type, base);
    doc.text(cells.billed, cols.billed, base, { align: "right" });
    doc.text(cells.collected, cols.collected, base, { align: "right" });
  };

  let y = TABLE_TOP;
  doc.setFillColor(PRIMARY[0], PRIMARY[1], PRIMARY[2]);
  doc.rect(M, y, W - 2 * M, HEAD_ROW, "F");
  ink([255, 255, 255]); font("bold", 9);
  line(y, HEAD_ROW, { student: "Student Name", centre: "Center Name", type: "Class Type", billed: "Total Billed", collected: "Total Collected" });
  y += HEAD_ROW;

  ink(INK); font("normal", size);
  rows.forEach((r, i) => {
    if (i % 2) { doc.setFillColor(249, 250, 251); doc.rect(M, y, W - 2 * M, rowH, "F"); }
    line(y, rowH, { student: r.student, centre: r.centre, type: r.classType, billed: rupees(r.billed), collected: rupees(r.collected) });
    y += rowH;
  });
  if (!rows.length) {
    ink(MUTED);
    doc.text("No enrolments or transactions for this month.", W / 2, y + rowH / 2 + 1, { align: "center" });
    y += rowH;
  }

  doc.setFillColor(SOFT[0], SOFT[1], SOFT[2]);
  doc.rect(M, y, W - 2 * M, TOTAL_ROW, "F");
  ink(INK); font("bold", size);
  line(y, TOTAL_ROW, {
    student: "Total", centre: "", type: "",
    billed:    rupees(input.rows.reduce((n, r) => n + r.billed, 0)),
    collected: rupees(input.rows.reduce((n, r) => n + r.collected, 0)),
  });

  // ── Notes + footer ─────────────────────────────────────────────────────────
  ink(MUTED); font("normal", 8);
  const notes = ["Collected is money received in the month, including advance payments and admission fees. Overdue is each student's unpaid balance to date."];
  if (input.rows.some(r => r.classType === "Other")) {
    notes.push("Other: payments from students no longer on the roster, and admission fees not yet linked to a student.");
  }
  notes.forEach((n, i) => doc.text(clip(n, W - 2 * M), M, TABLE_BOTTOM + 4 + i * 3.6));
  doc.line(M, H - M - 5, W - M, H - M - 5);
  doc.text(`${input.brand} ERP`, M, H - M - 1);
  doc.text("Page 1 of 1", W - M, H - M - 1, { align: "right" });

  const slug = input.scopeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  doc.save(`financial_statement_${input.month}_${slug || "centre"}.pdf`);
}
