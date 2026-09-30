// =============================================================================
// Application reference, e.g. "APP-2026-7K3F", stamped on every new admission
// application (both wings, staff and public /apply). It only identifies the
// application for parents and staff. It is NOT an admission number: those are
// still entered manually by leadership (lib/admissionNumber.ts).
// =============================================================================

// No 0/O, 1/I/L, so a parent can read it back over the phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** "APP-<year>-<4 random chars>" — works in the browser and on the server (Web Crypto). */
export function newApplicationRef(now: Date = new Date()): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const code = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join("");
  return `APP-${now.getFullYear()}-${code}`;
}
