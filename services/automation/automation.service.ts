import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { applyMonthlyFee } from "@/services/finance/finance.service";
import { checkGhostClass } from "@/services/attendance/attendance.service";

// ─── Monthly Billing ──────────────────────────────────────────────────────────

/**
 * Run monthly billing for all active students.
 * Calls applyMonthlyFee for each student — skips if already charged this cycle.
 * Returns a summary of charged and skipped counts.
 */
export async function runMonthlyBilling(): Promise<{
  charged: number;
  skipped: number;
  errors:  number;
}> {
  const snap = await getDocs(
    query(
      collection(db, "users"),
      where("role",   "==", "student"),
      where("status", "==", "active")
    )
  );

  let charged = 0;
  let skipped = 0;
  let errors  = 0;

  for (const studentDoc of snap.docs) {
    const studentUid = studentDoc.id;
    try {
      const applied = await applyMonthlyFee(studentUid);
      if (applied) charged++;
      else         skipped++;
    } catch (error) {
      console.error(`MONTHLY_BILLING_ERROR [${studentUid}]:`, error);
      errors++;
    }
  }

  console.log(`runMonthlyBilling complete — charged: ${charged}, skipped: ${skipped}, errors: ${errors}`);
  return { charged, skipped, errors };
}

// ─── Ghost Check ──────────────────────────────────────────────────────────────

/**
 * Run ghost class check for all scheduled classes.
 * Calls checkGhostClass for each — marks ghost if conditions met.
 * Returns a summary of ghosted and skipped counts.
 */
export async function runGhostCheck(): Promise<{
  ghosted: number;
  skipped: number;
  errors:  number;
}> {
  const snap = await getDocs(
    query(
      collection(db, "classes"),
      where("status", "==", "scheduled")
    )
  );

  let ghosted = 0;
  let skipped = 0;
  let errors  = 0;

  for (const classDoc of snap.docs) {
    const classId = classDoc.id;
    try {
      const marked = await checkGhostClass(classId);
      if (marked) ghosted++;
      else        skipped++;
    } catch (error) {
      console.error(`GHOST_CHECK_ERROR [${classId}]:`, error);
      errors++;
    }
  }

  console.log(`runGhostCheck complete — ghosted: ${ghosted}, skipped: ${skipped}, errors: ${errors}`);
  return { ghosted, skipped, errors };
}
