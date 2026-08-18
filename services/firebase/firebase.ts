import { initializeApp, getApps, getApp } from "firebase/app";
import { initializeAuth, browserLocalPersistence, getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey:            "AIzaSyDMMMYyamkxlz_Ot13_MQz4IDgV3dhrKMo",
  authDomain:        "rol-plus-erp.firebaseapp.com",
  projectId:         "rol-plus-erp",
  storageBucket:     "rol-plus-erp.firebasestorage.app",
  messagingSenderId: "230996545595",
  appId:             "1:230996545595:web:3bf7b9602f56ab038a0c1e",
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// ─── Auth with persistence set at init time (synchronous, no race) ───────────
// Using initializeAuth + browserLocalPersistence instead of getAuth +
// setPersistence(). The async setPersistence() IIFE raced with AuthContext's
// onAuthStateChanged subscription on mobile — Firebase fired an extra null
// auth state when persistence changed mid-flight, causing the login loop.
// initializeAuth sets persistence synchronously before any subscriber attaches.
//
// Guard: initializeAuth throws if called twice on the same app (HMR / double-
// import). We catch and fall back to getAuth() which returns the existing
// Auth instance. On SSR (no window), getAuth is used directly since
// browserLocalPersistence requires a DOM.
function buildAuth() {
  if (typeof window === "undefined") {
    // Server-side: no IndexedDB/localStorage — use default in-memory auth.
    return getAuth(app);
  }
  try {
    return initializeAuth(app, { persistence: browserLocalPersistence });
  } catch {
    // Auth was already initialized (HMR double-module-eval) — reuse it.
    return getAuth(app);
  }
}

export const auth    = buildAuth();
export const db      = getFirestore(app);
export const storage = getStorage(app);

export default app;
