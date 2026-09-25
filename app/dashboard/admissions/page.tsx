"use client";

// =============================================================================
// Wing 2 — Rol's School of Music — unified admissions wizard.
//
//   Step 1  Application   (reuses the ROL+ AdmissionFormContent)
//   Step 2  Screening     (reuses the Fast Track clinical protocol)
//   Step 3  Review & Enrol → creates the student, assigns the one shared
//                            wing syllabus (automatic — see lesson.service),
//                            downloads the admission card.
//
// This route only does anything for the school_of_music wing; ROL+ keeps its
// existing /dashboard/screening hub.
// =============================================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useWing } from "@/hooks/useWing";
import EnrollStudentModal from "@/components/admissions/EnrollStudentModal";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import { updateAdmission, findFastTrackScreeningByName } from "@/services/screening/screening.service";
import { AdmissionFormContent } from "../screening/admission-form";
import { AdmissionsList } from "../screening/admissions-list";
import { NewAdmissionChoiceModal, ParentQrModal } from "@/components/admissions/ParentModals";
import { EnquiriesDrawer } from "./enquiries";
import { ScreeningQuestionsPanel } from "@/components/screening/ScreeningQuestionsPanel";
import EnquiryForm from "@/components/enquiry/EnquiryForm";
import { markEnquiryConverted, subscribeEnquiries, type Enquiry } from "@/services/enquiry/enquiry.service";
import { FastTrackContent, type FastTrackScreeningResult } from "../screening/fast-track/FastTrackContent";

const ACCENT = "#d97706";
const WING = WINGS.SCHOOL_OF_MUSIC;

// ─── Shared primitives ────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
  padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const btn: React.CSSProperties = {
  padding: "11px 22px", borderRadius: 12, border: "none",
  fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", gap: 8,
};

// ─── Page shell ───────────────────────────────────────────────────────────────
export default function AdmissionsPage() {
  return (
    <ProtectedRoute
      allowedRoles={[ROLES.FOUNDER, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.TEACHER]}
      requiredCapability={CAPABILITIES.SCREENING_MANAGE}
    >
      <AdmissionsWizard />
    </ProtectedRoute>
  );
}

// ─── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step }: { step: number }) {
  const steps = ["Application", "Screening", "Review & Enrol"];
  return (
    <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 26 }}>
      {steps.map((l, i) => {
        const n = i + 1;
        const done = step > n;
        const active = step === n;
        return (
          <div key={n} style={{ display: "flex", alignItems: "flex-start", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
              <div style={{
                width: 34, height: 34, borderRadius: "50%",
                background: done || active ? ACCENT : "#f3f4f6",
                color: done || active ? "#fff" : "#9ca3af",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, flexShrink: 0,
                boxShadow: active ? "0 0 0 5px rgba(217,119,6,0.1)" : "none",
              }}>
                {done ? "✓" : n}
              </div>
              <div style={{ fontSize: 11, marginTop: 6, fontWeight: active ? 700 : 400, color: active ? ACCENT : done ? "#6b7280" : "#9ca3af", whiteSpace: "nowrap" }}>
                {l}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ height: 2, width: 48, flexShrink: 0, alignSelf: "flex-start", marginTop: 16, background: done ? ACCENT : "#f0f0f0" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

type AdmissionsTab = "applications" | "questions";
const ADMISSIONS_TABS: AdmissionsTab[] = ["applications", "questions"];

// ─── Wizard ───────────────────────────────────────────────────────────────────
function AdmissionsWizard() {
  const { wing } = useWing();

  const [mode, setMode]             = useState<"list" | "wizard">("list");
  const [step, setStep]             = useState<1 | 2 | 3>(1);
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [application, setApplication] = useState<Record<string, unknown> | null>(null);
  const [screening, setScreening]     = useState<FastTrackScreeningResult | null>(null);
  const [showQr, setShowQr]           = useState(false);
  // Which code the QR modal opens on — "enquiry" when launched from the
  // Enquiries drawer, otherwise the full admission form.
  const [qrTarget, setQrTarget]       = useState<"apply" | "enquiry" | null>(null);
  // Enquiries live in a slide-over opened from the "Enquiries +" header button.
  const [showEnquiries, setShowEnquiries] = useState(false);
  // "🎓 Enroll Student" → Student Enrollment & Batch Assignment modal.
  const [enrollFor, setEnrollFor] = useState<Record<string, unknown> | null>(null);
  const { toasts, toast, remove } = useToast();
  function enrolledToast(r: { name: string; centreName: string }) {
    toast(`Student ${r.name} successfully enrolled${r.centreName ? ` into ${r.centreName}` : ""}!`, "success");
  }
  const [newEnquiries, setNewEnquiries]   = useState(0);
  useEffect(() => {
    if (wing !== WING) return;
    return subscribeEnquiries(
      WING,
      list => setNewEnquiries(list.filter(e => e.status === "new").length),
      () => setNewEnquiries(0),
    );
  }, [wing]);
  const [showNewChoice, setShowNewChoice] = useState(false);
  const [tab, setTab]                 = useState<AdmissionsTab>("applications");
  // Deep links: ?tab=questions opens that tab; ?tab=enquiries (the old
  // Enquiries tab) now opens the Enquiries drawer.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "enquiries") setShowEnquiries(true);
    else if (t && (ADMISSIONS_TABS as string[]).includes(t)) setTab(t as AdmissionsTab);
  }, []);
  function selectTab(t: AdmissionsTab) {
    setTab(t);
    const url = new URL(window.location.href);
    if (t !== "applications") url.searchParams.set("tab", t); else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  }
  // Step 1 toggle: full application vs. a quick enquiry (lead only).
  const [formKind, setFormKind]       = useState<"full" | "quick">("full");
  // Set by "Convert to admission" — pre-fills the full form, marked converted on submit.
  const [fromEnquiry, setFromEnquiry] = useState<Enquiry | null>(null);

  function resetWizard() {
    setStep(1); setAdmissionId(null); setApplication(null); setScreening(null);
    setFormKind("full"); setFromEnquiry(null);
  }

  function convertEnquiry(e: Enquiry) {
    setShowEnquiries(false);
    resetWizard();
    setFromEnquiry(e);
    setMode("wizard");
  }

  if (wing !== WING) {
    return (
      <div style={{ maxWidth: 520, margin: "48px auto", ...card, textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎼</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#111", marginBottom: 6 }}>
          Admissions is the {WING_LABELS[WING]} intake
        </div>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>
          Switch the active wing to {WING_LABELS[WING]} to use this. The ROL+ Music Academy
          intake lives on the Screening hub.
        </div>
        <Link href="/dashboard/screening" style={{ ...btn, background: "#f3f4f6", color: "#374151", textDecoration: "none" }}>
          Go to Screening →
        </Link>
      </div>
    );
  }

  // ── List view (default) ──────────────────────────────────────────────────
  if (mode === "list") {
    return (
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 0 60px" }}>
        <ToastContainer toasts={toasts} onRemove={remove} />
        {enrollFor && (
          <EnrollStudentModal
            application={enrollFor}
            admissionId={String(enrollFor.id ?? "")}
            onClose={() => setEnrollFor(null)}
            onEnrolled={r => { setEnrollFor(null); enrolledToast(r); }}
          />
        )}
        {showQr && (
          <ParentQrModal wing={WING}
            initialTarget={qrTarget ?? "apply"}
            onClose={() => { setShowQr(false); setQrTarget(null); }} />
        )}
        {showNewChoice && (
          <NewAdmissionChoiceModal
            onClose={() => setShowNewChoice(false)}
            onDevice={() => { setShowNewChoice(false); resetWizard(); setMode("wizard"); }}
            onParentQr={() => { setShowNewChoice(false); setQrTarget("apply"); setShowQr(true); }}
          />
        )}
        <div style={{ marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 900, color: "#78350f" }}>Admissions — {WING_LABELS[WING]}</div>
            <div style={{ fontSize: 12, color: "#92400e", opacity: 0.8, marginTop: 2 }}>
              One application · Fast Track screening · Syllabus by level &amp; instrument
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setShowEnquiries(true)} title="Open enquiries — add a lead, follow up, convert"
              style={{ ...btn, background: ACCENT, color: "#fff", padding: "9px 16px", position: "relative" }}>
              <span aria-hidden style={{ fontSize: 15 }}>📇</span> Enquiries
              <span aria-hidden style={{ background: "rgba(255,255,255,0.25)", borderRadius: 6, width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15, lineHeight: 1 }}>+</span>
              {newEnquiries > 0 && (
                <span aria-label={`${newEnquiries} new`} style={{
                  position: "absolute", top: -7, right: -7, minWidth: 20, height: 20, padding: "0 6px", boxSizing: "border-box",
                  borderRadius: 999, background: "#dc2626", color: "#fff", fontSize: 11, fontWeight: 800,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", border: "2px solid #fff",
                }}>
                  {newEnquiries > 99 ? "99+" : newEnquiries}
                </span>
              )}
            </button>
          </div>
        </div>
        {showEnquiries && (
          <EnquiriesDrawer
            wing={WING}
            onClose={() => setShowEnquiries(false)}
            onConvert={convertEnquiry}
            onShowQr={() => { setQrTarget("enquiry"); setShowQr(true); }}
          />
        )}
        <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid #f0f0f0" }}>
          {([["applications", "Applications"], ["questions", "Screening Questions"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => selectTab(k)} style={{
              padding: "9px 16px", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 13.5, fontWeight: tab === k ? 800 : 500, color: tab === k ? "#92400e" : "#6b7280",
              borderBottom: tab === k ? `2.5px solid ${ACCENT}` : "2.5px solid transparent", marginBottom: -1,
            }}>
              {l}
            </button>
          ))}
        </div>
        {tab === "questions" ? (
          <ScreeningQuestionsPanel wing={WING} />
        ) : (
        <AdmissionsList
          onNewAdmission={() => setShowNewChoice(true)}
          onResume={async (rec, intent) => {
            if (intent === "enroll") { setEnrollFor(rec); return; }
            const recId = typeof rec.id === "string" ? rec.id : null;
            setApplication(rec);
            setAdmissionId(recId);
            setScreening(null);
            // Already screened → load the saved screening so it opens pre-filled
            // (read-only summary, "Edit Assessment" to change) instead of blank.
            let saved: FastTrackScreeningResult | null = null;
            try {
              if (typeof rec.screeningId === "string" && rec.screeningId) {
                const snap = await getDoc(doc(db, "screenings", rec.screeningId));
                if (snap.exists()) saved = { ...(snap.data() as Omit<FastTrackScreeningResult, "id">), id: snap.id };
              } else if (typeof rec.fullName === "string" && rec.fullName) {
                // Screened before the application recorded its screeningId —
                // find it by the child's name and link it for next time.
                const found = await findFastTrackScreeningByName(rec.fullName, WING);
                if (found) {
                  saved = found as FastTrackScreeningResult;
                  if (recId) {
                    updateAdmission(recId, { screeningId: found.id, screenedAt: found.screenedAt })
                      .catch(err => console.error("[admissions] link legacy screening:", err));
                  }
                }
              }
            } catch (err) {
              console.error("[admissions] load saved screening:", err);
            }
            setScreening(saved);
            // Opens the screening — its summary (Edit Assessment / Continue to
            // Enrol) when one exists. "Enroll Student" returned above (modal).
            setStep(2);
            setMode("wizard");
          }}
        />
        )}
      </div>
    );
  }

  // ── Wizard view ──────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 0 60px" }}>
      <button
        onClick={() => { resetWizard(); setMode("list"); }}
        style={{ ...btn, background: "transparent", color: "#6b7280", padding: "4px 0", marginBottom: 8 }}
      >
        ← All applications
      </button>

      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #fffbeb, #fef9ee)",
        border: "1px solid #fde68a", borderRadius: 20, padding: "22px 28px", marginBottom: 22,
        display: "flex", alignItems: "center", gap: 14,
      }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>📝</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 900, color: "#78350f" }}>New admission — {WING_LABELS[WING]}</div>
          <div style={{ fontSize: 12, color: "#92400e", opacity: 0.8, marginTop: 2 }}>
            One application · Fast Track screening · Syllabus by level &amp; instrument
          </div>
        </div>
      </div>

      <Stepper step={step} />

      {/* Step 1 — Application (or a quick enquiry instead) */}
      {step === 1 && !fromEnquiry && (
        <div style={{ display: "inline-flex", background: "#f3f4f6", borderRadius: 12, padding: 4, marginBottom: 14, gap: 4 }}>
          {([["full", "Full Admission Form"], ["quick", "Quick Enquiry Form"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFormKind(k)} style={{
              padding: "8px 16px", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 13, fontWeight: 700,
              background: formKind === k ? "#fff" : "transparent",
              color: formKind === k ? "#92400e" : "#6b7280",
              boxShadow: formKind === k ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
            }}>
              {l}
            </button>
          ))}
        </div>
      )}
      {step === 1 && fromEnquiry && (
        <div style={{ background: "#fef9ee", border: "1px solid #fde68a", borderRadius: 12, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#92400e" }}>
          Converting enquiry for <strong>{fromEnquiry.studentName}</strong> — name, parent, phone, place and instrument are pre-filled.
        </div>
      )}
      {step === 1 && formKind === "quick" && !fromEnquiry && (
        <div style={card}>
          <EnquiryForm wing={WING} source="staff" onCreated={() => {
            resetWizard();
            setMode("list");
            setShowEnquiries(true);
          }} />
        </div>
      )}
      {step === 1 && (formKind === "full" || fromEnquiry) && (
        <div style={card}>
          <AdmissionFormContent
            key={fromEnquiry?.id ?? "blank"}
            minimal
            initial={fromEnquiry ? {
              studentName:        fromEnquiry.studentName,
              parentName:         fromEnquiry.parentName,
              phone:              fromEnquiry.phone,
              address1:           fromEnquiry.place,
              instrumentsToLearn: fromEnquiry.instrument ? [fromEnquiry.instrument] : [],
            } : undefined}
            onSubmitted={(id, data) => {
              if (fromEnquiry) {
                markEnquiryConverted(fromEnquiry.id, id).catch(err => console.error("[admissions] mark enquiry converted:", err));
              }
              setAdmissionId(id);
              setApplication(data);
              setStep(2);
            }}
          />
        </div>
      )}

      {/* Step 2 — Fast Track screening */}
      {step === 2 && (
        <FastTrackContent
          key={screening?.id ?? "new"}
          initial={screening}
          onUpdated={sc => setScreening(sc)}
          lockedStudentName={typeof application?.fullName === "string" ? application.fullName : ""}
          // Viewing a saved screening (opened from the list) → Back returns to
          // the applications list; mid-wizard → back to the application step.
          onBack={screening ? () => { resetWizard(); setMode("list"); } : () => setStep(1)}
          onSaved={(sc) => {
            setScreening(sc);
            setStep(3);
            if (admissionId) {
              updateAdmission(admissionId, { screeningId: sc.id, screenedAt: sc.screenedAt })
                .catch(err => console.error("[admissions] link screening to application:", err));
            }
          }}
        />
      )}

      {/* Step 3 — Review & Enrol */}
      {step === 3 && screening && (
        <button onClick={() => setStep(2)}
          style={{ ...btn, background: "transparent", color: "#4f46e5", padding: "0 0 10px" }}>
          ← View / edit screening
        </button>
      )}
      {step === 3 && application && screening && admissionId && (
        <div style={card}>
          <EnrollStudentModal
            inline
            application={{ ...application, id: admissionId }}
            admissionId={admissionId}
            screening={screening as unknown as Record<string, unknown> & { id: string }}
            onClose={() => setStep(2)}
            onEnrolled={r => { enrolledToast(r); resetWizard(); setMode("list"); }}
          />
        </div>
      )}
    </div>
  );
}
