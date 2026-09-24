"use client";

// Quick enquiry form — shared by the Admissions dashboard (staff) and the
// public /enquiry page parents reach by scanning the QR code.

import { useState, type FormEvent } from "react";
import { createEnquiry, type EnquirySource } from "@/services/enquiry/enquiry.service";
import { ENQUIRY_INSTRUMENTS, isValidPhone, normalizePhone } from "@/lib/enquiry";

const ACCENT = "#d97706";

const fieldLabel: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6,
};
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10,
  border: "1px solid #d1d5db", fontSize: 16, fontFamily: "inherit", color: "#111",   // 16px: no iOS focus-zoom
  outline: "none", background: "#fff",
};

export default function EnquiryForm({ wing, source, onCreated, submitLabel = "Save enquiry" }: {
  wing: string;
  source: EnquirySource;
  onCreated?: (id: string) => void;
  submitLabel?: string;
}) {
  const [parentName, setParentName]   = useState("");
  const [studentName, setStudentName] = useState("");
  const [phone, setPhone]             = useState("");
  const [place, setPlace]             = useState("");
  const [instrument, setInstrument]   = useState("");
  const [touched, setTouched]         = useState(false);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState("");
  const [website, setWebsite]         = useState("");   // honeypot (QR / public only)

  const phoneOk = isValidPhone(phone);
  const valid = parentName.trim() !== "" && studentName.trim() !== "" && phoneOk && place.trim() !== "";

  // Keep only digits (plus an optional leading +91) and show as "98765 43210".
  function handlePhone(v: string) {
    const d = normalizePhone(v).slice(0, 10);
    setPhone(d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || saving) return;
    setSaving(true);
    setErr("");
    try {
      const data = { parentName, studentName, phone, place, instrument, wing, source };
      let id: string;
      if (source === "qr") {
        // Public page: no login, so write through the server route.
        const res  = await fetch("/api/public/enquiries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...data, website }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "Could not send the enquiry. Please try again.");
        id = json.id;
      } else {
        id = await createEnquiry(data);
      }
      setParentName(""); setStudentName(""); setPhone(""); setPlace(""); setInstrument("");
      setTouched(false);
      onCreated?.(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the enquiry. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const missing = (v: string) => touched && v.trim() === "";
  const errBorder = (bad: boolean): React.CSSProperties => (bad ? { borderColor: "#f87171" } : {});

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
      <div>
        <label style={fieldLabel}>Parent name *</label>
        <input value={parentName} onChange={e => setParentName(e.target.value)} autoComplete="name"
          placeholder="Parent or guardian" style={{ ...input, ...errBorder(missing(parentName)) }} />
      </div>
      <div>
        <label style={fieldLabel}>Student name *</label>
        <input value={studentName} onChange={e => setStudentName(e.target.value)}
          placeholder="Child / learner" style={{ ...input, ...errBorder(missing(studentName)) }} />
      </div>
      <div>
        <label style={fieldLabel}>Phone number *</label>
        <div style={{ display: "flex", alignItems: "stretch" }}>
          <span style={{ padding: "11px 10px", border: "1px solid #d1d5db", borderRight: "none", borderRadius: "10px 0 0 10px", background: "#f9fafb", fontSize: 16, color: "#6b7280" }}>+91</span>
          <input value={phone} onChange={e => handlePhone(e.target.value)} type="tel" inputMode="numeric" autoComplete="tel-national"
            placeholder="98765 43210"
            style={{ ...input, borderRadius: "0 10px 10px 0", ...errBorder(touched && !phoneOk) }} />
        </div>
        {touched && !phoneOk && (
          <div style={{ fontSize: 11.5, color: "#dc2626", marginTop: 4 }}>Enter a valid 10-digit mobile number.</div>
        )}
      </div>
      <div>
        <label style={fieldLabel}>Place / apartment name *</label>
        <input value={place} onChange={e => setPlace(e.target.value)}
          placeholder="e.g. Prestige Lakeside, Whitefield" style={{ ...input, ...errBorder(missing(place)) }} />
      </div>
      <div>
        <label style={fieldLabel}>Preferred instrument <span style={{ fontWeight: 400, color: "#9ca3af" }}>(optional)</span></label>
        <select value={instrument} onChange={e => setInstrument(e.target.value)} style={input}>
          <option value="">Not sure yet</option>
          {ENQUIRY_INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
      </div>

      {source === "qr" && (
        <input value={website} onChange={e => setWebsite(e.target.value)} name="website" tabIndex={-1}
          autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: -9999, width: 1, height: 1, opacity: 0 }} />
      )}

      {err && (
        <div style={{ gridColumn: "1 / -1", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 13px", fontSize: 13, color: "#dc2626" }}>
          {err}
        </div>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <button type="submit" disabled={saving} style={{
          padding: "12px 24px", borderRadius: 12, border: "none", fontSize: 14, fontWeight: 700,
          fontFamily: "inherit", cursor: saving ? "wait" : "pointer",
          background: ACCENT, color: "#fff", opacity: saving ? 0.7 : 1, width: "100%", maxWidth: 280,
        }}>
          {saving ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
