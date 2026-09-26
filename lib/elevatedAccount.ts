import { LEGACY_SUPER_ADMIN_ROLE, ROLES, WINGS } from "@/config/constants";

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

/** ROL+ Music Academy (Wing 1) leadership: Admin (+ Founder) — no Chief Teacher / Director there. */
const ROL_PLUS_LEADERS = new Set([ROLES.FOUNDER, LEGACY_SUPER_ADMIN_ROLE, ROLES.ADMIN].map(r => r.toLowerCase()));

/**
 * Whether a user doc may run a wing's admissions set-up (e.g. edit its
 * screening questions). ROL+ → Founder / Admin; School of Music → any
 * elevated role (Founder / Admin / Director / Chief Teacher).
 */
export function canLeadWing(data: { role?: unknown; roles?: unknown } | null | undefined, wing: string | null | undefined): boolean {
  if (!data) return false;
  if (wing !== WINGS.ROL_PLUS) return isElevatedAccount(data);
  const all: unknown[] = [data.role];
  if (data.roles && typeof data.roles === "object") {
    for (const v of Object.values(data.roles as Record<string, unknown>)) all.push(...(Array.isArray(v) ? v : [v]));
  }
  return all.some(r => typeof r === "string" && ROL_PLUS_LEADERS.has(r.trim().toLowerCase()));
}
