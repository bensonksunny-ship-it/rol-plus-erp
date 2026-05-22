import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { checkGhostClass } from "@/services/attendance/attendance.service";

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
