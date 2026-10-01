"use client";

// Admissions → ℹ School Info: wing leaders edit what parents see after sending
// a public enquiry (components/enquiry/SchoolInfoView). Blank sections stay
// hidden on the parents' page.
//
// Closes only on purpose — ✕ or Cancel (Save keeps it open with a confirmation).
// Never on a backdrop click: the backdrop is also the scroll area, so dragging its
// scrollbar or ending a text selection outside the box used to dismiss it. With
// unsaved edits, closing asks first.

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SCHOOL_INFO, MAX_SCHOOL_PHOTOS, type SchoolCourse, type SchoolInfo, type SchoolLeader, type SchoolPhoto } from "@/lib/schoolInfo";
import { SCHOOL_PHOTO_TYPES, deleteSchoolPhoto, loadSchoolInfo, saveSchoolInfo, uploadSchoolPhoto } from "@/services/schoolInfo.service";

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
  // Photo files: uploaded on pick. Ones added this session and never saved are
  // deleted if the editor closes without saving; saved ones removed here are
  // deleted only after the next successful save.
  const unsavedUploads = useRef(new Set<string>());
  const removedSaved   = useRef(new Set<string>());
  function closeEditor() {
    unsavedUploads.current.forEach(path => { void deleteSchoolPhoto(path); });
    unsavedUploads.current.clear();
    onClose();
  }
  // Snapshot of the last loaded / saved values — anything different is unsaved.
  const [savedSnap, setSavedSnap] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    loadSchoolInfo(wing).catch(() => DEFAULT_SCHOOL_INFO).then(i => {
      setInfo(i); setInstrumentsText(i.instruments.join(", ")); setKitText(i.kit.join("\n"));
      setSavedSnap(snapshot(i, i.instruments.join(", "), i.kit.join("\n")));
    });
  }, [wing]);

  if (!info) {
    return <Shell onClose={onClose}><div style={{ padding: 30, textAlign: "center", color: "#9ca3af" }}>Loading…</div></Shell>;
  }

  const dirty = snapshot(info, instrumentsText, kitText) !== savedSnap;
  function requestClose() {
    if (dirty && !confirmClose) { setConfirmClose(true); return; }
    closeEditor();
  }

  const set = <K extends keyof SchoolInfo>(k: K, v: SchoolInfo[K]) => { setInfo({ ...info, [k]: v }); setMsg(null); setConfirmClose(false); };
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
      removedSaved.current.forEach(path => { void deleteSchoolPhoto(path); });
      removedSaved.current.clear();
      unsavedUploads.current.clear();
      setSavedSnap(snapshot(saved, saved.instruments.join(", "), saved.kit.join("\n")));
      setConfirmClose(false);
      setMsg({ ok: true, text: "Saved — parents see this after sending an enquiry." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell onClose={requestClose} footer={confirmClose ? (
      <>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309", marginRight: "auto" }}>You have unsaved changes.</span>
        <button onClick={() => setConfirmClose(false)} style={{ ...smallBtn, padding: "9px 14px" }}>Keep editing</button>
        <button onClick={closeEditor} style={{ ...smallBtn, padding: "9px 14px", color: "#dc2626", borderColor: "#fecaca" }}>Discard &amp; close</button>
      </>
    ) : (
      <>
        {msg && <span style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? "#15803d" : "#dc2626", marginRight: "auto" }}>{msg.text}</span>}
        <button onClick={requestClose} style={{ ...smallBtn, padding: "9px 14px" }}>Cancel</button>
        <a href={`/enquiry?wing=${encodeURIComponent(wing)}&preview=info`} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: "none", padding: "9px 14px" }}>Preview ↗</a>
        <button onClick={save} disabled={saving} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: ACCENT, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </>
    )}>
      <div style={{ fontSize: 12.5, color: "#6b7280" }}>
        Shown to parents right after they send an enquiry from the QR code. Leave a section blank to hide it.
      </div>

      <div style={group}>
        <div style={groupTitle}>📸 School Highlights &amp; Facility Photos</div>
        <PhotoManager
          wing={wing}
          photos={info.photos}
          onChange={photos => setInfo(prev => (prev ? { ...prev, photos } : prev))}
          onUploaded={ph => unsavedUploads.current.add(ph.path)}
          onRemoved={ph => {
            if (unsavedUploads.current.delete(ph.path)) void deleteSchoolPhoto(ph.path);
            else removedSaved.current.add(ph.path);
          }}
        />
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
        <div><span style={label}>Instruments</span><input style={input} value={instrumentsText} onChange={e => { setInstrumentsText(e.target.value); setMsg(null); setConfirmClose(false); }} placeholder="Keyboard, Piano, Guitar" /><div style={hint}>Separate with commas.</div></div>
      </div>

      <div style={group}>
        <div style={groupTitle}>🗓️ Classes & Fees</div>
        <div><span style={label}>Class frequency</span><textarea style={{ ...input, minHeight: 60 }} value={info.classFrequency} onChange={e => set("classFrequency", e.target.value)} placeholder={"e.g. 2 classes a week, 1 hour each\nWeekend batches available"} /></div>
        <div><span style={label}>Tuition fee</span><textarea style={{ ...input, minHeight: 50 }} value={info.tuitionFee} onChange={e => set("tuitionFee", e.target.value)} placeholder="e.g. ₹____ per month" /></div>
        <div><span style={label}>Admission fee (one-time)</span><input style={input} value={info.admissionFee} onChange={e => set("admissionFee", e.target.value)} placeholder="e.g. ₹____" /></div>
      </div>

      <div style={group}>
        <div style={groupTitle}>🎁 What We Provide at Admission</div>
        <div><textarea style={{ ...input, minHeight: 80 }} value={kitText} onChange={e => { setKitText(e.target.value); setMsg(null); setConfirmClose(false); }} placeholder={"One item per line, e.g.\nCourse syllabus & progress logbook"} /><div style={hint}>One item per line.</div></div>
      </div>

      <div style={group}>
        <div style={groupTitle}>📞 Call Button</div>
        <div><span style={label}>Phone number</span><input style={input} value={info.phone} onChange={e => set("phone", e.target.value)} placeholder="+91 99218 74088" inputMode="tel" /></div>
      </div>
    </Shell>
  );
}

/** Comparable form state — the two free-text mirrors count, as that's what Save writes. */
function snapshot(info: SchoolInfo, instrumentsText: string, kitText: string): string {
  return JSON.stringify({ ...info, instruments: instrumentsText, kit: kitText });
}

function Shell({ children, footer, onClose }: { children: React.ReactNode; footer?: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 12px" }}>
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

// ─── Photo manager ────────────────────────────────────────────────────────────

function PhotoManager({ wing, photos, onChange, onUploaded, onRemoved }: {
  wing:       string;
  photos:     SchoolPhoto[];
  onChange:   (photos: SchoolPhoto[]) => void;
  onUploaded: (p: SchoolPhoto) => void;
  onRemoved:  (p: SchoolPhoto) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState("");
  // Latest list, so uploads finishing one by one don't overwrite each other.
  const latest = useRef(photos);
  latest.current = photos;

  async function addFiles(list: FileList | File[]) {
    setErr("");
    const all = Array.from(list);
    const files = all.filter(f => SCHOOL_PHOTO_TYPES.includes(f.type));
    const skipped = all.length - files.length;
    const room = MAX_SCHOOL_PHOTOS - latest.current.length;
    const take = files.slice(0, Math.max(0, room));
    const errors: string[] = [];
    if (skipped) errors.push(`${skipped} file${skipped !== 1 ? "s" : ""} skipped — PNG, JPEG or WebP only.`);
    if (files.length > take.length) errors.push(`Up to ${MAX_SCHOOL_PHOTOS} photos — ${files.length - take.length} not added.`);
    setUploading(n => n + take.length);
    await Promise.all(take.map(async f => {
      try {
        const ph = await uploadSchoolPhoto(wing, f);
        onUploaded(ph);
        latest.current = [...latest.current, ph];
        onChange(latest.current);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `${f.name} could not be uploaded.`);
      } finally {
        setUploading(n => n - 1);
      }
    }));
    if (errors.length) setErr(errors.join(" "));
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= photos.length) return;
    const next = [...photos];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        role="button" tabIndex={0}
        onClick={() => fileRef.current?.click()}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${drag ? ACCENT : "#c7d2fe"}`, borderRadius: 12, padding: "18px 12px", textAlign: "center",
          background: drag ? "#eef2ff" : "#f8faff", cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
        }}>
        <div style={{ fontSize: 26 }} aria-hidden>🖼️</div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#312e81", marginTop: 4 }}>
          {uploading > 0 ? `Uploading ${uploading} photo${uploading !== 1 ? "s" : ""}…` : "Drop photos here or tap to choose"}
        </div>
        <div style={hint}>PNG, JPEG or WebP · several at once · up to {MAX_SCHOOL_PHOTOS} photos · {photos.length} added</div>
        <input ref={fileRef} type="file" accept={SCHOOL_PHOTO_TYPES.join(",")} multiple hidden
          onChange={e => { if (e.target.files?.length) void addFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {err && <div style={{ fontSize: 12.5, color: "#dc2626" }}>{err}</div>}

      {photos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
          {photos.map((ph, i) => (
            <div key={ph.id} className="group" style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
              <div style={{ position: "relative", aspectRatio: "4 / 3", background: "#f3f4f6" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ph.url} alt={ph.caption || `Photo ${i + 1}`} loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                <button type="button" aria-label="Remove photo" title="Remove"
                  onClick={() => { onRemoved(ph); onChange(photos.filter(x => x.id !== ph.id)); }}
                  className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: "50%", border: "none", background: "rgba(17,24,39,0.75)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}>
                  ✕
                </button>
                <div style={{ position: "absolute", bottom: 6, left: 6, display: "flex", gap: 4 }}>
                  {i > 0 && <button type="button" aria-label="Move earlier" onClick={() => move(i, -1)} style={arrowBtn}>‹</button>}
                  {i < photos.length - 1 && <button type="button" aria-label="Move later" onClick={() => move(i, 1)} style={arrowBtn}>›</button>}
                </div>
              </div>
              <input value={ph.caption} maxLength={80} placeholder="Caption (optional)" aria-label={`Caption for photo ${i + 1}`}
                onChange={e => onChange(photos.map(x => (x.id === ph.id ? { ...x, caption: e.target.value } : x)))}
                style={{ ...input, border: "none", borderTop: "1px solid #e5e7eb", borderRadius: 0, fontSize: 12.5, padding: "7px 9px" }} />
            </div>
          ))}
        </div>
      )}
      {photos.length > 0 && <div style={hint}>The first photo leads the gallery. Changes go live when you press Save.</div>}
    </div>
  );
}

const arrowBtn: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: "none", background: "rgba(17,24,39,0.7)", color: "#fff",
  fontSize: 14, fontWeight: 800, cursor: "pointer", lineHeight: 1,
};
