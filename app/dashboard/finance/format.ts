// Display helpers shared by the Finance page and its modals.

export function fmtINR(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "2025-04" → "April 2025" */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const names = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y}`;
}

/** The billing month has ended and its due is still open. */
export function isOverdueMonth(ym: string): boolean {
  return ym < todayStr().slice(0, 7);
}

/** "Overdue — October 2026" for a past month, "Due — November 2026" otherwise. */
export function dueLabel(ym: string): string {
  return `${isOverdueMonth(ym) ? "Overdue" : "Due"} — ${fmtMonth(ym)}`;
}

/** Tooltip wherever a past month is on screen. */
export const HISTORY_NOTE = "Historical view. Actions update the live balance.";
