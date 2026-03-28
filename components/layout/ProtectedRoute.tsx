"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { validateUserAccess, isRoleAllowed } from "@/lib/validators/auth.validators";
import type { Role } from "@/types";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles: Role[];
}

export default function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // Not logged in → login
    if (!user) {
      router.replace("/login");
      return;
    }

    // Logged in but inactive/pending → login (blocked)
    if (!validateUserAccess(user)) {
      router.replace("/login");
      return;
    }

    // Logged in, active, but wrong role → login
    if (!isRoleAllowed(user, allowedRoles)) {
      router.replace("/login");
    }
  }, [user, loading, allowedRoles, router]);

  // Show nothing while resolving auth state
  if (loading || !user) return null;

  // Block render if status or role fails — redirect already triggered above
  if (!validateUserAccess(user) || !isRoleAllowed(user, allowedRoles)) return null;

  return <>{children}</>;
}
