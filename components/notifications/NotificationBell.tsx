"use client";

// 🔔 In-app notifications (Founder Suite follow-ups). The bell sits in the
// dashboard header for every signed-in user; NotificationList is also used by
// the Faculty Suite's own notifications panel.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  markAllNotificationsRead, markNotificationRead, subscribeMyNotifications, type AppNotification,
} from "@/services/notification/notification.service";

export function useMyNotifications(): AppNotification[] {
  const { user } = useAuthContext();
  const [list, setList] = useState<AppNotification[]>([]);
  useEffect(() => {
    if (!user?.uid) { setList([]); return; }
    return subscribeMyNotifications(user.uid, setList);
  }, [user?.uid]);
  return list;
}

const KIND_ICON: Record<string, string> = { attendance_nudge: "📋", fee_followup: "💰", general: "📣" };

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m) || m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function NotificationList({ list, onNavigate }: { list: AppNotification[]; onNavigate?: () => void }) {
  if (list.length === 0) {
    return <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 13, color: "var(--color-text-muted)" }}>No new notifications</div>;
  }
  return (
    <div style={{ maxHeight: 380, overflowY: "auto" }}>
      {list.map(n => {
        const body = (
          <div style={{ display: "flex", gap: 10, padding: "11px 16px", borderBottom: "1px solid var(--color-border)", background: n.read ? "transparent" : "var(--color-info-dim)" }}>
            <span aria-hidden style={{ fontSize: 16 }}>{KIND_ICON[n.kind] ?? "📣"}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: n.read ? 600 : 800, color: "var(--color-text-primary)" }}>{n.title}</div>
              <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 2, whiteSpace: "pre-line" }}>{n.body}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>{n.fromName ? `${n.fromName} · ` : ""}{ago(n.createdAt)}</div>
            </div>
            {!n.read && <span aria-label="unread" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-info)", marginTop: 6, flexShrink: 0 }} />}
          </div>
        );
        const open = () => { if (!n.read) void markNotificationRead(n.id); onNavigate?.(); };
        return n.link
          ? <Link key={n.id} href={n.link} onClick={open} style={{ textDecoration: "none", display: "block" }}>{body}</Link>
          : <div key={n.id} onClick={open} style={{ cursor: "pointer" }}>{body}</div>;
      })}
    </div>
  );
}

export default function NotificationBell({ style }: { style?: React.CSSProperties }) {
  const list = useMyNotifications();
  const unread = list.filter(n => !n.read);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`}
        style={{ position: "relative", width: 34, height: 34, borderRadius: "50%", border: "1px solid var(--color-border)", background: "var(--color-surface-2)", cursor: "pointer", fontSize: 15, display: "inline-flex", alignItems: "center", justifyContent: "center", ...style }}>
        🔔
        {unread.length > 0 && (
          <span style={{ position: "absolute", top: -4, right: -4, minWidth: 17, height: 17, padding: "0 4px", boxSizing: "border-box", borderRadius: 99, background: "#dc2626", color: "#fff", fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications"
          style={{ position: "absolute", right: 0, top: 42, width: "min(360px, calc(100vw - 24px))", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.15)", zIndex: 900, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: "1px solid var(--color-border)" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--color-text-primary)" }}>Notifications</span>
            {unread.length > 0 && (
              <button type="button" onClick={() => void markAllNotificationsRead(unread.map(n => n.id))}
                style={{ fontSize: 12, fontWeight: 600, color: "var(--color-info)", background: "none", border: "none", cursor: "pointer" }}>
                Mark all read
              </button>
            )}
          </div>
          <NotificationList list={list} onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
