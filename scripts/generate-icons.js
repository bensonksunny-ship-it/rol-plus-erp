#!/usr/bin/env node
/**
 * generate-icons.js — creates PWA PNG icons using only Node.js built-ins.
 * Run once: node scripts/generate-icons.js
 *
 * Generates:
 *   public/icons/icon-192.png           (192×192, rounded rect, transparent bg outside)
 *   public/icons/icon-512.png           (512×512)
 *   public/icons/icon-maskable-192.png  (192×192, full bleed — no transparency)
 *   public/icons/icon-maskable-512.png  (512×512, full bleed)
 *   public/icons/apple-touch-icon.png   (180×180, full bleed for iOS)
 */

const zlib = require("zlib");
const fs   = require("fs");
const path = require("path");

// ── Brand colours ─────────────────────────────────────────────────────────────
const BG  = [15, 23, 42];    // #0f172a  dark navy
const ACC = [245, 158, 11];  // #f59e0b  amber
const MID = [30, 41, 59];    // #1e293b  mid tone

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const tb  = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crcIn = Buffer.concat([tb, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcIn), 0);
  return Buffer.concat([len, tb, data, crcBuf]);
}

// ── PNG builder ───────────────────────────────────────────────────────────────

/**
 * @param {number}   size       — square pixel dimensions
 * @param {boolean}  maskable   — if true, full bleed (no transparency outside)
 * @param {number[]} bg         — [r,g,b] background
 * @param {number[]} accent     — [r,g,b] accent (cross symbol)
 */
function makePNG(size, maskable, bg, accent) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR — RGBA
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const cornerR = size * 0.22; // rounded-corner radius for non-maskable

  // Cross proportions
  const crossW  = Math.round(size * 0.085); // bar thickness
  const crossCX = Math.round(size * 0.5);
  const crossCY = Math.round(size * 0.48);
  const crossV   = Math.round(size * 0.52); // vertical arm half-length
  const crossH   = Math.round(size * 0.33); // horizontal arm half-length
  const crossTop = Math.round(size * 0.18); // top of vertical bar

  const raw = Buffer.allocUnsafe(size * (1 + size * 4));
  let off = 0;

  for (let y = 0; y < size; y++) {
    raw[off++] = 0; // no filter
    for (let x = 0; x < size; x++) {
      let inShape;

      if (maskable) {
        inShape = true;
      } else {
        // Rounded rectangle
        const rx = Math.min(x, size - 1 - x);
        const ry = Math.min(y, size - 1 - y);
        if (rx >= cornerR || ry >= cornerR) {
          inShape = true;
        } else {
          inShape =
            Math.hypot(x - cornerR, y - cornerR) <= cornerR ||
            Math.hypot(x - (size - cornerR), y - cornerR) <= cornerR ||
            Math.hypot(x - cornerR, y - (size - cornerR)) <= cornerR ||
            Math.hypot(x - (size - cornerR), y - (size - cornerR)) <= cornerR;
        }
      }

      if (!inShape) {
        raw[off++] = 0; raw[off++] = 0; raw[off++] = 0; raw[off++] = 0;
        continue;
      }

      // Cross symbol
      const inV = x >= crossCX - crossW && x <= crossCX + crossW &&
                  y >= crossTop          && y <= crossTop + crossV * 2;
      const inH = x >= crossCX - crossH && x <= crossCX + crossH &&
                  y >= crossCY - crossW  && y <= crossCY + crossW;
      const inCross = inV || inH;

      const [r, g, b] = inCross ? accent : bg;
      raw[off++] = r; raw[off++] = g; raw[off++] = b; raw[off++] = 255;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Generate ──────────────────────────────────────────────────────────────────

const OUT = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(OUT, { recursive: true });

const icons = [
  { file: "icon-192.png",          size: 192, maskable: false },
  { file: "icon-512.png",          size: 512, maskable: false },
  { file: "icon-maskable-192.png", size: 192, maskable: true  },
  { file: "icon-maskable-512.png", size: 512, maskable: true  },
  { file: "apple-touch-icon.png",  size: 180, maskable: true  },
];

for (const { file, size, maskable } of icons) {
  const buf  = makePNG(size, maskable, BG, ACC);
  const dest = path.join(OUT, file);
  fs.writeFileSync(dest, buf);
  console.log(`✓ ${file}  (${size}×${size}, ${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log("\nDone. Icons written to public/icons/");
console.log("Replace with branded artwork before launch if needed.");
