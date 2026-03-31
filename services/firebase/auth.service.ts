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

/**
 * Fetch the Firestore user profile — cache-first for speed.
 * Falls back to a server read only if the document is not in cache.
 * Returns null if the document does not exist.
 */
export async function getUserProfile(uid: string): Promise<User | null> {
  const ref  = doc(db, "users", uid);
  // getDoc uses Firestore's local cache when available (offline-first).
  // This is typically instant on subsequent page loads, preventing the
  // auth timeout from firing before the profile resolves.
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as User;
}

/**
 * Create a Firestore user document if one does not already exist.
 * Uses cache-first read for the existence check to avoid slow server
 * round-trips that could race with the AuthContext timeout.
 * Never overwrites an existing document.
 */
async function ensureUserDocument(user: FirebaseUser): Promise<boolean> {
  const userRef = doc(db, "users", user.uid);
  // Cache-first check: if the doc is in Firestore cache it resolves instantly.
  const snap = await getDoc(userRef);
  if (snap.exists()) return true;

  // Doc not in cache — write it for the first time.
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

  // Verify with a server read only on first-time creation.
  const verifySnap = await getDocFromServer(userRef);
  if (!verifySnap.exists()) {
    throw new Error("FIRESTORE WRITE FAILED: document not found after setDoc");
  }
  return true;
}

/**
 * Sign in with email + password, then validate role and active status.
 * Throws a typed error if the account is inactive — login is blocked.
 */
export async function signIn(
  email: string,
  password: string
): Promise<AuthSession> {
  const credential    = await signInWithEmailAndPassword(auth, email, password);
  const firebaseUser  = credential.user;

  // Ensure a Firestore profile exists before reading it.
  await ensureUserDocument(firebaseUser);

  const profile = await getUserProfile(firebaseUser.uid);
  if (!profile) {
    await firebaseSignOut(auth);
    throw new Error("AUTH/USER_NOT_FOUND");
  }

  // Strict rule: login blocked if account is inactive
  if (profile.status !== USER_STATUS.ACTIVE) {
    await firebaseSignOut(auth);
    throw new Error("AUTH/ACCOUNT_INACTIVE");
  }

  const token = await firebaseUser.getIdToken();
  return { user: profile, token };
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

/**
 * Subscribe to Firebase Auth state. Resolves the full User profile on change.
 * Returns the unsubscribe function.
 *
 * IMPORTANT: onAuthStateChanged fires multiple times on mobile:
 *  1. Immediately with the cached token (null or previous user)
 *  2. Again after the token is refreshed over the network
 * The AuthContext guards against processing multiple callbacks via resolvedRef.
 * This function simply propagates each callback as-is.
 */
export function subscribeToAuthState(
  callback: (user: User | null) => void
): () => void {
  let cancelled = false;

  const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
    if (cancelled) return;

    if (!firebaseUser) {
      callback(null);
      return;
    }

    const profile = await getUserProfile(firebaseUser.uid);
    if (cancelled) return; // component may have unmounted during await

    // If profile missing or inactive, treat as signed out.
    // DO NOT call firebaseSignOut here — doing so triggers onAuthStateChanged
    // again → callback fires again → infinite loop.
    if (!profile || profile.status !== USER_STATUS.ACTIVE) {
      callback(null);
      return;
    }

    callback(profile);
  });

  return () => {
    cancelled = true;
    unsubscribe();
  };
}