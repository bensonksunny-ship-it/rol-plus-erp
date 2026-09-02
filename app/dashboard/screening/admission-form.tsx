"use client";

// Extracted from ./page.tsx — a Next.js `page.tsx` may not carry extra named
// exports (its route type check forbids them). The Wing 2 admissions wizard
// (../admissions/page.tsx) reuses AdmissionFormContent, so it lives here.

import { useState, useEffect, useRef } from "react";
import { collection, getDocs } from "firebase/firestore";

/** Whole years from a DD/MM/YYYY date of birth to today. Empty string if invalid. */
function ageFromDob(dd: string, mm: string, yyyy: string): string {
  const d = Number(dd), m = Number(mm), y = Number(yyyy);
  if (!d || !m || !y || yyyy.length !== 4) return "";
  const dob = new Date(y, m - 1, d);
  if (dob.getFullYear() !== y || dob.getMonth() !== m - 1 || dob.getDate() !== d) return "";
  const now = new Date();
  if (dob > now) return "";
  let age = now.getFullYear() - y;
  const beforeBirthday = now.getMonth() < m - 1 || (now.getMonth() === m - 1 && now.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? String(age) : "";
}
import { db } from "@/services/firebase/firebase";
import { useAuthContext } from "@/features/auth/AuthContext";
import { useWing } from "@/hooks/useWing";
import { saveAdmission } from "@/services/screening/screening.service";

const s: Record<string, React.CSSProperties> = {
  card: {
    background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
    padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
  },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 18 },
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

export function OptionGroup({ options, value, onChange }: {
  options: string[];
  value:   string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
      {options.map(opt => {
        const sel = value === opt;
        return (
          <button key={opt} type="button" onClick={() => onChange(sel ? "" : opt)} style={{
            padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13,
            border:     sel ? "2px solid #4f46e5" : "1px solid #e5e7eb",
            background: sel ? "#ede9fe" : "#f9fafb",
            color:      sel ? "#4f46e5" : "#374151",
            fontWeight: sel ? 700 : 400,
          }}>
            {opt}
          </button>
        );
      })}
    </div>
  );
}

export function MultiOptionGroup({ options, values, onChange }: {
  options:  string[];
  values:   string[];
  onChange: (vals: string[]) => void;
}) {
  function toggle(opt: string) {
    onChange(values.includes(opt) ? values.filter(v => v !== opt) : [...values, opt]);
  }
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
      {options.map(opt => {
        const sel = values.includes(opt);
        return (
          <button key={opt} type="button" onClick={() => toggle(opt)} style={{
            padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13,
            border:     sel ? "2px solid #4f46e5" : "1px solid #e5e7eb",
            background: sel ? "#ede9fe" : "#f9fafb",
            color:      sel ? "#4f46e5" : "#374151",
            fontWeight: sel ? 700 : 400,
          }}>
            {sel ? "✓ " : ""}{opt}
          </button>
        );
      })}
    </div>
  );
}

// ─── Admission form content ───────────────────────────────────────────────────

export function AdmissionFormContent({
  onDone,
  onSubmitted,
  minimal = false,
}: {
  onDone?: () => void;
  /**
   * When provided, the saved application is handed back (id + payload) instead
   * of showing the built-in success screen — used by the Wing 2 admissions wizard.
   */
  onSubmitted?: (admissionId: string, data: Record<string, unknown>) => void;
  /**
   * Wing 2 lean intake: show only the fields the admission actually needs.
   * Hidden fields still submit as empty so the saved record keeps one shape.
   */
  minimal?: boolean;
} = {}) {
  const { user } = useAuthContext();
  const { wing } = useWing();

  // Personal information
  // ROL+ (non-minimal) keeps a single Full Name field. Wing 2 (minimal) splits
  // it into first / middle / last; `effectiveName` is the combined value used
  // everywhere downstream so the saved record keeps one shape.
  const [fullName,      setFullName]      = useState("");
  const [firstName,     setFirstName]     = useState("");
  const [middleName,    setMiddleName]    = useState("");
  const [lastName,      setLastName]      = useState("");
  const [age,           setAge]           = useState("");
  const [dobDD,         setDobDD]         = useState("");
  const [dobMM,         setDobMM]         = useState("");
  const [dobYYYY,       setDobYYYY]       = useState("");
  const [parentName,    setParentName]    = useState("");
  const [workingStatus, setWorkingStatus] = useState("");
  const [schoolCompany, setSchoolCompany] = useState("");

  // Contact information
  const [phone,    setPhone]    = useState("");
  const [email,    setEmail]    = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [centre,   setCentre]   = useState("");
  const [centres,  setCentres]  = useState<{ id: string; name: string }[]>([]);

  // Musical skills
  const [purposeOfLearning,   setPurposeOfLearning]   = useState("");
  const [instrumentsToLearn,  setInstrumentsToLearn]  = useState<string[]>([]);
  const [previousExperience,  setPreviousExperience]  = useState("");
  const [instrumentsPlayed,   setInstrumentsPlayed]   = useState<string[]>([]);
  const [musicalSkill,        setMusicalSkill]        = useState("");
  const [howHeardAboutUs,     setHowHeardAboutUs]     = useState("");
  const [initialExperience,   setInitialExperience]   = useState<number | null>(null);
  const [parentPartnerProgram,setParentPartnerProgram]= useState("");

  // Photo
  const [photoDataUrl,  setPhotoDataUrl]  = useState<string | null>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Submit state
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [saveErr, setSaveErr] = useState("");

  useEffect(() => {
    getDocs(collection(db, "centers"))
      .then(snap => setCentres(snap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id }))))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Wing 2 (minimal): age is derived from DOB, never entered directly. `age`
  // state stays in sync so the saved payload keeps its existing shape.
  const computedAge = ageFromDob(dobDD, dobMM, dobYYYY);
  useEffect(() => { if (minimal) setAge(computedAge); }, [minimal, computedAge]);

  const effectiveName = minimal
    ? [firstName, middleName, lastName].map(p => p.trim()).filter(Boolean).join(" ")
    : fullName.trim();

  const nameOk = minimal
    ? firstName.trim().length > 0 && lastName.trim().length > 0
    : fullName.trim().length > 0;

  const dobOk = !minimal || computedAge !== "";

  const canSubmit = nameOk && dobOk && phone.trim().length > 0;

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
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
      img.src = url;
    });
  }

  function handlePhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    compressImage(file).then(setPhotoDataUrl).catch(() => {});
    e.target.value = "";
  }

  async function handleSubmit() {
    if (!canSubmit || saving) return;
    setSaving(true); setSaveErr("");
    try {
      const payload = {
        wing,
        fullName:            effectiveName,
        firstName:           firstName.trim(),
        middleName:          middleName.trim(),
        lastName:            lastName.trim(),
        age:                 age.trim(),
        dob:                 `${dobDD}/${dobMM}/${dobYYYY}`,
        parentName:          parentName.trim(),
        workingStatus,
        schoolCompany:       schoolCompany.trim(),
        phone:               phone.trim(),
        email:               email.trim(),
        address1:            address1.trim(),
        address2:            address2.trim(),
        centre,
        purposeOfLearning,
        instrumentsToLearn,
        previousExperience,
        instrumentsPlayed,
        musicalSkill,
        howHeardAboutUs:     howHeardAboutUs.trim(),
        initialExperience,
        parentPartnerProgram,
        photo:               photoDataUrl ?? null,
        submittedBy:         user?.uid ?? "",
      };
      const admissionId = await saveAdmission(payload);
      if (onSubmitted) {
        onSubmitted(admissionId, payload);
        return;
      }
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setFullName(""); setFirstName(""); setMiddleName(""); setLastName("");
    setAge(""); setDobDD(""); setDobMM(""); setDobYYYY("");
    setParentName(""); setWorkingStatus(""); setSchoolCompany("");
    setPhone(""); setEmail(""); setAddress1(""); setAddress2(""); setCentre("");
    setPurposeOfLearning(""); setInstrumentsToLearn([]); setPreviousExperience("");
    setInstrumentsPlayed([]); setMusicalSkill(""); setHowHeardAboutUs("");
    setInitialExperience(null); setParentPartnerProgram("");
    setPhotoDataUrl(null);
    setSaved(false); setSaveErr("");
  }

  if (saved) {
    return (
      <div style={{ maxWidth: 520, margin: "40px auto", textAlign: "center" }}>
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 14, padding: "36px 28px" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#15803d", marginBottom: 8 }}>Application Submitted</div>
          <div style={{ fontSize: 14, color: "#166534", marginBottom: 24 }}>
            <strong>{effectiveName}</strong>&apos;s admission form has been saved successfully.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={reset} style={s.primaryBtn}>+ New Application</button>
            {onDone && (
              <button onClick={onDone} style={s.secondaryBtn}>← Back to Applications</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {!minimal && (
        <>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#111", marginBottom: 4 }}>📋 Admission Form</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
            ROL&apos;s School Of Music — Student Admission Application
          </div>
        </>
      )}

      {/* ── Personal Information ─────────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={s.sectionTitle}>Personal Information</div>

        {minimal ? (
          <>
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" as const }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={s.label}>First Name *</label>
                <input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" style={s.input} />
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={s.label}>Second Name</label>
                <input value={middleName} onChange={e => setMiddleName(e.target.value)} placeholder="Middle name" style={s.input} />
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={s.label}>Last Name *</label>
                <input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" style={s.input} />
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 3 }}>
              <label style={s.label}>Full Name *</label>
              <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Enter full name" style={s.input} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Age</label>
              <input value={age} onChange={e => setAge(e.target.value)} placeholder="—" style={s.input} type="number" min={0} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" as const }}>
          <div style={{ flex: minimal ? "0 0 auto" : 1 }}>
            <label style={s.label}>Date of Birth {minimal && <span style={{ color: "#9ca3af" }}>*</span>}</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={dobDD} onChange={e => setDobDD(e.target.value.replace(/\D/g, ""))} placeholder="DD"
                style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} maxLength={2} inputMode="numeric" />
              <span style={{ color: "#9ca3af", fontWeight: 700 }}>/</span>
              <input value={dobMM} onChange={e => setDobMM(e.target.value.replace(/\D/g, ""))} placeholder="MM"
                style={{ ...s.input, width: 48, textAlign: "center" as const, boxSizing: "border-box" as const }} maxLength={2} inputMode="numeric" />
              <span style={{ color: "#9ca3af", fontWeight: 700 }}>/</span>
              <input value={dobYYYY} onChange={e => setDobYYYY(e.target.value.replace(/\D/g, ""))} placeholder="YYYY"
                style={{ ...s.input, width: 68, textAlign: "center" as const, boxSizing: "border-box" as const }} maxLength={4} inputMode="numeric" />
            </div>
          </div>
          {minimal && (
            <div style={{ flex: "0 0 auto" }}>
              <label style={s.label}>Age</label>
              <div style={{ ...s.input, minWidth: 90, background: "#f3f4f6", color: computedAge ? "#111" : "#9ca3af", display: "flex", alignItems: "center" }}>
                {computedAge ? `${computedAge} yrs` : "—"}
              </div>
            </div>
          )}
          <div style={{ flex: 1.5, minWidth: 200 }}>
            <label style={s.label}>Name of Parent / Guardian</label>
            <input value={parentName} onChange={e => setParentName(e.target.value)} placeholder="Parent or guardian name" style={s.input} />
          </div>
        </div>

        {!minimal && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={s.label}>Working Status</label>
              <OptionGroup
                options={["Student", "Working", "Part Time", "Not Working"]}
                value={workingStatus}
                onChange={setWorkingStatus}
              />
            </div>

            <div>
              <label style={s.label}>Name of School / Company</label>
              <input value={schoolCompany} onChange={e => setSchoolCompany(e.target.value)} placeholder="School or company name" style={s.input} />
            </div>
          </>
        )}
      </div>

      {/* ── Contact Information ──────────────────────────────────────────────── */}
      <div style={{ ...s.card, marginTop: 16 }}>
        <div style={s.sectionTitle}>Contact Information</div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Phone Number *</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 00000 00000" style={s.input} type="tel" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Email ID</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" style={s.input} type="email" />
          </div>
        </div>

        <div style={{ marginBottom: minimal ? 0 : 16 }}>
          <label style={s.label}>{minimal ? "Address" : "Address Line 1"}</label>
          <input value={address1} onChange={e => setAddress1(e.target.value)} placeholder="House / Flat no., Street name" style={s.input} />
        </div>

        {minimal ? (
          <div style={{ marginTop: 16 }}>
            <label style={s.label}>Centre</label>
            {centres.length > 0 ? (
              <select value={centre} onChange={e => setCentre(e.target.value)} style={{ ...s.input, cursor: "pointer" }}>
                <option value="">— Select —</option>
                {centres.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            ) : (
              <input value={centre} onChange={e => setCentre(e.target.value)} placeholder="Centre" style={s.input} />
            )}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 2 }}>
              <label style={s.label}>Address Line 2</label>
              <input value={address2} onChange={e => setAddress2(e.target.value)} placeholder="Area, Landmark" style={s.input} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Centre</label>
              {centres.length > 0 ? (
                <select value={centre} onChange={e => setCentre(e.target.value)} style={{ ...s.input, cursor: "pointer" }}>
                  <option value="">— Select —</option>
                  {centres.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              ) : (
                <input value={centre} onChange={e => setCentre(e.target.value)} placeholder="Centre" style={s.input} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Musical Skills ───────────────────────────────────────────────────── */}
      <div style={{ ...s.card, marginTop: 16 }}>
        <div style={s.sectionTitle}>{minimal ? "Learning" : "Information on Musical Skills"}</div>

        {!minimal && (
          <div style={{ marginBottom: 20 }}>
            <label style={s.label}>Purpose of Learning</label>
            <OptionGroup
              options={["Formal Music Learning", "Skill Development", "Entertainment"]}
              value={purposeOfLearning}
              onChange={setPurposeOfLearning}
            />
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>
            Musical Instrument to Learn{" "}
            <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}>(select all that apply)</span>
          </label>
          <MultiOptionGroup
            options={["Piano", "Keyboard", "Guitar", "Drums", "Violin", "Vocal"]}
            values={instrumentsToLearn}
            onChange={setInstrumentsToLearn}
          />
        </div>

        <div style={{ marginBottom: minimal ? 0 : 20 }}>
          <label style={s.label}>Previous Experience in Music</label>
          <OptionGroup
            options={["Well-Trained", "Average", "No Previous Experience"]}
            value={previousExperience}
            onChange={setPreviousExperience}
          />
        </div>

        {!minimal && (
          <>
            <div style={{ marginBottom: 20 }}>
              <label style={s.label}>
                Instruments You Already Play{" "}
                <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}>(select all that apply)</span>
              </label>
              <MultiOptionGroup
                options={["Guitar", "Drums", "Keyboard", "None of the Above"]}
                values={instrumentsPlayed}
                onChange={setInstrumentsPlayed}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={s.label}>Explain Your Musical Skill</label>
              <OptionGroup
                options={["Excellent", "Average", "Poor"]}
                value={musicalSkill}
                onChange={setMusicalSkill}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={s.label}>How Do You Know About ROL&apos;s School Of Music?</label>
              <input value={howHeardAboutUs} onChange={e => setHowHeardAboutUs(e.target.value)}
                placeholder="e.g. Social media, friend referral, walk-in…" style={s.input} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={s.label}>
                How Do You Describe Your Initial Experience With Us?{" "}
                <span style={{ color: "#9ca3af", fontWeight: 400 }}>( / 10)</span>
              </label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setInitialExperience(initialExperience === n ? null : n)}
                    style={{
                      width: 42, height: 42, borderRadius: 8, cursor: "pointer", fontSize: 14,
                      border:     "none",
                      background: initialExperience === n ? "#4f46e5" : "#f3f4f6",
                      color:      initialExperience === n ? "#fff" : "#374151",
                      fontWeight: initialExperience === n ? 800 : 500,
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {initialExperience !== null && (
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>Selected: {initialExperience} / 10</div>
              )}
            </div>

            <div>
              <label style={s.label}>Would You Like to Participate in Our Parent Partner Program?</label>
              <OptionGroup
                options={["Yes", "No", "Want to Know More"]}
                value={parentPartnerProgram}
                onChange={setParentPartnerProgram}
              />
            </div>
          </>
        )}
      </div>

      {/* ── Candidate Photo ──────────────────────────────────────────────────── */}
      <div style={{ ...s.card, marginTop: 16 }}>
        <div style={s.sectionTitle}>Candidate Photo</div>

        {/* Hidden inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={handlePhotoFile}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handlePhotoFile}
        />

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" as const }}>
          {/* Preview box */}
          <div style={{
            width: 120, height: 150, flexShrink: 0,
            border: "2px dashed #d1d5db", borderRadius: 10,
            background: "#f9fafb",
            display: "flex", alignItems: "center", justifyContent: "center",
            overflow: "hidden",
          }}>
            {photoDataUrl ? (
              <img src={photoDataUrl} alt="Candidate" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ textAlign: "center" as const, color: "#9ca3af" }}>
                <div style={{ fontSize: 32, marginBottom: 4 }}>📷</div>
                <div style={{ fontSize: 11 }}>No photo</div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10, justifyContent: "center", flex: 1 }}>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              style={{
                padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                border: "1px solid #4f46e5", background: "#ede9fe",
                color: "#4f46e5", fontSize: 13, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ fontSize: 18 }}>📸</span> Take Photo
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                border: "1px solid #d1d5db", background: "#f9fafb",
                color: "#374151", fontSize: 13, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ fontSize: 18 }}>🖼️</span> Upload Photo
            </button>
            {photoDataUrl && (
              <button
                type="button"
                onClick={() => setPhotoDataUrl(null)}
                style={{
                  padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid #fecaca", background: "#fef2f2",
                  color: "#dc2626", fontSize: 12, fontWeight: 600,
                }}
              >
                Remove Photo
              </button>
            )}
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
              Photo is optional. Compressed automatically.
            </div>
          </div>
        </div>
      </div>

      {saveErr && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginTop: 16 }}>
          {saveErr}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
        <button type="button" onClick={reset} style={s.secondaryBtn}>Reset</button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || saving}
          style={{ ...s.primaryBtn, opacity: canSubmit && !saving ? 1 : 0.4, cursor: canSubmit && !saving ? "pointer" : "not-allowed" }}
        >
          {saving ? "Submitting…" : "Submit Application"}
        </button>
      </div>
    </div>
  );
}
