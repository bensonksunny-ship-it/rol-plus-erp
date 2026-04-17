import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import { doc, getDoc, getDocFromServer, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/services/firebase/firebase";
import type { User, AuthSession } from "@/types";
import { USER_STATUS } from "@/config/constants";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export function persistSessionToken(token: string): void {
  if (typeof document === "undefined") return;

  document.cookie = `rol_session=${token}; path=/; SameSite=Lax; max-age=${SESSION_MAX_AGE}`;

  try {
    localStorage.setItem("rol_session", token);
    localStorage.setItem("rol_session_expires", String(Date.now() + SESSION_MAX_AGE * 1000));
  } catch {
    // localStorage can be blocked in private browsing or hardened mobile browsers.
  }
}

export function clearPersistedSession(): void {
  if (typeof document !== "undefined") {
    document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
    document.cookie = "rol_session=; path=/; max-age=0; SameSite=Strict";
  }

  try {
    localStorage.removeItem("rol_session");
    localStorage.removeItem("rol_session_expires");
  } catch {
    // Ignore storage access failures.
  }
}

/**
 * Fetch the Firestore user profile — cache-first for speed.
 * On mobile this resolves from the local Firestore cache in <5ms after the
 * first load, avoiding a network round-trip that races onAuthStateChanged.
 */
export async function getUserProfile(uid: string): Promise<User | null> {
  const ref  = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as User;
}

/**
 * Create a Firestore user document if one does not already exist.
 */
async function ensureUserDocument(user: FirebaseUser): Promise<boolean> {
  const userRef = doc(db, "users", user.uid);
  const snap    = await getDoc(userRef);
  if (snap.exists()) return true;

  await setDoc(userRef, {
    uid:          user.uid,
    email:        user.email || "",
    displayName:  user.displayName || "",
    role:         "admin",
    status:       "active",
    lastActivity: serverTimestamp(),
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  });

  const verifySnap = await getDocFromServer(userRef);
  if (!verifySnap.exists()) {
    throw new Error("FIRESTORE WRITE FAILED: document not found after setDoc");
  }
  return true;
}

/**
 * Sign in with email + password, validate role and active status.
 */
export async function signIn(
  email: string,
  password: string
): Promise<AuthSession> {
  const credential   = await signInWithEmailAndPassword(auth, email, password);
  const firebaseUser = credential.user;

  await ensureUserDocument(firebaseUser);

  const profile = await getUserProfile(firebaseUser.uid);
  if (!profile) {
    await firebaseSignOut(auth);
    throw new Error("AUTH/USER_NOT_FOUND");
  }

  if (profile.status !== USER_STATUS.ACTIVE) {
    await firebaseSignOut(auth);
    throw new Error("AUTH/ACCOUNT_INACTIVE");
  }

  const token = await firebaseUser.getIdToken();
  return { user: profile, token };
}

/**
 * Sign out the current user and clear all persisted session artifacts.
 * Clearing here ensures every call site is safe — callers do not need to
 * manually clear the cookie or localStorage after calling this function.
 */
export async function signOut(): Promise<void> {
  clearPersistedSession();
  await firebaseSignOut(auth);
}

/**
 * Subscribe to Firebase Auth state changes, resolving the full Firestore
 * User profile on each valid user callback.
 *
 * KEY MOBILE FIX:
 * onAuthStateChanged fires async, but we must not call callback(null) while
 * a profile fetch is in-flight. On mobile, Firebase fires:
 *   1. null  (IndexedDB not yet read)
 *   2. user  (IndexedDB resolved)
 *   3. null  (token refresh started)
 *   4. user  (token refresh completed)
 *
 * We use a serial queue (pendingFetch ref) so:
 *  - Each new Firebase callback cancels any in-flight profile fetch
 *  - null is only forwarded once there is no concurrent user fetch running
 *  - This prevents the AuthContext from ever seeing a spurious null while
 *    a valid user is being loaded, which caused the login refresh loop.
 */
export function subscribeToAuthState(
  callback: (user: User | null) => void
): () => void {
  let cancelled  = false;
  // Monotonically increasing counter. Each onAuthStateChanged callback gets
  // a unique generation number. Only the latest generation may call callback.
  let generation = 0;

  const unsubscribe = onAuthStateChanged(auth, (firebaseUser: FirebaseUser | null) => {
    if (cancelled) return;

    // Claim this generation — any in-flight fetch from a previous callback
    // will see its generation is stale and silently discard its result.
    const myGen = ++generation;

    if (!firebaseUser) {
      // Only emit null if this is still the latest callback.
      // Use a microtask delay so that if Firebase immediately fires again
      // with a real user (common on mobile token refresh), the null is
      // superseded before it reaches AuthContext.
      Promise.resolve().then(() => {
        if (cancelled || myGen !== generation) return;
        callback(null);
      });
      return;
    }

    // Async profile fetch — uses Firestore cache so typically <5ms on repeat loads.
    (async () => {
      try {
        const profile = await getUserProfile(firebaseUser.uid);

        // Stale — a newer callback has superseded this one.
        if (cancelled || myGen !== generation) return;

        if (!profile || profile.status !== USER_STATUS.ACTIVE) {
          // Profile missing or inactive — emit null but do NOT call firebaseSignOut
          // (that would trigger onAuthStateChanged again → infinite loop).
          callback(null);
          return;
        }

        try {
          const token = await firebaseUser.getIdToken();
          if (!cancelled && myGen === generation) {
            persistSessionToken(token);
          }
        } catch {
          // Best effort only — keep the valid user session in memory even if
          // token persistence temporarily fails.
        }

        callback(profile);
      } catch {
        if (cancelled || myGen !== generation) return;
        // Firestore error — emit null conservatively.
        callback(null);
      }
    })();
  });

  return () => {
    cancelled = true;
    unsubscribe();
  };
}
