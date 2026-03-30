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

// How long to wait for Firebase onAuthStateChanged before giving up.
// indexedDB hangs are the primary cause of a blank/frozen login screen.
const AUTH_TIMEOUT_MS = 5000;

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
});

function clearSessionCookie() {
  document.cookie = "rol_session=; path=/; max-age=0; SameSite=Strict";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const resolvedRef = useRef(false);

  useEffect(() => {
    // Safety timeout: if Firebase never calls back (indexedDB hang, network
    // issue, stale token loop), force loading=false so the login page renders.
    const timer = setTimeout(() => {
      if (!resolvedRef.current) {
        resolvedRef.current = true;
        // No valid session — clear any stale cookie so middleware doesn't
        // redirect authenticated-only routes in a loop.
        clearSessionCookie();
        setUser(null);
        setLoading(false);
      }
    }, AUTH_TIMEOUT_MS);

    const unsubscribe = subscribeToAuthState((resolvedUser) => {
      clearTimeout(timer);
      resolvedRef.current = true;

      // If Firebase resolved with no user, ensure the session cookie is gone
      // so middleware stops protecting routes with a dead cookie.
      if (!resolvedUser) {
        clearSessionCookie();
      }

      setUser(resolvedUser);
      setLoading(false);
    });

    return () => {
      clearTimeout(timer);
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