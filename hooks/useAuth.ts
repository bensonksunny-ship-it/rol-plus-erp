"use client";

import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import type { Role } from "@/types";

export function useAuth() {
  const { user, loading } = useAuthContext();

  return {
    user,
    loading,
    isAuthenticated: !!user,
    role: user?.role ?? null,
    isSuperAdmin: user?.role === ROLES.SUPER_ADMIN,
    isAdmin: user?.role === ROLES.ADMIN,
    isTeacher: user?.role === ROLES.TEACHER,
    hasRole: (role: Role) => user?.role === role,
    hasAnyRole: (...roles: Role[]) =>
      roles.some((r) => user?.role === r),
  };
}