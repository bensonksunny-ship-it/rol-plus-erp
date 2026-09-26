import jsPDF from "jspdf";
import { screeningSectionLines } from "@/lib/screeningQuestions";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function s(v: unknown): string { return typeof v === "string" ? v : ""; }
function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }

/** Card instrument from an application's chosen instruments (default keyboard). */
export function cardInstrument(instruments: unknown): "keyboard" | "guitar" | "drums" {
  const set = arr(instruments).map(i => i.toLowerCase());
  if (set.some(i => i === "keyboard" || i === "piano")) return "keyboard";
  if (set.includes("guitar")) return "guitar";
  if (set.includes("drums")) return "drums";
  return "keyboard";
}

/**
 * A saved Fast Track screening (School of Music, `screenings` collection) in
 * the shape generateAdmissionCardPDF prints: section marks (5 × /3, or 3 × /5
 * for an older screening) + total, or the v1 H/M/L grades.
 */
export function fastTrackCardScreening(sc: Record<string, unknown>, instrument: string): Record<string, unknown> {
  const ss = sc.screeningScores as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    instrument,
    stream:       "fast-track",
    assessmentId: s(sc.id),
    config:       sc.config,
    ...(ss
      ? { ft_sections: screeningSectionLines(sc), ft_totalScore: num(ss.total) }
      : {
          ft_rhythmGrade:    sc.rhythmSyncGrade,
          ft_dexterityGrade: sc.dexterityGrade,
          ft_pitchGrade:     sc.pitchEchoGrade,
          ft_totalScore:     num(sc.rhythmScore) + num(sc.pitchScore) + num(sc.motorScore),
        }),
  };
}

export function toAdmissionNumber(id: string): string {
  let n = 0;
  for (const ch of id) n = Math.floor((n * 31 + ch.charCodeAt(0)) % 100000000000);
  return n.toString().padStart(11, "0");
}

// ─── Color palette ────────────────────────────────────────────────────────────
const CLR = {
  primary:    [79,  70,  229] as [number, number, number],
  primarySoft:[237, 233, 254] as [number, number, number],
  gray100:    [243, 244, 246] as [number, number, number],
  gray300:    [209, 213, 219] as [number, number, number],
  gray500:    [107, 114, 128] as [number, number, number],
  gray700:    [55,  65,  81 ] as [number, number, number],
  gray900:    [17,  24,  39 ] as [number, number, number],
  green:      [22,  163, 74 ] as [number, number, number],
  amber:      [217, 119, 6  ] as [number, number, number],
  red:        [220, 38,  38 ] as [number, number, number],
  white:      [255, 255, 255] as [number, number, number],
};

// ─── Drawing helpers ──────────────────────────────────────────────────────────
function fill(doc: jsPDF, [r, g, b]: [number, number, number]) { doc.setFillColor(r, g, b); }
function stroke(doc: jsPDF, [r, g, b]: [number, number, number]) { doc.setDrawColor(r, g, b); }
function color(doc: jsPDF, [r, g, b]: [number, number, number]) { doc.setTextColor(r, g, b); }

// ─── Layout grid (mm) ────────────────────────────────────────────────────────
// Every key/value block on the card uses the same grid so labels and values
// line up in straight columns across all sections:
//   | label (LABEL_W) | value (wraps) |  COL_GAP  | label (LABEL_W) | value (wraps) |
// Rows are laid out in pairs (left + right cell share one row), and a row is as
// tall as its tallest wrapped cell, so the two columns never drift apart.
const PAGE_W   = 210;
const MARGIN   = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;          // 182
const COL_GAP  = 8;
const COL_W    = (CONTENT_W - COL_GAP) / 2;     // 87
const COL2_X   = MARGIN + COL_W + COL_GAP;
const LABEL_W  = 33;
const FONT_SZ  = 7.5;
const LINE_H   = 3.6;   // wrapped-line spacing
const ROW_PAD  = 1.9;   // extra space under each row
const SECTION_GAP = 4;  // space above each section header
const FOOTER_Y = 282;
const BOTTOM_LIMIT = FOOTER_Y - 6;

type KV = [label: string, value: string];

/** Empty / whitespace-only → "—", so every row keeps its full height. */
function dash(v: string): string { return v && v.trim() ? v.trim() : "—"; }

// Section header — full content-width band, returns the y to start the rows at.
function sh(doc: jsPDF, label: string, y: number): number {
  y += SECTION_GAP;
  fill(doc, CLR.primarySoft);
  doc.rect(MARGIN, y, CONTENT_W, 7, "F");
  fill(doc, CLR.primary);
  doc.rect(MARGIN, y, 1.2, 7, "F");               // accent strip
  color(doc, CLR.primary);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(FONT_SZ);
  doc.text(label.toUpperCase(), MARGIN + 3.5, y + 4.8);
  return y + 7 + 4.5;                              // first row baseline
}

/** Lines for one label/value cell inside a column of width `w`. */
function cellLines(doc: jsPDF, [label, value]: KV, w: number): { l: string[]; v: string[] } {
  doc.setFontSize(FONT_SZ);
  doc.setFont("helvetica", "bold");
  const l = doc.splitTextToSize(label, LABEL_W - 2) as string[];
  doc.setFont("helvetica", "normal");
  const v = doc.splitTextToSize(dash(value), w - LABEL_W) as string[];
  return { l, v };
}

function drawCell(doc: jsPDF, cell: { l: string[]; v: string[] }, x: number, y: number) {
  doc.setFontSize(FONT_SZ);
  doc.setFont("helvetica", "bold");
  color(doc, CLR.gray500);
  doc.text(cell.l, x, y, { lineHeightFactor: LINE_H / (FONT_SZ * 0.3528) });
  doc.setFont("helvetica", "normal");
  color(doc, CLR.gray900);
  doc.text(cell.v, x + LABEL_W, y, { lineHeightFactor: LINE_H / (FONT_SZ * 0.3528) });
}

const rowHeight = (lines: number) => Math.max(1, lines) * LINE_H + ROW_PAD;

/**
 * Two-column key/value grid. Cells fill left column then right column row by
 * row (left[i] beside right[i]); returns the y after the last row.
 */
function grid2(doc: jsPDF, left: KV[], right: KV[], y: number): number {
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const a = left[i]  ? cellLines(doc, left[i],  COL_W) : null;
    const b = right[i] ? cellLines(doc, right[i], COL_W) : null;
    const lines = Math.max(a ? Math.max(a.l.length, a.v.length) : 0, b ? Math.max(b.l.length, b.v.length) : 0);
    y = ensureSpace(doc, y, rowHeight(lines));
    if (a) drawCell(doc, a, MARGIN, y);
    if (b) drawCell(doc, b, COL2_X, y);
    y += rowHeight(lines);
  }
  return y;
}

/** Single key/value rows spanning width `w` from `x` (used beside the photo and for long values). */
function grid1(doc: jsPDF, rows: KV[], x: number, y: number, w: number): number {
  for (const kv of rows) {
    const c = cellLines(doc, kv, w);
    const lines = Math.max(c.l.length, c.v.length);
    y = ensureSpace(doc, y, rowHeight(lines));
    drawCell(doc, c, x, y);
    y += rowHeight(lines);
  }
  return y;
}

/** Start a new page when the next `h` mm would run into the footer. */
function ensureSpace(doc: jsPDF, y: number, h: number): number {
  if (y + h <= BOTTOM_LIMIT) return y;
  doc.addPage();
  return MARGIN + 6;
}

/** Rounded chip sized to its text; returns the x after it (+ gap). */
function chip(doc: jsPDF, text: string, x: number, y: number, bg: [number, number, number], fg: [number, number, number]): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(FONT_SZ);
  const w = doc.getTextWidth(text) + 5;
  fill(doc, bg);
  doc.roundedRect(x, y, w, 7, 1.5, 1.5, "F");
  color(doc, fg);
  doc.text(text, x + 2.5, y + 4.8);
  return x + w + 3;
}

function hr(doc: jsPDF, y: number) {
  stroke(doc, CLR.gray300);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
}

// ─── Money (Helvetica has no ₹ glyph, so "Rs.") ────────────────────────────────
function rupees(n: number): string {
  return `Rs. ${Math.round(n).toLocaleString("en-IN")}/-`;
}
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? " " + ONES[r % 10] : ""}`;
  return [h ? `${ONES[h]} Hundred` : "", rest].filter(Boolean).join(" ");
}
/** 1500 → "Rupees One Thousand Five Hundred Only" (Indian lakh/crore grouping). */
export function rupeesInWords(amount: number): string {
  let n = Math.round(amount);
  if (n <= 0) return "Rupees Zero Only";
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh  = Math.floor(n / 100000);   n %= 100000;
  const thou  = Math.floor(n / 1000);     n %= 1000;
  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh)  parts.push(`${under1000(lakh)} Lakh`);
  if (thou)  parts.push(`${under1000(thou)} Thousand`);
  if (n)     parts.push(under1000(n));
  return `Rupees ${parts.join(" ")} Only`;
}
const PAY_MODE_LABEL: Record<string, string> = { Cash: "Cash", UPI: "UPI", Card: "Card", Bank: "Bank Transfer" };

// ─── Main generator ───────────────────────────────────────────────────────────
export async function generateAdmissionCardPDF(
  admission: Record<string, unknown>,
  screening: Record<string, unknown> | null
) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = PAGE_W;
  const M = MARGIN;

  const admNo  = s(admission.admissionNumber) || "";
  const isCard = admNo.length > 0;

  // ── HEADER BAND (26 mm) ───────────────────────────────────────────────────
  fill(doc, CLR.primary);
  doc.rect(0, 0, W, 26, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  color(doc, CLR.white);
  doc.text("ROL+ Music Academy", M, 11);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  color(doc, [200, 200, 255]);
  doc.text("River of Life  •  Bangalore", M, 18);

  // Badge
  fill(doc, CLR.white);
  doc.roundedRect(W - 54, 7, 42, 12, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(isCard ? 9 : 7.2);
  color(doc, CLR.primary);
  doc.text(isCard ? "ADMISSION CARD" : "ADMISSION REQUEST FORM", W - 33, 14.5, { align: "center" });

  // ── ADMISSION NUMBER BAND (10 mm) ─────────────────────────────────────────
  fill(doc, CLR.gray100);
  doc.rect(0, 26, W, 10, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  color(doc, CLR.primary);
  doc.text(`Admission No:  ${admNo || "—"}`, M, 32.5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  color(doc, CLR.gray500);
  doc.text(
    new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
    W - M, 32.5, { align: "right" }
  );

  // ── PHOTO + PERSONAL INFO ─────────────────────────────────────────────────
  // Content starts at y = 38 (2 mm gap after bands)
  let y = 38;
  const PHOTO_W = 28, PHOTO_H = 36;

  stroke(doc, CLR.gray300);
  doc.setLineWidth(0.3);
  doc.roundedRect(M, y, PHOTO_W, PHOTO_H, 2, 2, "S");
  const photo = s(admission.photo);
  if (photo && photo.startsWith("data:image")) {
    try { doc.addImage(photo, "JPEG", M, y, PHOTO_W, PHOTO_H); } catch { /* skip */ }
  } else {
    color(doc, CLR.gray300);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text("No Photo", M + PHOTO_W / 2, y + PHOTO_H / 2, { align: "center" });
  }

  const IX = M + PHOTO_W + 7;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  color(doc, CLR.gray900);
  doc.text(s(admission.fullName) || "—", IX, y + 7);

  const ageStr = s(admission.age) ? `${s(admission.age)} yrs` : "";
  const ry = grid1(doc, [
    ["Date of Birth:",     s(admission.dob)],
    ["Age:",               ageStr],
    ["Parent / Guardian:", s(admission.parentName)],
    ["Working Status:",    s(admission.workingStatus)],
  ], IX, y + 14, PAGE_W - MARGIN - IX);

  y = Math.max(y + PHOTO_H, ry - ROW_PAD) + 1;

  // ── CONTACT & LOCATION ────────────────────────────────────────────────────
  y = sh(doc, "Contact & Location", y);
  const addr = [s(admission.address1), s(admission.address2)].filter(Boolean).join(", ");
  y = grid2(doc,
    [["Phone:", s(admission.phone)], ["Email:", s(admission.email)], ["Centre:", s(admission.centre)]],
    [["School / Company:", s(admission.schoolCompany)], ["Address:", addr]],
    y);

  // ── MUSICAL PROFILE ───────────────────────────────────────────────────────
  y = sh(doc, "Musical Profile", ensureSpace(doc, y, 30));
  y = grid2(doc,
    [
      ["Instruments to Learn:", arr(admission.instrumentsToLearn).join(", ")],
      ["Purpose of Learning:",  s(admission.purposeOfLearning)],
      ["Previous Experience:",  s(admission.previousExperience)],
    ],
    [
      ["Instruments Played:",  arr(admission.instrumentsPlayed).join(", ")],
      ["Musical Skill Level:", s(admission.musicalSkill)],
      ["How Heard About Us:",  s(admission.howHeardAboutUs)],
    ],
    y);

  // ── SCREENING RESULTS ─────────────────────────────────────────────────────
  y = sh(doc, "Screening Results", ensureSpace(doc, y, 30));

  if (!screening) {
    fill(doc, [254, 249, 195]);
    doc.roundedRect(M, y - 3.5, CONTENT_W, 9, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    color(doc, [146, 64, 14]);
    doc.text("Screening Pending — not yet conducted", M + 4, y + 2);
    y += 9;
  } else {
    const instrument = s(screening.instrument);
    const stream     = s(screening.stream);
    const assessId   = s(screening.assessmentId);
    const config     = screening.config as Record<string, unknown> | undefined;
    const trackName  = config ? s(config.track) : "";
    const strategy   = config ? s(config.syllabusStrategy) : "";
    const metronome  = config?.metronome ? `Yes @ ${config.metronomeBpm} BPM` : "No";

    const instrLabel  = instrument.charAt(0).toUpperCase() + instrument.slice(1);
    const streamLabel = stream.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const trackColor: [number, number, number] =
      trackName.includes("Zeta") ? CLR.green : trackName.includes("Epsilon") ? CLR.amber : CLR.red;

    // Chips row — each chip sized to its text
    const chipY = y - 4;
    let cx = M;
    if (instrLabel)  cx = chip(doc, instrLabel,  cx, chipY, CLR.primarySoft, CLR.primary);
    if (streamLabel) cx = chip(doc, streamLabel, cx, chipY, CLR.gray100, CLR.gray700);
    if (trackName)   chip(doc, trackName, cx, chipY,
      trackColor.map(c => Math.min(255, c + 210)) as [number, number, number], trackColor);
    y = chipY + 7 + 5;

    const left: KV[] = [
      ["Assessment ID:", assessId],
      ["Slab Assigned:", trackName],
    ];
    const right: KV[] = [["Metronome:", metronome]];
    if (config) {
      if (instrument === "guitar") {
        right.push(["Strum Technique:",  s(config.strumTechnique)], ["Chord Complexity:", s(config.chordComplexity)]);
      }
      if (instrument === "keyboard") {
        right.push(["Hand Integration:", s(config.handIntegration)], ["Chords:", s(config.chords as string) || "None"]);
      }
      if (instrument === "drums") {
        right.push(["Stick Type:", s(config.stickType)], ["Groove Complexity:", s(config.grooveComplexity)]);
      }
    }
    y = grid2(doc, left, right, y);

    // Long values get the full content width so they wrap cleanly.
    const grades: string[] = [];
    // Fast Track 15-mark rubric: pre-formatted section marks ("Rhythm Sync: 4/5").
    const sections = Array.isArray(screening.ft_sections) ? (screening.ft_sections as unknown[]).map(String) : [];
    if (sections.length) grades.push(...sections);
    else if (screening.ft_rhythmGrade) grades.push(`Rhythm: ${screening.ft_rhythmGrade}`);
    if (screening.ft_dexterityGrade) grades.push(`Dexterity: ${screening.ft_dexterityGrade}`);
    if (instrument === "guitar"   && screening.ft_pitchGrade)    grades.push(`Pitch: ${screening.ft_pitchGrade}`);
    if (instrument === "keyboard" && screening.ft_pitchGrade)    grades.push(`Pitch Echo: ${screening.ft_pitchGrade}`);
    if (instrument === "drums"    && screening.ft_rudimentGrade) grades.push(`Rudiments: ${screening.ft_rudimentGrade}`);
    if (typeof screening.ft_totalScore === "number") grades.push(`Total: ${screening.ft_totalScore}/15`);
    const wide: KV[] = [["Strategy:", strategy]];
    if (grades.length > 0) wide.push(["Clinical Scores:", grades.join("   |   ")]);
    y = grid1(doc, wide, M, y, CONTENT_W);
  }

  // ── ADMISSION FEE RECEIPT ─────────────────────────────────────────────────
  const feeAmount = typeof admission.admissionFeeAmount === "number" ? admission.admissionFeeAmount : 0;
  if (admission.admissionFeePaid === true && feeAmount > 0) {
    const BOX_H = 38;
    y = ensureSpace(doc, y + SECTION_GAP, BOX_H + 2);
    const top = y;

    // Dashed receipt border
    stroke(doc, CLR.green);
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([1.5, 1], 0);
    doc.roundedRect(M, top, CONTENT_W, BOX_H, 2, 2, "S");
    doc.setLineDashPattern([], 0);

    // Title strip
    fill(doc, [220, 252, 231]);
    doc.rect(M + 0.4, top + 0.4, CONTENT_W - 0.8, 8, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    color(doc, [21, 128, 61]);
    doc.text("ADMISSION FEE RECEIPT", M + 4, top + 5.7);
    const txId = s(admission.admissionFeeTxId);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    color(doc, CLR.gray700);
    doc.text(`Receipt No: ${txId ? "AF-" + txId.slice(0, 8).toUpperCase() : "—"}`, W - M - 4, top + 5.7, { align: "right" });

    // Details (left) + amount (right)
    const paidOn = s(admission.admissionFeeDate)
      ? new Date(`${s(admission.admissionFeeDate)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
      : "—";
    const rows: KV[] = [
      ["Received from:", dash(s(admission.parentName)) !== "—" ? `${s(admission.parentName)} (for ${s(admission.fullName)})` : s(admission.fullName)],
      ["Towards:",       "Admission Fee - ROL's School of Music"],
      ["Payment mode:",  PAY_MODE_LABEL[s(admission.admissionFeeMethod)] ?? s(admission.admissionFeeMethod)],
      ["Reference:",     s(admission.admissionFeeReference)],
      ["Date paid:",     paidOn],
    ];
    let ry = top + 13;
    for (const kv of rows) {
      const c = cellLines(doc, kv, CONTENT_W * 0.58);
      drawCell(doc, c, M + 4, ry);
      ry += rowHeight(Math.max(c.l.length, c.v.length)) - 0.6;
    }

    // Amount block + PAID stamp
    const AX = M + CONTENT_W * 0.62;
    const AW = W - M - 4 - AX;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    color(doc, CLR.gray500);
    doc.text("AMOUNT PAID", AX, top + 14);
    doc.setFontSize(16);
    color(doc, CLR.gray900);
    doc.text(rupees(feeAmount), AX, top + 21);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(6.8);
    color(doc, CLR.gray700);
    doc.text(doc.splitTextToSize(rupeesInWords(feeAmount), AW) as string[], AX, top + 25.5);
    // Stamp
    stroke(doc, CLR.green);
    doc.setLineWidth(0.6);
    doc.roundedRect(W - M - 28, top + BOX_H - 11, 24, 8, 1.5, 1.5, "S");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    color(doc, CLR.green);
    doc.text("PAID", W - M - 16, top + BOX_H - 5.3, { align: "center" });

    y = top + BOX_H + 2;
  }

  // ── BEFORE THE FIRST CLASS (admission card only) ──────────────────────────
  if (isCard) {
    y = sh(doc, "Before your first class", ensureSpace(doc, y, 18));
    const note = "You will be receiving your text book and note book when the teacher comes for the first class.";
    fill(doc, [255, 251, 235]);
    const lines = doc.splitTextToSize(note, CONTENT_W - 12) as string[];
    const h = lines.length * LINE_H + 4;
    y = ensureSpace(doc, y - 3.5, h + 2);
    doc.roundedRect(M, y, CONTENT_W, h, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    color(doc, CLR.amber);
    doc.text("i", M + 4, y + 4.6);
    doc.setFont("helvetica", "normal");
    color(doc, CLR.gray900);
    doc.text(lines, M + 9, y + 4.6, { lineHeightFactor: LINE_H / (8 * 0.3528) });
    y += h + 2;
  }

  // ── REQUEST FORM EXTRAS ───────────────────────────────────────────────────
  if (!isCard) {
    // Acknowledgement — 6 lines when no screening, 2 lines when screened
    const ackLines = !screening
      ? [
          "The student/guardian confirms all information provided in this form is accurate and complete.",
          "Fees are to be paid as per the schedule communicated by the centre at the time of joining.",
          "Class attendance must be maintained in accordance with ROL's School of Music policy.",
          "The student is expected to practise regularly as guided by the assigned faculty member.",
          "The school reserves the right to modify class schedules, faculty, and course structure.",
          "This form, once submitted with the admission number, serves as the official admission record.",
        ]
      : [
          "The student/guardian confirms all information provided in this form is accurate and complete.",
          "All fee, attendance, and academic policies of ROL's School of Music are duly acknowledged.",
        ];

    y = sh(doc, "Acknowledgement", ensureSpace(doc, y, 20));
    doc.setFont("helvetica", "normal");
    doc.setFontSize(FONT_SZ);
    for (const line of ackLines) {
      const wrapped = doc.splitTextToSize(line, CONTENT_W - 8) as string[];
      y = ensureSpace(doc, y, rowHeight(wrapped.length));
      color(doc, CLR.gray700);
      doc.text("•", M + 2, y);
      doc.text(wrapped, M + 6, y, { lineHeightFactor: LINE_H / (FONT_SZ * 0.3528) });
      y += rowHeight(wrapped.length);
    }
    y += 2;
    hr(doc, y);
    y += 4;
    y = ensureSpace(doc, y, 40);

    // ── SEAL + ADMISSION NUMBER + DIRECTOR (36 mm tall) ───────────────────
    const ROW_H   = 36;
    const SEAL_R  = 15;
    const SEAL_CX = M + SEAL_R;
    const SEAL_CY = y + SEAL_R + 2;      // 2 mm top padding

    // Dashed circle seal
    stroke(doc, CLR.gray300);
    doc.setLineWidth(0.35);
    doc.setLineDashPattern([1.2, 1.2], 0);
    doc.circle(SEAL_CX, SEAL_CY, SEAL_R, "S");
    doc.setLineDashPattern([], 0);
    color(doc, CLR.gray300);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.text("Official Seal",           SEAL_CX, SEAL_CY - 3,   { align: "center" });
    doc.text("ROL's School of Music",   SEAL_CX, SEAL_CY + 3.5, { align: "center" });

    // Right panel layout
    const RX = M + SEAL_R * 2 + 10;
    const RW = W - M - RX;
    const MX = RX + RW / 2;

    // Admission number fill box (top of right panel)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    color(doc, CLR.primary);
    doc.text("Admission No:", RX, y + 8);
    stroke(doc, CLR.gray300);
    doc.setLineWidth(0.3);
    fill(doc, CLR.white);
    doc.roundedRect(RX + 30, y + 2, RW - 30, 9, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    color(doc, CLR.gray300);
    doc.text("(fill manually)", RX + 30 + (RW - 30) / 2, y + 7.8, { align: "center" });

    // Director signature line
    const SIG_Y = y + ROW_H - 14;
    stroke(doc, CLR.gray300);
    doc.setLineWidth(0.3);
    doc.line(RX + 8, SIG_Y, W - M, SIG_Y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    color(doc, CLR.gray700);
    doc.text("Director", MX, SIG_Y + 5, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    color(doc, CLR.gray500);
    doc.text("ROL's School of Music", MX, SIG_Y + 9.5, { align: "center" });

    y += ROW_H;
  }

  // ── FOOTER BAND ──────────────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let pg = 1; pg <= pages; pg++) {
    doc.setPage(pg);
    fill(doc, CLR.primary);
    doc.rect(0, FOOTER_Y, W, 15, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    color(doc, [200, 200, 255]);
    doc.text(
      `ROL+ Music Academy  •  ${isCard ? "Admission Card" : "Admission Request Form"}  •  Computer-generated document.`,
      W / 2, FOOTER_Y + 6, { align: "center" }
    );
    doc.text(
      `Issued: ${new Date().toLocaleDateString("en-IN")}${pages > 1 ? `  •  Page ${pg} of ${pages}` : ""}`,
      W / 2, FOOTER_Y + 11, { align: "center" }
    );
  }

  // ── SAVE ─────────────────────────────────────────────────────────────────
  const name      = s(admission.fullName).replace(/\s+/g, "-") || "Student";
  const fileBase  = isCard ? "Admission-Card" : "Admission-Request-Form";
  const fileSuffix = admNo ? `-${admNo}` : "";
  doc.save(`${fileBase}-${name}${fileSuffix}.pdf`);
}
