// =============================================================================
// In-app notifications — follow-ups the Founder sends from the Founder Suite
// (nudge a teacher about unmarked attendance, alert a wing lead about fees).
// One doc per recipient in `notifications`; shown in the 🔔 bell
// (components/notifications/NotificationBell).
// =============================================================================

import {
  addDoc, collection, doc, onSnapshot, query, updateDoc, where, writeBatch,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";

const NOTIFICATIONS = "notifications";

export type NotificationKind = "attendance_nudge" | "fee_followup" | "general";

export interface AppNotification {
  id:        string;
  toUid:     string;
  fromUid:   string;
  fromName:  string;
  kind:      NotificationKind;
  title:     string;
  body:      string;
  /** In-app page to open (e.g. /dashboard/my-classes?centerId=…). */
  link:      string | null;
  wing:      string | null;
  read:      boolean;
  createdAt: string;   // ISO
}

export async function sendNotifications(
  toUids: string[],
  n: Omit<AppNotification, "id" | "toUid" | "read" | "createdAt">,
): Promise<void> {
  const createdAt = new Date().toISOString();
  await Promise.all([...new Set(toUids)].filter(Boolean).map(toUid =>
    addDoc(collection(db, NOTIFICATIONS), { ...n, toUid, read: false, createdAt })));
}

/** Live list of a user's notifications, newest first (max 50). */
export function subscribeMyNotifications(uid: string, cb: (list: AppNotification[]) => void): () => void {
  return onSnapshot(
    query(collection(db, NOTIFICATIONS), where("toUid", "==", uid)),
    snap => cb(snap.docs
      .map(d => ({ id: d.id, ...(d.data() as Omit<AppNotification, "id">) }))
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 50)),
    () => cb([]),
  );
}

export async function markNotificationRead(id: string): Promise<void> {
  await updateDoc(doc(db, NOTIFICATIONS, id), { read: true });
}

export async function markAllNotificationsRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const b = writeBatch(db);
  ids.forEach(id => b.update(doc(db, NOTIFICATIONS, id), { read: true }));
  await b.commit();
}
