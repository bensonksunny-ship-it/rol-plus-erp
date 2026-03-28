/**
 * Alert Engine — centralized service for ROL's Plus alert detection and management.
 *
 * Detection functions are designed to run:
 *  - detectGhostClass()       → every 15 minutes (scheduled job or manual trigger)
 *  - detectRevenueLeakage()   → triggered after attendance is written
 *  - detectDormancy()         → once daily
 *
 * All detection functions are IDEMPOTENT — they check for an existing active alert
 * before creating a new one. No duplicates will be created.
 *
 * All resolve actions are audit-logged via logAction().
 */

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDocs,
  getDocFromServer,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type { Alert, AlertType, AlertStatus, CreateAlertInput } from "@/types/alert";
import type { Role } from "@/types";
import type { Class } from "@/types/attendance";

// ─── Collection ───────────────────────────────────────────────────────────────

const ALERTS     = "alerts";
const CLASSES    = "classes";
const ATTENDANCE = "attendance";
const USERS      = "users";

// ─── Thresholds ───────────────────────────────────────────────────────────────

const GHOST_THRESHOLD_MINS  = 30;
const DORMANCY_THRESHOLD_DAYS = 14;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if an active alert of the given type already exists for the key.
 * Key is typically classId or studentId — stored in the appropriate field.
 */
async function activeAlertExists(
  type:     AlertType,
  keyField: "classId" | "studentId",
  keyValue: string,
): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, ALERTS),
      where("type",      "==", type),
      where("status",    "==", "active"),
      where(keyField,    "==", keyValue),
    )
  );
  return !snap.empty;
}

async function createAlert(input: CreateAlertInput): Promise<Alert> {
  const ref = await addDoc(collection(db, ALERTS), {
    ...input,
    status:     "active",
    createdAt:  serverTimestamp(),
    resolvedAt: null,
    resolvedBy: null,
  });
  const snap = await getDocFromServer(ref);
  return { id: snap.id, ...snap.data() } as Alert;
}

// ─── Detection: Ghost Class ───────────────────────────────────────────────────

/**
 * Scans all scheduled classes where teacherClockIn exists and it has been
 * more than GHOST_THRESHOLD_MINS minutes with zero attendance.
 *
 * Idempotent — skips if an active ghost_class alert already exists for that class.
 * Should be called every 15 minutes.
 */
export async function detectGhostClass(): Promise<number> {
  let created = 0;
  try {
    const cutoff = new Date(Date.now() - GHOST_THRESHOLD_MINS * 60 * 1000).toISOString();

    const classSnap = await getDocs(
      query(
        collection(db, CLASSES),
        where("status", "==", "scheduled"),
      )
    );

    for (const classDoc of classSnap.docs) {
      const cls = classDoc.data() as Class;

      // Must have clocked in
      if (!cls.teacherClockIn) continue;

      // Must have been at least 30 minutes since clock-in
      if (cls.teacherClockIn > cutoff) continue;

      // Skip if active alert already exists
      if (await activeAlertExists("ghost_class", "classId", classDoc.id)) continue;

      // Check attendance — must be zero
      const attSnap = await getDocs(
        query(collection(db, ATTENDANCE), where("classId", "==", classDoc.id))
      );
      if (!attSnap.empty) continue;

      await createAlert({
        type:      "ghost_class",
        severity:  "red",
        centerId:  cls.centerId,
        studentId: null,
        classId:   classDoc.id,
        message:   `Ghost class detected: teacher clocked in at ${cls.teacherClockIn} but no students marked present after ${GHOST_THRESHOLD_MINS} minutes.`,
        status:    "active",
      });

      logAction({
        action:        "ALERT_CREATED",
        initiatorId:   "system",
        initiatorRole: "admin",
        approverId:    null,
        approverRole:  null,
        reason:        null,
        metadata:      { alertType: "ghost_class", classId: classDoc.id, centerId: cls.centerId },
      });

      created++;
    }
  } catch (err) {
    console.error("detectGhostClass error:", err instanceof Error ? err.message : err);
  }
  return created;
}

// ─── Detection: Revenue Leakage ───────────────────────────────────────────────

/**
 * Checks a single student after attendance is marked present.
 * If the student's currentBalance > 0 (meaning they owe fees),
 * creates a RED revenue_leakage alert.
 *
 * Idempotent — skips if active alert already exists for this student.
 * Should be called immediately after a successful markAttendance (present).
 */
export async function detectRevenueLeakage(
  studentId: string,
  centerId:  string,
): Promise<void> {
  try {
    if (!studentId || !centerId) return;

    // Check for existing active alert (idempotency)
    if (await activeAlertExists("revenue_leakage", "studentId", studentId)) return;

    // Fetch student balance
    const studentSnap = await getDocFromServer(doc(db, USERS, studentId));
    if (!studentSnap.exists()) return;

    const balance: number = studentSnap.data().currentBalance ?? 0;
    if (balance <= 0) return;

    const name: string = studentSnap.data().displayName
      ?? studentSnap.data().name
      ?? studentId;

    await createAlert({
      type:      "revenue_leakage",
      severity:  "red",
      centerId,
      studentId,
      classId:   null,
      message:   `Revenue leakage: ${name} attended class with outstanding balance of ₹${balance}.`,
      status:    "active",
    });

    logAction({
      action:        "ALERT_CREATED",
      initiatorId:   "system",
      initiatorRole: "admin",
      approverId:    null,
      approverRole:  null,
      reason:        null,
      metadata:      { alertType: "revenue_leakage", studentId, centerId, balance },
    });
  } catch (err) {
    console.error("detectRevenueLeakage error:", err instanceof Error ? err.message : err);
  }
}

// ─── Detection: Dormancy ──────────────────────────────────────────────────────

/**
 * Scans all active students and raises a YELLOW dormancy alert if their
 * lastActivity (or updatedAt as fallback) is older than DORMANCY_THRESHOLD_DAYS.
 *
 * Idempotent — skips if active dormancy alert already exists for this student.
 * Should be called once daily.
 */
export async function detectDormancy(): Promise<number> {
  let created = 0;
  try {
    const cutoffDate = new Date(
      Date.now() - DORMANCY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
    );
    const cutoffIso  = cutoffDate.toISOString();

    const studentsSnap = await getDocs(
      query(
        collection(db, USERS),
        where("role", "==", "student"),
      )
    );

    for (const studentDoc of studentsSnap.docs) {
      const data = studentDoc.data();

      // Skip inactive / suspended students
      if (data.status && data.status !== "active") continue;

      // Resolve last activity timestamp
      const rawActivity: string | Timestamp | undefined =
        data.lastActivity ?? data.updatedAt;

      if (!rawActivity) continue;

      let lastActivityIso: string;
      if (rawActivity instanceof Timestamp) {
        lastActivityIso = rawActivity.toDate().toISOString();
      } else {
        lastActivityIso = String(rawActivity);
      }

      if (lastActivityIso >= cutoffIso) continue;

      // Skip if active dormancy alert already exists
      if (await activeAlertExists("dormancy", "studentId", studentDoc.id)) continue;

      const name: string = data.displayName ?? data.name ?? studentDoc.id;
      const daysSince    = Math.floor(
        (Date.now() - new Date(lastActivityIso).getTime()) / (1000 * 60 * 60 * 24)
      );

      await createAlert({
        type:      "dormancy",
        severity:  "yellow",
        centerId:  data.centerId ?? "",
        studentId: studentDoc.id,
        classId:   null,
        message:   `Dormant student: ${name} has had no activity for ${daysSince} days (last: ${lastActivityIso.slice(0, 10)}).`,
        status:    "active",
      });

      logAction({
        action:        "ALERT_CREATED",
        initiatorId:   "system",
        initiatorRole: "admin",
        approverId:    null,
        approverRole:  null,
        reason:        null,
        metadata:      {
          alertType:    "dormancy",
          studentId:    studentDoc.id,
          centerId:     data.centerId ?? "",
          daysSince,
          lastActivity: lastActivityIso.slice(0, 10),
        },
      });

      created++;
    }
  } catch (err) {
    console.error("detectDormancy error:", err instanceof Error ? err.message : err);
  }
  return created;
}

// ─── Read: List alerts ────────────────────────────────────────────────────────

export interface AlertFilters {
  type?:     AlertType;
  severity?: "yellow" | "red";
  centerId?: string;
  status?:   AlertStatus;
}

export async function getAlerts(
  filters:  AlertFilters = {},
  pageSize: number = 50,
): Promise<Alert[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const constraints: any[] = [orderBy("createdAt", "desc"), limit(pageSize)];

  if (filters.status)   constraints.unshift(where("status",   "==", filters.status));
  if (filters.type)     constraints.unshift(where("type",     "==", filters.type));
  if (filters.severity) constraints.unshift(where("severity", "==", filters.severity));
  if (filters.centerId) constraints.unshift(where("centerId", "==", filters.centerId));

  const snap = await getDocs(query(collection(db, ALERTS), ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Alert);
}

// ─── Write: Resolve alert ─────────────────────────────────────────────────────

export async function resolveAlert(
  alertId:      string,
  resolverId:   string,
  resolverRole: Role,
): Promise<void> {
  const alertRef  = doc(db, ALERTS, alertId);
  const alertSnap = await getDocFromServer(alertRef);
  if (!alertSnap.exists()) throw new Error(`ALERT_NOT_FOUND: ${alertId}`);

  const alert = alertSnap.data() as Alert;
  if (alert.status === "resolved") throw new Error(`ALERT_ALREADY_RESOLVED: ${alertId}`);

  const now = new Date().toISOString();

  await updateDoc(alertRef, {
    status:     "resolved",
    resolvedAt: now,
    resolvedBy: resolverId,
  });

  logAction({
    action:        "ALERT_RESOLVED",
    initiatorId:   resolverId,
    initiatorRole: resolverRole,
    approverId:    null,
    approverRole:  null,
    reason:        null,
    metadata:      {
      alertId,
      alertType: alert.type,
      centerId:  alert.centerId,
      studentId: alert.studentId,
      classId:   alert.classId,
      resolvedAt: now,
    },
  });
}
