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
  const resolvedWithUserRef        = useRef(false);
  const resolvedDefinitiveNullRef  = useRef(false);
  // Debounce timer for null-after-user — gives Firebase time to re-emit the
  // real user during a token refresh on mobile networks before treating as
  // a genuine sign-out.
  const signOutDebounceRef         = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
        // Real user — cancel any pending sign-out debounce and lock in.
        if (signOutDebounceRef.current) {
          clearTimeout(signOutDebounceRef.current);
          signOutDebounceRef.current = null;
        }
        clearTimeout(safetyTimer);
        resolvedWithUserRef.current = true;
        resolvedDefinitiveNullRef.current = false;
        setUser(resolvedUser);
        setLoading(false);
      } else {
        if (resolvedWithUserRef.current) {
          // Null after having a real user — may be a token refresh flicker on
          // mobile. Debounce for 2 s before committing to sign-out state.
          // If Firebase re-emits the real user within 2 s the timer is cancelled.
          if (signOutDebounceRef.current) return; // already debouncing
          signOutDebounceRef.current = setTimeout(() => {
            signOutDebounceRef.current = null;
            // Only sign out if no real user arrived during the debounce window.
            if (!resolvedWithUserRef.current) return;
            // Check: did Firebase re-fire with a user? If so resolvedWithUserRef
            // would have been set back to true — but we check the cookie too.
            const hasSessionCookie =
              typeof document !== "undefined" &&
              document.cookie.includes("rol_session=");
            if (!hasSessionCookie) {
              resolvedWithUserRef.current = false;
              resolvedDefinitiveNullRef.current = true;
              clearSessionCookie();
              setUser(null);
            }
          }, 2_000);
          return;
        }

        const hasSessionCookie =
          typeof document !== "undefined" &&
          document.cookie.includes("rol_session=");

        if (!hasSessionCookie) {
          if (!resolvedDefinitiveNullRef.current) {
            clearTimeout(safetyTimer);
            resolvedDefinitiveNullRef.current = true;
            clearSessionCookie();
            setUser(null);
            setLoading(false);
          }
        }
        // Cookie present → still waiting for Firebase IndexedDB read.
      }
    });

    return () => {
      clearTimeout(safetyTimer);
      if (signOutDebounceRef.current) clearTimeout(signOutDebounceRef.current);
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