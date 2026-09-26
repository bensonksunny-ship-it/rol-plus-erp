"use client";

// Shown by every intake form when checkDuplicates() finds a match.
//   same     → blocked; link to the existing record
//   family   → same phone/email: continue as a sibling or parent
//   possible → same name only: continue as a different person

import Link from "next/link";
import { duplicateMessage, type DedupMatch } from "@/lib/dedup";

export type DuplicateOverride = "sibling" | "parent" | "different";

function recordHref(m: DedupMatch): string {
  const c = m.candidate;
  if (c.kind === "student") return `/dashboard/students/${c.id}`;
  if (c.kind === "enquiry") return "/dashboard/admissions?tab=enquiries";
  return "/dashboard/admissions";
}

/** True when saving must stop (an exact match exists). */
export function isBlockingDuplicate(matches: DedupMatch[]): boolean {
  return matches.some(m => m.level === "same");
}

export default function DuplicateWarning({ matches, onContinue, onCancel }: {
  matches: DedupMatch[];
  /** Omit to hide the continue buttons (e.g. when only "same" matches exist). */
  onContinue?: (why: DuplicateOverride) => void;
  onCancel?: () => void;
}) {
  if (matches.length === 0) return null;
  const blocking = isBlockingDuplicate(matches);
  const shown = (blocking ? matches.filter(m => m.level === "same") : matches).slice(0, 4);
  const familyOnly = !blocking && shown.every(m => m.level === "family");
  const c = blocking
    ? { bg: "#fef2f2", border: "#fecaca", fg: "#991b1b" }
    : { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" };

  return (
    <div role="alert" style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: "12px 14px", margin: "12px 0", color: c.fg }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>
        {blocking ? "⛔ This person is already registered" : "⚠️ A matching record already exists"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map(m => (
          <div key={`${m.candidate.kind}-${m.candidate.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", background: "#fff", border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{m.candidate.name || "—"}</div>
              <div style={{ fontSize: 12, color: "#374151" }}>{duplicateMessage(m)}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>Matched on: {m.reasons.join(", ")}</div>
            </div>
            <Link href={recordHref(m)} target="_blank" style={{ fontSize: 12, fontWeight: 700, color: "#4f46e5", whiteSpace: "nowrap" }}>
              Open existing record →
            </Link>
          </div>
        ))}
      </div>
      {blocking ? (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          A new record was not created. Open the existing record and update it instead.
        </div>
      ) : onContinue && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12 }}>{familyOnly ? "Same phone/email — is this family?" : "Is this a different person?"}</span>
          {familyOnly ? (
            <>
              <button type="button" onClick={() => onContinue("sibling")} style={btn}>Continue — it&apos;s a sibling</button>
              <button type="button" onClick={() => onContinue("parent")} style={btn}>Continue — it&apos;s a parent</button>
            </>
          ) : (
            <button type="button" onClick={() => onContinue("different")} style={btn}>Continue — different person</button>
          )}
          {onCancel && <button type="button" onClick={onCancel} style={{ ...btn, background: "transparent", border: "none", textDecoration: "underline" }}>Cancel</button>}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 8, border: "1px solid #fcd34d", background: "#fff",
  color: "#92400e", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
