"use client";

// =============================================================================
// Final review before an enrolment is written. Opened by "Confirm & Complete
// Enrollment" in EnrollStudentModal (both wings) — staff check the five key
// details and only "Confirm Enrollment" runs enrollApplicant().
// =============================================================================

import { useEffect } from "react";

export interface EnrollmentSummary {
  name: string;
  admissionNo: string;
  centreName: string;
  phone: string;
  course: string;
}

export default function EnrollmentConfirmationModal({
  summary, saving, error, onConfirm, onCancel,
}: {
  summary: EnrollmentSummary;
  saving: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc cancels (not while the enrolment is being written).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onCancel]);

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Student Name",     value: summary.name },
    { label: "Admission Number", value: summary.admissionNo, mono: true },
    { label: "Centre",           value: summary.centreName },
    { label: "Contact Number",   value: summary.phone },
    { label: "Course",           value: summary.course },
  ];

  return (
    <div onClick={saving ? undefined : onCancel} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="enrol-confirm-title" onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: "#fff", borderRadius: 16, boxShadow: "0 24px 64px rgba(0,0,0,0.3)", overflow: "hidden", boxSizing: "border-box" }}>
        <div style={{ background: "#065f46", padding: "16px 20px" }}>
          <div id="enrol-confirm-title" style={{ fontSize: 16, fontWeight: 900, color: "#fff" }}>Confirm Enrollment</div>
          <div style={{ fontSize: 12, color: "#a7f3d0", marginTop: 3 }}>Check these details before enrolling.</div>
        </div>

        <dl style={{ margin: 0, padding: "8px 20px" }}>
          {rows.map((r, i) => (
            <div key={r.label} style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
              padding: "11px 0", borderTop: i ? "1px solid #f0f0f0" : "none",
            }}>
              <dt style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>{r.label}</dt>
              <dd style={{
                margin: 0, textAlign: "right", fontSize: 14, fontWeight: 800, overflowWrap: "anywhere",
                color: r.value ? "#111" : "#dc2626",
                fontFamily: r.mono && r.value ? "monospace" : "inherit", letterSpacing: r.mono ? "0.05em" : undefined,
              }}>
                {r.value || "Not set"}
              </dd>
            </div>
          ))}
        </dl>

        {error && (
          <div style={{ margin: "0 20px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 12px", fontSize: 13, color: "#dc2626" }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 10, padding: "4px 20px 20px" }}>
          <button onClick={onCancel} disabled={saving} style={{
            flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff",
            color: "#374151", fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
          }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={saving} autoFocus style={{
            flex: 2, padding: "11px 0", borderRadius: 10, border: "none",
            background: saving ? "#9ca3af" : "#065f46", color: "#fff", fontSize: 13, fontWeight: 800,
            cursor: saving ? "not-allowed" : "pointer",
          }}>
            {saving ? "Enrolling…" : "✓ Confirm Enrollment"}
          </button>
        </div>
      </div>
    </div>
  );
}
