"use client";

import type { Wing } from "@/types";
import { AdmissionFormContent } from "@/app/dashboard/screening/admission-form";

export default function PublicAdmissionForm({ wing, wingLabel }: { wing: Wing; wingLabel: string }) {
  return (
    <div style={{ minHeight: "100dvh", background: "#fffbeb", padding: "0 0 40px" }}>
      <header style={{
        background: "linear-gradient(135deg, #d97706, #b45309)", color: "#fff",
        padding: "calc(env(safe-area-inset-top, 0px) + 22px) 16px 22px", textAlign: "center",
      }}>
        <div style={{ fontSize: 28, marginBottom: 4 }}>🎼</div>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>{wingLabel}</h1>
        <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>Online Admission Form</div>
      </header>

      <main style={{ maxWidth: 640, margin: "0 auto", padding: "16px 12px 0" }}>
        <p style={{ fontSize: 13, color: "#78350f", margin: "0 4px 14px", lineHeight: 1.5 }}>
          Fill in the student&apos;s details below. Fields marked * are required. After you submit,
          our team will call you to schedule a short screening session.
        </p>
        <AdmissionFormContent publicWing={wing} />
      </main>
    </div>
  );
}
