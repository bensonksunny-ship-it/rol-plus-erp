"use client";

// Public enquiry page — no login. Parents reach it by scanning the QR code on
// /dashboard/admissions (Enquiries tab). `?wing=` picks the wing the lead is
// filed under; defaults to Rol's School of Music. After an enquiry (either
// wing), parents see that wing's school overview (components/enquiry/SchoolInfoView).

import { useEffect, useState } from "react";
import EnquiryForm from "@/components/enquiry/EnquiryForm";
import SchoolInfoView from "@/components/enquiry/SchoolInfoView";
import { WINGS, WING_LABELS } from "@/config/constants";

export default function PublicEnquiryPage() {
  const [wing, setWing] = useState<string>(WINGS.SCHOOL_OF_MUSIC);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get("wing");
    if (w && (Object.values(WINGS) as string[]).includes(w)) setWing(w);
    // Leaders' "Preview" link from Admissions → School Info.
    if (["info", "true"].includes(new URLSearchParams(window.location.search).get("preview") ?? "")) setDone(true);
  }, []);

  return (
    <div style={{ minHeight: "100dvh", background: "linear-gradient(180deg, #fffbeb, #fff 40%)", padding: "32px 16px 48px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 40 }}>🎼</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#78350f", marginTop: 6 }}>{WING_LABELS[wing]}</div>
          {!done && <div style={{ fontSize: 14, color: "#92400e", marginTop: 4 }}>
            Interested in music classes? Leave your details and we&apos;ll call you back.
          </div>}
        </div>

        {done ? (
          <SchoolInfoView wing={wing} />
        ) : (
        <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18, padding: 22, boxShadow: "0 4px 14px rgba(0,0,0,0.05)" }}>
          <EnquiryForm wing={wing} source="qr" submitLabel="Send enquiry" onCreated={() => { setDone(true); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
        </div>
        )}
      </div>
    </div>
  );
}
