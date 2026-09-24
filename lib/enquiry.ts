// Pure enquiry helpers — safe to import from client components and API routes
// alike (no Firebase SDK). Persistence lives in services/enquiry/enquiry.service.

export const ENQUIRY_INSTRUMENTS = ["Keyboard", "Piano", "Guitar", "Drums", "Violin", "Vocal"];

/** Strip to digits and drop a leading 91 / 0 → the 10-digit mobile number. */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}

export function isValidPhone(raw: string): boolean {
  return /^[6-9]\d{9}$/.test(normalizePhone(raw));
}

/** "9876543210" → "98765 43210". */
export function formatPhone(raw: string): string {
  const d = normalizePhone(raw);
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : raw;
}
