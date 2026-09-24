import { LEGACY_SUPER_ADMIN_ROLE, ROLES } from "@/config/constants";

/**
 * Administrative roles a Chief Teacher may not see or manage on the Users
 * page (including other Chief Teachers). Compared case-insensitively.
 */
const ELEVATED_ROLES = new Set(
  [ROLES.FOUNDER, LEGACY_SUPER_ADMIN_ROLE, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER].map(r => r.toLowerCase()),
);

const isElevatedRole = (r: unknown) => typeof r === "string" && ELEVATED_ROLES.has(r.trim().toLowerCase());

/**
 * Whether a user doc holds an administrative role in any wing — its home
 * `role` or any entry of the per-wing `roles` map. Pure (no Firebase imports)
 * so the client page and the Admin-SDK API routes share one definition.
 */
export function isElevatedAccount(data: { role?: unknown; roles?: unknown } | null | undefined): boolean {
  if (!data) return false;
  if (isElevatedRole(data.role)) return true;
  const roles = data.roles;
  if (roles && typeof roles === "object") {
    return Object.values(roles as Record<string, unknown>).some(v =>
      Array.isArray(v) ? v.some(isElevatedRole) : isElevatedRole(v));
  }
  return false;
}
