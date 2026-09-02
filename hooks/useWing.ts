"use client";

// =============================================================================
// useWing — the active wing for the current session.
//
//  - Users without the wing.switch capability are pinned to their own wing
//    (user.wing, legacy → "rol_plus").
//  - The Founder can switch; the choice persists in localStorage and is shared
//    across tabs via a storage event + a module-level listener set.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { useAuthContext } from "@/features/auth/AuthContext";
import { CAPABILITIES } from "@/config/permissions";
import { DEFAULT_WING } from "@/config/constants";
import { isWing, wingOf } from "@/lib/wing";
import type { Wing } from "@/types";

const STORAGE_KEY = "rol_active_wing";

function readStored(): Wing | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isWing(v) ? v : null;
  } catch {
    return null;
  }
}

// Subscribers in this tab (localStorage 'storage' events only fire in *other*
// tabs, so we also notify locally on setWing).
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((fn) => fn());
}

export interface UseWingResult {
  wing: Wing;
  /** True when this user may change the active wing. */
  canSwitch: boolean;
  setWing: (w: Wing) => void;
}

export function useWing(): UseWingResult {
  const { user, capabilities } = useAuthContext();
  const canSwitch = capabilities.has(CAPABILITIES.WING_SWITCH);

  const [stored, setStored] = useState<Wing | null>(null);

  useEffect(() => {
    setStored(readStored());
    const sync = () => setStored(readStored());
    listeners.add(sync);
    window.addEventListener("storage", sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setWing = useCallback(
    (w: Wing) => {
      if (!canSwitch) return;
      try {
        localStorage.setItem(STORAGE_KEY, w);
      } catch {
        /* ignore */
      }
      setStored(w);
      notify();
    },
    [canSwitch],
  );

  const pinned = user ? wingOf(user) : DEFAULT_WING;
  const wing: Wing = canSwitch ? stored ?? DEFAULT_WING : pinned;

  return { wing, canSwitch, setWing };
}
