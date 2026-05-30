import jsPDF from "jspdf";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function s(v: unknown): string { return typeof v === "string" ? v : ""; }
function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }

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

// Compact section header — 6mm band, returns y after 8mm gap
function sh(doc: jsPDF, label: string, y: number, W: number, M: number): number {
  fill(doc, CLR.primarySoft);
  doc.rect(M, y, W - M * 2, 6, "F");
  color(doc, CLR.primary);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.text(label.toUpperCase(), M + 3, y + 4.2);
  return y + 8;
}

// Compact label+value — 4.5mm line height
function lv(doc: jsPDF, label: string, value: string, x: number, y: number, lw = 36): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  color(doc, CLR.gray500);
  doc.text(label, x, y);
  doc.setFont("helvetica", "normal");
  color(doc, CLR.gray900);
  doc.text(value || "—", x + lw, y);
  return y + 4.5;
}

function hr(doc: jsPDF, y: number, M: number, W: number) {
  stroke(doc, CLR.gray300);
  doc.setLineWidth(0.2);
  doc.line(M, y, W - M, y);
}

// ─── Main generator ───────────────────────────────────────────────────────────
export async function generateAdmissionCardPDF(
  admission: Record<string, unknown>,
  screening: Record<string, unknown> | null
) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210;
  const M = 13;

  const admNo  = s(admission.admissionNumber) || "";
  const isCard = admNo.length > 0;

  // ── HEADER BAND (20mm) ────────────────────────────────────────────────────
  fill(doc, CLR.primary);
  doc.rect(0, 0, W, 20, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  color(doc, CLR.white);
  doc.text("ROL+ Music Academy", M, 9);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  color(doc, [200, 200, 255]);
  doc.text("River of Life  •  Bangalore", M, 15);

  // Badge
  fill(doc, CLR.white);
  doc.roundedRect(W - 53, 5, 41, 11, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(isCard ? 8.5 : 7);
  color(doc, CLR.primary);
  doc.text(isCard ? "ADMISSION CARD" : "ADMISSION REQUEST FORM", W - 32.5, 12, { align: "center" });

  // ── ADMISSION NUMBER BAND (8mm) ───────────────────────────────────────────
  fill(doc, CLR.gray100);
  doc.rect(0, 20, W, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  color(doc, CLR.primary);
  doc.text(`Admission No:  ${admNo || "—"}`, M, 25.2);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  color(doc, CLR.gray500);
  doc.text(
    new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
    W - M, 25.2, { align: "right" }
  );

  // ── PHOTO + PERSONAL INFO ─────────────────────────────────────────────────
  let y = 31;
  const PHOTO_W = 24, PHOTO_H = 30;
  const COL2 = M + (W - M * 2) / 2 + 2;

  stroke(doc, CLR.gray300);
  doc.setLineWidth(0.3);
  doc.roundedRect(M, y, PHOTO_W, PHOTO_H, 2, 2, "S");
  const photo = s(admission.photo);
  if (photo && photo.startsWith("data:image")) {
    try { doc.addImage(photo, "JPEG", M, y, PHOTO_W, PHOTO_H); } catch { /* skip */ }
  } else {
    color(doc, CLR.gray300);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.text("No Photo", M + PHOTO_W / 2, y + PHOTO_H / 2, { align: "center" });
  }

  const IX = M + PHOTO_W + 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  color(doc, CLR.gray900);
  doc.text(s(admission.fullName) || "—", IX, y + 5);

  let ry = y + 10;
  ry = lv(doc, "Date of Birth:",      s(admission.dob)          || "—", IX, ry, 28);
  ry = lv(doc, "Age:",                s(admission.age) ? `${s(admission.age)} yrs` : "—", IX, ry, 28);
  ry = lv(doc, "Parent / Guardian:",  s(admission.parentName)   || "—", IX, ry, 30);
  ry = lv(doc, "Working Status:",     s(admission.workingStatus)|| "—", IX, ry, 30);

  y = Math.max(y + PHOTO_H, ry) + 3;
  hr(doc, y, M, W); y += 3;

  // ── CONTACT & LOCATION (2-col) ────────────────────────────────────────────
  y = sh(doc, "Contact & Location", y, W, M);

  const addr = [s(admission.address1), s(admission.address2)].filter(Boolean).join(", ") || "—";
  let c1y = y;
  c1y = lv(doc, "Phone:",   s(admission.phone)  || "—", M,    c1y, 20);
  c1y = lv(doc, "Email:",   s(admission.email)  || "—", M,    c1y, 20);
  c1y = lv(doc, "Centre:",  s(admission.centre) || "—", M,    c1y, 20);
  let c2y = y;
  c2y = lv(doc, "School / Company:", s(admission.schoolCompany) || "—", COL2, c2y, 34);
  c2y = lv(doc, "Address:",          addr,                               COL2, c2y, 34);

  y = Math.max(c1y, c2y) + 3;
  hr(doc, y, M, W); y += 3;

  // ── MUSICAL PROFILE (2-col) ───────────────────────────────────────────────
  y = sh(doc, "Musical Profile", y, W, M);

  let m1y = y;
  m1y = lv(doc, "Instruments to Learn:", arr(admission.instrumentsToLearn).join(", ") || "—", M, m1y, 38);
  m1y = lv(doc, "Purpose of Learning:",  s(admission.purposeOfLearning)  || "—",              M, m1y, 38);
  m1y = lv(doc, "Previous Experience:",  s(admission.previousExperience) || "—",              M, m1y, 38);
  let m2y = y;
  m2y = lv(doc, "Instruments Played:",  arr(admission.instrumentsPlayed).join(", ") || "—", COL2, m2y, 32);
  m2y = lv(doc, "Musical Skill Level:", s(admission.musicalSkill)   || "—",                 COL2, m2y, 32);
  m2y = lv(doc, "How Heard About Us:",  s(admission.howHeardAboutUs)|| "—",                 COL2, m2y, 32);

  y = Math.max(m1y, m2y) + 3;
  hr(doc, y, M, W); y += 3;

  // ── SCREENING RESULTS ─────────────────────────────────────────────────────
  y = sh(doc, "Screening Results", y, W, M);

  if (!screening) {
    fill(doc, [254, 249, 195]);
    doc.roundedRect(M, y, W - M * 2, 8, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    color(doc, [146, 64, 14]);
    doc.text("Screening Pending — not yet conducted", M + 4, y + 5.5);
    y += 12;
  } else {
    const instrument = s(screening.instrument);
    const stream     = s(screening.stream);
    const assessId   = s(screening.assessmentId);
    const config     = screening.config as Record<string, unknown> | undefined;
    const trackName  = config ? s(config.track) : "—";
    const strategy   = config ? s(config.syllabusStrategy) : "—";
    const metronome  = config?.metronome ? `Yes @ ${config.metronomeBpm} BPM` : "No";

    const instrLabel  = instrument.charAt(0).toUpperCase() + instrument.slice(1);
    const streamLabel = stream.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const trackColor: [number, number, number] =
      trackName.includes("Zeta") ? CLR.green : trackName.includes("Epsilon") ? CLR.amber : CLR.red;

    // Chips row
    fill(doc, CLR.primarySoft);
    doc.roundedRect(M, y, 28, 6.5, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7);
    color(doc, CLR.primary);
    doc.text(instrLabel, M + 2, y + 4.7);

    fill(doc, CLR.gray100);
    doc.roundedRect(M + 31, y, 38, 6.5, 1.5, 1.5, "F");
    color(doc, CLR.gray700);
    doc.text(streamLabel, M + 33, y + 4.7);

    fill(doc, [...trackColor.map(c => Math.min(255, c + 210))] as [number, number, number]);
    doc.roundedRect(M + 72, y, 50, 6.5, 1.5, 1.5, "F");
    color(doc, trackColor);
    doc.text(trackName, M + 74, y + 4.7);
    y += 10;

    // 2-column data
    let s1y = y;
    s1y = lv(doc, "Assessment ID:", assessId,  M, s1y, 30);
    s1y = lv(doc, "Slab Assigned:", trackName, M, s1y, 30);
    s1y = lv(doc, "Strategy:",      strategy,  M, s1y, 30);

    const grades: string[] = [];
    if (screening.ft_rhythmGrade)    grades.push(`Rhythm: ${screening.ft_rhythmGrade}`);
    if (screening.ft_dexterityGrade) grades.push(`Dexterity: ${screening.ft_dexterityGrade}`);
    if (instrument === "guitar"   && screening.ft_pitchGrade)    grades.push(`Pitch: ${screening.ft_pitchGrade}`);
    if (instrument === "keyboard" && screening.ft_pitchGrade)    grades.push(`Pitch Echo: ${screening.ft_pitchGrade}`);
    if (instrument === "drums"    && screening.ft_rudimentGrade) grades.push(`Rudiments: ${screening.ft_rudimentGrade}`);
    if (typeof screening.ft_totalScore === "number") grades.push(`Score: ${screening.ft_totalScore}/15`);
    if (grades.length > 0) s1y = lv(doc, "Clinical Scores:", grades.join("  |  "), M, s1y, 30);

    let s2y = y;
    s2y = lv(doc, "Metronome:", metronome, COL2, s2y, 26);
    if (config) {
      if (instrument === "guitar") {
        s2y = lv(doc, "Strum Technique:",  s(config.strumTechnique),  COL2, s2y, 26);
        s2y = lv(doc, "Chord Complexity:", s(config.chordComplexity), COL2, s2y, 26);
      }
      if (instrument === "keyboard") {
        s2y = lv(doc, "Hand Integration:", s(config.handIntegration),             COL2, s2y, 26);
        s2y = lv(doc, "Chords:",           s(config.chords as string) || "None",  COL2, s2y, 26);
      }
      if (instrument === "drums") {
        s2y = lv(doc, "Stick Type:",        s(config.stickType),        COL2, s2y, 26);
        s2y = lv(doc, "Groove Complexity:", s(config.grooveComplexity), COL2, s2y, 26);
      }
    }

    y = Math.max(s1y, s2y) + 3;
  }

  hr(doc, y, M, W); y += 4;

  // ── ADMISSION REQUEST FORM EXTRAS ─────────────────────────────────────────
  if (!isCard) {
    const SEAL_R  = 15;
    const SEAL_CX = M + SEAL_R;
    const SEAL_CY = y + SEAL_R;

    // Dashed seal circle
    stroke(doc, CLR.gray300);
    doc.setLineWidth(0.35);
    doc.setLineDashPattern([1.2, 1.2], 0);
    doc.circle(SEAL_CX, SEAL_CY, SEAL_R, "S");
    doc.setLineDashPattern([], 0);
    color(doc, CLR.gray300);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(5.5);
    doc.text("Official Seal",           SEAL_CX, SEAL_CY - 3,   { align: "center" });
    doc.text("ROL's School of Music",   SEAL_CX, SEAL_CY + 2.5, { align: "center" });

    // Right panel: admission number box + director signature
    const RX      = M + SEAL_R * 2 + 8;
    const RW      = W - M - RX;
    const MID_RX  = RX + RW / 2;

    // Admission number fill box
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    color(doc, CLR.primary);
    doc.text("Admission No:", RX, y + 6);
    stroke(doc, CLR.gray300);
    doc.setLineWidth(0.3);
    fill(doc, CLR.white);
    doc.roundedRect(RX + 28, y + 1, RW - 28, 8, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    color(doc, CLR.gray300);
    doc.text("(fill manually)", RX + 28 + (RW - 28) / 2, y + 6.5, { align: "center" });

    // Director signature line
    const SIG_LINE_Y = y + SEAL_R * 2 - 5;
    stroke(doc, CLR.gray300);
    doc.setLineWidth(0.3);
    doc.line(RX, SIG_LINE_Y, W - M, SIG_LINE_Y);
    color(doc, CLR.gray700);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text("Director", MID_RX, SIG_LINE_Y + 4.5, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    color(doc, CLR.gray500);
    doc.text("ROL's School of Music", MID_RX, SIG_LINE_Y + 9, { align: "center" });

    y += SEAL_R * 2 + 6;
    hr(doc, y, M, W);
    y += 4;
  }

  // ── FOOTER BAND ──────────────────────────────────────────────────────────
  const FOOT_Y = 282;
  fill(doc, CLR.primary);
  doc.rect(0, FOOT_Y, W, 15, "F");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  color(doc, [200, 200, 255]);
  doc.text(
    `ROL+ Music Academy  •  ${isCard ? "Admission Card" : "Admission Request Form"}  •  Computer-generated document.`,
    W / 2, FOOT_Y + 6, { align: "center" }
  );
  doc.text(`Issued: ${new Date().toLocaleDateString("en-IN")}`, W / 2, FOOT_Y + 11, { align: "center" });

  // ── SAVE ─────────────────────────────────────────────────────────────────
  const name      = s(admission.fullName).replace(/\s+/g, "-") || "Student";
  const fileBase  = isCard ? "Admission-Card" : "Admission-Request-Form";
  const fileSuffix = admNo ? `-${admNo}` : "";
  doc.save(`${fileBase}-${name}${fileSuffix}.pdf`);
}
