import type { Timestamp } from "firebase/firestore";

// ─── Alert types ──────────────────────────────────────────────────────────────

export type AlertType     = "ghost_class" | "revenue_leakage" | "dormancy";
export type AlertSeverity = "yellow" | "red";
export type AlertStatus   = "active" | "resolved";

export interface Alert {
  id:          string;
  type:        AlertType;
  severity:    AlertSeverity;
  centerId:    string;
  studentId:   string | null;
  classId:     string | null;
  message:     string;
  status:      AlertStatus;
  createdAt:   Timestamp | string;
  resolvedAt:  string | null;
  resolvedBy:  string | null;  // UID of admin who resolved
}

export type CreateAlertInput = Omit<Alert, "id" | "createdAt" | "resolvedAt" | "resolvedBy">;

// ─── Notification stub (for future channel delivery) ─────────────────────────

export type NotificationChannel = "whatsapp" | "in_app";
export type NotificationStatus  = "pending" | "sent" | "failed";

export interface AlertNotification {
  id:        string;
  alertId:   string;
  type:      NotificationChannel;
  status:    NotificationStatus;
  createdAt: Timestamp | string;
  sentAt:    string | null;
}
