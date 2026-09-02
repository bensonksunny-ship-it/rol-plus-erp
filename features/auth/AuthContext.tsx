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
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { clearPersistedSession, subscribeToAuthState } from "@/services/firebase/auth.service";
import { DEFAULT_WING } from "@/config/constants";
import {
  resolveCapabilities,
  type Capability,
  type PermissionOverrideDoc,
} from "@/config/permissions";
import { wingOf } from "@/lib/wing";
import type { User } from "@/types";

const AUTH_TIMEOUT_MS = 15000;

const EMPTY_CAPS: Set<Capability> = new Set();

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Effective capability set for the current user (role default ∪ wing override). */
  capabilities: Set<Capability>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  capabilities: EMPTY_CAPS,
});

/** Cache of per-wing permission override docs so we fetch each at most once. */
const overrideCache = new Map<string, PermissionOverrideDoc | null>();

async function loadWingOverride(wing: string): Promise<PermissionOverrideDoc | null> {
  if (overrideCache.has(wing)) return overrideCache.get(wing) ?? null;
  try {
    const snap = await getDoc(doc(db, "config", `permissions_${wing}`));
    const data = snap.exists() ? (snap.data() as PermissionOverrideDoc) : null;
    overrideCache.set(wing, data);
    return data;
  } catch {
    overrideCache.set(wing, null);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [override, setOverride] = useState<PermissionOverrideDoc | null>(null);

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

        // Load this wing's permission override (best-effort, cached).
        const wing = wingOf(resolvedUser) || DEFAULT_WING;
        loadWingOverride(wing).then((ov) => {
          if (mountedRef.current) setOverride(ov);
        });

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

  const capabilities = useMemo(
    () => (user ? resolveCapabilities(user.role, override) : EMPTY_CAPS),
    [user, override]
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      capabilities,
    }),
    [user, loading, capabilities]
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