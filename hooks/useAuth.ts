"use client";

import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import type { Capability } from "@/config/permissions";
import type { Role } from "@/types";

export function useAuth() {
  const { user, loading, capabilities } = useAuthContext();

  const isFounder = user?.role === ROLES.FOUNDER;

  return {
    user,
    loading,
    isAuthenticated: !!user,
    role: user?.role ?? null,
    capabilities,
    can: (cap: Capability) => capabilities.has(cap),
    isFounder,
    /** @deprecated use isFounder */
    isSuperAdmin: isFounder,
    isAdmin: user?.role === ROLES.ADMIN,
    isDirector: user?.role === ROLES.DIRECTOR,
    isChiefTeacher: user?.role === ROLES.CHIEF_TEACHER,
    isTeacher: user?.role === ROLES.TEACHER,
    isParent: user?.role === ROLES.PARENT,
    hasRole: (role: Role) => user?.role === role,
    hasAnyRole: (...roles: Role[]) =>
      roles.some((r) => user?.role === r),
  };
}
