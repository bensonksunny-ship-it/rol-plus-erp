import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import { doc, getDocFromServer, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/services/firebase/firebase";
import type { User, AuthSession } from "@/types";
import { USER_STATUS } from "@/config/constants";

/**
 * Fetch the Firestore user profile for a Firebase Auth uid.
 * Returns null if the document does not exist.
 */
export async function getUserProfile(uid: string): Promise<User | null> {
  const ref = doc(db, "users", uid);
  const snap = await getDocFromServer(ref);
  if (!snap.exists()) return null;
  return snap.data() as User;
}

/**
 * Create a Firestore user document if one does not already exist.
 * Never overwrites an existing document.
 */
async function ensureUserDocument(user: FirebaseUser): Promise<boolean> {
  const userRef = doc(db, "users", user.uid);
  const snap = await getDocFromServer(userRef);
  console.log("SERVER SNAP EXISTS?", snap.exists());
  if (snap.exists()) {
    return true;
  }
  console.log("WRITING TO PROJECT:", db.app.options.projectId);
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
  console.log("USER CREATED");
  const verifySnap = await getDocFromServer(userRef);
  console.log("USER DOC VERIFIED:", verifySnap.exists());
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
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const firebaseUser = credential.user;
  console.log("LOGIN SUCCESS", firebaseUser.uid);

  // Ensure a Firestore profile exists before reading it
  console.log("CALLING ensureUserDocument");
  await ensureUserDocument(firebaseUser);
  console.log("USER DOC READY");

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
 */
export function subscribeToAuthState(
  callback: (user: User | null) => void
): () => void {
  return onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }
    const profile = await getUserProfile(firebaseUser.uid);
    // If profile missing or inactive, treat as signed out.
    // DO NOT call firebaseSignOut here — doing so triggers onAuthStateChanged
    // again, which calls this callback again → infinite reload loop.
    if (!profile || profile.status !== USER_STATUS.ACTIVE) {
      callback(null);
      return;
    }
    callback(profile);
  });
}