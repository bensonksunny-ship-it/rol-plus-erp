"use client";

// =============================================================================
// useRoleHub — the active role/hub for the current session.
//
//  - A user with one role in the active wing is pinned to it.
//  - A user with more than one role in the active wing (e.g. both Admin and
//    Teacher) can switch between them; the choice persists in localStorage
//    and is shared across tabs. See features/auth/AuthContext.tsx for the
//    resolution logic — the same pattern as hooks/useWing.ts, one level down.
// =============================================================================

import { useAuthContext } from "@/features/auth/AuthContext";
import type { Role } from "@/types";

export interface UseRoleHubResult {
  role: Role | null;
  /** True when this user holds more than one role in the active wing. */
  canSwitch: boolean;
  setRole: (r: Role) => void;
  /** Roles this user can switch into (only meaningful when canSwitch is true). */
  availableRoles: Role[];
}

export function useRoleHub(): UseRoleHubResult {
  const { activeRole, canSwitchRole, setActiveRole, availableRoles } = useAuthContext();
  return { role: activeRole, canSwitch: canSwitchRole, setRole: setActiveRole, availableRoles };
}
