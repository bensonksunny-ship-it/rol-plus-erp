import type { Timestamp } from "firebase/firestore";
import type { Role } from "@/types";

export interface AuditLog {
  id:            string;
  action:        string;           // e.g. "STUDENT_ASSIGNED", "FEE_APPLIED", "PROGRESS_OVERRIDE"
  initiatorId:   string;           // UID of user who triggered the action
  initiatorRole: Role;
  approverId:    string | null;    // UID of approver (null if no approval required)
  approverRole:  Role | null;
  timestamp:     Timestamp | string;
  reason:        string | null;    // required for sensitive actions (override, deactivation)
  metadata:      Record<string, unknown>; // contextual data (ids, amounts, etc.)
}

export type LogActionInput = Omit<AuditLog, "id" | "timestamp">;
