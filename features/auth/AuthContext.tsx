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

  // Tracks whether we have ever emitted a real user in this session.
  // Used to distinguish "token refresh null flicker" from "genuine sign-out".
  const hadUserRef        = useRef(false);
  // Prevents multiple simultaneous debounce timers.
  const debounceRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prevents acting on stale callbacks after unmount.
  const mountedRef        = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Safety valve: if Firebase never calls back at all (IndexedDB deadlock,
    // extreme privacy mode) — unblock loading after AUTH_TIMEOUT_MS.
    const safetyTimer = setTimeout(() => {
      if (!mountedRef.current) return;
      clearSessionCookie();
      setUser(null);
      setLoading(false);
    }, AUTH_TIMEOUT_MS);

    const unsubscribe = subscribeToAuthState((resolvedUser) => {
      if (!mountedRef.current) return;

      if (resolvedUser) {
        // ── REAL USER: cancel debounce, lock in immediately ──────────────────
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        clearTimeout(safetyTimer);
        hadUserRef.current = true;
        setUser(resolvedUser);
        setLoading(false);
        return;
      }

      // ── NULL CALLBACK ────────────────────────────────────────────────────────
      if (hadUserRef.current) {
        // We had a real user and now got null — this is the mobile token-refresh
        // flicker. Debounce: wait 2 s for Firebase to re-emit the real user.
        // If it does, the block above will cancel this timer.
        if (debounceRef.current) return; // already waiting
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          if (!mountedRef.current) return;
          // After 2 s, if Firebase still hasn't given us a user back,
          // treat as genuine sign-out — clear everything.
          // (hadUserRef is still true here; we clear it on sign-out.)
          hadUserRef.current = false;
          clearSessionCookie();
          try { localStorage.removeItem("rol_session"); } catch(_) {}
          setUser(null);
          // loading stays false — it was already resolved when we had the user.
        }, 2_000);
        return;
      }

      // First-ever null (fresh page load, no prior user in this mount).
      // Check cookie: if present, Firebase is still reading from IndexedDB — wait.
      // If absent, this is definitely a logged-out state.
      const hasCookie =
        typeof document !== "undefined" &&
        document.cookie.includes("rol_session=");

      if (!hasCookie) {
        clearTimeout(safetyTimer);
        setUser(null);
        setLoading(false);
      }
      // else: cookie present, keep loading=true and wait for the real user callback.
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(safetyTimer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
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