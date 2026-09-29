"use client";

// Shown by every intake form when checkDuplicates() finds a match.
//   same     → blocked; link to the existing record (on the staff admission
//              form an existing student → continue as a re-enrolment instead)
//   family   → same phone/email: continue as a sibling or parent
//   possible → same name only: continue as a different person

import Link from "next/link";
import { duplicateMessage, type DedupMatch } from "@/lib/dedup";

export type DuplicateOverride = "sibling" | "parent" | "different" | "reenrol";

function recordHref(m: DedupMatch): string {
  const c = m.candidate;
  if (c.kind === "student") return `/dashboard/students/${c.id}`;
  if (c.kind === "enquiry") return "/dashboard/admissions?tab=enquiries";
  return "/dashboard/admissions";
}

/**
 * True when saving must stop (an exact match exists). With `reEnrolWing` (the
 * staff admission form), an exact match to an existing *student* doesn't stop
 * it: in that wing, enrolment merges into their record; in the other wing a
 * separate student is created. Exact matches to open applications/enquiries
 * still block.
 */
export function isBlockingDuplicate(matches: DedupMatch[], reEnrolWing?: string): boolean {
  return matches.some(m => m.level === "same" && !(reEnrolWing && isReEnrolMatch(m)));
}

/** An exact match to an existing student by name (+ admission no., phone or DOB). A shared
 *  admission number under a different name is a conflict, never a re-enrolment. */
function isReEnrolMatch(m: DedupMatch): boolean {
  return m.level === "same" && m.candidate.kind === "student" && m.reasons.includes("same name");
}

export default function DuplicateWarning({ matches, onContinue, onCancel, reEnrolWing }: {
  matches: DedupMatch[];
  /** Omit to hide the continue buttons (e.g. when only "same" matches exist). */
  onContinue?: (why: DuplicateOverride) => void;
  onCancel?: () => void;
  /** Admission form's wing — makes an exact student match a re-enrolment, not a block. */
  reEnrolWing?: string;
}) {
  if (matches.length === 0) return null;
  const blocking = isBlockingDuplicate(matches, reEnrolWing);
  const reEnrol = !blocking && reEnrolWing ? matches.find(isReEnrolMatch) : undefined;
  const shown = (blocking || reEnrol ? matches.filter(m => m.level === "same") : matches).slice(0, 4);
  const familyOnly = !blocking && shown.every(m => m.level === "family");
  if (reEnrol && onContinue) {
    const sameWing = !reEnrol.candidate.wing || reEnrol.candidate.wing === reEnrolWing;
    const cr = { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e3a8a" };
    return (
      <div role="alert" style={{ background: cr.bg, border: `1px solid ${cr.border}`, borderRadius: 12, padding: "12px 14px", margin: "12px 0", color: cr.fg }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>🔁 Existing student found</div>
        <MatchRows shown={shown} border={cr.border} />
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {sameWing
            ? "You can continue. At enrolment this application merges into their existing record: new details replace the old ones, and their admission number, fees, attendance and screening history are kept. No duplicate is created."
            : "This student is in the other wing. Continuing creates a separate record for this wing; wing data is never merged."}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
          <button type="button" onClick={() => onContinue(sameWing ? "reenrol" : "different")} style={{ ...btn, borderColor: "#93c5fd", color: "#1e3a8a" }}>
            {sameWing ? "Continue — re-enrol & merge" : "Continue — new record in this wing"}
          </button>
          {onCancel && <button type="button" onClick={onCancel} style={{ ...btn, background: "transparent", border: "none", textDecoration: "underline", color: "#1e3a8a" }}>Cancel</button>}
        </div>
      </div>
    );
  }
  const c = blocking
    ? { bg: "#fef2f2", border: "#fecaca", fg: "#991b1b" }
    : { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" };

  return (
    <div role="alert" style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: "12px 14px", margin: "12px 0", color: c.fg }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>
        {blocking ? "⛔ This person is already registered" : "⚠️ A matching record already exists"}
      </div>
      <MatchRows shown={shown} border={c.border} />
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

function MatchRows({ shown, border }: { shown: DedupMatch[]; border: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {shown.map(m => (
        <div key={`${m.candidate.kind}-${m.candidate.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", background: "#fff", border: `1px solid ${border}`, borderRadius: 8, padding: "8px 10px" }}>
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
  );
}

const btn: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 8, border: "1px solid #fcd34d", background: "#fff",
  color: "#92400e", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
