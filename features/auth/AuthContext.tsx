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
  const resolvedRef           = useRef(false);

  useEffect(() => {
    // Safety timeout: unblocks the UI if Firebase never fires.
    // Does NOT clear the session cookie — if we can't confirm auth state,
    // it's safer to let ProtectedRoute/layout handle the redirect rather
    // than proactively wiping a potentially valid cookie.
    const safetyTimer = setTimeout(() => {
      if (!resolvedRef.current) {
        resolvedRef.current = true;
        setUser(null);
        setLoading(false);
      }
    }, AUTH_TIMEOUT_MS);

    const unsubscribe = subscribeToAuthState((resolvedUser) => {
      // Only process the first resolution. Firebase's onAuthStateChanged can
      // fire multiple times on mobile (token refresh, network recovery), but
      // we must not flip loading back to true after it was set to false —
      // that causes re-render loops in the dashboard layout.
      if (resolvedRef.current) return;

      clearTimeout(safetyTimer);
      resolvedRef.current = true;

      if (!resolvedUser) {
        // Definitive sign-out — clear the cookie so middleware stops
        // redirecting back to protected routes.
        clearSessionCookie();
      }

      setUser(resolvedUser);
      setLoading(false);
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