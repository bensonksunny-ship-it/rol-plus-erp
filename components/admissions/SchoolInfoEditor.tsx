"use client";

// Admissions → ℹ School Info: wing leaders edit what parents see after sending
// a public enquiry (components/enquiry/SchoolInfoView). Blank sections stay
// hidden on the parents' page.

import { useEffect, useState } from "react";
import { DEFAULT_SCHOOL_INFO, type SchoolCourse, type SchoolInfo, type SchoolLeader } from "@/lib/schoolInfo";
import { loadSchoolInfo, saveSchoolInfo } from "@/services/schoolInfo.service";

const ACCENT = "#4f46e5";
const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 };
const hint: React.CSSProperties = { fontSize: 11.5, color: "#9ca3af", marginTop: 3 };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9, border: "1px solid #d1d5db", fontSize: 13.5, fontFamily: "inherit", color: "#111827", background: "#fff" };
const group: React.CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 14, display: "grid", gap: 12 };
const groupTitle: React.CSSProperties = { fontSize: 14, fontWeight: 800, color: "#111827" };
const smallBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };

export function SchoolInfoEditor({ wing, onClose }: { wing: string; onClose: () => void }) {
  const [info, setInfo]     = useState<SchoolInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState<{ ok: boolean; text: string } | null>(null);
  // Free-text mirrors so typing commas / new lines isn't fought by the parser.
  const [instrumentsText, setInstrumentsText] = useState("");
  const [kitText, setKitText] = useState("");

  useEffect(() => {
    loadSchoolInfo(wing).catch(() => DEFAULT_SCHOOL_INFO).then(i => {
      setInfo(i); setInstrumentsText(i.instruments.join(", ")); setKitText(i.kit.join("\n"));
    });
  }, [wing]);

  if (!info) {
    return <Shell onClose={onClose}><div style={{ padding: 30, textAlign: "center", color: "#9ca3af" }}>Loading…</div></Shell>;
  }

  const set = <K extends keyof SchoolInfo>(k: K, v: SchoolInfo[K]) => { setInfo({ ...info, [k]: v }); setMsg(null); };
  const setLeader = (i: number, patch: Partial<SchoolLeader>) => set("leaders", info.leaders.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const setCourse = (i: number, patch: Partial<SchoolCourse>) => set("courses", info.courses.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  async function save() {
    if (!info) return;
    setSaving(true); setMsg(null);
    try {
      const saved = await saveSchoolInfo(wing, {
        ...info,
        instruments: instrumentsText.split(",").map(x => x.trim()).filter(Boolean),
        kit: kitText.split("\n").map(x => x.trim()).filter(Boolean),
      });
      setInfo(saved); setInstrumentsText(saved.instruments.join(", ")); setKitText(saved.kit.join("\n"));
      setMsg({ ok: true, text: "Saved — parents see this after sending an enquiry." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell onClose={onClose} footer={
      <>
        {msg && <span style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? "#15803d" : "#dc2626", marginRight: "auto" }}>{msg.text}</span>}
        <a href={`/enquiry?wing=${encodeURIComponent(wing)}&preview=info`} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: "none", padding: "9px 14px" }}>Preview ↗</a>
        <button onClick={save} disabled={saving} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: ACCENT, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </>
    }>
      <div style={{ fontSize: 12.5, color: "#6b7280" }}>
        Shown to parents right after they send an enquiry from the QR code. Leave a section blank to hide it.
      </div>

      <div style={group}>
        <div style={groupTitle}>🏛️ About Our Academy</div>
        <div><span style={label}>Established</span><input style={input} value={info.established} onChange={e => set("established", e.target.value)} placeholder="e.g. 2005" /></div>
        <div><span style={label}>Background</span><textarea style={{ ...input, minHeight: 70 }} value={info.background} onChange={e => set("background", e.target.value)} placeholder="A few lines about the school's story" /></div>
        {info.leaders.map((l, i) => (
          <div key={i} style={{ display: "grid", gap: 6, background: "#f9fafb", borderRadius: 10, padding: 10 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input style={{ ...input, flex: "0 0 34%" }} value={l.role} onChange={e => setLeader(i, { role: e.target.value })} placeholder="Role (e.g. Founder)" aria-label="Role" />
              <input style={input} value={l.name} onChange={e => setLeader(i, { name: e.target.value })} placeholder="Full name" aria-label="Name" />
              <button onClick={() => set("leaders", info.leaders.filter((_, k) => k !== i))} style={smallBtn} aria-label="Remove">✕</button>
            </div>
            <input style={input} value={l.bio} onChange={e => setLeader(i, { bio: e.target.value })} placeholder="One-line profile (optional)" aria-label="Profile" />
          </div>
        ))}
        <div><button onClick={() => set("leaders", [...info.leaders, { role: "", name: "", bio: "" }])} style={smallBtn}>+ Add person</button></div>
        <div style={hint}>A person without a name isn&apos;t shown.</div>
      </div>

      <div style={group}>
        <div style={groupTitle}>🎹 Courses & Progression</div>
        {info.courses.map((c, i) => (
          <div key={i} style={{ display: "grid", gap: 6, background: "#f9fafb", borderRadius: 10, padding: 10 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input style={input} value={c.level} onChange={e => setCourse(i, { level: e.target.value })} placeholder="Level (e.g. Introduction)" aria-label="Level" />
              <input style={input} value={c.tagline} onChange={e => setCourse(i, { tagline: e.target.value })} placeholder="Tagline (e.g. Foundation)" aria-label="Tagline" />
              <button onClick={() => set("courses", info.courses.filter((_, k) => k !== i))} style={smallBtn} aria-label="Remove">✕</button>
            </div>
            <input style={input} value={c.detail} onChange={e => setCourse(i, { detail: e.target.value })} placeholder="What it covers / duration (optional)" aria-label="Detail" />
          </div>
        ))}
        <div><button onClick={() => set("courses", [...info.courses, { level: "", tagline: "", detail: "" }])} style={smallBtn}>+ Add level</button></div>
        <div><span style={label}>Instruments</span><input style={input} value={instrumentsText} onChange={e => { setInstrumentsText(e.target.value); setMsg(null); }} placeholder="Keyboard, Piano, Guitar" /><div style={hint}>Separate with commas.</div></div>
      </div>

      <div style={group}>
        <div style={groupTitle}>🗓️ Classes & Fees</div>
        <div><span style={label}>Class frequency</span><textarea style={{ ...input, minHeight: 60 }} value={info.classFrequency} onChange={e => set("classFrequency", e.target.value)} placeholder={"e.g. 2 classes a week, 1 hour each\nWeekend batches available"} /></div>
        <div><span style={label}>Tuition fee</span><textarea style={{ ...input, minHeight: 50 }} value={info.tuitionFee} onChange={e => set("tuitionFee", e.target.value)} placeholder="e.g. ₹____ per month" /></div>
        <div><span style={label}>Admission fee (one-time)</span><input style={input} value={info.admissionFee} onChange={e => set("admissionFee", e.target.value)} placeholder="e.g. ₹____" /></div>
      </div>

      <div style={group}>
        <div style={groupTitle}>🎁 What We Provide at Admission</div>
        <div><textarea style={{ ...input, minHeight: 80 }} value={kitText} onChange={e => { setKitText(e.target.value); setMsg(null); }} placeholder={"One item per line, e.g.\nCourse syllabus & progress logbook"} /><div style={hint}>One item per line.</div></div>
      </div>

      <div style={group}>
        <div style={groupTitle}>📞 Call Button</div>
        <div><span style={label}>Phone number</span><input style={input} value={info.phone} onChange={e => set("phone", e.target.value)} placeholder="+91 99218 74088" inputMode="tel" /></div>
      </div>
    </Shell>
  );
}

function Shell({ children, footer, onClose }: { children: React.ReactNode; footer?: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 12px" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="School Info" style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 640, boxShadow: "0 24px 64px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#111" }}>ℹ️ School Info for Parents</div>
          <button onClick={onClose} style={smallBtn} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: "16px 20px", display: "grid", gap: 14, maxHeight: "70vh", overflowY: "auto" }}>{children}</div>
        {footer && <div style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>{footer}</div>}
      </div>
    </div>
  );
}
