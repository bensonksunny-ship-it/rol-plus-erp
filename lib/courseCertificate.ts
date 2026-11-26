// =============================================================================
// Course completion certificate → JPEG download (client-side canvas). Both
// wings. A4 portrait, formal examination-certificate layout: guitar emblem,
// school name, student, "is awarded", course, dates (no centre name), one signature
// ("Founder / Director") over a faint seal, metadata + certificate no., navy footer
// bar. The emblem (public/logos/school-of-music.png) is used for both wings;
// a completion date of "" (date unavailable) leaves that line out.
// =============================================================================

import { WING_LABELS } from "@/config/constants";
import { findCourse, normalizeCourse } from "@/lib/course";

export interface CertificateData {
  studentName: string;
  course: string;
  /** YYYY-MM-DD, or "" when the date is unavailable. */
  completedOn: string;
  admissionNo?: string;
  /** Centre name, when known. */
  centre?: string;   // kept for callers; not printed (user: school name only)
  /** Certificate number entered by staff (required to download; saved per course). */
  certificateNo?: string;
  /** "rol_plus" | "school_of_music" */
  wing: string;
}

const LOGO_SRC = "/logos/school-of-music.png";
const W = 1654, H = 2339;   // A4 portrait at 200 dpi
const NAVY = "#0B1942", NAVY_BAR = "#08143B", SLATE = "#1E293B", GOLD = "#C9A227", MUTED = "#4B5563", PAPER = "#FAF9F5";
const SERIF = `Georgia, "Times New Roman", serif`;
const SANS  = `"Segoe UI", "Helvetica Neue", Arial, sans-serif`;

const blank = (v?: string) => !v || v === "-" || v === "—" || /^unassigned/i.test(v.trim());

function fmtLongDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
function fmtYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? "" : fmtLongDate(d);
}

/** Sets a font of `size`, shrunk until `text` fits `maxW`. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, style: string, family = SANS, min = 24) {
  let s = size;
  ctx.font = `${style} ${s}px ${family}`;
  while (s > min && ctx.measureText(text).width > maxW) { s -= 2; ctx.font = `${style} ${s}px ${family}`; }
}

// ── Emblem ───────────────────────────────────────────────────────────────────
// The logo file has a white background: knock the white out and crop to the
// emblem so it sits on the cream paper and works as a watermark.
let logoCache: Promise<HTMLCanvasElement | null> | null = null;
function loadLogo(): Promise<HTMLCanvasElement | null> {
  logoCache ??= new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext("2d", { willReadFrequently: true });
        if (!x) return resolve(null);
        x.drawImage(img, 0, 0);
        const data = x.getImageData(0, 0, c.width, c.height);
        const px = data.data;
        let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
        for (let i = 0; i < px.length; i += 4) {
          const lo = Math.min(px[i], px[i + 1], px[i + 2]);
          // Near-white → transparent, with a soft edge for anti-aliasing.
          const a = lo >= 245 ? 0 : lo >= 215 ? Math.round(((245 - lo) / 30) * px[i + 3]) : px[i + 3];
          px[i + 3] = a;
          if (a > 20) {
            const p = i / 4, xx = p % c.width, yy = (p - xx) / c.width;
            if (xx < minX) minX = xx;
            if (xx > maxX) maxX = xx;
            if (yy < minY) minY = yy;
            if (yy > maxY) maxY = yy;
          }
        }
        x.putImageData(data, 0, 0);
        if (maxX <= minX || maxY <= minY) return resolve(c);
        const out = document.createElement("canvas");
        out.width = maxX - minX + 1; out.height = maxY - minY + 1;
        out.getContext("2d")?.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
        resolve(out);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = LOGO_SRC;
  });
  return logoCache;
}

function drawLogo(ctx: CanvasRenderingContext2D, logo: HTMLCanvasElement, cx: number, top: number, height: number, alpha = 1) {
  const w = (logo.width / logo.height) * height;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.drawImage(logo, cx - w / 2, top, w, height);
  ctx.restore();
}

/** The emblem's silhouette in one colour — for the watermark. */
function tinted(logo: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = logo.width; c.height = logo.height;
  const x = c.getContext("2d");
  if (!x) return logo;
  x.drawImage(logo, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Faint embossed seal behind the signature. */
function seal(ctx: CanvasRenderingContext2D, cx: number, cy: number, school: string) {
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = GOLD; ctx.fillStyle = GOLD;
  ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(cx, cy, 150, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 132, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 92, 0, Math.PI * 2); ctx.stroke();
  const label = `${school.toUpperCase()} • COURSE COMPLETION • `;
  ctx.font = `bold 21px ${SERIF}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const step = (Math.PI * 2) / label.length;
  for (let i = 0; i < label.length; i++) {
    const a = -Math.PI / 2 + i * step;
    ctx.save();
    ctx.translate(cx + 112 * Math.cos(a), cy + 112 * Math.sin(a));
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(label[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Draws the certificate on a new canvas. */
export async function drawCertificate(d: CertificateData): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  const logo = await loadLogo();

  const school = WING_LABELS[d.wing] ?? WING_LABELS.rol_plus;
  const listed = findCourse(d.course);
  const course = listed?.label ?? (normalizeCourse(d.course) || d.course);
  const completed = d.completedOn ? fmtYmd(d.completedOn) : "";
  const issued = new Date();
  const admNo = blank(d.admissionNo) ? "" : d.admissionNo!.trim();
  const name = d.studentName.trim() || "Student";
  const cx = W / 2;

  // Paper with a fine linen texture
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.strokeStyle = "#8a7f62"; ctx.lineWidth = 1;
  ctx.globalAlpha = 0.035;
  for (let y = 0; y < H; y += 4) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  ctx.globalAlpha = 0.02;
  for (let x = 0; x < W; x += 5) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
  ctx.restore();

  // Watermark: large faint emblem behind the body text
  if (logo) drawLogo(ctx, tinted(logo, GOLD), cx, 640, 1100, 0.08);

  // Frame: thin dark border + gold hairline
  ctx.strokeStyle = SLATE; ctx.lineWidth = 4; ctx.strokeRect(56, 56, W - 112, H - 112);
  ctx.strokeStyle = GOLD;  ctx.lineWidth = 1.5; ctx.strokeRect(72, 72, W - 144, H - 144);

  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";

  // Emblem + school name
  if (logo) drawLogo(ctx, logo, cx, 150, 200);
  ctx.fillStyle = NAVY; fit(ctx, school, 1300, 76, "600", SERIF);
  ctx.fillText(school, cx, 470);

  // Student
  ctx.fillStyle = NAVY; fit(ctx, name, 1300, 82, "bold", SANS, 40);
  ctx.fillText(name, cx, 680);
  const sub = `student of ${school}`;
  ctx.fillStyle = MUTED; fit(ctx, sub, 1300, 36, "", SANS, 22);
  ctx.fillText(sub, cx, 745);

  ctx.fillStyle = SLATE; ctx.font = `500 40px ${SANS}`;
  ctx.fillText("is awarded", cx, 880);

  // Course: level line + instrument line (e.g. "Introduction to" / "Keyboard")
  const courseLines = listed
    ? [listed.level === "Introduction" ? "Introduction to" : listed.level, listed.instrument]
    : [course];
  ctx.fillStyle = NAVY;
  courseLines.forEach((line, i) => {
    fit(ctx, line, 1300, 76, "bold", SANS, 36);
    ctx.fillText(line, cx, 1020 + i * 92);
  });
  const afterCourse = 1020 + (courseLines.length - 1) * 92;

  ctx.fillStyle = SLATE; ctx.font = `500 40px ${SANS}`;
  ["Certificate of Course Completion", "in Contemporary & Graded Music"]
    .forEach((line, i) => ctx.fillText(line, cx, afterCourse + 110 + i * 54));

  // Dates
  const meta = [
    completed ? `Date of Completion: ${completed}` : "",
    `Certificate Issued: ${fmtLongDate(issued)}`,
  ].filter(Boolean);
  ctx.fillStyle = SLATE; ctx.font = `30px ${SANS}`;
  meta.forEach((line, i) => ctx.fillText(line, cx, 1500 + i * 44));

  // One signature over a faint seal
  const sigY = 1800;
  seal(ctx, cx, sigY - 40, school);
  ctx.strokeStyle = SLATE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - 260, sigY); ctx.lineTo(cx + 260, sigY); ctx.stroke();
  ctx.fillStyle = NAVY; ctx.font = `bold 32px ${SANS}`;
  ctx.fillText("Founder / Director", cx, sigY + 48);
  ctx.fillStyle = MUTED; ctx.font = `28px ${SANS}`;
  ctx.fillText(school, cx, sigY + 88);

  // Bottom-left metadata
  const left = [
    admNo ? `Admission No.: ${admNo}` : "",
    listed ? `Course Level: ${listed.level} · ${listed.instrument}` : `Course: ${course}`,
    "Certificate Issue No.: 1",
  ].filter(Boolean);
  ctx.textAlign = "left"; ctx.fillStyle = SLATE; ctx.font = `24px ${SANS}`;
  left.forEach((line, i) => ctx.fillText(line, 130, 2000 + i * 36));

  // Bottom-right: the certificate number typed by staff when downloading.
  const serial = (d.certificateNo ?? "").trim();
  if (serial) {
    ctx.font = `bold 26px ${SANS}`;
    const sw = ctx.measureText(serial).width + 48, sx = W - 130 - sw, sy = 1990;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(sx, sy, sw, 92);
    ctx.strokeStyle = SLATE; ctx.lineWidth = 2; ctx.strokeRect(sx, sy, sw, 92);
    ctx.textAlign = "center";
    ctx.fillStyle = MUTED; ctx.font = `18px ${SANS}`;
    ctx.fillText("CERTIFICATE NO.", sx + sw / 2, sy + 32);
    ctx.fillStyle = NAVY; ctx.font = `bold 26px ${SANS}`;
    ctx.fillText(serial, sx + sw / 2, sy + 70);
  }

  // Navy footer bar with the wordmark
  const barY = H - 72 - 120;
  ctx.fillStyle = NAVY_BAR; ctx.fillRect(72, barY, W - 144, 120);
  let tx = 120;
  if (logo) {
    const lh = 76, lw = (logo.width / logo.height) * lh;
    ctx.drawImage(logo, tx, barY + 22, lw, lh);
    tx += lw + 22;
  }
  ctx.textAlign = "left";
  const [first, ...rest] = school.split(" ");
  ctx.fillStyle = "#ffffff"; ctx.font = `bold 40px ${SANS}`;
  ctx.fillText(first.toUpperCase(), tx, barY + 62);
  ctx.fillStyle = GOLD; ctx.font = `600 22px ${SANS}`;
  ctx.fillText(rest.join(" ").toUpperCase(), tx + 2, barY + 94);

  return canvas;
}

/** Draws the certificate and downloads it as a JPEG. */
export async function downloadCertificateJPEG(d: CertificateData): Promise<void> {
  const canvas = await drawCertificate(d);
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/jpeg", 0.95));
  if (!blob) throw new Error("Could not create the certificate image.");
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").trim().replace(/\s+/g, "_");
  const course = findCourse(d.course)?.label ?? (normalizeCourse(d.course) || d.course);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safe(d.studentName) || "Student"}_${safe(course)}_Certificate.jpg`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
