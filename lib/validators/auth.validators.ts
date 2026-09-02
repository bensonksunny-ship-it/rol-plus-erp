import { USER_STATUS } from "@/config/constants";
import { CAPABILITIES, resolveCapabilities } from "@/config/permissions";
import type { User, Role } from "@/types";

export function isActiveUser(user: User): boolean {
  return user.status === USER_STATUS.ACTIVE;
}

export function hasRole(user: User, role: Role): boolean {
  return user.role === role;
}

export function hasAnyRole(user: User, roles: Role[]): boolean {
  return roles.includes(user.role);
}

/**
 * Capability check against the default role map (no Firestore override).
 * Components should prefer useCan() from lib/permissions; this is for
 * non-React callers and legacy helpers below.
 */
function userCan(user: User, cap: string): boolean {
  return resolveCapabilities(user.role).has(cap as never);
}

export function canApproveStudentDeactivation(user: User): boolean {
  return userCan(user, CAPABILITIES.APPROVALS_MANAGE);
}

export function canApproveTeacherDeactivation(user: User): boolean {
  // Teacher lifecycle is staff administration — founder-level only.
  return userCan(user, CAPABILITIES.STAFF_CREATE_TEACHER) && userCan(user, CAPABILITIES.APPROVALS_MANAGE);
}

export function canOverrideSyllabus(user: User): boolean {
  return userCan(user, CAPABILITIES.SYLLABUS_OVERRIDE);
}

export function canManuallyMarkAttendance(user: User): boolean {
  // Manual attendance is allowed but flagged — any active user with the
  // attendance capability may do it.
  return isActiveUser(user) && userCan(user, CAPABILITIES.ATTENDANCE_MANAGE);
}

/**
 * Returns true if the user is active and not pending.
 * Use this before allowing any protected action.
 */
export function validateUserAccess(user: User | null): boolean {
  if (!user) return false;
  return user.status === USER_STATUS.ACTIVE;
}

/**
 * Returns true if the user's role is in the allowed list.
 * Combines with validateUserAccess for full gate: access + role.
 */
export function isRoleAllowed(user: User | null, roles: Role[]): boolean {
  if (!user) return false;
  return roles.includes(user.role);
}
