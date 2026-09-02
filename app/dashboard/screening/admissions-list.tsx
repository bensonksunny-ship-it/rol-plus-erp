"use client";

// Extracted from ./page.tsx so both the ROL+ Screening hub and the School of
// Music Admissions page can render the applications list.

import { useState, useEffect, useRef } from "react";
import { collection, getDocs, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import Link from "next/link";
import { ROLES, WINGS, WING_LABELS } from "@/config/constants";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useWing } from "@/hooks/useWing";
import {
  getAllAdmissions,
  getAdmissionsByTeacher,
  updateAdmission,
  deleteAdmission,
  moveAdmissionToWing,
} from "@/services/screening/screening.service";
import { AdmissionFormContent, OptionGroup, MultiOptionGroup } from "./admission-form";
import { generateAdmissionCardPDF } from "@/lib/generateAdmissionCard";

const s: Record<string, React.CSSProperties> = {
  card: {
    background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
    padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
  },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 18 },
  field: { marginBottom: 18 },
  label: { fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 },
  input: {
    width: "100%", boxSizing: "border-box", border: "1.5px solid #f0f0f0", borderRadius: 10,
    padding: "10px 13px", fontSize: 13, outline: "none", fontFamily: "inherit", color: "#111", background: "#fafafa",
  },
  primaryBtn: {
    padding: "11px 22px", borderRadius: 12, border: "none", background: "#4f46e5",
    color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
  },
  secondaryBtn: {
    padding: "11px 22px", borderRadius: 12, border: "none", background: "#f3f4f6",
    color: "#6b7280", fontSize: 13, fontWeight: 700, cursor: "pointer",
  },
};

function EditAdmissionOverlay({
  record,
  centresList,
  onSave,
  onCancel,
}: {
  record:      Record<string, unknown>;
  centresList: { id: string; name: string }[];
  onSave:      (updated: Record<string, unknown>) => Promise<void>;
  onCancel:    () => void;
}) {
  function rs(v: unknown): string    { return typeof v === "string" ? v : ""; }
  function ra(v: unknown): string[]  { return Array.isArray(v) ? v.map(String) : []; }
  function rn(v: unknown): number | null { return typeof v === "number" ? v : null; }

  const dobParts = rs(record.dob).split("/");

  const [admissionNumber,    setAdmissionNumber]    = useState(rs(record.admissionNumber));
  const [fullName,           setFullName]           = useState(rs(record.fullName));
  const [age,                setAge]                = useState(rs(record.age));
  const [dobDD,              setDobDD]              = useState(dobParts[0] ?? "");
  const [dobMM,              setDobMM]              = useState(dobParts[1] ?? "");
  const [dobYYYY,            setDobYYYY]            = useState(dobParts[2] ?? "");
  const [parentName,         setParentName]         = useState(rs(record.parentName));
  const [workingStatus,      setWorkingStatus]      = useState(rs(record.workingStatus));
  const [schoolCompany,      setSchoolCompany]      = useState(rs(record.schoolCompany));
  const [phone,              setPhone]              = useState(rs(record.phone));
  const [email,              setEmail]              = useState(rs(record.email));
  const [address1,           setAddress1]           = useState(rs(record.address1));
  const [address2,           setAddress2]           = useState(rs(record.address2));
  const [centre,             setCentre]             = useState(() => { const raw = rs(record.centre); const found = centresList.find(c => c.id === raw); return found ? found.name : raw; });
  const [purposeOfLearning,  setPurposeOfLearning]  = useState(rs(record.purposeOfLearning));
  const [instrumentsToLearn, setInstrumentsToLearn] = useState<string[]>(ra(record.instrumentsToLearn));
  const [previousExperience, setPreviousExperience] = useState(rs(record.previousExperience));
  const [instrumentsPlayed,  setInstrumentsPlayed]  = useState<string[]>(ra(record.instrumentsPlayed));
  const [musicalSkill,       setMusicalSkill]       = useState(rs(record.musicalSkill));
  const [howHeardAboutUs,    setHowHeardAboutUs]    = useState(rs(record.howHeardAboutUs));
  const [initialExperience,  setInitialExperience]  = useState<number | null>(rn(record.initialExperience));
  const [parentPartnerProgram, setParentPartnerProgram] = useState(rs(record.parentPartnerProgram));
  const [photoDataUrl,       setPhotoDataUrl]       = useState<string | null>(rs(record.photo) || null);

  const fileInputRef   = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [saving,   setSaving]   = useState(false);
  const [saveErr,  setSaveErr]  = useState("");

  function compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX_W = 320, MAX_H = 420;
        const ratio = Math.min(MAX_W / img.width, MAX_H / img.height, 1);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load failed")); };
      img.src = url;
    });
  }

  function handlePhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    compressImage(file).then(setPhotoDataUrl).catch(() => {});
    e.target.value = "";
  }

  async function handleSave() {
    if (!fullName.trim() || !phone.trim() || saving) return;
    setSaving(true); setSaveErr("");
    try {
      await onSave({
        admissionNumber: admissionNumber.trim(),
        fullName: fullName.trim(), age: age.trim(),
        dob: `${dobDD}/${dobMM}/${dobYYYY}`,
        parentName: parentName.trim(), workingStatus, schoolCompany: schoolCompany.trim(),
        phone: phone.trim(), email: email.trim(),
        address1: address1.trim(), address2: address2.trim(), centre,
        purposeOfLearning, instrumentsToLearn, previousExperience,
        instrumentsPlayed, musicalSkill, howHeardAboutUs: howHeardAboutUs.trim(),
        initialExperience, parentPartnerProgram, photo: photoDataUrl ?? null,
      });
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save.");
      setSaving(false);
    }
  }

  const canSave = fullName.trim().length > 0 && phone.trim().length > 0;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 12px" }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 640, boxShadow: "0 24px 64px rgba(0,0,0,0.2)" }}>
        {/* Header */}
        <div style={{ padding: "18px 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>✏️ Edit Application</div>
          <button onClick={onCancel} style={{ border: "none", background: "#f3f4f6", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13, color: "#374151" }}>✕ Cancel</button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", maxHeight: "72vh", overflowY: "auto", display: "flex", flexDirection: "column" as const, gap: 20 }}>
          {/* Admission Number */}
          <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4338ca", marginBottom: 8 }}>Admission Number <span style={{ fontSize: 11, fontWeight: 400, color: "#6366f1" }}>(11 digits)</span></div>
            <input
              value={admissionNumber}
              onChange={e => setAdmissionNumber(e.target.value.replace(/\D/g, "").slice(0, 11))}
              placeholder="00000000000"
              maxLength={11}
              style={{ ...s.input, fontFamily: "monospace", fontSize: 15, fontWeight: 700, letterSpacing: "0.12em", color: "#4338ca", background: "#fff", maxWidth: 200 }}
            />
          </div>

          {/* Personal */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Personal Information</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 3 }}>
                <label style={s.label}>Full Name *</label>
                <input value={fullName} onChange={e => setFullName(e.target.value)} style={s.input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Age</label>
                <input value={age} onChange={e => setAge(e.target.value)} type="number" min={0} style={s.input} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Date of Birth</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={dobDD} onChange={e => setDobDD(e.target.value)} placeholder="DD" maxLength={2} style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} />
                  <span style={{ color: "#9ca3af" }}>/</span>
                  <input value={dobMM} onChange={e => setDobMM(e.target.value)} placeholder="MM" maxLength={2} style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} />
                  <span style={{ color: "#9ca3af" }}>/</span>
                  <input value={dobYYYY} onChange={e => setDobYYYY(e.target.value)} placeholder="YYYY" maxLength={4} style={{ ...s.input, width: 68, textAlign: "center" as const, boxSizing: "border-box" as const }} />
                </div>
              </div>
              <div style={{ flex: 1.5 }}>
                <label style={s.label}>Parent / Guardian</label>
                <input value={parentName} onChange={e => setParentName(e.target.value)} style={s.input} />
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={s.label}>Working Status</label>
              <OptionGroup options={["Student","Working","Part Time","Not Working"]} value={workingStatus} onChange={setWorkingStatus} />
            </div>
            <div>
              <label style={s.label}>School / Company</label>
              <input value={schoolCompany} onChange={e => setSchoolCompany(e.target.value)} style={s.input} />
            </div>
          </div>

          {/* Contact */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Contact Information</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Phone *</label>
                <input value={phone} onChange={e => setPhone(e.target.value)} type="tel" style={s.input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Email</label>
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" style={s.input} />
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={s.label}>Address Line 1</label>
              <input value={address1} onChange={e => setAddress1(e.target.value)} style={s.input} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 2 }}>
                <label style={s.label}>Address Line 2</label>
                <input value={address2} onChange={e => setAddress2(e.target.value)} style={s.input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Centre</label>
                {centresList.length > 0 ? (
                  <select value={centre} onChange={e => setCentre(e.target.value)} style={{ ...s.input, cursor: "pointer" }}>
                    <option value="">— Select —</option>
                    {centresList.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                ) : (
                  <input value={centre} onChange={e => setCentre(e.target.value)} style={s.input} />
                )}
              </div>
            </div>
          </div>

          {/* Musical */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Musical Skills</div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Purpose of Learning</label>
              <OptionGroup options={["Formal Music Learning","Skill Development","Entertainment"]} value={purposeOfLearning} onChange={setPurposeOfLearning} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Instruments to Learn</label>
              <MultiOptionGroup options={["Piano","Keyboard","Guitar","Drums","Violin","Vocal"]} values={instrumentsToLearn} onChange={setInstrumentsToLearn} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Previous Experience</label>
              <OptionGroup options={["Well-Trained","Average","No Previous Experience"]} value={previousExperience} onChange={setPreviousExperience} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Instruments Already Playing</label>
              <MultiOptionGroup options={["Guitar","Drums","Keyboard","None of the Above"]} values={instrumentsPlayed} onChange={setInstrumentsPlayed} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Musical Skill</label>
              <OptionGroup options={["Excellent","Average","Poor"]} value={musicalSkill} onChange={setMusicalSkill} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>How Heard About Us</label>
              <input value={howHeardAboutUs} onChange={e => setHowHeardAboutUs(e.target.value)} style={s.input} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Initial Experience (/ 10)</label>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <button key={n} type="button"
                    onClick={() => setInitialExperience(initialExperience === n ? null : n)}
                    style={{ width: 38, height: 38, borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13,
                      background: initialExperience === n ? "#4f46e5" : "#f3f4f6",
                      color:      initialExperience === n ? "#fff" : "#374151",
                      fontWeight: initialExperience === n ? 800 : 500,
                    }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={s.label}>Parent Partner Program</label>
              <OptionGroup options={["Yes","No","Want to Know More"]} value={parentPartnerProgram} onChange={setParentPartnerProgram} />
            </div>
          </div>

          {/* Photo */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 12 }}>Candidate Photo</div>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handlePhotoFile} />
            <input ref={fileInputRef}   type="file" accept="image/*"                       style={{ display: "none" }} onChange={handlePhotoFile} />
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
              <div style={{ width: 90, height: 112, flexShrink: 0, border: "2px dashed #d1d5db", borderRadius: 8, background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                {photoDataUrl
                  ? <img src={photoDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontSize: 26, color: "#d1d5db" }}>📷</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                <button type="button" onClick={() => cameraInputRef.current?.click()} style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #4f46e5", background: "#ede9fe", color: "#4f46e5", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>📸 Take Photo</button>
                <button type="button" onClick={() => fileInputRef.current?.click()} style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>🖼️ Upload</button>
                {photoDataUrl && <button type="button" onClick={() => setPhotoDataUrl(null)} style={{ padding: "6px 14px", borderRadius: 7, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: 12, cursor: "pointer" }}>Remove</button>}
              </div>
            </div>
          </div>

          {saveErr && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 7, padding: "9px 13px", fontSize: 13, color: "#dc2626" }}>{saveErr}</div>}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onCancel} style={s.secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave || saving}
            style={{ ...s.primaryBtn, opacity: canSave && !saving ? 1 : 0.4, cursor: canSave && !saving ? "pointer" : "not-allowed" }}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Admission applications list ─────────────────────────────────────────────

export function AdmissionsList({
  onStartScreening,
  onNewAdmission,
  onResume,
}: {
  onStartScreening?: (name: string) => void;
  /** When set, the "＋ New Admission" buttons call this instead of a link/modal. */
  onNewAdmission?: () => void;
  /** When set (School of Music, inside the Admissions page), each card gets a
   *  "Continue →" button that hands the application back to the wizard. */
  onResume?: (rec: Record<string, unknown>) => void;
} = {}) {
  const { user }       = useAuthContext();
  const { wing }       = useWing();
  const [admissions,   setAdmissions]   = useState<Record<string, unknown>[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [selected,     setSelected]     = useState<Record<string, unknown> | null>(null);
  const [editing,      setEditing]      = useState<Record<string, unknown> | null>(null);
  const [deleteId,     setDeleteId]     = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [movingId,     setMovingId]     = useState<string | null>(null);
  const [menu,         setMenu]         = useState<{ id: string; rec: Record<string, unknown>; x: number; y: number } | null>(null);

  const otherWing      = wing === WINGS.SCHOOL_OF_MUSIC ? WINGS.ROL_PLUS : WINGS.SCHOOL_OF_MUSIC;
  const otherWingLabel = WING_LABELS[otherWing] ?? otherWing;
  const [centresList,  setCentresList]  = useState<{ id: string; name: string }[]>([]);
  const [showForm,     setShowForm]     = useState(false);
  const [pdfLoading,   setPdfLoading]   = useState<string | null>(null);

  // Screening lookup map: keyed by studentId and by lowercased studentName
  const [screeningMap, setScreeningMap] = useState<Map<string, Record<string, unknown>>>(new Map());

  // Complete-admission modal state
  const [completing,       setCompleting]       = useState<{ admission: Record<string, unknown>; screening: Record<string, unknown> } | null>(null);
  const [completingAdmNo,  setCompletingAdmNo]  = useState("");
  const [completingSaving, setCompletingSaving] = useState("");
  const [completingPhase,  setCompletingPhase]  = useState<"number" | "success" | "enroll">("number");
  const [enrollCentre,     setEnrollCentre]     = useState("");
  const [enrolling,        setEnrolling]        = useState(false);

  function closeCompleting() {
    setCompleting(null); setCompletingAdmNo(""); setCompletingPhase("number"); setEnrollCentre("");
  }

  function str(v: unknown): string   { return typeof v === "string" ? v : ""; }
  function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }
  function num(v: unknown): number | null { return typeof v === "number" ? v : null; }

  function reload() {
    setLoading(true);
    (user?.role === ROLES.TEACHER && user.uid
      ? getAdmissionsByTeacher(user.uid)
      : getAllAdmissions()
    )
      .then(list => setAdmissions(list.filter(a => (typeof a.wing === "string" ? a.wing : "rol_plus") === wing)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  // Re-fetch whenever the active wing changes — the founder's wing switcher
  // does not remount this component, so without this the list would keep
  // showing the wing that was active when it first mounted (and applications
  // just moved to the other wing would never appear).
  useEffect(() => {
    reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wing]);

  useEffect(() => {
    getDocs(collection(db, "centers"))
      .then(snap => setCentresList(snap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id }))))
      .catch(() => {});
    // Build screening lookup map from all 3 instrument collections
    Promise.all(
      ["guitar-screenings", "keyboard-screenings", "drum-screenings"].map(col => getDocs(collection(db, col)))
    ).then(snaps => {
      const map = new Map<string, Record<string, unknown>>();
      for (const snap of snaps) {
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          const sid  = typeof data.studentId   === "string" ? data.studentId   : "";
          const snam = typeof data.studentName === "string" ? data.studentName.toLowerCase() : "";
          if (sid)  map.set(sid,  data);
          if (snam) map.set(snam, data);
        }
      }
      setScreeningMap(map);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveEdit(id: string, updated: Record<string, unknown>) {
    await updateAdmission(id, updated);
    setAdmissions(prev => prev.map(a => str(a.id) === id ? { ...a, ...updated } : a));
    setSelected(prev => prev && str(prev.id) === id ? { ...prev, ...updated } : prev);
    setEditing(null);
  }

  async function handleDelete(id: string) {
    setDeleteSubmitting(true);
    try {
      await deleteAdmission(id);
      setAdmissions(prev => prev.filter(a => str(a.id) !== id));
      if (selected && str(selected.id) === id) setSelected(null);
      setDeleteId(null);
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  async function handleMove(id: string) {
    setMovingId(id);
    try {
      await moveAdmissionToWing(id, otherWing);
      // It now belongs to the other wing — drop it from this list.
      setAdmissions(prev => prev.filter(a => str(a.id) !== id));
      if (selected && str(selected.id) === id) setSelected(null);
    } catch (err) {
      console.error("Move failed:", err);
    } finally {
      setMovingId(null);
    }
  }

  function getScreening(rec: Record<string, unknown>): Record<string, unknown> | null {
    return screeningMap.get(str(rec.id))
        || screeningMap.get(str(rec.fullName).toLowerCase())
        || null;
  }

  async function handleRedownload(admission: Record<string, unknown>) {
    const id = str(admission.id);
    setPdfLoading(id);
    try {
      await generateAdmissionCardPDF(admission, getScreening(admission));
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setPdfLoading(null);
    }
  }

  async function handleCompleteAdmission() {
    if (!completing || completingAdmNo.length !== 11 || completingSaving) return;
    setCompletingSaving("saving");
    try {
      const id      = str(completing.admission.id);
      const updated = { ...completing.admission, admissionNumber: completingAdmNo };
      await updateAdmission(id, { admissionNumber: completingAdmNo });
      setAdmissions(prev => prev.map(a => str(a.id) === id ? updated : a));
      setCompletingSaving("downloading");
      await generateAdmissionCardPDF(updated, completing.screening);
      // Advance to success phase — keep modal open for enroll option
      setCompleting({ ...completing, admission: updated });
      setCompletingPhase("success");
    } catch (err) {
      console.error("Complete admission failed:", err);
    } finally {
      setCompletingSaving("");
    }
  }

  async function handleEnrollStudent() {
    if (!completing || !enrollCentre || enrolling) return;
    setEnrolling(true);
    try {
      const adm = completing.admission;
      await addDoc(collection(db, "users"), {
        name:            str(adm.fullName),
        role:            "student",
        phone:           str(adm.phone),
        email:           str(adm.email),
        age:             str(adm.age),
        dob:             str(adm.dob),
        parentName:      str(adm.parentName),
        workingStatus:   str(adm.workingStatus),
        schoolCompany:   str(adm.schoolCompany),
        address1:        str(adm.address1),
        address2:        str(adm.address2),
        centre:          enrollCentre,
        admissionNumber: str(adm.admissionNumber),
        studentID:       str(adm.admissionNumber),
        instruments:     arr(adm.instrumentsToLearn),
        musicalSkill:    str(adm.musicalSkill),
        photo:           str(adm.photo) || null,
        wing,
        createdAt:       serverTimestamp(),
      });
      await deleteAdmission(str(adm.id));
      setAdmissions(prev => prev.filter(a => str(a.id) !== str(adm.id)));
      closeCompleting();
    } catch (err) {
      console.error("Enrollment failed:", err);
    } finally {
      setEnrolling(false);
    }
  }

  if (loading) {
    return <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 13 }}>Loading…</div>;
  }

  const formModal = showForm ? (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.55)", overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "16px" }}>
      <div style={{ width: "100%", maxWidth: 640, borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", background: "#fff", margin: "20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>📋 New Admission Application</div>
          <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1, padding: 4 }}>✕</button>
        </div>
        <AdmissionFormContent onDone={() => { setShowForm(false); reload(); }} />
      </div>
    </div>
  ) : null;

  if (admissions.length === 0) {
    return (
      <>
        {formModal}
        <div style={{ textAlign: "center", padding: "60px 24px", color: "#9ca3af" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#374151", marginBottom: 6 }}>No applications yet</div>
          <div style={{ fontSize: 13, marginBottom: 24 }}>Submitted forms will appear here.</div>
          {onNewAdmission ? (
            <button onClick={onNewAdmission} style={s.primaryBtn}>
              + New Admission
            </button>
          ) : wing === WINGS.SCHOOL_OF_MUSIC ? (
            <Link href="/dashboard/admissions" style={{ ...s.primaryBtn, textDecoration: "none" }}>
              + New Admission
            </Link>
          ) : (
            <button onClick={() => setShowForm(true)} style={s.primaryBtn}>
              + New Admission
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div>
      {formModal}
      {/* Edit overlay */}
      {editing && (
        <EditAdmissionOverlay
          record={editing}
          centresList={centresList}
          onSave={async (updated) => { await handleSaveEdit(str(editing.id), updated); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* Delete confirmation overlay */}
      {deleteId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 28px", maxWidth: 380, width: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.2)", textAlign: "center" as const }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🗑️</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111", marginBottom: 6 }}>Delete Application?</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 22 }}>
              This will permanently remove the application. This action cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={() => setDeleteId(null)}
                disabled={deleteSubmitting}
                style={{ ...s.secondaryBtn, minWidth: 90 }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                disabled={deleteSubmitting}
                style={{ ...s.primaryBtn, background: "#dc2626", minWidth: 90, opacity: deleteSubmitting ? 0.6 : 1, cursor: deleteSubmitting ? "not-allowed" : "pointer" }}
              >
                {deleteSubmitting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Complete Admission modal (3 phases) ── */}
      {completing && (
        <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 460, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>

            {/* ─ PHASE 1: Enter admission number ─ */}
            {completingPhase === "number" && (<>
              <div style={{ background: "#16a34a", borderRadius: "16px 16px 0 0", padding: "18px 24px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>✅ Complete Admission</div>
                <div style={{ fontSize: 12, color: "#bbf7d0", marginTop: 3 }}>{str(completing.admission.fullName)}</div>
              </div>
              <div style={{ padding: "14px 24px", background: "#f0fdf4", borderBottom: "1px solid #d1fae5" }}>
                {(() => {
                  const sc = completing.screening;
                  const cfg = sc.config as Record<string, unknown> | undefined;
                  return (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                      <span style={{ background: "#dcfce7", color: "#15803d", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99 }}>
                        {str(sc.instrument).charAt(0).toUpperCase() + str(sc.instrument).slice(1)}
                      </span>
                      <span style={{ background: "#f3f4f6", color: "#374151", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 99 }}>
                        {str(sc.stream).replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                      {cfg && str(cfg.track) && (
                        <span style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99 }}>
                          {str(cfg.track)}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div style={{ padding: "24px 24px 20px" }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: "#374151", display: "block", marginBottom: 8 }}>
                  Admission Number <span style={{ fontWeight: 400, color: "#9ca3af" }}>(11 digits)</span>
                </label>
                <input
                  value={completingAdmNo}
                  onChange={e => setCompletingAdmNo(e.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="00000000000"
                  maxLength={11}
                  autoFocus
                  style={{
                    width: "100%", boxSizing: "border-box" as const,
                    padding: "12px 16px", borderRadius: 10,
                    border: completingAdmNo.length === 11 ? "2px solid #16a34a" : completingAdmNo.length > 0 ? "2px solid #d97706" : "1px solid #d1d5db",
                    fontSize: 22, fontFamily: "monospace", fontWeight: 800,
                    letterSpacing: "0.18em", color: "#111", outline: "none",
                    background: completingAdmNo.length === 11 ? "#f0fdf4" : "#fff",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: completingAdmNo.length === 11 ? "#16a34a" : "#9ca3af" }}>
                    {completingAdmNo.length}/11 digits{completingAdmNo.length === 11 ? " ✓" : ""}
                  </span>
                  {completingAdmNo.length > 0 && completingAdmNo.length < 11 && (
                    <span style={{ fontSize: 11, color: "#d97706" }}>{11 - completingAdmNo.length} more needed</span>
                  )}
                </div>
              </div>
              <div style={{ padding: "0 24px 20px", display: "flex", gap: 10 }}>
                <button onClick={closeCompleting} disabled={!!completingSaving} style={{ ...s.secondaryBtn, flex: 1 }}>Cancel</button>
                <button
                  onClick={handleCompleteAdmission}
                  disabled={completingAdmNo.length !== 11 || !!completingSaving}
                  style={{ ...s.primaryBtn, flex: 2, background: "#16a34a", opacity: completingAdmNo.length === 11 && !completingSaving ? 1 : 0.45, cursor: completingAdmNo.length === 11 && !completingSaving ? "pointer" : "not-allowed" }}
                >
                  {completingSaving === "saving" ? "Saving…" : completingSaving === "downloading" ? "Generating PDF…" : "Save & Download PDF"}
                </button>
              </div>
            </>)}

            {/* ─ PHASE 2: Success — offer enroll ─ */}
            {completingPhase === "success" && (<>
              <div style={{ background: "#16a34a", borderRadius: "16px 16px 0 0", padding: "18px 24px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>🎉 Admission Complete</div>
                <div style={{ fontSize: 12, color: "#bbf7d0", marginTop: 3 }}>{str(completing.admission.fullName)}</div>
              </div>
              <div style={{ padding: "28px 24px" }}>
                <div style={{ background: "#f0fdf4", border: "1px solid #d1fae5", borderRadius: 12, padding: "16px 20px", marginBottom: 20, textAlign: "center" as const }}>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Admission Number</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: 800, color: "#15803d", letterSpacing: "0.14em" }}>
                    {str(completing.admission.admissionNumber)}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#374151", marginBottom: 6 }}>
                  The Admission Card PDF has been downloaded. Would you like to enroll this student now?
                </div>
                <div style={{ fontSize: 12, color: "#9ca3af" }}>
                  Enrolling will add the student to the Students list and remove them from Applications.
                </div>
              </div>
              <div style={{ padding: "0 24px 24px", display: "flex", gap: 10 }}>
                <button onClick={closeCompleting} style={{ ...s.secondaryBtn, flex: 1 }}>Close</button>
                <button
                  onClick={() => setCompletingPhase("enroll")}
                  style={{ ...s.primaryBtn, flex: 2, background: "#4f46e5" }}
                >
                  Enroll Student →
                </button>
              </div>
            </>)}

            {/* ─ PHASE 3: Select centre & enroll ─ */}
            {completingPhase === "enroll" && (<>
              <div style={{ background: "#4f46e5", borderRadius: "16px 16px 0 0", padding: "18px 24px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>🏫 Enroll Student</div>
                <div style={{ fontSize: 12, color: "#c7d2fe", marginTop: 3 }}>{str(completing.admission.fullName)}</div>
              </div>
              <div style={{ padding: "28px 24px" }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: "#374151", display: "block", marginBottom: 10 }}>
                  Select Centre
                </label>
                {centresList.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                    {centresList.map(c => {
                      const sel = enrollCentre === c.id;
                      return (
                        <button key={c.id} onClick={() => setEnrollCentre(c.id)}
                          style={{ textAlign: "left", padding: "12px 16px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                            border: sel ? "2px solid #4f46e5" : "1px solid #e5e7eb",
                            background: sel ? "#ede9fe" : "#f9fafb",
                            display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                            background: sel ? "#4f46e5" : "#d1d5db", transition: "background 0.15s" }} />
                          <span style={{ fontSize: 13, fontWeight: sel ? 700 : 500, color: sel ? "#4f46e5" : "#374151" }}>
                            {c.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: "16px", background: "#f9fafb", borderRadius: 10, fontSize: 13, color: "#9ca3af", textAlign: "center" as const }}>
                    No centres found in database.
                  </div>
                )}
              </div>
              <div style={{ padding: "0 24px 24px", display: "flex", gap: 10 }}>
                <button onClick={() => setCompletingPhase("success")} disabled={enrolling} style={{ ...s.secondaryBtn, flex: 1 }}>← Back</button>
                <button
                  onClick={handleEnrollStudent}
                  disabled={!enrollCentre || enrolling}
                  style={{ ...s.primaryBtn, flex: 2, background: "#4f46e5", opacity: enrollCentre && !enrolling ? 1 : 0.45, cursor: enrollCentre && !enrolling ? "pointer" : "not-allowed" }}
                >
                  {enrolling ? "Enrolling…" : "Confirm Enrollment"}
                </button>
              </div>
            </>)}

          </div>
        </div>
      )}

      {/* ── Detail panel ── */}
      {selected && (
        <div style={{
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
          padding: "24px", marginBottom: 20, position: "relative" as const,
          boxShadow: "0 4px 24px rgba(0,0,0,0.07)",
        }}>
          {/* Action row */}
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" as const }}>
            {onResume ? (
              <button
                onClick={() => onResume(selected)}
                style={{
                  padding: "9px 16px", borderRadius: 8, border: "none",
                  background: "#4f46e5", color: "#fff",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                Continue in wizard →
              </button>
            ) : wing === WINGS.SCHOOL_OF_MUSIC ? (
              <Link
                href="/dashboard/admissions"
                style={{
                  padding: "9px 16px", borderRadius: 8, border: "none",
                  background: "#4f46e5", color: "#fff",
                  fontSize: 13, fontWeight: 700, cursor: "pointer", textDecoration: "none",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                📝 Admissions wizard
              </Link>
            ) : (
              <button
                onClick={() => { onStartScreening?.(str(selected.fullName)); }}
                style={{
                  padding: "9px 16px", borderRadius: 8, border: "none",
                  background: "#4f46e5", color: "#fff",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                🎹 Start Screening
              </button>
            )}
            <button
              onClick={() => setEditing(selected)}
              style={{
                padding: "9px 16px", borderRadius: 8,
                border: "1px solid #d1d5db", background: "#f9fafb",
                color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              ✏️ Edit
            </button>
            <button
              onClick={() => handleMove(str(selected.id))}
              disabled={movingId === str(selected.id)}
              style={{
                padding: "9px 16px", borderRadius: 8,
                border: "1px solid #c7d2fe", background: "#eef2ff",
                color: "#4338ca", fontSize: 13, fontWeight: 600,
                cursor: movingId === str(selected.id) ? "not-allowed" : "pointer",
                opacity: movingId === str(selected.id) ? 0.6 : 1,
              }}
            >
              {movingId === str(selected.id) ? "Moving…" : `↦ Move to ${otherWingLabel}`}
            </button>
            <button
              onClick={() => setDeleteId(str(selected.id))}
              style={{
                padding: "9px 16px", borderRadius: 8,
                border: "1px solid #fecaca", background: "#fef2f2",
                color: "#dc2626", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              🗑️ Delete
            </button>
            <button
              onClick={() => setSelected(null)}
              style={{
                marginLeft: "auto", padding: "9px 14px", borderRadius: 8,
                border: "none", background: "#f3f4f6",
                color: "#374151", fontSize: 13, cursor: "pointer",
              }}
            >
              ✕ Close
            </button>
          </div>

          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" as const }}>
            {/* Photo */}
            <div style={{
              width: 90, height: 112, flexShrink: 0,
              border: "2px solid #e5e7eb", borderRadius: 8, overflow: "hidden",
              background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {str(selected.photo) ? (
                <img src={str(selected.photo)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontSize: 28, color: "#d1d5db" }}>👤</span>
              )}
            </div>

            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#111", marginBottom: 2 }}>{str(selected.fullName)}</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
                {str(selected.submittedAt) ? new Date(str(selected.submittedAt)).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : ""}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 20px" }}>
                {([
                  ["Age",        str(selected.age)],
                  ["DOB",        str(selected.dob)],
                  ["Parent",     str(selected.parentName)],
                  ["Phone",      str(selected.phone)],
                  ["Email",      str(selected.email)],
                  ["Status",     str(selected.workingStatus)],
                  ["School/Co.", str(selected.schoolCompany)],
                  ["Centre",     centresList.find(c => c.id === str(selected.centre))?.name ?? str(selected.centre)],
                ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{k}</div>
                    <div style={{ fontSize: 13, color: "#111", fontWeight: 500 }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Address */}
          {(str(selected.address1) || str(selected.address2)) && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f3f4f6" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>Address</div>
              <div style={{ fontSize: 13, color: "#374151" }}>
                {[str(selected.address1), str(selected.address2)].filter(Boolean).join(", ")}
              </div>
            </div>
          )}

          {/* Musical info */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f3f4f6", display: "flex", flexDirection: "column" as const, gap: 10 }}>
            {([
              ["Purpose of Learning",    str(selected.purposeOfLearning)],
              ["Previous Experience",    str(selected.previousExperience)],
              ["Musical Skill",          str(selected.musicalSkill)],
              ["How Heard About Us",     str(selected.howHeardAboutUs)],
              ["Parent Partner Program", str(selected.parentPartnerProgram)],
            ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>{k}</div>
                <div style={{ fontSize: 13, color: "#374151" }}>{v}</div>
              </div>
            ))}
            {arr(selected.instrumentsToLearn).length > 0 && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>Instruments to Learn</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                  {arr(selected.instrumentsToLearn).map(i => (
                    <span key={i} style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99 }}>{i}</span>
                  ))}
                </div>
              </div>
            )}
            {arr(selected.instrumentsPlayed).length > 0 && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>Instruments Played</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                  {arr(selected.instrumentsPlayed).map(i => (
                    <span key={i} style={{ background: "#dcfce7", color: "#15803d", fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99 }}>{i}</span>
                  ))}
                </div>
              </div>
            )}
            {num(selected.initialExperience) !== null && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.06em", minWidth: 160, flexShrink: 0 }}>Initial Experience</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#4f46e5" }}>{num(selected.initialExperience)} <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>/ 10</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Applications grid ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>
          Applications
          <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>({admissions.length})</span>
        </div>
        {onNewAdmission ? (
          <button onClick={onNewAdmission}
            style={{ ...s.primaryBtn, padding: "8px 16px", fontSize: 12 }}>
            + New Admission
          </button>
        ) : wing === WINGS.SCHOOL_OF_MUSIC ? (
          <Link href="/dashboard/admissions"
            style={{ ...s.primaryBtn, padding: "8px 16px", fontSize: 12, textDecoration: "none" }}>
            + New Admission
          </Link>
        ) : (
          <button onClick={() => setShowForm(true)}
            style={{ ...s.primaryBtn, padding: "8px 16px", fontSize: 12 }}>
            + New Admission
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
        {admissions.map((rec, i) => {
          const isSelected  = selected?.id === rec.id;
          const instruments = arr(rec.instrumentsToLearn);
          const admNo       = str(rec.admissionNumber);
          const date        = str(rec.submittedAt) ? new Date(str(rec.submittedAt)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
          const centreName  = centresList.find(c => c.id === str(rec.centre))?.name ?? str(rec.centre);
          return (
            <div
              key={str(rec.id) || i}
              onClick={() => setSelected(isSelected ? null : rec)}
              style={{
                border: isSelected ? "2px solid #4f46e5" : "1px solid #e5e7eb",
                borderRadius: 12,
                background: isSelected ? "#f5f3ff" : "#fff",
                padding: 14, cursor: "pointer",
                display: "flex", flexDirection: "column", gap: 10,
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              }}
            >
              {/* Header: photo + name + ⋯ */}
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", background: "#f3f4f6", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {str(rec.photo)
                    ? <img src={str(rec.photo)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontSize: 20 }}>👤</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#111", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {str(rec.fullName) || "—"}
                  </div>
                  <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.04em", color: admNo ? "#4f46e5" : "#9ca3af" }}>
                    {admNo || "no adm. no."}
                  </div>
                </div>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu(m => m?.id === str(rec.id) ? null : { id: str(rec.id), rec, x: r.right, y: r.bottom });
                  }}
                  title="More"
                  style={{ padding: "4px 9px", borderRadius: 6, border: "1px solid #e5e7eb", background: menu?.id === str(rec.id) ? "#ede9fe" : "#f9fafb", cursor: "pointer", fontSize: 14, color: "#374151", lineHeight: 1, flexShrink: 0 }}
                >
                  ⋯
                </button>
              </div>

              {/* Meta */}
              <div style={{ fontSize: 12, color: "#6b7280", display: "flex", gap: 12, flexWrap: "wrap" as const }}>
                {str(rec.age) && <span>Age {str(rec.age)}</span>}
                {str(rec.phone) && <span>{str(rec.phone)}</span>}
              </div>

              {/* Instruments */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                {instruments.length > 0
                  ? instruments.map(inst => <span key={inst} style={{ background: "#ede9fe", color: "#4f46e5", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>{inst}</span>)
                  : <span style={{ color: "#9ca3af", fontSize: 12 }}>No instrument</span>}
              </div>

              {/* Footer: centre · date + CTA */}
              <div
                onClick={e => e.stopPropagation()}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: "auto", paddingTop: 10, borderTop: "1px solid #f3f4f6" }}
              >
                <div style={{ fontSize: 11, color: "#9ca3af", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                  {[centreName, date].filter(Boolean).join(" · ") || "—"}
                </div>
                {onResume ? (
                  <button
                    onClick={() => onResume(rec)}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#4f46e5", cursor: "pointer", fontSize: 12, color: "#fff", fontWeight: 700, flexShrink: 0 }}
                  >
                    Continue →
                  </button>
                ) : admNo ? (
                  <button
                    onClick={() => { setCompleting({ admission: rec, screening: getScreening(rec) ?? {} }); setCompletingPhase("success"); }}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #a5b4fc", background: "#ede9fe", cursor: "pointer", fontSize: 12, color: "#4338ca", fontWeight: 700, flexShrink: 0 }}
                  >
                    🎓 Enroll
                  </button>
                ) : getScreening(rec) ? (
                  <button
                    onClick={() => { setCompleting({ admission: rec, screening: getScreening(rec)! }); setCompletingAdmNo(""); }}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #86efac", background: "#dcfce7", cursor: "pointer", fontSize: 12, color: "#15803d", fontWeight: 700, flexShrink: 0 }}
                  >
                    ✅ Admit
                  </button>
                ) : wing !== WINGS.SCHOOL_OF_MUSIC ? (
                  <button
                    onClick={() => { onStartScreening?.(str(rec.fullName)); }}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#4f46e5", cursor: "pointer", fontSize: 12, color: "#fff", fontWeight: 700, flexShrink: 0 }}
                  >
                    🎹 Screen
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Row overflow menu */}
      {menu && (() => {
        const rec = menu.rec;
        const hasAdmNo = !!str(rec.admissionNumber);
        const screened = !!getScreening(rec);
        const items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[] = [
          { label: "✏️  Edit details", onClick: () => { setSelected(rec); setEditing(rec); } },
        ];
        if (hasAdmNo)       items.push({ label: pdfLoading === str(rec.id) ? "…  Generating PDF" : "📄  Admission card PDF", onClick: () => handleRedownload(rec), disabled: pdfLoading === str(rec.id) });
        else if (screened) items.push({ label: pdfLoading === str(rec.id) ? "…  Generating PDF" : "📄  Request form PDF",   onClick: () => handleRedownload(rec), disabled: pdfLoading === str(rec.id) });
        items.push({ label: movingId === str(rec.id) ? "…  Moving" : `↦  Move to ${otherWingLabel}`, onClick: () => handleMove(str(rec.id)), disabled: movingId === str(rec.id) });
        items.push({ label: "🗑️  Delete", onClick: () => setDeleteId(str(rec.id)), danger: true });
        return (
          <>
            <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
            <div style={{
              position: "fixed", top: menu.y + 6, left: Math.max(8, menu.x - 210), zIndex: 201,
              background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
              boxShadow: "0 12px 32px rgba(0,0,0,0.16)", minWidth: 210, overflow: "hidden", padding: "4px 0",
            }}>
              {items.map((it, idx) => (
                <button
                  key={idx}
                  disabled={it.disabled}
                  onClick={() => { setMenu(null); it.onClick(); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", padding: "9px 16px",
                    border: "none", background: "#fff", fontSize: 13,
                    color: it.danger ? "#dc2626" : "#374151",
                    cursor: it.disabled ? "not-allowed" : "pointer",
                    opacity: it.disabled ? 0.5 : 1,
                  }}
                  onMouseEnter={e => { if (!it.disabled) e.currentTarget.style.background = it.danger ? "#fef2f2" : "#f9fafb"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </>
        );
      })()}
    </div>
  );
}
