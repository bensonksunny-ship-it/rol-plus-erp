// ─── ONE-TIME SEED SCRIPT ─────────────────────────────────────────
// Run once from the project root:  node seed-admin.mjs
// Delete this file after running.
// ──────────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey:            "AIzaSyDMMMYyamkxlz_Ot13_MQz4IDgV3dhrKMo",
  authDomain:        "rol-plus-erp.firebaseapp.com",
  projectId:         "rol-plus-erp",
  storageBucket:     "rol-plus-erp.firebasestorage.app",
  messagingSenderId: "230996545595",
  appId:             "1:230996545595:web:3bf7b9602f56ab038a0c1e",
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// Auth user already exists in Firebase — only create the Firestore document
const UID   = "cAhUkrWHsaOxqVFkMFF0pkwhmr82";
const EMAIL = "admin@test.com";
const NOW   = new Date().toISOString();

try {
  await setDoc(doc(db, "users", UID), {
    uid:          UID,
    email:        EMAIL,
    displayName:  "Test Admin",
    role:         "admin",
    status:       "active",
    lastActivity: NOW,
    createdAt:    NOW,
    updatedAt:    NOW,
  });

  console.log("✅ Firestore user document created");
  console.log("   UID:  ", UID);
  console.log("   Email:", EMAIL);
} catch (err) {
  console.error("❌ Error:", err.message);
}

process.exit(0);
