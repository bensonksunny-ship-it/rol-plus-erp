"use client";

import {
  createContext,
  useCallback,
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
import { DEFAULT_WING, WINGS } from "@/config/constants";
import {
  CAPABILITIES,
  resolveCapabilities,
  type Capability,
  type PermissionOverrideDoc,
} from "@/config/permissions";
import { getRolesForWing, getUserWings, isWing, wingOf } from "@/lib/wing";
import type { Role, User, Wing } from "@/types";

const AUTH_TIMEOUT_MS = 15000;
const WING_STORAGE_KEY = "rol_active_wing";
const ROLE_STORAGE_KEY = "rol_active_role";

const EMPTY_CAPS: Set<Capability> = new Set();

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Effective capability set for the current user in the active wing (role default ∪ wing override). */
  capabilities: Set<Capability>;
  /** The wing currently being viewed — see hooks/useWing.ts. */
  activeWing: Wing;
  /** Wings this user can switch into: every wing they hold a role in, or all wings with wing.switch. */
  availableWings: Wing[];
  /** True when this user may change the active wing (multiple wing roles, or wing.switch). */
  canSwitchWing: boolean;
  setActiveWing: (w: Wing) => void;
  /** The role/hub currently being viewed — see hooks/useRoleHub.ts. */
  activeRole: Role | null;
  /** Every role this user holds in the active wing (e.g. both Admin and Teacher). */
  availableRoles: Role[];
  /** True when this user holds more than one role in the active wing. */
  canSwitchRole: boolean;
  setActiveRole: (r: Role) => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  capabilities: EMPTY_CAPS,
  activeWing: DEFAULT_WING,
  availableWings: [DEFAULT_WING],
  canSwitchWing: false,
  setActiveWing: () => {},
  activeRole: null,
  availableRoles: [],
  canSwitchRole: false,
  setActiveRole: () => {},
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

// Cross-tab active-wing persistence — a 'storage' event only fires in *other*
// tabs, so same-tab subscribers are notified directly via this listener set.
const wingListeners = new Set<() => void>();
function notifyWingListeners() {
  wingListeners.forEach((fn) => fn());
}
function readStoredWing(): Wing | null {
  try {
    const v = localStorage.getItem(WING_STORAGE_KEY);
    return isWing(v) ? v : null;
  } catch {
    return null;
  }
}

// Cross-tab active-role persistence — same pattern as the wing listeners above.
const roleListeners = new Set<() => void>();
function notifyRoleListeners() {
  roleListeners.forEach((fn) => fn());
}
function readStoredRole(): Role | null {
  try {
    return (localStorage.getItem(ROLE_STORAGE_KEY) as Role | null) ?? null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [homeOverride, setHomeOverride] = useState<PermissionOverrideDoc | null>(null);
  const [activeOverride, setActiveOverride] = useState<PermissionOverrideDoc | null>(null);
  const [storedWing, setStoredWing] = useState<Wing | null>(null);
  const [storedRole, setStoredRole] = useState<Role | null>(null);

  const mountedRef = useRef(true);
  const hadUserRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active-wing persistence (localStorage + cross-tab sync).
  useEffect(() => {
    setStoredWing(readStoredWing());
    const sync = () => setStoredWing(readStoredWing());
    wingListeners.add(sync);
    window.addEventListener("storage", sync);
    return () => {
      wingListeners.delete(sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Active-role (hub) persistence (localStorage + cross-tab sync).
  useEffect(() => {
    setStoredRole(readStoredRole());
    const sync = () => setStoredRole(readStoredRole());
    roleListeners.add(sync);
    window.addEventListener("storage", sync);
    return () => {
      roleListeners.delete(sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

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

        // Home wing's override gates wing-switching itself (a wing-agnostic
        // privilege) — always resolved from the home wing, never the active
        // one, to avoid a chicken/egg loop.
        const homeWing = wingOf(resolvedUser) || DEFAULT_WING;
        loadWingOverride(homeWing).then((ov) => {
          if (mountedRef.current) setHomeOverride(ov);
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

  // wing.switch is a wing-agnostic privilege — resolved from the user's home
  // role only, never the currently active wing.
  const homeRole = user?.role ?? null;
  const homeCapabilities = useMemo(
    () => (homeRole ? resolveCapabilities(homeRole, homeOverride) : EMPTY_CAPS),
    [homeRole, homeOverride]
  );
  const hasWingSwitchCap = homeCapabilities.has(CAPABILITIES.WING_SWITCH);

  const userWings = useMemo(() => getUserWings(user), [user]);
  const canSwitchWing = hasWingSwitchCap || userWings.length > 1;
  const availableWings: Wing[] = hasWingSwitchCap
    ? [WINGS.ROL_PLUS, WINGS.SCHOOL_OF_MUSIC]
    : userWings;

  const homeWing = user ? wingOf(user) : DEFAULT_WING;
  const activeWing: Wing = canSwitchWing
    ? (storedWing && availableWings.includes(storedWing) ? storedWing : homeWing)
    : homeWing;

  useEffect(() => {
    if (!user) return;
    loadWingOverride(activeWing).then((ov) => {
      if (mountedRef.current) setActiveOverride(ov);
    });
  }, [user, activeWing]);

  const setActiveWing = useCallback(
    (w: Wing) => {
      if (!canSwitchWing) return;
      try {
        localStorage.setItem(WING_STORAGE_KEY, w);
      } catch {
        /* ignore */
      }
      setStoredWing(w);
      notifyWingListeners();
    },
    [canSwitchWing]
  );

  // Every role held in the active wing — usually from the explicit per-wing
  // assignment; falls back to the home scalar `role` when the active wing has
  // no explicit entry (e.g. a Founder who switched into a wing they have no
  // roles[] entry for — their role is the same everywhere).
  const availableRoles: Role[] = useMemo(() => {
    if (!user) return [];
    const explicit = getRolesForWing(user, activeWing);
    return explicit.length > 0 ? explicit : (user.role ? [user.role] : []);
  }, [user, activeWing]);

  const canSwitchRole = availableRoles.length > 1;

  // The hub currently being viewed — one of availableRoles. Persists like the
  // active wing; an invalid/stale choice (e.g. after switching wings) falls
  // back to the most senior role for that wing.
  const activeRole: Role | null = canSwitchRole
    ? (storedRole && availableRoles.includes(storedRole) ? storedRole : availableRoles[0])
    : (availableRoles[0] ?? null);

  const setActiveRole = useCallback(
    (r: Role) => {
      if (!availableRoles.includes(r)) return;
      try {
        localStorage.setItem(ROLE_STORAGE_KEY, r);
      } catch {
        /* ignore */
      }
      setStoredRole(r);
      notifyRoleListeners();
    },
    [availableRoles]
  );

  const capabilities = useMemo(
    () => (activeRole ? resolveCapabilities(activeRole, activeOverride) : EMPTY_CAPS),
    [activeRole, activeOverride]
  );

  // Present the logged-in user's role as "the hub currently being viewed" so
  // every consumer that reads user.role (nav visibility, ProtectedRoute,
  // post-login redirects, …) is automatically wing- and hub-scoped without
  // having to thread activeWing/activeRole through each of them. The cast is
  // intentional: a second-wing or secondary role can outrun the role-specific
  // fields (e.g. a Teacher role granted in a wing where the account's doc has
  // no centerIds) — callers that need those fields should check capabilities,
  // not just the role tag.
  const effectiveUser = useMemo(
    () =>
      user && activeRole && activeRole !== user.role
        ? ({ ...user, role: activeRole } as User)
        : user,
    [user, activeRole]
  );

  const value = useMemo(
    () => ({
      user: effectiveUser,
      loading,
      capabilities,
      activeWing,
      availableWings,
      canSwitchWing,
      setActiveWing,
      activeRole,
      availableRoles,
      canSwitchRole,
      setActiveRole,
    }),
    [
      effectiveUser, loading, capabilities, activeWing, availableWings, canSwitchWing, setActiveWing,
      activeRole, availableRoles, canSwitchRole, setActiveRole,
    ]
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
