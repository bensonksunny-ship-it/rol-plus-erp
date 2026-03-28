import {
  collection,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import type { AuditLog, LogActionInput } from "@/types/audit";

const AUDIT_LOGS = "audit_logs";

/**
 * Write an audit log entry for a critical action.
 * Never throws — audit failure must not block the main flow.
 * Logs write errors to console for observability.
 */
export async function logAction(data: LogActionInput): Promise<void> {
  try {
    await addDoc(collection(db, AUDIT_LOGS), {
      action:        data.action,
      initiatorId:   data.initiatorId,
      initiatorRole: data.initiatorRole,
      approverId:    data.approverId   ?? null,
      approverRole:  data.approverRole ?? null,
      reason:        data.reason       ?? null,
      metadata:      data.metadata     ?? {},
      timestamp:     serverTimestamp(),
    });
  } catch (error) {
    console.error("AUDIT_LOG_FAILED:", error);
  }
}
