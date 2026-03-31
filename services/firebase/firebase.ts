import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey:            "AIzaSyDMMMYyamkxlz_Ot13_MQz4IDgV3dhrKMo",
  authDomain:        "rol-plus-erp.firebaseapp.com",
  projectId:         "rol-plus-erp",
  storageBucket:     "rol-plus-erp.firebasestorage.app",
  messagingSenderId: "230996545595",
  appId:             "1:230996545595:web:3bf7b9602f56ab038a0c1e",
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db   = getFirestore(app);

// ─── Persistence ─────────────────────────────────────────────────────────────
// Set localStorage persistence BEFORE the first onAuthStateChanged subscriber
// is attached. We await it inside an IIFE so we don't block module evaluation
// but the promise is resolved before AuthProvider mounts (React renders
// synchronously after module evaluation on the same tick).
//
// Do NOT call setPersistence inside AuthContext — doing so after
// onAuthStateChanged is subscribed can trigger a second auth-state callback
// on mobile, causing the login page to re-render/reload.
(async () => {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch {
    // Persistence failure is non-fatal — Firebase falls back to in-memory.
  }
})();

// ─── One-time indexedDB cleanup ───────────────────────────────────────────────
// Removes the stale Firebase indexedDB token store left behind from before we
// switched to browserLocalPersistence. This must only run ONCE per device, not
// on every page load — doing so on mobile triggers a visibilitychange event
// (keyboard/focus) that the browser treats as a page reload.
//
// We use a localStorage flag so this only runs one time ever, then never again.
if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
  const CLEANUP_KEY = "__rol_idb_cleaned__";
  if (!localStorage.getItem(CLEANUP_KEY)) {
    try { indexedDB.deleteDatabase("firebaseLocalStorageDb"); } catch {}
    try { indexedDB.deleteDatabase("firebase-heartbeat-database"); } catch {}
    localStorage.setItem(CLEANUP_KEY, "1");
  }
}

export default app;
