"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { subscribeToAuthState } from "@/services/firebase/auth.service";
import type { User } from "@/types";

// Safety timeout — only fires if Firebase never calls onAuthStateChanged at all.
// This is rare (indexedDB deadlock, extreme privacy mode). Keep generous so
// that normal token-refresh on slow mobile networks doesn't hit it.
const AUTH_TIMEOUT_MS = 15_000;

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
});

function clearSessionCookie() {
  document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
  document.cookie = "rol_session=; path=/; max-age=0; SameSite=Strict";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // resolvedWithUser: set to true once we receive a real (non-null) user.
  // After that we ignore further callbacks to prevent re-render loops on mobile.
  // We do NOT use this to block the null→real-user transition — Firebase always
  // fires null first when reading from localStorage, then fires the real user.
  const resolvedWithUserRef = useRef(false);
  // resolvedDefinitiveNull: set true when we receive null AND have waited enough
  // time to confirm there is no session (safety timeout or cookie-less null).
  const resolvedDefinitiveNullRef = useRef(false);

  useEffect(() => {
    // Safety timeout: if Firebase never resolves a real user within AUTH_TIMEOUT_MS,
    // treat as definitively signed out.
    const safetyTimer = setTimeout(() => {
      if (!resolvedWithUserRef.current && !resolvedDefinitiveNullRef.current) {
        resolvedDefinitiveNullRef.current = true;
        clearSessionCookie();
        setUser(null);
        setLoading(false);
      }
    }, AUTH_TIMEOUT_MS);

    const unsubscribe = subscribeToAuthState((resolvedUser) => {
      if (resolvedUser) {
        // Real user resolved — lock in this state, ignore further callbacks.
        if (resolvedWithUserRef.current) return;
        clearTimeout(safetyTimer);
        resolvedWithUserRef.current = true;
        resolvedDefinitiveNullRef.current = false;
        setUser(resolvedUser);
        setLoading(false);
      } else {
        // Null callback — Firebase fires this first before reading localStorage.
        // Only treat as definitive sign-out if:
        //   (a) we already had a real user (genuine sign-out), OR
        //   (b) there is no session cookie (no persisted session to wait for).
        if (resolvedWithUserRef.current) {
          // Genuine sign-out after having been logged in.
          resolvedWithUserRef.current = false;
          resolvedDefinitiveNullRef.current = true;
          clearSessionCookie();
          setUser(null);
          // Keep loading=false (already false from prior real-user resolve).
          return;
        }

        const hasSessionCookie =
          typeof document !== "undefined" &&
          document.cookie.includes("rol_session=");

        if (!hasSessionCookie) {
          // No cookie → definitively not logged in; no need to wait.
          if (!resolvedDefinitiveNullRef.current) {
            clearTimeout(safetyTimer);
            resolvedDefinitiveNullRef.current = true;
            clearSessionCookie();
            setUser(null);
            setLoading(false);
          }
        }
        // If cookie IS present: Firebase is still reading from localStorage.
        // Keep loading=true and wait — the real user callback will come shortly.
        // The safety timer will unblock if it never arrives.
      }
    });

    return () => {
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, []);

  // Memoize the context value so that every consumer (useAuth, useAuthContext)
  // only re-renders when user or loading actually changes — not on every AuthProvider
  // render caused by parent re-renders or unrelated state updates.
  const value = useMemo(() => ({ user, loading }), [user, loading]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextValue {
  return useContext(AuthContext);
}