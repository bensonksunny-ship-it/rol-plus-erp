"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { subscribeToAuthState } from "@/services/firebase/auth.service";
import type { User } from "@/types";

// How long to wait for Firebase before giving up and showing the login form.
// Must be long enough for slow mobile networks and cold token-refresh cycles.
// Firebase on mobile can take 3–5 s to re-validate a token via network.
const AUTH_TIMEOUT_MS = 12_000;

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
});

function clearSessionCookie() {
  // Clear for both SameSite=Lax (current) and SameSite=Strict (legacy) in one shot.
  document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
  document.cookie = "rol_session=; path=/; max-age=0; SameSite=Strict";
}

function hasSessionCookie(): boolean {
  return document.cookie.split(";").some((c) => c.trim().startsWith("rol_session="));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]     = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Becomes true after the first onAuthStateChanged callback fires.
  // Used to prevent the timeout from overwriting a valid auth resolution.
  const resolvedRef = useRef(false);

  // Whether this is the FIRST callback from onAuthStateChanged.
  // Firebase on mobile sometimes emits null briefly during token refresh
  // before emitting the real user. We must not clear the cookie on that
  // first null — wait to see if a real user follows.
  const firstCallbackRef = useRef(true);

  // Stable timer ref for deferred "null user" cookie clear.
  // When Firebase says null on the first callback, we wait briefly before
  // clearing the cookie — giving it time to emit the real user.
  const nullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Safety timeout: if Firebase never fires onAuthStateChanged at all
    // (indexedDB deadlock, aggressive browser privacy mode, etc.), we
    // unblock the UI without clearing a potentially valid session cookie.
    const safetyTimer = setTimeout(() => {
      if (!resolvedRef.current) {
        resolvedRef.current = true;
        // Don't clear cookie here — Firebase may still be mid-refresh.
        // ProtectedRoute will handle the redirect if the user is truly gone.
        setUser(null);
        setLoading(false);
      }
    }, AUTH_TIMEOUT_MS);

    const unsubscribe = subscribeToAuthState((resolvedUser) => {
      clearTimeout(safetyTimer);

      if (resolvedUser) {
        // Got a real user — cancel any pending null-cookie-clear.
        if (nullTimerRef.current) {
          clearTimeout(nullTimerRef.current);
          nullTimerRef.current = null;
        }
        resolvedRef.current = true;
        firstCallbackRef.current = false;
        setUser(resolvedUser);
        setLoading(false);
        return;
      }

      // Firebase reported null.
      if (firstCallbackRef.current) {
        // First callback is null — common on mobile during token refresh.
        // Wait 2 s to see if a real user follows before treating as signed-out.
        firstCallbackRef.current = false;
        nullTimerRef.current = setTimeout(() => {
          // Still null after the wait — this is a genuine sign-out.
          resolvedRef.current = true;
          clearSessionCookie();
          setUser(null);
          setLoading(false);
        }, 2000);
      } else {
        // Subsequent null callback — definitive sign-out (e.g. user signed out
        // in another tab, token revoked server-side).
        if (nullTimerRef.current) clearTimeout(nullTimerRef.current);
        resolvedRef.current = true;
        clearSessionCookie();
        setUser(null);
        setLoading(false);
      }
    });

    return () => {
      clearTimeout(safetyTimer);
      if (nullTimerRef.current) clearTimeout(nullTimerRef.current);
      unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextValue {
  return useContext(AuthContext);
}