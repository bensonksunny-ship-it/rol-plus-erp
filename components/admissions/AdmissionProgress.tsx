"use client";

// Admission number as the final phase of the admissions workflow — not an error.
//   1. Application Received → 2. Screening Conducted → 3. Admission Fee Recorded
//   → 4. Assign Admission Number (final phase)
// Shared by the admissions list (cards, detail panel, edit overlay) and the
// Enrol Student modal. Admission numbers stay manual-only (see lib/admissionNumber).

const has = (rec: Record<string, unknown>, k: string) => typeof rec[k] === "string" && (rec[k] as string).trim() !== "";
const feePaid = (rec: Record<string, unknown>) =>
  rec.admissionFeePaid === true && typeof rec.admissionFeeAmount === "number" && rec.admissionFeeAmount > 0;

export interface AdmissionStep { label: string; done: boolean }

/** The four steps; `admNo` is the admission number as the caller sees it (typed or saved). */
export function admissionSteps(rec: Record<string, unknown>, admNo: string): AdmissionStep[] {
  return [
    { label: "Application Received",   done: true },
    { label: "Screening Conducted",    done: has(rec, "screeningId") },
    { label: "Admission Fee Recorded", done: feePaid(rec) },
    { label: "Assign Admission Number", done: admNo.trim() !== "" },
  ];
}

const C = {
  indigo: "#4f46e5", indigoSoft: "#eef2ff", indigoBorder: "#c7d2fe", indigoText: "#3730a3",
  green: "#15803d", greenSoft: "#dcfce7", grey: "#9ca3af", greySoft: "#f3f4f6", line: "#e5e7eb",
};

/** Linear 4-step stepper. The first unfinished step is highlighted as the next step. */
export function AdmissionStepper({ rec, admNo }: { rec: Record<string, unknown>; admNo: string }) {
  const steps = admissionSteps(rec, admNo);
  const current = steps.findIndex(st => !st.done);
  return (
    <ol aria-label="Admission progress" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", alignItems: "flex-start", gap: 0 }}>
      {steps.map((st, i) => {
        const active = i === current;
        const dot = st.done
          ? { bg: C.greenSoft, fg: C.green, border: C.greenSoft }
          : active ? { bg: C.indigo, fg: "#fff", border: C.indigo } : { bg: "#fff", fg: C.grey, border: C.line };
        return (
          <li key={st.label} aria-current={active ? "step" : undefined}
            style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", position: "relative" }}>
            {i > 0 && (
              <span aria-hidden style={{ position: "absolute", top: 12, right: "50%", width: "100%", height: 2,
                background: steps[i - 1].done ? "#86efac" : C.line }} />
            )}
            <span style={{ position: "relative", zIndex: 1, width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, fontWeight: 800, background: dot.bg, color: dot.fg, border: `2px solid ${dot.border}`,
              boxShadow: active ? "0 0 0 4px rgba(79,70,229,0.15)" : "none" }}>
              {st.done ? "✓" : i + 1}
            </span>
            <span style={{ marginTop: 6, fontSize: 11, lineHeight: 1.3, textAlign: "center", padding: "0 4px",
              fontWeight: active ? 800 : 600, color: st.done ? C.green : active ? C.indigoText : C.grey }}>
              {st.label}
              {i === steps.length - 1 && <span style={{ display: "block", fontSize: 10, fontWeight: 600, opacity: 0.8 }}>Final phase</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Stepper + a calm status line for an application that has no admission number
 * yet. When steps 1–3 are done it reads as the final step; otherwise it notes
 * the number comes last. `onAssign` shows the primary "Assign Admission Number"
 * button (omit it for staff who can't enter numbers — `note` explains who can).
 */
export function AdmissionFinalPhase({ rec, admNo, onAssign, note }: {
  rec: Record<string, unknown>; admNo: string; onAssign?: () => void; note?: string;
}) {
  const steps = admissionSteps(rec, admNo);
  const earlierDone = steps.slice(0, 3).every(st => st.done);
  return (
    <div role="status" style={{ background: C.indigoSoft, border: `1px solid ${C.indigoBorder}`, borderRadius: 12, padding: "14px 14px 12px" }}>
      <AdmissionStepper rec={rec} admNo={admNo} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
        <div style={{ fontSize: 12.5, color: C.indigoText, fontWeight: 600, minWidth: 0 }}>
          {earlierDone
            ? "Application & Screening Complete — Final Step: Assign Admission Number to complete enrollment."
            : "The admission number is assigned in the final phase, once screening and the admission fee are done."}
          {note && <span style={{ display: "block", fontWeight: 500, fontSize: 11.5, marginTop: 2, opacity: 0.85 }}>{note}</span>}
        </div>
        {onAssign && (
          <button type="button" onClick={onAssign}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: C.indigo, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0, fontFamily: "inherit" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#4338ca")}
            onMouseLeave={e => (e.currentTarget.style.background = C.indigo)}>
            Assign Admission Number
          </button>
        )}
      </div>
    </div>
  );
}

/** Small card pill for an application still waiting for its number. */
export function AdmNoPendingPill({ style }: { style?: React.CSSProperties }) {
  return (
    <span title="Stage 4 (final phase): an admission number is assigned before enrolment"
      style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 700, letterSpacing: 0, background: "#e0e7ff", color: C.indigoText, padding: "1px 7px", borderRadius: 99, whiteSpace: "nowrap", ...style }}>
      ⏱ Stage 4: Awaiting Adm. No.
    </span>
  );
}
