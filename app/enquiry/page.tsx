"use client";

// Public enquiry page — no login. Parents reach it by scanning the QR code on
// /dashboard/admissions (Enquiries tab). `?wing=` picks the wing the lead is
// filed under; defaults to Rol's School of Music.

import { useEffect, useState } from "react";
import EnquiryForm from "@/components/enquiry/EnquiryForm";
import { WINGS, WING_LABELS } from "@/config/constants";

export default function PublicEnquiryPage() {
  const [wing, setWing] = useState<string>(WINGS.SCHOOL_OF_MUSIC);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get("wing");
    if (w && (Object.values(WINGS) as string[]).includes(w)) setWing(w);
  }, []);

  return (
    <div style={{ minHeight: "100dvh", background: "linear-gradient(180deg, #fffbeb, #fff 40%)", padding: "32px 16px 48px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 40 }}>🎼</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#78350f", marginTop: 6 }}>{WING_LABELS[wing]}</div>
          <div style={{ fontSize: 14, color: "#92400e", marginTop: 4 }}>
            Interested in music classes? Leave your details and we&apos;ll call you back.
          </div>
        </div>

        <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18, padding: 22, boxShadow: "0 4px 14px rgba(0,0,0,0.05)" }}>
          {done ? (
            <div style={{ textAlign: "center", padding: "24px 8px" }}>
              <div style={{ fontSize: 44 }}>✅</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#15803d", marginTop: 8 }}>Thank you!</div>
              <div style={{ fontSize: 14, color: "#374151", marginTop: 6 }}>
                We&apos;ve received your enquiry and will contact you shortly.
              </div>
              <button onClick={() => setDone(false)} style={{
                marginTop: 20, padding: "10px 20px", borderRadius: 10, border: "1px solid #e5e7eb",
                background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
              }}>
                Submit another enquiry
              </button>
            </div>
          ) : (
            <EnquiryForm wing={wing} source="qr" submitLabel="Send enquiry" onCreated={() => setDone(true)} />
          )}
        </div>
      </div>
    </div>
  );
}
