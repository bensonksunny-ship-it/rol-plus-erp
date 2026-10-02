"use client";

// Founder Suite follow-up: pick recipients, edit the message, then
//   • "Send in app" — a notification in each recipient's 🔔 bell, and/or
//   • "WhatsApp"    — opens WhatsApp with the message pre-written to that
//                     person's saved number (you press Send there).
// Every in-app send is written to the audit log.

import { useState } from "react";
import { useAuthContext } from "@/features/auth/AuthContext";
import { sendNotifications, type NotificationKind } from "@/services/notification/notification.service";
import { logAction } from "@/services/audit/audit.service";
import { waLink } from "@/lib/whatsapp";
import type { Role } from "@/types";

export interface Recipient { uid: string; name: string; role: string; phone: string }

export function FollowUpModal({ title, recipients, defaultMessage, kind, link, wing, onClose }: {
  title: string;
  recipients: Recipient[];
  defaultMessage: string;
  kind: NotificationKind;
  link: string | null;
  wing: string | null;
  onClose: () => void;
}) {
  const { user } = useAuthContext();
  const [picked, setPicked] = useState<Set<string>>(new Set(recipients.map(r => r.uid)));
  const [msg, setMsg] = useState(defaultMessage);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const chosen = recipients.filter(r => picked.has(r.uid));

  async function sendInApp() {
    if (!user || chosen.length === 0 || !msg.trim()) return;
    setState("sending");
    try {
      await sendNotifications(chosen.map(r => r.uid), {
        fromUid: user.uid, fromName: String(user.displayName ?? "Founder"), kind, title, body: msg.trim(), link, wing,
      });
      logAction({
        action: "FOLLOWUP_SENT", initiatorId: user.uid, initiatorRole: (user.role ?? "founder") as Role,
        approverId: null, approverRole: null, reason: null,
        metadata: { kind, title, to: chosen.map(r => r.uid), wing },
      });
      setState("sent");
    } catch {
      setState("error");
    }
  }

  const btn: React.CSSProperties = { padding: "9px 14px", borderRadius: 9, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 950, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "40px 12px" }}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{ width: "100%", maxWidth: 520, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 16, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15.5, fontWeight: 800, color: "var(--color-text-primary)" }}>📣 {title}</div>
          <button onClick={onClose} aria-label="Close" style={{ ...btn, padding: "5px 10px" }}>✕</button>
        </div>

        <div style={{ padding: "16px 20px", display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 6 }}>To</div>
            {recipients.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--color-warning)" }}>No one is assigned for this yet (no teacher / wing lead on record).</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {recipients.map(r => {
                  const wa = waLink(r.phone, msg);
                  return (
                    <div key={r.uid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 10 }}>
                      <input type="checkbox" checked={picked.has(r.uid)} aria-label={`Send to ${r.name}`}
                        onChange={() => setPicked(prev => { const n = new Set(prev); if (n.has(r.uid)) n.delete(r.uid); else n.add(r.uid); return n; })} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--color-text-primary)" }}>{r.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>{r.role}{r.phone ? ` · ${r.phone}` : " · no phone saved"}</div>
                      </div>
                      {wa ? (
                        <a href={wa} target="_blank" rel="noreferrer"
                          style={{ ...btn, padding: "6px 10px", fontSize: 12, textDecoration: "none", color: "#15803d", borderColor: "#bbf7d0", background: "#f0fdf4" }}>
                          WhatsApp ↗
                        </a>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 6 }}>Message</div>
            <textarea value={msg} onChange={e => { setMsg(e.target.value); setState("idle"); }} rows={5}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-primary)", fontSize: 13.5, fontFamily: "inherit", resize: "vertical" }} />
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {state === "sent" && <span style={{ marginRight: "auto", fontSize: 12.5, fontWeight: 700, color: "var(--color-success)" }}>✓ Sent to {chosen.length} in the app</span>}
          {state === "error" && <span style={{ marginRight: "auto", fontSize: 12.5, fontWeight: 700, color: "var(--color-danger)" }}>Couldn&apos;t send — try again.</span>}
          <button onClick={onClose} style={btn}>Close</button>
          <button onClick={sendInApp} disabled={state === "sending" || chosen.length === 0 || !msg.trim()}
            style={{ ...btn, border: "none", background: "#4f46e5", color: "#fff", opacity: state === "sending" || chosen.length === 0 ? 0.55 : 1 }}>
            {state === "sending" ? "Sending…" : `🔔 Send in app${chosen.length ? ` (${chosen.length})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
