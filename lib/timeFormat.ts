/**
 * 12-hour display helpers. Schedules are stored as 24-hour "HH:MM" strings
 * (and parsed that way elsewhere), so convert only at render time.
 */

/** "17:00" → "5:00 PM", "03:00" → "3:00 AM". Returns the input unchanged if it isn't HH:MM. */
export function formatTime12(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m) return t ?? "";
  const h = Number(m[1]) % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "17:00", "18:00" → "5:00 PM – 6:00 PM"; empty string if either end is blank. */
export function formatTimeRange12(start: string | null | undefined, end: string | null | undefined): string {
  return start && end ? `${formatTime12(start)} – ${formatTime12(end)}` : "";
}

/**
 * Rewrites every 24-hour time in free text, e.g. a stored timeSlot
 * "Mon/Wed 17:00–18:00" → "Mon/Wed 5:00 PM – 6:00 PM". Times already
 * followed by AM/PM are left alone.
 */
export function formatTimesIn12h(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\b(\d{1,2}:\d{2})\b(?!\s*[AaPp][Mm])/g, (_, t: string) => formatTime12(t))
    .replace(/\s*[–-]\s*(?=\d{1,2}:\d{2} [AP]M)/g, " – ");
}
