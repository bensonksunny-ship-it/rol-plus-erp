"use client";

// Record Admission Fee Payment — a mandatory step before "Enroll Student".
// Saves a completed "admission_fee" transaction to the Finance ledger and marks
// the application paid (services/finance/finance.service → recordAdmissionFee).

import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { WINGS } from "@/config/constants";
import { wingOf } from "@/lib/wing";
import { useAuthContext } from "@/features/auth/AuthContext";
import { recordAdmissionFee } from "@/services/finance/finance.service";

const WING = WINGS.SCHOOL_OF_MUSIC;
const DEFAULT_FEE = 1500;   // standard admission fee (₹); editable per payment
const MODES: { value: "Cash" | "UPI" | "Card" | "Bank"; label: string }[] = [
  { value: "Cash", label: "Cash" },
  { value: "UPI",  label: "UPI" },
  { value: "Card", label: "Card" },
  { value: "Bank", label: "Bank Transfer" },
];

const str = (v: unknown) => (typeof v === "string" ? v : "");
function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const labelCss: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.08em", display: "block", marginBottom: 7,
};
const inputCss: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
  border: "1.5px solid #e5e7eb", fontSize: 14, fontFamily: "inherit", color: "#111", background: "#fff", outline: "none",
};

/** The admission-fee fields saved on the application (merge into local state). */
export type AdmissionFeePatch = {
  admissionFeePaid: true; admissionFeeAmount: number; admissionFeeMethod: string;
  admissionFeeReference: string | null; admissionFeeDate: string; admissionFeeCentreId: string; admissionFeeTxId: string;
};

export default function AdmissionFeeModal({ application, onClose, onPaid, onDownloadCard }: {
  application: Record<string, unknown>;
  onClose: () => void;
  /** Called once the payment is saved (the modal stays open on its receipt step). */
  onPaid: (fee: AdmissionFeePatch) => void;
  /** Download the admission card (with the fee receipt) for the updated application. */
  onDownloadCard?: (applicationWithFee: Record<string, unknown>) => Promise<void>;
}) {
  const { user } = useAuthContext();
  const name = str(application.fullName) || "Applicant";

  const [centres, setCentres] = useState<{ id: string; name: string }[]>([]);
  const [centreId, setCentreId] = useState("");
  const [amount, setAmount] = useState(String(DEFAULT_FEE));
  const [mode, setMode] = useState<"Cash" | "UPI" | "Card" | "Bank">("Cash");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(todayYMD());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [paid, setPaid] = useState<AdmissionFeePatch | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    getDocs(query(collection(db, "centers"), where("status", "==", "active")))
      .then(snap => {
        const list = snap.docs
          .filter(d => wingOf(d.data()) === WING)
          .map(d => ({ id: d.id, name: str(d.data().name) || d.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCentres(list);
        // Pre-select the centre on the application (saved as id or name).
        const want = str(application.centre).trim().toLowerCase();
        const match = want ? list.find(c => c.id.toLowerCase() === want || c.name.trim().toLowerCase() === want) : undefined;
        if (match) setCentreId(match.id);
      })
      .catch(e => console.error("[AdmissionFeeModal] load centres:", e));
  }, [application.centre]);

  // UPI / Card / Bank transfers need a transaction reference; cash doesn't.
  const needsRef = mode !== "Cash";
  const amt = Number(amount);
  const missing = [
    !(amt > 0) && "amount",
    !centreId && "centre",
    !date && "payment date",
    needsRef && !reference.trim() && "reference / transaction ID",
  ].filter(Boolean) as string[];

  async function save() {
    if (missing.length || saving) return;
    setSaving(true);
    setErr("");
    try {
      const txId = await recordAdmissionFee({
        admissionId: str(application.id), payerName: name,
        admissionNumber: str(application.admissionNumber),
        centerId: centreId, amount: amt, method: mode, reference, date,
        receivedBy: user?.uid ?? "",
      });
      const fee: AdmissionFeePatch = {
        admissionFeePaid: true, admissionFeeAmount: amt, admissionFeeMethod: mode,
        admissionFeeReference: reference.trim() || null, admissionFeeDate: date,
        admissionFeeCentreId: centreId, admissionFeeTxId: txId,
      };
      setPaid(fee);
      setSaving(false);
      onPaid(fee);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not record the payment.");
      setSaving(false);
    }
  }

  async function download() {
    if (!paid || !onDownloadCard || downloading) return;
    setDownloading(true);
    try {
      await onDownloadCard({ ...application, ...paid });
    } catch (e) {
      console.error("[AdmissionFeeModal] admission card:", e);
      setErr("Could not create the admission card PDF.");
    } finally {
      setDownloading(false);
    }
  }

  // ── Receipt step (after "Mark Paid") ──────────────────────────────────────
  if (paid) {
    const hasAdmNo = !!str(application.admissionNumber);
    return (
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <div role="dialog" aria-label="Admission fee recorded" onClick={e => e.stopPropagation()}
          style={{ width: "100%", maxWidth: 440, background: "#fff", borderRadius: 18, padding: 26, boxShadow: "0 24px 64px rgba(0,0,0,0.25)", boxSizing: "border-box", textAlign: "center" }}>
          <div style={{ fontSize: 42, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 900, color: "#15803d" }}>Admission fee recorded</div>
          <div style={{ fontSize: 13, color: "#374151", marginTop: 6 }}>
            ₹{paid.admissionFeeAmount.toLocaleString("en-IN")} · {MODES.find(m => m.value === paid.admissionFeeMethod)?.label ?? paid.admissionFeeMethod}
            {" · "}{new Date(`${paid.admissionFeeDate}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{name} is now ready to enrol. Saved to Finance.</div>
          {err && <div style={{ marginTop: 12, fontSize: 12.5, color: "#dc2626" }}>{err}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 20 }}>
            {onDownloadCard && (
              <button onClick={download} disabled={downloading} style={{
                padding: "11px 18px", borderRadius: 10, border: "none", fontSize: 13.5, fontWeight: 800, cursor: downloading ? "wait" : "pointer",
                background: "#4f46e5", color: "#fff",
              }}>
                {downloading ? "Preparing PDF…" : hasAdmNo ? "📄 Download Admission Card" : "📄 Download Admission Form & Receipt"}
              </button>
            )}
            {onDownloadCard && !hasAdmNo && (
              <div style={{ fontSize: 11, color: "#9a3412" }}>No admission number yet — it prints as the request form (with the fee receipt) until one is entered.</div>
            )}
            <button onClick={onClose} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div onClick={saving ? undefined : onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-label="Record admission fee payment" onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480, background: "#fff", borderRadius: 18, padding: 22, boxShadow: "0 24px 64px rgba(0,0,0,0.25)", boxSizing: "border-box", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: "#92400e" }}>💰 Record Admission Fee Payment</div>
            <div style={{ fontSize: 12.5, color: "#6b7280", marginTop: 3 }}>
              {name}{str(application.admissionNumber) ? ` · ${str(application.admissionNumber)}` : ""}
            </div>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af" }}>✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelCss}>Admission fee amount (₹) *</label>
            <input value={amount} inputMode="numeric" placeholder={String(DEFAULT_FEE)} onChange={e => setAmount(e.target.value.replace(/[^\d]/g, "").slice(0, 7))}
              style={{ ...inputCss, fontSize: 18, fontWeight: 800 }} />
          </div>

          <div>
            <label style={labelCss}>Payment mode *</label>
            <div role="radiogroup" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 6 }}>
              {MODES.map(m => {
                const on = mode === m.value;
                return (
                  <button key={m.value} type="button" role="radio" aria-checked={on} onClick={() => setMode(m.value)}
                    style={{
                      padding: "9px 6px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                      border: on ? "2px solid #d97706" : "1.5px solid #e5e7eb", background: on ? "#fffbeb" : "#fff", color: on ? "#92400e" : "#374151",
                    }}>
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label style={labelCss}>Reference / transaction ID {needsRef && "*"}</label>
            <input value={reference} onChange={e => setReference(e.target.value.slice(0, 80))}
              placeholder={needsRef ? "e.g. UPI ref no. / card slip no." : "Optional for cash (receipt no.)"} style={inputCss} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div>
              <label style={labelCss}>Payment date *</label>
              <input type="date" value={date} max={todayYMD()} onChange={e => setDate(e.target.value)} style={inputCss} />
            </div>
            <div>
              <label style={labelCss}>Centre *</label>
              <select value={centreId} onChange={e => setCentreId(e.target.value)} style={{ ...inputCss, cursor: "pointer" }}>
                <option value="">— Select —</option>
                {centres.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          {err && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 12px", fontSize: 13, color: "#dc2626" }}>{err}</div>}

          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            {missing.length ? `Still needed: ${missing.join(", ")}` : "Saved to the Finance ledger as an Admission Fee under this centre."}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={onClose} disabled={saving} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={save} disabled={!!missing.length || saving} style={{
              padding: "10px 20px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 800,
              background: missing.length || saving ? "#e5e7eb" : "#15803d", color: missing.length || saving ? "#9ca3af" : "#fff",
              cursor: missing.length || saving ? "not-allowed" : "pointer",
            }}>
              {saving ? "Saving…" : `✓ Mark Paid${amt > 0 ? ` · ₹${amt.toLocaleString("en-IN")}` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
