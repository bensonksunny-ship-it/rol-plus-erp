"use client";

// =============================================================================
// Student Enrollment & Batch Assignment — the last step of a School of Music
// admission. Opened from "🎓 Enroll Student" (applicant card / detail panel)
// and also rendered inline as the admissions wizard's Review & Enrol step, so
// there is one enrolment path. The writes live in services/screening/enroll.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { WINGS } from "@/config/constants";
import { wingOf } from "@/lib/wing";
import { explicitBatches, batchSchedule, DEFAULT_BATCH_NAME } from "@/lib/batches";
import { canEnterAdmissionNo, cleanAdmissionNo } from "@/lib/admissionNumber";
import { readScreeningMarks } from "@/lib/screeningQuestions";
import { generateAdmissionCardPDF, cardInstrument, fastTrackCardScreening } from "@/lib/generateAdmissionCard";
import { useAuthContext } from "@/features/auth/AuthContext";
import { findFastTrackScreeningByName } from "@/services/screening/screening.service";
import { enrollApplicant } from "@/services/screening/enroll.service";
import { getWingSyllabus } from "@/services/lesson/lesson.service";
import type { CenterBatch } from "@/types";
import {
  SYLLABUS_INSTRUMENTS, SYLLABUS_INSTRUMENT_LABELS, SYLLABUS_LEVELS, SYLLABUS_LEVEL_LABELS,
  type SyllabusInstrument, type SyllabusLevel,
} from "@/types/lesson";

const WING = WINGS.SCHOOL_OF_MUSIC;
const ACCENT = "#d97706";

interface CentreOpt { id: string; name: string; monthlyFee?: number; batches: CenterBatch[] }
type Screening = Record<string, unknown> & { id: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Fast Track slab → suggested syllabus level (staff can override). */
function levelFromSlab(track: string): SyllabusLevel {
  if (track.includes("Zeta")) return "advanced";
  if (track.includes("Epsilon")) return "intermediate";
  return "introduction";
}

const labelCss: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.08em", display: "block", marginBottom: 8,
};
const inputCss: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
  border: "1.5px solid #e5e7eb", fontSize: 14, fontFamily: "inherit", color: "#111", background: "#fff", outline: "none",
};
const section: React.CSSProperties = { border: "1px solid #f0f0f0", borderRadius: 14, padding: 16, background: "#fff" };

export default function EnrollStudentModal({
  application, admissionId, screening: screeningProp, onClose, onEnrolled, inline = false,
}: {
  application: Record<string, unknown>;
  admissionId: string;
  /** The saved screening, if the caller already has it; otherwise it's looked up. */
  screening?: Screening | null;
  onClose: () => void;
  onEnrolled: (r: { uid: string; name: string; centreName: string }) => void;
  /** Render as a page section (wizard step 3) instead of a modal. */
  inline?: boolean;
}) {
  const { user } = useAuthContext();
  const canEditAdmNo = canEnterAdmissionNo(user?.role);
  const name = str(application.fullName) || "Student";

  // ── Screening (needed for the level suggestion, links and the card) ──────
  const [screening, setScreening] = useState<Screening | null>(screeningProp ?? null);
  const [scLoading, setScLoading] = useState(!screeningProp);
  useEffect(() => {
    if (screeningProp) return;
    let live = true;
    (async () => {
      try {
        let sc: Screening | null = null;
        const sid = str(application.screeningId);
        if (sid) {
          const snap = await getDoc(doc(db, "screenings", sid));
          if (snap.exists()) sc = { ...(snap.data() as Record<string, unknown>), id: snap.id };
        } else if (name) {
          sc = (await findFastTrackScreeningByName(name, WING)) as unknown as Screening | null;
        }
        if (live) setScreening(sc);
      } catch (err) {
        console.error("[EnrollStudentModal] load screening:", err);
      } finally {
        if (live) setScLoading(false);
      }
    })();
    return () => { live = false; };
  }, [screeningProp, application.screeningId, name]);

  const slab = str((screening?.config as { track?: string } | undefined)?.track);

  // ── Centres + batches ─────────────────────────────────────────────────────
  const [centres, setCentres] = useState<CentreOpt[]>([]);
  const [centreId, setCentreId] = useState("");
  const [batchId, setBatchId] = useState("");
  useEffect(() => {
    getDocs(query(collection(db, "centers"), where("status", "==", "active")))
      .then(snap => {
        const list = snap.docs
          .filter(d => wingOf(d.data()) === WING)
          .map(d => ({
            id: d.id,
            name: str(d.data().name) || d.id,
            monthlyFee: typeof d.data().monthlyFee === "number" ? (d.data().monthlyFee as number) : undefined,
            batches: explicitBatches(d.data()),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCentres(list);
        // Pre-select the centre chosen on the application (stored as id or name).
        const want = str(application.centre).trim().toLowerCase();
        const match = want ? list.find(c => c.id.toLowerCase() === want || c.name.trim().toLowerCase() === want) : undefined;
        if (match) setCentreId(match.id);
      })
      .catch(err => console.error("[EnrollStudentModal] load centres:", err));
  }, [application.centre]);

  const centre = centres.find(c => c.id === centreId);
  const batches = useMemo(() => centre?.batches ?? [], [centre]);
  // One batch → pick it; none → General Batch; several → staff must choose.
  useEffect(() => { setBatchId(batches.length === 1 ? batches[0].id : ""); }, [centreId, batches]);
  const needsBatch = batches.length > 1;

  // ── Course, fee, start date, admission number ─────────────────────────────
  const [instrument, setInstrument] = useState<SyllabusInstrument>(() => cardInstrument(application.instrumentsToLearn));
  const [level, setLevel] = useState<SyllabusLevel | "">("");
  useEffect(() => { if (!level && screening) setLevel(levelFromSlab(slab)); }, [screening, slab, level]);
  const [slotCount, setSlotCount] = useState<number | null>(null);
  useEffect(() => {
    if (!level) return;
    setSlotCount(null);
    getWingSyllabus(WING, level, instrument).then(ls => setSlotCount(ls.length)).catch(() => setSlotCount(null));
  }, [level, instrument]);

  const [fee, setFee] = useState(() => (typeof application.monthlyFee === "number" ? String(application.monthlyFee) : ""));
  const [feeTouched, setFeeTouched] = useState(false);
  useEffect(() => {
    if (!feeTouched && centre?.monthlyFee) setFee(String(centre.monthlyFee));
  }, [centre, feeTouched]);

  const [startDate, setStartDate] = useState(todayYMD());
  const [admNo, setAdmNo] = useState(() => str(application.admissionNumber));

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const missing = [
    !screening && "screening",
    !str(application.photo) && "photo",
    !centreId && "centre",
    needsBatch && !batchId && "batch",
    !level && "syllabus level",
    !(Number(fee) > 0) && "monthly fee",
    !startDate && "start date",
    admNo.trim().length < 4 && "admission number",
  ].filter(Boolean) as string[];

  async function confirm() {
    if (missing.length || saving || !screening || !level) return;
    setSaving(true);
    setErr("");
    try {
      const batch = batches.find(b => b.id === batchId) ?? null;
      const uid = await enrollApplicant({
        application, admissionId, screening,
        centreId, batch, admissionNo: admNo, instrument, syllabusLevel: level,
        monthlyFee: Number(fee), startDate, enrolledBy: user?.uid ?? "",
      });
      // The admission card is a convenience — never fail the enrolment over it.
      await generateAdmissionCardPDF(
        { ...application, id: admissionId, admissionNumber: admNo.trim() },
        fastTrackCardScreening(screening, instrument),
      ).catch(e => console.error("[EnrollStudentModal] admission card PDF:", e));
      onEnrolled({ uid, name, centreName: centre?.name ?? "" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Enrolment failed.");
      setSaving(false);
    }
  }

  const marks = screening ? readScreeningMarks(screening) : null;

  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Who + readiness */}
      <div style={{ ...section, display: "flex", gap: 14, alignItems: "center" }}>
        <div style={{ width: 52, height: 64, borderRadius: 8, overflow: "hidden", background: "#f3f4f6", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {str(application.photo) ? <img src={str(application.photo)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 22 }}>👤</span>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>{name}</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {scLoading ? "Loading screening…"
              : screening ? `Screened · ${slab || "Fast Track"}${marks?.total != null ? ` · ${marks.total}/15` : ""}`
              : "⚠ No screening found — conduct the screening first."}
            {!str(application.photo) && " · ⚠ Photo missing"}
          </div>
        </div>
      </div>

      {/* Centre */}
      <div style={section}>
        <label style={labelCss}>Assigned centre *</label>
        <select value={centreId} onChange={e => setCentreId(e.target.value)} style={{ ...inputCss, cursor: "pointer" }}>
          <option value="">— Select centre —</option>
          {centres.map(c => <option key={c.id} value={c.id}>{c.name}{c.monthlyFee ? ` · ₹${c.monthlyFee}/mo` : ""}</option>)}
        </select>
        {str(application.centre) && !centre && centres.length > 0 && (
          <div style={{ fontSize: 11, color: "#92400e", marginTop: 6 }}>Applied for “{str(application.centre)}” — not an active centre, please choose one.</div>
        )}

        {centre && (
          <div style={{ marginTop: 14 }}>
            <label style={labelCss}>Batch {needsBatch && "*"}</label>
            {batches.length === 0 ? (
              <div style={{ fontSize: 13, color: "#374151" }}>
                {DEFAULT_BATCH_NAME} <span style={{ color: "#9ca3af" }}>(centre schedule — this centre has no separate batches)</span>
              </div>
            ) : (
              <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {batches.map(b => {
                  const on = batchId === b.id;
                  const sched = batchSchedule(b);
                  return (
                    <label key={b.id} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, cursor: "pointer",
                      border: on ? `2px solid ${ACCENT}` : "1.5px solid #e5e7eb", background: on ? "#fffbeb" : "#fff",
                    }}>
                      <input type="radio" name="enrol-batch" checked={on} onChange={() => setBatchId(b.id)} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{b.name || "Unnamed batch"}</span>
                      {sched && <span style={{ fontSize: 12, color: "#6b7280" }}>{sched}</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Course */}
      <div style={{ ...section, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <div>
          <label style={labelCss}>Instrument *</label>
          <select value={instrument} onChange={e => setInstrument(e.target.value as SyllabusInstrument)} style={{ ...inputCss, cursor: "pointer" }}>
            {SYLLABUS_INSTRUMENTS.map(i => <option key={i} value={i}>{SYLLABUS_INSTRUMENT_LABELS[i]}</option>)}
          </select>
        </div>
        <div>
          <label style={labelCss}>Syllabus level *</label>
          <select value={level} onChange={e => setLevel(e.target.value as SyllabusLevel)} style={{ ...inputCss, cursor: "pointer" }}>
            <option value="">— Select —</option>
            {SYLLABUS_LEVELS.map(l => <option key={l} value={l}>{SYLLABUS_LEVEL_LABELS[l]}</option>)}
          </select>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>
            {slab ? `Suggested from ${slab}` : ""}{slotCount != null ? ` · ${slotCount} lesson${slotCount !== 1 ? "s" : ""}` : ""}
          </div>
        </div>
      </div>

      {/* Fee, start date, admission number */}
      <div style={{ ...section, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <div>
          <label style={labelCss}>Monthly fee (₹) *</label>
          <input value={fee} inputMode="numeric" onChange={e => { setFeeTouched(true); setFee(e.target.value.replace(/[^\d]/g, "").slice(0, 7)); }} placeholder="e.g. 1500" style={inputCss} />
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>Prepaid, billed monthly</div>
        </div>
        <div>
          <label style={labelCss}>Start date *</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputCss} />
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>First class — used as the admission date</div>
        </div>
        <div>
          <label style={labelCss}>Admission number *</label>
          <input value={admNo} readOnly={!canEditAdmNo} autoComplete="off"
            onChange={e => setAdmNo(cleanAdmissionNo(e.target.value))}
            placeholder={canEditAdmNo ? "Enter admission number" : "Not entered yet"}
            style={{ ...inputCss, fontFamily: "monospace", fontWeight: 800, letterSpacing: "0.06em", background: canEditAdmNo ? "#fff" : "#f3f4f6" }} />
          <div style={{ fontSize: 11, color: !canEditAdmNo && !admNo ? "#dc2626" : "#9ca3af", marginTop: 5 }}>
            {canEditAdmNo ? "Entered manually · checked for duplicates" : admNo ? "Set by Chief Teacher / Director" : "A Chief Teacher or Director must enter it"}
          </div>
        </div>
      </div>

      {err && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 12px", fontSize: 13, color: "#dc2626" }}>{err}</div>}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {missing.length ? `Still needed: ${missing.join(", ")}` : "Adds the student to Registry, the centre roster, Attendance and Finance."}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={confirm} disabled={!!missing.length || saving} style={{
            padding: "10px 20px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 800,
            background: missing.length || saving ? "#e5e7eb" : "#065f46", color: missing.length || saving ? "#9ca3af" : "#fff",
            cursor: missing.length || saving ? "not-allowed" : "pointer",
          }}>
            {saving ? "Enrolling…" : "✓ Confirm & Complete Enrollment"}
          </button>
        </div>
      </div>
    </div>
  );

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#065f46" }}>🎓 Enroll Student</div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Confirm centre, batch, course, fee and start date</div>
      </div>
      {!inline && <button onClick={onClose} disabled={saving} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af" }}>✕</button>}
    </div>
  );

  if (inline) return <div>{header}{body}</div>;

  return (
    <div onClick={saving ? undefined : onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div role="dialog" aria-label="Enroll student" onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 640, background: "#faf9f7", borderRadius: 18, padding: 20, margin: "24px 0", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", boxSizing: "border-box" }}>
        {header}
        {body}
      </div>
    </div>
  );
}
