"use client";

// Enquiries tab on /dashboard/admissions — quick prospect leads (from staff or
// the parent QR code) with Mark contacted / Convert to admission actions.

import { useCallback, useEffect, useMemo, useState } from "react";
import EnquiryForm from "@/components/enquiry/EnquiryForm";
import {
  getEnquiries, markEnquiryContacted,
  type Enquiry, type EnquiryStatus,
} from "@/services/enquiry/enquiry.service";
import { formatPhone } from "@/lib/enquiry";

const ACCENT = "#d97706";

const STATUS_STYLE: Record<EnquiryStatus, { label: string; color: string; bg: string }> = {
  new:       { label: "New",       color: "#b45309", bg: "#fef3c7" },
  contacted: { label: "Contacted", color: "#1d4ed8", bg: "#dbeafe" },
  converted: { label: "Converted", color: "#15803d", bg: "#dcfce7" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

const pill = (active: boolean): React.CSSProperties => ({
  padding: "6px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit", border: active ? `1.5px solid ${ACCENT}` : "1px solid #e5e7eb",
  background: active ? "#fef9ee" : "#fff", color: active ? "#92400e" : "#6b7280",
});
const actionBtn: React.CSSProperties = {
  padding: "7px 12px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 5,
};

export function EnquiriesPanel({ wing, onConvert, showFormInitially = false }: {
  wing: string;
  /** Hand the lead to the full admission form. */
  onConvert: (enquiry: Enquiry) => void;
  showFormInitially?: boolean;
}) {
  const [items, setItems]       = useState<Enquiry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState("");
  const [filter, setFilter]     = useState<EnquiryStatus | "open" | "all">("open");
  const [showForm, setShowForm] = useState(showFormInitially);
  const [busyId, setBusyId]     = useState<string | null>(null);
  const [flash, setFlash]       = useState("");

  const reload = useCallback(async () => {
    setErr("");
    try {
      setItems(await getEnquiries(wing));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load enquiries.");
    } finally {
      setLoading(false);
    }
  }, [wing]);

  useEffect(() => { reload(); }, [reload]);

  const counts = useMemo(() => ({
    new:       items.filter(e => e.status === "new").length,
    contacted: items.filter(e => e.status === "contacted").length,
    converted: items.filter(e => e.status === "converted").length,
  }), [items]);

  const shown = useMemo(() => items.filter(e =>
    filter === "all" ? true : filter === "open" ? e.status !== "converted" : e.status === filter,
  ), [items, filter]);

  async function handleContacted(e: Enquiry) {
    setBusyId(e.id);
    try {
      await markEnquiryContacted(e.id);
      setItems(list => list.map(x => x.id === e.id ? { ...x, status: "contacted", contactedAt: new Date().toISOString() } : x));
    } catch (er) {
      setErr(er instanceof Error ? er.message : "Could not update the enquiry.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {/* Quick enquiry form */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18, padding: showForm ? 22 : "14px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>Quick enquiry</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Capture a lead in seconds — convert it to a full admission later.</div>
          </div>
          <button onClick={() => setShowForm(v => !v)} style={{ ...actionBtn, background: showForm ? "#f3f4f6" : ACCENT, color: showForm ? "#374151" : "#fff", border: "none", padding: "9px 16px" }}>
            {showForm ? "Hide form" : "+ New enquiry"}
          </button>
        </div>
        {showForm && (
          <div style={{ marginTop: 18 }}>
            <EnquiryForm wing={wing} source="staff" onCreated={() => {
              setFlash("Enquiry saved.");
              setTimeout(() => setFlash(""), 2500);
              reload();
            }} />
          </div>
        )}
        {flash && <div style={{ marginTop: 10, fontSize: 13, color: "#15803d", fontWeight: 600 }}>✓ {flash}</div>}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button style={pill(filter === "open")} onClick={() => setFilter("open")}>Open ({counts.new + counts.contacted})</button>
        <button style={pill(filter === "new")} onClick={() => setFilter("new")}>New ({counts.new})</button>
        <button style={pill(filter === "contacted")} onClick={() => setFilter("contacted")}>Contacted ({counts.contacted})</button>
        <button style={pill(filter === "converted")} onClick={() => setFilter("converted")}>Converted ({counts.converted})</button>
        <button style={pill(filter === "all")} onClick={() => setFilter("all")}>All ({items.length})</button>
      </div>

      {err && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 13px", fontSize: 13, color: "#dc2626", marginBottom: 12 }}>{err}</div>
      )}

      {/* Lead list */}
      {loading ? (
        <div style={{ padding: 30, textAlign: "center", fontSize: 13, color: "#9ca3af" }}>Loading enquiries…</div>
      ) : shown.length === 0 ? (
        <div style={{ padding: "36px 16px", textAlign: "center", fontSize: 13, color: "#9ca3af", background: "#fafafa", borderRadius: 14, border: "1px dashed #e5e7eb" }}>
          {items.length === 0 ? "No enquiries yet. Add one above or share the parent QR code." : "Nothing in this filter."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map(e => {
            const st = STATUS_STYLE[e.status] ?? STATUS_STYLE.new;
            return (
              <div key={e.id} style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 14, padding: "14px 16px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>{e.studentName}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: st.color, background: st.bg, borderRadius: 999, padding: "2px 9px" }}>{st.label}</span>
                    {e.source === "qr" && (
                      <span title="Submitted by a parent via the QR code" style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", background: "#f3f4f6", borderRadius: 999, padding: "2px 9px" }}>📱 QR</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: "#4b5563", marginTop: 4 }}>
                    Parent: {e.parentName} · <a href={`tel:+91${e.phone}`} style={{ color: "#4f46e5", fontWeight: 600, textDecoration: "none" }}>{formatPhone(e.phone)}</a>
                  </div>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>
                    {[e.place, e.instrument || null, fmtDate(e.createdAt)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {e.status === "new" && (
                    <button disabled={busyId === e.id} onClick={() => handleContacted(e)}
                      style={{ ...actionBtn, background: "#fff", color: "#1d4ed8", border: "1px solid #bfdbfe", opacity: busyId === e.id ? 0.6 : 1 }}>
                      ☎ Mark contacted
                    </button>
                  )}
                  {e.status !== "converted" ? (
                    <button onClick={() => onConvert(e)}
                      style={{ ...actionBtn, background: ACCENT, color: "#fff", border: "none" }}>
                      Convert to admission →
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: "#15803d", fontWeight: 600 }}>
                      ✓ Application created{e.convertedAt ? ` ${fmtDate(e.convertedAt)}` : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
