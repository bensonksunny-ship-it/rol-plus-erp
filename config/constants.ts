export const ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student",
} as const;

export const USER_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  PENDING: "pending",
} as const;

export const STUDENT_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  DEACTIVATION_REQUESTED: "deactivation_requested",
  ON_BREAK: "on_break",
  BREAK_REQUESTED: "break_requested",
} as const;

export const CENTER_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
} as const;

export const APPROVAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;

export const ATTENDANCE_MODE = {
  SYSTEM: "system",
  MANUAL: "manual",         // allowed but flagged
} as const;

export const ROLE_ROUTES: Record<string, string> = {
  [ROLES.SUPER_ADMIN]: "/dashboard",
  [ROLES.ADMIN]: "/dashboard",
  [ROLES.TEACHER]: "/dashboard",
  [ROLES.STUDENT]: "/dashboard",
};

export const PUBLIC_ROUTES = ["/login", "/forgot-password"];