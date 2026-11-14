"use client";

// Enquiries tab on /dashboard/admissions — quick prospect leads (from staff or
// the parent QR code) with Mark contacted / Convert to admission actions.
// The list is a live Firestore subscription, so "Online Lead" submissions from
// the public /enquiry page show up under Open as soon as a parent sends one.

import { useEffect, useMemo, useState } from "react";
import EnquiryForm from "@/components/enquiry/EnquiryForm";
import {
  subscribeEnquiries, markEnquiryContacted, restoreAdmissionFromEnquiry,
  type Enquiry, type EnquiryStatus,
} from "@/services/enquiry/enquiry.service";
import { formatPhone } from "@/lib/enquiry";

const ACCENT = "#d97706";

const STATUS_STYLE: Record<EnquiryStatus, { label: string; color: string; bg: string }> = {
  new:       { label: "New",       color: "#b45309", bg: "#fef3c7" },
  follow_up: { label: "Pending Follow-up", color: "#be123c", bg: "#ffe4e6" },
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

export function EnquiriesPanel({ wing, onConvert, onShowQr, showFormInitially = false, canRestore = false, inModal = false }: {
  wing: string;
  /** Inside the centred popup: controls stay pinned, only the lead list scrolls. */
  inModal?: boolean;
  /** Wing leaders: may restore an application that was moved here. */
  canRestore?: boolean;
  /** Hand the lead to the full admission form. */
  onConvert: (enquiry: Enquiry) => void;
  /** Opens the parent QR modal on the Quick Enquiry code. */
  onShowQr?: () => void;
  showFormInitially?: boolean;
}) {
  const [items, setItems]       = useState<Enquiry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState("");
  const [filter, setFilter]     = useState<EnquiryStatus | "open" | "all">("open");
  const [showForm, setShowForm] = useState(showFormInitially);
  const [busyId, setBusyId]     = useState<string | null>(null);
  const [flash, setFlash]       = useState("");

  useEffect(() => {
    setLoading(true);
    setErr("");
    return subscribeEnquiries(
      wing,
      list => { setItems(list); setLoading(false); },
      e => { setErr(e.message || "Could not load enquiries."); setLoading(false); },
    );
  }, [wing]);

  const counts = useMemo(() => ({
    new:       items.filter(e => e.status === "new").length,
    follow_up: items.filter(e => e.status === "follow_up").length,
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

  async function handleRestore(e: Enquiry) {
    setBusyId(e.id);
    setErr("");
    try {
      await restoreAdmissionFromEnquiry(e.id);
      setFlash(`${e.studentName}'s application is back in Admissions with all its data.`);
      setTimeout(() => setFlash(""), 4000);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "Could not restore the application.");
    } finally {
      setBusyId(null);
    }
  }

  const controls = (
    <>
      {/* Quick enquiry form */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18, padding: showForm ? 22 : "14px 20px", marginBottom: inModal ? 12 : 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>Quick enquiry</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Capture a lead in seconds — convert it to a full admission later.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onShowQr && (
              <button onClick={onShowQr} style={{ ...actionBtn, background: "#fff", color: "#b45309", border: "1.5px solid #fcd34d", padding: "9px 14px" }}>
                <span aria-hidden>📱</span> Enquiry QR code
              </button>
            )}
            <button onClick={() => setShowForm(v => !v)} style={{ ...actionBtn, background: showForm ? "#f3f4f6" : ACCENT, color: showForm ? "#374151" : "#fff", border: "none", padding: "9px 16px" }}>
              {showForm ? "Hide form" : "+ New enquiry"}
            </button>
          </div>
        </div>
        {showForm && (
          <div style={{ marginTop: 18 }}>
            <EnquiryForm wing={wing} source="staff" onCreated={() => {
              setFlash("Enquiry saved.");
              setTimeout(() => setFlash(""), 2500);
            }} />
          </div>
        )}
        {flash && <div style={{ marginTop: 10, fontSize: 13, color: "#15803d", fontWeight: 600 }}>✓ {flash}</div>}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: inModal ? 0 : 12 }}>
        <button style={pill(filter === "open")} onClick={() => setFilter("open")}>Open ({counts.new + counts.follow_up + counts.contacted})</button>
        <button style={pill(filter === "new")} onClick={() => setFilter("new")}>New ({counts.new})</button>
        {counts.follow_up > 0 && (
          <button style={pill(filter === "follow_up")} onClick={() => setFilter("follow_up")}>Follow-up ({counts.follow_up})</button>
        )}
        <button style={pill(filter === "contacted")} onClick={() => setFilter("contacted")}>Contacted ({counts.contacted})</button>
        <button style={pill(filter === "converted")} onClick={() => setFilter("converted")}>Converted ({counts.converted})</button>
        <button style={pill(filter === "all")} onClick={() => setFilter("all")}>All ({items.length})</button>
      </div>

      {err && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 13px", fontSize: 13, color: "#dc2626", marginBottom: inModal ? 0 : 12, marginTop: inModal ? 10 : 0 }}>{err}</div>
      )}
    </>
  );

  const list = (
    <>
      {/* Lead list */}
      {loading ? (
        <div style={{ padding: 30, textAlign: "center", fontSize: 13, color: "#9ca3af" }}>Loading enquiries…</div>
      ) : shown.length === 0 ? (
        <div style={{ padding: "36px 16px", textAlign: "center", fontSize: 13, color: "#9ca3af", background: "#fafafa", borderRadius: 14, border: "1px dashed #e5e7eb" }}>
          {items.length === 0 ? "No enquiries yet. Add one above or share the parent QR code." : "Nothing in this filter."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: inModal ? 12 : 10 }}>
          {shown.map(e => {
            const st = STATUS_STYLE[e.status] ?? STATUS_STYLE.new;
            return (
              <div key={e.id} style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 14, padding: inModal ? "18px 20px" : "14px 16px", display: "flex", gap: inModal ? 18 : 14, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>{e.studentName}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: st.color, background: st.bg, borderRadius: 999, padding: "2px 9px" }}>{st.label}</span>
                    {e.source === "admission" && (
                      <span title="Moved here from an incomplete admission application — its full record is kept"
                        style={{ fontSize: 11, fontWeight: 700, color: "#4338ca", background: "#e0e7ff", borderRadius: 999, padding: "2px 9px" }}>
                        📝 From application{e.applicationRef ? ` ${e.applicationRef}` : ""}
                      </span>
                    )}
                    {e.source === "qr" && (
                      <span title="Submitted by a parent from their phone (QR code / enquiry link)" style={{ fontSize: 11, fontWeight: 700, color: "#6d28d9", background: "#ede9fe", borderRadius: 999, padding: "2px 9px" }}>📱 Online Lead</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: "#4b5563", marginTop: 4 }}>
                    Parent: {e.parentName} · <a href={`tel:+91${e.phone}`} style={{ color: "#4f46e5", fontWeight: 600, textDecoration: "none" }}>{formatPhone(e.phone)}</a>
                  </div>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>
                    {[e.place, e.instrument || null, fmtDate(e.createdAt)].filter(Boolean).join(" · ")}
                  </div>
                  {e.source === "admission" && <MovedApplicationInfo e={e} />}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(e.status === "new" || e.status === "follow_up") && (
                    <button disabled={busyId === e.id} onClick={() => handleContacted(e)}
                      style={{ ...actionBtn, background: "#fff", color: "#1d4ed8", border: "1px solid #bfdbfe", opacity: busyId === e.id ? 0.6 : 1 }}>
                      ☎ Mark contacted
                    </button>
                  )}
                  {e.source === "admission" && e.admissionId ? (
                    e.status !== "converted" ? (
                      canRestore ? (
                        <button disabled={busyId === e.id} onClick={() => handleRestore(e)}
                          title="Put the application back in Admissions — form, photo and screening intact"
                          style={{ ...actionBtn, background: "#4f46e5", color: "#fff", border: "none", opacity: busyId === e.id ? 0.6 : 1 }}>
                          {busyId === e.id ? "Restoring…" : "↩ Restore application"}
                        </button>
                      ) : null
                    ) : (
                      <span style={{ fontSize: 12, color: "#15803d", fontWeight: 600 }}>
                        ✓ Restored to Admissions{e.convertedAt ? ` ${fmtDate(e.convertedAt)}` : ""}
                      </span>
                    )
                  ) : e.status !== "converted" ? (
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
    </>
  );

  if (!inModal) return <div>{controls}{list}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Pinned: Quick enquiry + filter tabs. With the form open it can
          scroll on its own so the list never disappears. */}
      <div style={{
        flexShrink: 0, padding: "16px 24px 14px", borderBottom: "1px solid #eee",
        ...(showForm ? { maxHeight: "50vh", overflowY: "auto" as const } : {}),
      }}>
        {controls}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 24 }}>
        {list}
      </div>
    </div>
  );
}

/** Context for a lead moved over from an application: what was done, why it moved. */
function MovedApplicationInfo({ e }: { e: Enquiry }) {
  const a = e.applicationSummary ?? {};
  const facts = [
    a.age ? `Age ${a.age}` : null,
    a.course || (a.instruments?.length ? a.instruments.join(", ") : null),
    e.applicationDate ? `Applied ${fmtDate(e.applicationDate)}` : null,
  ].filter(Boolean).join(" · ");
  const steps: [string, boolean | undefined][] = [["Photo", a.hasPhoto], ["Screening", a.screened], ["Fee", a.feePaid]];
  return (
    <div style={{ marginTop: 8, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "8px 10px", fontSize: 12, color: "#475569" }}>
      {facts && <div>{facts}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: facts ? 5 : 0 }}>
        {steps.map(([label, done]) => (
          <span key={label} style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "1px 8px", color: done ? "#15803d" : "#9ca3af", background: done ? "#dcfce7" : "#f3f4f6" }}>
            {done ? "✓" : "–"} {label}
          </span>
        ))}
      </div>
      {e.transferNote && <div style={{ marginTop: 6, color: "#334155" }}>“{e.transferNote}”</div>}
      <div style={{ marginTop: 4, fontSize: 11, color: "#94a3b8" }}>
        Moved {e.movedAt ? fmtDate(e.movedAt) : ""}{e.movedByName ? ` by ${e.movedByName}` : ""} · full application kept on file
      </div>
    </div>
  );
}

/**
 * Centred popup holding the whole enquiry workflow (form, filters, Mark
 * contacted / Convert, enquiry QR). Opened from the "Enquiries" header button
 * on /dashboard/admissions, both wings. Title, Quick enquiry buttons and the
 * filter tabs stay pinned; only the lead list scrolls. Closes on ✕, a click
 * on the backdrop, or Escape.
 */
export function EnquiriesDrawer({ wing, onClose, onConvert, onShowQr, canRestore }: {
  wing: string;
  canRestore?: boolean;
  onClose: () => void;
  onConvert: (enquiry: Enquiry) => void;
  onShowQr?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // Keep the page behind still while the popup is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <>
      <style>{`@keyframes enqFade{from{opacity:0}to{opacity:1}}@keyframes enqPop{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:none}}`}</style>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        animation: "enqFade 0.2s ease",
      }}>
        <div role="dialog" aria-modal="true" aria-label="Enquiries" onClick={e => e.stopPropagation()} style={{
          width: "100%", maxWidth: 896, maxHeight: "88vh", display: "flex", flexDirection: "column",
          background: "#faf9f7", borderRadius: 16, overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.28)", animation: "enqPop 0.22s cubic-bezier(0.4,0,0.2,1)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 24px", borderBottom: "1px solid #eee", background: "#fff", flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#78350f" }}>Enquiries</div>
              <div style={{ fontSize: 12, color: "#92400e", opacity: 0.8, marginTop: 2 }}>Leads from staff and the parent QR code</div>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ background: "#f3f4f6", border: "none", width: 34, height: 34, borderRadius: 999, fontSize: 16, cursor: "pointer", color: "#6b7280", lineHeight: 1 }}>✕</button>
          </div>
          <EnquiriesPanel wing={wing} onConvert={onConvert} onShowQr={onShowQr} canRestore={canRestore} inModal />
        </div>
      </div>
    </>
  );
}
