// ─── ONE-TIME BACKFILL: wings + founder rename ────────────────────────────────
// Run once from the project root:  node scripts/backfill-wings.mjs
//
// Idempotent — safe to re-run. It:
//   1. Renames every user with role "super_admin" → "founder".
//   2. Stamps wing: "rol_plus" on every wing-scoped doc that has no `wing`
//      field yet (all existing data belongs to the original wing).
//
// Firestore rules are open on this project, so the client SDK is enough.
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, getDocs, doc, writeBatch,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey:            "AIzaSyDMMMYyamkxlz_Ot13_MQz4IDgV3dhrKMo",
  authDomain:        "rol-plus-erp.firebaseapp.com",
  projectId:         "rol-plus-erp",
  storageBucket:     "rol-plus-erp.firebasestorage.app",
  messagingSenderId: "230996545595",
  appId:             "1:230996545595:web:3bf7b9602f56ab038a0c1e",
};

const DEFAULT_WING = "rol_plus";

// Collections whose documents are wing-scoped.
const WING_COLLECTIONS = [
  "users", "centers", "transactions", "attendance",
  "screenings", "admissions", "syllabus", "finance_records",
  "guitar-screenings", "keyboard-screenings", "drum-screenings",
];

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

async function commitInChunks(ops) {
  // Firestore batches cap at 500 writes.
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    for (const { ref, data } of ops.slice(i, i + 450)) batch.update(ref, data);
    await batch.commit();
  }
}

async function run() {
  let renamed = 0;
  let stamped = 0;

  for (const col of WING_COLLECTIONS) {
    let snap;
    try {
      snap = await getDocs(collection(db, col));
    } catch (err) {
      console.warn(`  (skip ${col}: ${err.message})`);
      continue;
    }
    const ops = [];
    for (const d of snap.docs) {
      const data = d.data();
      const patch = {};
      if (col === "users" && data.role === "super_admin") {
        patch.role = "founder";
        renamed++;
      }
      if (data.wing === undefined || data.wing === null || data.wing === "") {
        patch.wing = DEFAULT_WING;
        stamped++;
      }
      if (Object.keys(patch).length > 0) {
        ops.push({ ref: doc(db, col, d.id), data: patch });
      }
    }
    if (ops.length > 0) {
      await commitInChunks(ops);
      console.log(`  ${col}: ${ops.length} docs updated`);
    } else {
      console.log(`  ${col}: nothing to do`);
    }
  }

  console.log(`\n✅ Done. super_admin→founder: ${renamed}. wing stamped: ${stamped}.`);
}

run().then(() => process.exit(0)).catch(err => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
