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

// Delete the stale Firebase indexedDB token store.
// When we switched from indexedDB → browserLocalPersistence, old browsers
// still have a cached token in "firebaseLocalStorageDb" (indexedDB).
// Firebase reads that stale token on startup, fires an accounts:lookup that
// hangs, and causes onAuthStateChanged to loop. Deleting it forces Firebase
// to start clean; the user simply logs in again (one-time cost).
if (typeof indexedDB !== "undefined") {
  try { indexedDB.deleteDatabase("firebaseLocalStorageDb"); } catch {}
  try { indexedDB.deleteDatabase("firebase-heartbeat-database"); } catch {}
}

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db   = getFirestore(app);

// Use localStorage persistence so Firebase never touches indexedDB again.
setPersistence(auth, browserLocalPersistence).catch(() => {});

export default app;
