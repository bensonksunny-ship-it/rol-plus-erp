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

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { collection, addDoc, doc, updateDoc, getDocs, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useWing } from "@/hooks/useWing";
import { wingOf } from "@/lib/wing";
import { formatAdmissionNo, reserveAdmissionSeq } from "@/lib/admissionNumber";
import { updateAdmission, deleteAdmission } from "@/services/screening/screening.service";
import { getWingSyllabus } from "@/services/lesson/lesson.service";
import { generateAdmissionCardPDF } from "@/lib/generateAdmissionCard";
import { AdmissionFormContent } from "../screening/admission-form";
import { AdmissionsList } from "../screening/admissions-list";
import { FastTrackContent, type FastTrackScreeningResult } from "../screening/fast-track/FastTrackContent";
import {
  SYLLABUS_LEVELS,
  SYLLABUS_LEVEL_LABELS,
  SYLLABUS_INSTRUMENT_LABELS,
  type SyllabusLevel,
  type SyllabusInstrument,
} from "@/types/lesson";

const ACCENT = "#d97706";
const WING = WINGS.SCHOOL_OF_MUSIC;

// Map the applicant's chosen instruments to one of the 3 syllabus instruments.
function instrumentFromApplication(instruments: string[]): SyllabusInstrument | "" {
  const set = instruments.map(i => i.toLowerCase());
  if (set.some(i => i === "keyboard" || i === "piano")) return "keyboard";
  if (set.includes("guitar")) return "guitar";
  if (set.includes("drums")) return "drums";
  return "";
}

// Fast Track slab → suggested syllabus level (staff can override).
function levelFromSlab(track: string): SyllabusLevel {
  if (track.includes("Zeta")) return "advanced";
  if (track.includes("Epsilon")) return "intermediate";
  return "introduction";
}

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
const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.09em", display: "block", marginBottom: 10,
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

// ─── Wizard ───────────────────────────────────────────────────────────────────
function AdmissionsWizard() {
  const { wing } = useWing();

  const [mode, setMode]             = useState<"list" | "wizard">("list");
  const [step, setStep]             = useState<1 | 2 | 3>(1);
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [application, setApplication] = useState<Record<string, unknown> | null>(null);
  const [screening, setScreening]     = useState<FastTrackScreeningResult | null>(null);

  function resetWizard() {
    setStep(1); setAdmissionId(null); setApplication(null); setScreening(null);
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
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 19, fontWeight: 900, color: "#78350f" }}>Admissions — {WING_LABELS[WING]}</div>
          <div style={{ fontSize: 12, color: "#92400e", opacity: 0.8, marginTop: 2 }}>
            One application · Fast Track screening · Syllabus by level &amp; instrument
          </div>
        </div>
        <AdmissionsList
          onNewAdmission={() => { resetWizard(); setMode("wizard"); }}
          onResume={(rec) => {
            setApplication(rec);
            setAdmissionId(typeof rec.id === "string" ? rec.id : null);
            setScreening(null);
            setStep(2);
            setMode("wizard");
          }}
        />
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

      {/* Step 1 — Application */}
      {step === 1 && (
        <div style={card}>
          <AdmissionFormContent
            minimal
            onSubmitted={(id, data) => {
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
          lockedStudentName={typeof application?.fullName === "string" ? application.fullName : ""}
          onBack={() => setStep(1)}
          onSaved={(sc) => {
            setScreening(sc);
            setStep(3);
          }}
        />
      )}

      {/* Step 3 — Review & Enrol */}
      {step === 3 && application && screening && admissionId && (
        <ReviewEnrol
          wing={wing}
          admissionId={admissionId}
          application={application}
          screening={screening}
          onRestart={() => { resetWizard(); setMode("list"); }}
        />
      )}
    </div>
  );
}

// ─── Step 3: Review & Enrol ───────────────────────────────────────────────────
interface CentreOption { id: string; name: string; monthlyFee?: number; code?: string }

function ReviewEnrol({
  wing, admissionId, application, screening, onRestart,
}: {
  wing: string;
  admissionId: string;
  application: Record<string, unknown>;
  screening: FastTrackScreeningResult;
  onRestart: () => void;
}) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const strArr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const slab = screening.config.track;

  const [centres, setCentres]       = useState<CentreOption[]>([]);
  const [centre, setCentre]         = useState("");
  const [fee, setFee]               = useState("");
  const [admNo, setAdmNo]           = useState("");
  const [admNoAuto, setAdmNoAuto]   = useState(false);   // was it system-generated?
  const [genBusy, setGenBusy]       = useState(false);
  const [enrolling, setEnrolling]   = useState(false);
  const [err, setErr]               = useState("");
  const [done, setDone]             = useState<{ uid: string; name: string } | null>(null);

  // Syllabus slot: instrument from the application, level chosen by staff
  // (pre-filled from the Fast Track slab).
  const [instrument, setInstrument] = useState<SyllabusInstrument | "">(
    () => instrumentFromApplication(strArr(application.instrumentsToLearn)),
  );
  const [syllabusLevel, setSyllabusLevel] = useState<SyllabusLevel>(
    () => levelFromSlab(slab),
  );
  const [slotCount, setSlotCount] = useState<number | null>(null);

  useEffect(() => {
    getDocs(collection(db, "centers"))
      .then(snap => setCentres(
        snap.docs
          .filter(d => wingOf(d.data()) === wing)
          .map(d => ({
            id: d.id,
            name: (d.data().name as string) ?? d.id,
            code: (d.data().centerCode as string) ?? "",
            monthlyFee: typeof d.data().monthlyFee === "number" ? (d.data().monthlyFee as number) : undefined,
          })),
      ))
      .catch(() => {});
  }, [wing]);

  useEffect(() => {
    if (!instrument) { setSlotCount(null); return; }
    setSlotCount(null);
    getWingSyllabus(WING, syllabusLevel, instrument)
      .then(ls => setSlotCount(ls.length))
      .catch(() => setSlotCount(null));
  }, [syllabusLevel, instrument]);

  const selectedCentre = centres.find(c => c.id === centre);

  const generateAdmNo = useCallback(async () => {
    if (genBusy) return;
    setGenBusy(true);
    try {
      const seq = await reserveAdmissionSeq(1);
      setAdmNo(formatAdmissionNo({
        prefix: selectedCentre?.code,
        dateISO: new Date().toISOString(),
        seq,
      }));
      setAdmNoAuto(true);
    } catch {
      /* leave the field for manual entry */
    } finally {
      setGenBusy(false);
    }
  }, [genBusy, selectedCentre?.code]);

  // Auto-fill an admission number once a centre is chosen, if the staff hasn't
  // typed one. They can still overwrite it or hit "Regenerate".
  useEffect(() => {
    if (centre && !admNo && !genBusy) generateAdmNo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centre]);

  const canEnrol = admNo.trim().length >= 4 && !!centre && !!instrument && Number(fee) > 0 && !enrolling;

  async function handleEnrol() {
    if (!canEnrol) return;
    setEnrolling(true);
    setErr("");
    try {
      // 1. Create the student
      const userRef = await addDoc(collection(db, "users"), {
        name:            str(application.fullName),
        displayName:     str(application.fullName),
        firstName:       str(application.firstName),
        middleName:      str(application.middleName),
        lastName:        str(application.lastName),
        role:            "student",
        wing:            WING,
        phone:           str(application.phone),
        email:           str(application.email),
        age:             str(application.age),
        dob:             str(application.dob),
        parentName:      str(application.parentName),
        workingStatus:   str(application.workingStatus),
        schoolCompany:   str(application.schoolCompany),
        address1:        str(application.address1),
        address2:        str(application.address2),
        centre,
        centerId:        centre,
        admissionNumber: admNo,
        admissionNoAutoGenerated: admNoAuto,
        studentID:       admNo,
        instruments:     strArr(application.instrumentsToLearn),
        musicalSkill:    str(application.musicalSkill),
        photo:           str(application.photo) || null,
        screening:       { ...screening, studentId: "" },
        syllabusLevel:      syllabusLevel,
        syllabusInstrument: instrument,
        // Wing 2 fee model: group batch, prepaid, billed monthly.
        classType:          "group",
        billingMode:        "prepay",
        feeCycle:           "monthly",
        monthlyFee:         Number(fee),
        feePerClass:        0,
        assignedTeacherUid: null,
        classDays:          [],
        classTime:          null,
        currentBalance:     0,
        status:             "active",
        studentStatus:      "active",
        createdAt:       serverTimestamp(),
        updatedAt:       serverTimestamp(),
      });

      // 2. Link the screening + application to the new student
      await updateDoc(doc(db, "users", userRef.id), {
        "screening.studentId": userRef.id,
        updatedAt: new Date().toISOString(),
      });
      await updateDoc(doc(db, "screenings", screening.id), { studentId: userRef.id }).catch(() => {});
      await updateAdmission(admissionId, { admissionNumber: admNo });

      // 3. Admission-card PDF
      await generateAdmissionCardPDF(
        { ...application, id: admissionId, admissionNumber: admNo },
        {
          instrument:       instrument || "keyboard",
          stream:           "fast-track",
          assessmentId:     screening.id,
          config:           screening.config,
          ft_rhythmGrade:   screening.rhythmSyncGrade,
          ft_dexterityGrade: screening.dexterityGrade,
          ft_pitchGrade:    screening.pitchEchoGrade,
          ft_totalScore:    screening.rhythmScore + screening.pitchScore + screening.motorScore,
        },
      );

      // 4. Remove the pending application
      await deleteAdmission(admissionId).catch(() => {});

      setDone({ uid: userRef.id, name: str(application.fullName) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Enrolment failed.");
    } finally {
      setEnrolling(false);
    }
  }

  if (done) {
    return (
      <div style={{ ...card, border: "2px solid #86efac", background: "#f0fdf4", textAlign: "center", padding: "44px 32px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
        <div style={{ fontSize: 22, fontWeight: 900, color: "#15803d", marginBottom: 6 }}>{done.name} enrolled</div>
        <div style={{ fontSize: 13, color: "#166534", marginBottom: 4 }}>
          {WING_LABELS[WING]} · {slab} · Admission No. {admNo}
        </div>
        <div style={{ fontSize: 13, color: "#166534", marginBottom: 28 }}>
          Syllabus: <strong>{SYLLABUS_LEVEL_LABELS[syllabusLevel]} {instrument && SYLLABUS_INSTRUMENT_LABELS[instrument]}</strong>
          {slotCount != null && ` (${slotCount} lesson${slotCount !== 1 ? "s" : ""})`}. Admission card downloaded.
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button onClick={onRestart} style={{ ...btn, background: ACCENT, color: "#fff" }}>← All applications</button>
          <Link href={`/dashboard/students/${done.uid}`} style={{ ...btn, background: "#f3f4f6", color: "#374151", textDecoration: "none" }}>
            Open student →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14 }}>

      {/* Application summary */}
      <div style={{ ...card, gridColumn: "span 6" }}>
        <div style={label}>Applicant</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#111" }}>{str(application.fullName) || "—"}</div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
          {[str(application.age) && `Age ${str(application.age)}`, str(application.phone), str(application.email)].filter(Boolean).join(" · ")}
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
          Instruments: {strArr(application.instrumentsToLearn).join(", ") || "—"}
        </div>
      </div>

      {/* Screening summary */}
      <div style={{ ...card, gridColumn: "span 6" }}>
        <div style={label}>Fast Track result</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#111" }}>{slab}</div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{screening.config.syllabusStrategy}</div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
          Rhythm {screening.rhythmSyncGrade} · Dexterity {screening.dexterityGrade} · Pitch {screening.pitchEchoGrade}
          {" "}({screening.averageScore.toFixed(2)}/5)
        </div>
      </div>

      {/* Syllabus slot */}
      <div style={{ ...card, gridColumn: "span 12", background: "#f8f9fb" }}>
        <div style={label}>Syllabus</div>

        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
          Instrument <span style={{ color: "#9ca3af" }}>(from application)</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" as const }}>
          {(["keyboard", "guitar", "drums"] as SyllabusInstrument[]).map(inst => {
            const sel = instrument === inst;
            return (
              <button key={inst} onClick={() => setInstrument(inst)} style={{
                padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                border: sel ? `2px solid ${ACCENT}` : "1px solid #e5e7eb",
                background: sel ? "#fef9ee" : "#fff",
                fontWeight: sel ? 700 : 500, color: sel ? "#92400e" : "#374151",
              }}>
                {sel && "✓ "}{SYLLABUS_INSTRUMENT_LABELS[inst]}
              </button>
            );
          })}
        </div>

        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
          Level <span style={{ color: "#9ca3af" }}>(screening suggests {SYLLABUS_LEVEL_LABELS[levelFromSlab(slab)]})</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
          {SYLLABUS_LEVELS.map(lv => {
            const sel = syllabusLevel === lv;
            return (
              <button key={lv} onClick={() => setSyllabusLevel(lv)} style={{
                padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                border: sel ? `2px solid ${ACCENT}` : "1px solid #e5e7eb",
                background: sel ? "#fef9ee" : "#fff",
                fontWeight: sel ? 700 : 500, color: sel ? "#92400e" : "#374151",
              }}>
                {sel && "✓ "}{SYLLABUS_LEVEL_LABELS[lv]}
              </button>
            );
          })}
        </div>

        <div style={{ fontSize: 12.5, marginTop: 14, color: !instrument ? "#b91c1c" : slotCount === 0 ? "#b45309" : "#15803d" }}>
          {!instrument
            ? "⚠ Pick the instrument for this student."
            : slotCount === null
              ? "Checking this syllabus…"
              : slotCount === 0
                ? <>⚠ The <strong>{SYLLABUS_LEVEL_LABELS[syllabusLevel]} {SYLLABUS_INSTRUMENT_LABELS[instrument]}</strong> syllabus is empty. Enrolment still works — <Link href={`/dashboard/lessons/import?scope=wing&level=${syllabusLevel}&instrument=${instrument}`} style={{ color: ACCENT, fontWeight: 700 }}>import it</Link> and the student picks it up automatically.</>
                : <>Student gets the <strong>{SYLLABUS_LEVEL_LABELS[syllabusLevel]} {SYLLABUS_INSTRUMENT_LABELS[instrument]}</strong> syllabus — {slotCount} lesson{slotCount !== 1 ? "s" : ""}.</>}
        </div>
      </div>

      {/* Centre */}
      <div style={{ ...card, gridColumn: "span 6" }}>
        <div style={label}>Centre</div>
        {centres.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9ca3af" }}>No {WING_LABELS[WING]} centres found.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {centres.map(c => {
              const sel = centre === c.id;
              return (
                <button key={c.id} onClick={() => {
                  setCentre(c.id);
                  // Prefill the monthly fee from the centre's standard fee (only
                  // if the staff member hasn't already typed one).
                  setFee(f => (!f && c.monthlyFee ? String(c.monthlyFee) : f));
                }} style={{
                  textAlign: "left", padding: "10px 14px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                  border: sel ? `2px solid ${ACCENT}` : "1px solid #e5e7eb",
                  background: sel ? "#fef9ee" : "#fafafa",
                  fontSize: 13, fontWeight: sel ? 700 : 500, color: sel ? "#92400e" : "#374151",
                }}>
                  {sel && "✓ "}{c.name}
                  {c.monthlyFee ? <span style={{ color: "#9ca3af", fontWeight: 400 }}> · ₹{c.monthlyFee}/mo</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Admission number */}
      <div style={{ ...card, gridColumn: "span 6" }}>
        <div style={{ ...label, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Admission Number</span>
          <button
            type="button"
            onClick={generateAdmNo}
            disabled={!centre || genBusy}
            style={{
              textTransform: "none", letterSpacing: 0, fontSize: 11, fontWeight: 700,
              background: "#ede9fe", color: "#4f46e5", border: "none", borderRadius: 6,
              padding: "3px 9px", cursor: centre && !genBusy ? "pointer" : "not-allowed",
              opacity: centre && !genBusy ? 1 : 0.5,
            }}
          >
            {genBusy ? "…" : "⟳ Regenerate"}
          </button>
        </div>
        <input
          value={admNo}
          onChange={e => { setAdmNo(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24)); setAdmNoAuto(false); }}
          placeholder={centre ? "auto-generated" : "select a centre first"}
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10,
            border: admNo.trim().length >= 4 ? "2px solid #16a34a" : "1px solid #d1d5db",
            fontSize: 18, fontFamily: "monospace", fontWeight: 800, letterSpacing: "0.08em",
            color: "#111", outline: "none", background: admNo.trim().length >= 4 ? "#f0fdf4" : "#fff",
          }}
        />
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
          {admNoAuto ? "Auto-generated — edit if you have an existing number." : "Format: ROLCC + admission date + sequence."}
        </div>
      </div>

      {/* Monthly fee */}
      <div style={{ ...card, gridColumn: "span 6" }}>
        <div style={label}>Monthly Fee (₹)</div>
        <input
          value={fee}
          onChange={e => setFee(e.target.value.replace(/\D/g, "").slice(0, 7))}
          placeholder="e.g. 2000"
          inputMode="numeric"
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10,
            border: Number(fee) > 0 ? "2px solid #16a34a" : "1px solid #d1d5db",
            fontSize: 20, fontFamily: "monospace", fontWeight: 800,
            color: "#111", outline: "none", background: Number(fee) > 0 ? "#f0fdf4" : "#fff",
          }}
        />
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
          Prepaid, billed monthly. Prefilled from the centre; editable per student.
        </div>
      </div>

      {err && (
        <div style={{ gridColumn: "span 12", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#dc2626" }}>
          {err}
        </div>
      )}

      <div style={{ gridColumn: "span 12", display: "flex", justifyContent: "space-between", gap: 10 }}>
        <button onClick={onRestart} disabled={enrolling} style={{ ...btn, background: "#f3f4f6", color: "#6b7280" }}>
          Start over
        </button>
        <button onClick={handleEnrol} disabled={!canEnrol} style={{
          ...btn, background: canEnrol ? "#16a34a" : "#e5e7eb", color: canEnrol ? "#fff" : "#9ca3af",
          cursor: canEnrol ? "pointer" : "not-allowed", padding: "13px 26px",
        }}>
          {enrolling ? "Enrolling…" : "Enrol student & download card"}
        </button>
      </div>
    </div>
  );
}
