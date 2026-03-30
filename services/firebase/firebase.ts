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

// Force localStorage persistence (not indexedDB).
// indexedDB can hang indefinitely on Vercel / certain browsers when a stale
// cached token exists, causing onAuthStateChanged to never fire and leaving
// the app frozen on a blank screen.
setPersistence(auth, browserLocalPersistence).catch(() => {
  // Non-fatal: if localStorage is blocked (private browsing strictest mode),
  // Firebase falls back gracefully. We still proceed.
});

export default app;
