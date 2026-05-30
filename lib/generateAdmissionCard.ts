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

// Section header — 8 mm band, returns y + 9
function sh(doc: jsPDF, label: string, y: number, W: number, M: number): number {
  fill(doc, CLR.primarySoft);
  doc.rect(M, y, W - M * 2, 8, "F");
  color(doc, CLR.primary);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.text(label.toUpperCase(), M + 3, y + 5.5);
  return y + 9;
}

// Label + value row — 5.5 mm line height
function lv(doc: jsPDF, label: string, value: string, x: number, y: number, lw = 38): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  color(doc, CLR.gray500);
  doc.text(label, x, y);
  doc.setFont("helvetica", "normal");
  color(doc, CLR.gray900);
  doc.text(value || "—", x + lw, y);
  return y + 5.5;
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
  const M = 14;
  const GAP = 5;          // standard gap after hr
  const COL2 = M + (W - M * 2) / 2 + 2;

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

  let ry = y + 14;
  ry = lv(doc, "Date of Birth:",     s(admission.dob)         || "—", IX, ry, 32);
  ry = lv(doc, "Age:",               s(admission.age) ? `${s(admission.age)} yrs` : "—", IX, ry, 32);
  ry = lv(doc, "Parent / Guardian:", s(admission.parentName)  || "—", IX, ry, 32);
  ry = lv(doc, "Working Status:",    s(admission.workingStatus)|| "—", IX, ry, 32);

  y = Math.max(y + PHOTO_H, ry) + GAP;
  hr(doc, y, M, W);
  y += GAP;

  // ── CONTACT & LOCATION (2-col) ────────────────────────────────────────────
  y = sh(doc, "Contact & Location", y, W, M);
  const addr = [s(admission.address1), s(admission.address2)].filter(Boolean).join(", ") || "—";
  let c1y = y;
  c1y = lv(doc, "Phone:",   s(admission.phone)  || "—", M,    c1y, 22);
  c1y = lv(doc, "Email:",   s(admission.email)  || "—", M,    c1y, 22);
  c1y = lv(doc, "Centre:",  s(admission.centre) || "—", M,    c1y, 22);
  let c2y = y;
  c2y = lv(doc, "School / Company:", s(admission.schoolCompany) || "—", COL2, c2y, 34);
  c2y = lv(doc, "Address:",          addr,                               COL2, c2y, 34);

  y = Math.max(c1y, c2y) + GAP;
  hr(doc, y, M, W);
  y += GAP;

  // ── MUSICAL PROFILE (2-col) ───────────────────────────────────────────────
  y = sh(doc, "Musical Profile", y, W, M);
  let m1y = y;
  m1y = lv(doc, "Instruments to Learn:", arr(admission.instrumentsToLearn).join(", ") || "—", M, m1y, 40);
  m1y = lv(doc, "Purpose of Learning:",  s(admission.purposeOfLearning)  || "—",              M, m1y, 40);
  m1y = lv(doc, "Previous Experience:",  s(admission.previousExperience) || "—",              M, m1y, 40);
  let m2y = y;
  m2y = lv(doc, "Instruments Played:",  arr(admission.instrumentsPlayed).join(", ") || "—", COL2, m2y, 34);
  m2y = lv(doc, "Musical Skill Level:", s(admission.musicalSkill)   || "—",                 COL2, m2y, 34);
  m2y = lv(doc, "How Heard About Us:",  s(admission.howHeardAboutUs)|| "—",                 COL2, m2y, 34);

  y = Math.max(m1y, m2y) + GAP;
  hr(doc, y, M, W);
  y += GAP;

  // ── SCREENING RESULTS ─────────────────────────────────────────────────────
  y = sh(doc, "Screening Results", y, W, M);

  if (!screening) {
    fill(doc, [254, 249, 195]);
    doc.roundedRect(M, y, W - M * 2, 10, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    color(doc, [146, 64, 14]);
    doc.text("Screening Pending — not yet conducted", M + 4, y + 7);
    y += 15;
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
    doc.roundedRect(M, y, 30, 7, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.5);
    color(doc, CLR.primary);
    doc.text(instrLabel, M + 2, y + 5);

    fill(doc, CLR.gray100);
    doc.roundedRect(M + 33, y, 40, 7, 1.5, 1.5, "F");
    color(doc, CLR.gray700);
    doc.text(streamLabel, M + 35, y + 5);

    fill(doc, [...trackColor.map(c => Math.min(255, c + 210))] as [number, number, number]);
    doc.roundedRect(M + 76, y, 50, 7, 1.5, 1.5, "F");
    color(doc, trackColor);
    doc.text(trackName, M + 78, y + 5);
    y += 11;

    // 2-col data
    let s1y = y;
    s1y = lv(doc, "Assessment ID:", assessId,  M, s1y, 32);
    s1y = lv(doc, "Slab Assigned:", trackName, M, s1y, 32);
    s1y = lv(doc, "Strategy:",      strategy,  M, s1y, 32);

    const grades: string[] = [];
    if (screening.ft_rhythmGrade)    grades.push(`Rhythm: ${screening.ft_rhythmGrade}`);
    if (screening.ft_dexterityGrade) grades.push(`Dexterity: ${screening.ft_dexterityGrade}`);
    if (instrument === "guitar"   && screening.ft_pitchGrade)    grades.push(`Pitch: ${screening.ft_pitchGrade}`);
    if (instrument === "keyboard" && screening.ft_pitchGrade)    grades.push(`Pitch Echo: ${screening.ft_pitchGrade}`);
    if (instrument === "drums"    && screening.ft_rudimentGrade) grades.push(`Rudiments: ${screening.ft_rudimentGrade}`);
    if (typeof screening.ft_totalScore === "number") grades.push(`Score: ${screening.ft_totalScore}/15`);
    if (grades.length > 0) s1y = lv(doc, "Clinical Scores:", grades.join("  |  "), M, s1y, 32);

    let s2y = y;
    s2y = lv(doc, "Metronome:", metronome, COL2, s2y, 34);
    if (config) {
      if (instrument === "guitar") {
        s2y = lv(doc, "Strum Technique:",  s(config.strumTechnique),  COL2, s2y, 34);
        s2y = lv(doc, "Chord Complexity:", s(config.chordComplexity), COL2, s2y, 34);
      }
      if (instrument === "keyboard") {
        s2y = lv(doc, "Hand Integration:", s(config.handIntegration),            COL2, s2y, 34);
        s2y = lv(doc, "Chords:",           s(config.chords as string) || "None", COL2, s2y, 34);
      }
      if (instrument === "drums") {
        s2y = lv(doc, "Stick Type:",        s(config.stickType),        COL2, s2y, 34);
        s2y = lv(doc, "Groove Complexity:", s(config.grooveComplexity), COL2, s2y, 34);
      }
    }

    y = Math.max(s1y, s2y) + GAP;
  }

  hr(doc, y, M, W);
  y += GAP;

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

    y = sh(doc, "Acknowledgement", y, W, M);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    color(doc, CLR.gray700);
    for (const line of ackLines) {
      doc.text(`•  ${line}`, M + 2, y, { maxWidth: W - M * 2 - 4 });
      y += 5.5;
    }
    y += GAP;
    hr(doc, y, M, W);
    y += GAP;

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
    hr(doc, y, M, W);
    y += GAP;
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
