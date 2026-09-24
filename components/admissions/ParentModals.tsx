"use client";

// Parent-facing admission pop-ups shared by /dashboard/admissions (School of
// Music) and the ROL+ Screening hub's applications list:
//   • NewAdmissionChoiceModal — "+ New Admission": fill on this device vs. parent QR
//   • ParentQrModal           — QR + copyable link to the public /apply (or /enquiry) form

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { WING_LABELS } from "@/config/constants";

const ACCENT = "#d97706";
const card: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
  padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const btn: React.CSSProperties = {
  padding: "11px 22px", borderRadius: 12, border: "none",
  fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", gap: 8,
};

// ─── "+ New Admission" — who fills the form? ─────────────────────────────────
// Staff either type the application in here, or hand the parent the QR code so
// they fill the public /apply form on their own phone.
export function NewAdmissionChoiceModal({ onClose, onDevice, onParentQr }: {
  onClose: () => void; onDevice: () => void; onParentQr: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const options = [
    { key: "device", icon: "💻", title: "Fill Form on This Device", desc: "Enter the full application here, then go straight on to Fast Track screening.", onClick: onDevice },
    { key: "qr",     icon: "📱", title: "Scan QR Code (For Parents)", desc: "Show a QR code the parent scans to fill the admission form on their own phone.", onClick: onParentQr },
  ];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="New admission"
        style={{ ...card, width: "100%", maxWidth: 520, padding: 0, overflow: "hidden", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #f3f4f6" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>New admission</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Who&apos;s filling in the application?</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {options.map(o => (
            <button key={o.key} onClick={o.onClick} autoFocus={o.key === "device"}
              style={{
                textAlign: "left", fontFamily: "inherit", cursor: "pointer", background: "#fff",
                border: "1.5px solid #fde68a", borderRadius: 14, padding: "18px 16px",
                display: "flex", flexDirection: "column", gap: 8, transition: "border-color .15s, background .15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "#fffbeb"; e.currentTarget.style.borderColor = ACCENT; }}
              onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#fde68a"; }}
            >
              <span aria-hidden style={{ fontSize: 30, lineHeight: 1 }}>{o.icon}</span>
              <span style={{ fontSize: 14.5, fontWeight: 800, color: "#78350f" }}>{o.title}</span>
              <span style={{ fontSize: 12.5, color: "#6b7280", lineHeight: 1.45 }}>{o.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── QR code for parents ──────────────────────────────────────────────────────
// Parents scan this to open the public /apply form (lands in this wing's
// application list) or the /enquiry quick form (lands under Enquiries → Open
// as an "Online Lead") on their own phone.
export function ParentQrModal({ wing, initialTarget = "apply", allowEnquiry = true, onClose }: {
  wing: string; initialTarget?: "apply" | "enquiry";
  /** false where the wing has no Enquiries list to receive quick enquiries (ROL+). */
  allowEnquiry?: boolean;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<"apply" | "enquiry">(allowEnquiry ? initialTarget : "apply");
  const url = `${window.location.origin}/${target}?wing=${encodeURIComponent(wing)}`;
  const [qr, setQr]         = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then(setQr)
      .catch(err => console.error("[ParentQrModal] QR error:", err));
  }, [url]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.getElementById("parent-apply-link") as HTMLInputElement | null;
      el?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="QR code for parents"
        style={{ ...card, width: "100%", maxWidth: 420, padding: 0, overflow: "hidden", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #f3f4f6" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>📱 {target === "apply" ? "Mobile Admission Form" : "Mobile Enquiry Form"}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: 20, textAlign: "center" }}>
          {allowEnquiry && <div style={{ display: "inline-flex", background: "#f3f4f6", borderRadius: 10, padding: 3, gap: 3, marginBottom: 14 }}>
            {([["apply", "Full admission"], ["enquiry", "Quick enquiry"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTarget(k)} style={{
                padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontFamily: "inherit",
                fontSize: 12, fontWeight: 700,
                background: target === k ? "#fff" : "transparent", color: target === k ? "#92400e" : "#6b7280",
                boxShadow: target === k ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
              }}>{l}</button>
            ))}
          </div>}
          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12, width: "min(280px, 100%)", aspectRatio: "1", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
            {qr
              ? <img src={qr} alt="QR code linking to the online admission form" style={{ width: "100%", height: "100%", imageRendering: "pixelated" }} />
              : <span style={{ fontSize: 12, color: "#9ca3af" }}>Generating…</span>}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#78350f", margin: "16px 0 4px", lineHeight: 1.45 }}>
            {target === "apply"
              ? <>Scan with phone camera to open the {WING_LABELS[wing] ?? ""} Online Admission Form.</>
              : <>Scan with phone camera to send a quick enquiry — just name, phone and place.</>}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>
            {target === "apply"
              ? "Submitted forms appear in the application list below, ready for Fast Track screening."
              : "Enquiries appear instantly under Enquiries → Open, tagged “Online Lead”."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="parent-apply-link" readOnly value={url} onFocus={e => e.currentTarget.select()}
              style={{ flex: 1, minWidth: 0, border: "1.5px solid #f0f0f0", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#374151", background: "#fafafa", fontFamily: "inherit" }} />
            <button onClick={copyLink} style={{ ...btn, background: copied ? "#16a34a" : ACCENT, color: "#fff", padding: "10px 16px", flexShrink: 0 }}>
              {copied ? "✓ Copied" : "Copy Link"}
            </button>
          </div>
          {qr && (
            <a href={qr} download={target === "apply" ? "admission-form-qr.png" : "enquiry-form-qr.png"}
              style={{ display: "inline-block", marginTop: 14, fontSize: 12, fontWeight: 600, color: "#b45309" }}>
              Download QR image (for printing)
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
