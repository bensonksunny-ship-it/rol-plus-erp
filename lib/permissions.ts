"use client";

// =============================================================================
// Capability checks. See config/permissions.ts for the model.
// =============================================================================

import { useAuthContext } from "@/features/auth/AuthContext";
import {
  resolveCapabilities,
  type Capability,
  type PermissionOverrideDoc,
} from "@/config/permissions";
import type { User } from "@/types";

/**
 * Pure check against an already-resolved capability set. Prefer the hooks below
 * in components — this is for non-React code paths (services, guards).
 */
export function hasCapability(
  caps: Set<Capability> | null | undefined,
  cap: Capability,
): boolean {
  return !!caps && caps.has(cap);
}

/**
 * Resolve + check for a user without going through context. Uses the default
 * role map plus an optional override doc. Used server-ish / outside React.
 */
export function can(
  user: User | null | undefined,
  cap: Capability,
  override?: PermissionOverrideDoc | null,
): boolean {
  if (!user) return false;
  return resolveCapabilities(user.role, override).has(cap);
}

/** The current user's effective capability set (role default ∪ wing override). */
export function useCapabilities(): Set<Capability> {
  return useAuthContext().capabilities;
}

/** True when the current user has `cap`. */
export function useCan(cap: Capability): boolean {
  return useAuthContext().capabilities.has(cap);
}

/** True when the current user has every capability in `caps`. */
export function useCanEvery(...caps: Capability[]): boolean {
  const set = useAuthContext().capabilities;
  return caps.every((c) => set.has(c));
}

/** True when the current user has at least one of `caps`. */
export function useCanSome(...caps: Capability[]): boolean {
  const set = useAuthContext().capabilities;
  return caps.some((c) => set.has(c));
}
