"use client";

// Post-enquiry screen for parents (public /enquiry): a thank-you banner, then
// the school's story, courses, class schedule, fees and starter kit (each a
// collapsible card, hidden while blank), ending with a call button.
// Content: lib/schoolInfo.ts, edited by wing leaders from Admissions.

import { useEffect, useState, type ReactNode } from "react";
import { WING_LABELS } from "@/config/constants";
import { DEFAULT_SCHOOL_INFO, telHref, type SchoolInfo } from "@/lib/schoolInfo";
import { loadSchoolInfo } from "@/services/schoolInfo.service";

const INK = "#1e1b4b", MUTED = "#4b5563", INDIGO = "#4f46e5";

function Section({ icon, title, children, defaultOpen = true }: { icon: string; title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, marginTop: 12, overflow: "hidden" }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
        <span aria-hidden style={{ width: 34, height: 34, borderRadius: 10, background: "#eef2ff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{icon}</span>
        <span style={{ flex: 1, fontSize: 15.5, fontWeight: 800, color: INK }}>{title}</span>
        <span aria-hidden style={{ fontSize: 13, color: "#9ca3af", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▼</span>
      </button>
      {open && <div style={{ padding: "0 16px 16px", fontSize: 14, color: MUTED, lineHeight: 1.6 }}>{children}</div>}
    </section>
  );
}

const Lines = ({ text }: { text: string }) => (
  <>{text.split("\n").map((l, i) => <div key={i}>{l}</div>)}</>
);

export default function SchoolInfoView({ wing, onAnother }: { wing: string; onAnother: () => void }) {
  const [info, setInfo] = useState<SchoolInfo | null>(null);
  useEffect(() => {
    let live = true;
    loadSchoolInfo(wing).then(i => { if (live) setInfo(i); }).catch(() => { if (live) setInfo(DEFAULT_SCHOOL_INFO); });
    return () => { live = false; };
  }, [wing]);

  const school = WING_LABELS[wing] ?? "our school";
  const i = info ?? DEFAULT_SCHOOL_INFO;
  const leaders = i.leaders.filter(l => l.name);
  const hasAbout = !!(i.established || i.background || leaders.length);
  const hasFees = !!(i.classFrequency || i.tuitionFee || i.admissionFee);
  const phone = i.phone || DEFAULT_SCHOOL_INFO.phone;

  return (
    <div>
      {/* Confirmation */}
      <div style={{ textAlign: "center", padding: "22px 16px", borderRadius: 18, background: "linear-gradient(135deg, #ecfdf5, #f0fdf4)", border: "1px solid #bbf7d0" }}>
        <div aria-hidden style={{ fontSize: 40 }}>✅</div>
        <div style={{ fontSize: 19, fontWeight: 900, color: "#15803d", marginTop: 6 }}>Thank you! Your enquiry has been received.</div>
        <div style={{ fontSize: 14, color: "#166534", marginTop: 6 }}>
          Here is everything you need to know about {school}:
        </div>
      </div>

      {!info && <div style={{ textAlign: "center", color: "#9ca3af", fontSize: 13, padding: "18px 0" }}>Loading school details…</div>}

      {info && (
        <>
          {hasAbout && (
            <Section icon="🏛️" title="About Our Academy">
              {i.established && <div><b style={{ color: INK }}>Established:</b> {i.established}</div>}
              {i.background && <div style={{ marginTop: i.established ? 6 : 0 }}><Lines text={i.background} /></div>}
              {leaders.length > 0 && (
                <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                  {leaders.map((l, k) => (
                    <div key={k} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: "#f9fafb", borderRadius: 12, padding: 12 }}>
                      <span aria-hidden style={{ width: 40, height: 40, borderRadius: "50%", background: INDIGO, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, flexShrink: 0 }}>
                        {l.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <div style={{ fontWeight: 800, color: INK }}>{l.name}</div>
                        {l.role && <div style={{ fontSize: 12, fontWeight: 700, color: INDIGO, textTransform: "uppercase", letterSpacing: "0.04em" }}>{l.role}</div>}
                        {l.bio && <div style={{ fontSize: 13, marginTop: 4 }}>{l.bio}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {(i.courses.length > 0 || i.instruments.length > 0) && (
            <Section icon="🎹" title="Courses & Progression">
              {i.courses.length > 0 && (
                <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                  {i.courses.map((c, k) => (
                    <li key={k} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <span aria-hidden style={{ width: 26, height: 26, borderRadius: "50%", background: "#eef2ff", color: INDIGO, fontWeight: 800, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>{k + 1}</span>
                      <div>
                        <span style={{ fontWeight: 800, color: INK }}>{c.level}</span>
                        {c.tagline && <span style={{ color: INDIGO, fontWeight: 600 }}> · {c.tagline}</span>}
                        {c.detail && <div style={{ fontSize: 13 }}>{c.detail}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {i.instruments.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 6 }}>Instruments</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {i.instruments.map(n => (
                      <span key={n} style={{ fontSize: 13, fontWeight: 600, color: INK, background: "#f3f4f6", borderRadius: 999, padding: "4px 12px" }}>{n}</span>
                    ))}
                  </div>
                </div>
              )}
            </Section>
          )}

          {hasFees && (
            <Section icon="🗓️" title="Classes & Fees">
              <div style={{ display: "grid", gap: 10 }}>
                {i.classFrequency && <FeeRow label="Class frequency" value={i.classFrequency} />}
                {i.tuitionFee && <FeeRow label="Tuition fee" value={i.tuitionFee} />}
                {i.admissionFee && <FeeRow label="Admission fee (one-time)" value={i.admissionFee} />}
              </div>
            </Section>
          )}

          {i.kit.length > 0 && (
            <Section icon="🎁" title="What We Provide at Admission">
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
                {i.kit.map((k, n) => (
                  <li key={n} style={{ display: "flex", gap: 8 }}><span aria-hidden style={{ color: "#16a34a", fontWeight: 800 }}>✓</span>{k}</li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {/* Call to action */}
      <div style={{ marginTop: 20, padding: 20, background: "#eef2ff", border: "1px solid #e0e7ff", borderRadius: 18, textAlign: "center" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#312e81" }}>Have Questions or Ready to Join?</div>
        <div style={{ fontSize: 13.5, color: "#4338ca", margin: "4px 0 14px" }}>
          Connect directly with our admissions coordinator for instant assistance.
        </div>
        <a href={telHref(phone)} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", boxSizing: "border-box",
          padding: "14px 20px", background: INDIGO, color: "#fff", fontWeight: 700, fontSize: 16, borderRadius: 12,
          textDecoration: "none", boxShadow: "0 6px 16px rgba(79,70,229,0.3)",
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
          Call Us: {phone}
        </a>
      </div>

      <div style={{ textAlign: "center", marginTop: 16 }}>
        <button onClick={onAnother} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          Submit another enquiry
        </button>
      </div>
    </div>
  );
}

function FeeRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#f9fafb", borderRadius: 12, padding: "10px 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: INDIGO, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 14.5, color: INK, fontWeight: 600, marginTop: 2 }}><Lines text={value} /></div>
    </div>
  );
}
