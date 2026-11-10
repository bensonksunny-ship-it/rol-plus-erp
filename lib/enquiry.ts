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

// ─── Admission → Enquiry transfer ────────────────────────────────────────────
// A stale application can be moved to Enquiries for follow-up. The admission
// document is kept untouched apart from these flags (photo, form answers and
// the screening link all stay on it), so a restore brings everything back.

/** `admissions.status` while the application sits in Enquiries. */
export const MOVED_TO_ENQUIRY = "moved_to_enquiry";

/** Enquiry status for a lead moved over from an application. */
export const FOLLOW_UP_STATUS = "follow_up";

export function isMovedToEnquiry(rec: { status?: unknown } | null | undefined): boolean {
  return rec?.status === MOVED_TO_ENQUIRY;
}

/** Longest transfer note kept (characters). */
export const TRANSFER_NOTE_MAX = 500;
