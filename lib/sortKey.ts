// Safe sort helpers. Firestore fields typed as `string` are not always strings
// at runtime: centres created in-app store `createdAt` as a Timestamp
// (serverTimestamp()), imported rows can carry numbers, and old docs miss the
// field entirely. Calling `.localeCompare` on any of those throws and takes
// the whole page down, so sorts go through these instead.

/** Any Firestore-ish value → a comparable string (Timestamps/Dates → ISO). */
export function sortKey(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString();
  if (typeof v === "object" && "toDate" in v && typeof (v as { toDate: unknown }).toDate === "function") {
    const d = (v as { toDate(): Date }).toDate();
    return isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof v === "object" && "seconds" in v && typeof (v as { seconds: unknown }).seconds === "number") {
    return new Date((v as { seconds: number }).seconds * 1000).toISOString(); // serialized Timestamp
  }
  return String(v);
}

/** localeCompare that never throws, whatever the operand types. */
export function safeCompare(a: unknown, b: unknown): number {
  return sortKey(a).localeCompare(sortKey(b));
}
