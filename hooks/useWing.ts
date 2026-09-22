"use client";

// =============================================================================
// useWing — the active wing for the current session.
//
//  - Users with a role in only one wing are pinned to it (user.wing / their
//    single roles[] entry, legacy → "rol_plus").
//  - Users with roles in both wings, or the wing.switch capability (Founder),
//    can switch; the choice persists in localStorage and is shared across
//    tabs. See features/auth/AuthContext.tsx for the resolution logic.
// =============================================================================

import { useAuthContext } from "@/features/auth/AuthContext";
import type { Wing } from "@/types";

export interface UseWingResult {
  wing: Wing;
  /** True when this user may change the active wing. */
  canSwitch: boolean;
  setWing: (w: Wing) => void;
  /** Wings this user can switch into (only meaningful when canSwitch is true). */
  availableWings: Wing[];
}

export function useWing(): UseWingResult {
  const { activeWing, canSwitchWing, setActiveWing, availableWings } = useAuthContext();
  return { wing: activeWing, canSwitch: canSwitchWing, setWing: setActiveWing, availableWings };
}
