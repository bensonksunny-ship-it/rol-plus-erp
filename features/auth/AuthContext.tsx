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
import { clearPersistedSession, subscribeToAuthState } from "@/services/firebase/auth.service";
import type { User } from "@/types";

const AUTH_TIMEOUT_MS = 15000;

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const mountedRef = useRef(true);
  const hadUserRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    const safetyTimer = setTimeout(() => {
      if (!mountedRef.current) return;

      console.warn("Auth timeout reached");

      hadUserRef.current = false;
      clearPersistedSession();
      setUser(null);
      setLoading(false);
    }, AUTH_TIMEOUT_MS);

    const unsubscribe = subscribeToAuthState((resolvedUser) => {
      if (!mountedRef.current) return;

      // ─────────────────────────────────────────────
      // VALID USER
      // ─────────────────────────────────────────────
      if (resolvedUser) {
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

      // ─────────────────────────────────────────────
      // TEMP NULL AFTER USER
      // Firebase mobile token refresh flicker
      // ─────────────────────────────────────────────
      if (hadUserRef.current) {
        if (debounceRef.current) return;

        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;

          if (!mountedRef.current) return;

          console.warn("Auth user lost after debounce");

          hadUserRef.current = false;
          clearPersistedSession();
          setUser(null);
          setLoading(false);
        }, 2000);

        return;
      }

      // ─────────────────────────────────────────────
      // FIRST NULL (logged out)
      // ─────────────────────────────────────────────
      clearTimeout(safetyTimer);

      setUser(null);
      setLoading(false);
    });

    return () => {
      mountedRef.current = false;

      clearTimeout(safetyTimer);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
    }),
    [user, loading]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextValue {
  return useContext(AuthContext);
}