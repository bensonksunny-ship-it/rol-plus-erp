"use client";

import { useEffect, useMemo, useRef } from "react";
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

  // Stabilise the roles array so its reference doesn't change on every render.
  // Callers pass inline literals like [ROLES.ADMIN, ROLES.SUPER_ADMIN] which
  // would be a new array instance each render and cause the useEffect below to
  // fire in a tight loop, re-rendering the page 2× per second.
  const rolesKey = allowedRoles.slice().sort().join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRoles = useMemo(() => allowedRoles, [rolesKey]);

  // Guard against triggering router.replace more than once per mount.
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (loading) return;

    // Not logged in → login
    if (!user) {
      if (!redirectedRef.current) { redirectedRef.current = true; router.replace("/login"); }
      return;
    }

    // Logged in but inactive/pending → login (blocked)
    if (!validateUserAccess(user)) {
      if (!redirectedRef.current) { redirectedRef.current = true; router.replace("/login"); }
      return;
    }

    // Logged in, active, but wrong role → login
    if (!isRoleAllowed(user, stableRoles)) {
      if (!redirectedRef.current) { redirectedRef.current = true; router.replace("/login"); }
    }
  }, [user, loading, stableRoles, router]);

  // Show a neutral background while auth resolves — never return null which
  // would cause a hydration mismatch and a blank flash on SSR.
  if (loading) return (
    <div style={{
      height: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--color-bg)",
    }} />
  );

  if (!user) return null;

  // Block render if status or role fails — redirect already triggered above
  if (!validateUserAccess(user) || !isRoleAllowed(user, stableRoles)) return null;

  return <>{children}</>;
}
