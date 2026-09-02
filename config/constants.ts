export const ROLES = {
  // Cross-wing owner. Renamed from the old "super_admin". Existing user docs are
  // migrated to "founder" by scripts/backfill-wings.mjs, and getUserProfile()
  // normalizes any not-yet-migrated "super_admin" to "founder" on read.
  FOUNDER: "founder",
  /**
   * @deprecated Use ROLES.FOUNDER. Kept (pointing at the same "founder" value)
   * so the many existing `ROLES.SUPER_ADMIN` call sites keep compiling and
   * resolve to the founder role. New code must use ROLES.FOUNDER.
   */
  SUPER_ADMIN: "founder",
  // ROL+ Music Academy (wing "rol_plus") administrator. Unchanged behaviour.
  ADMIN: "admin",
  // Rol's School of Music (wing "school_of_music") leadership.
  DIRECTOR: "director",
  CHIEF_TEACHER: "chief_teacher",
  // Present in both wings.
  TEACHER: "teacher",
  STUDENT: "student",
  // Rol's School of Music parent portal — read-only, own children only.
  PARENT: "parent",
  // Rol's School of Music generic account — created via the Users screen with a
  // login id instead of an email. No leadership capabilities.
  MEMBER: "member",
} as const;

/**
 * Domain appended to a School of Music login id to form the hidden email that
 * Firebase Auth actually stores. Members sign in with just their login id; the
 * login form appends "@<this>" when the input has no "@". The domain never
 * needs to receive mail — it only has to be a syntactically valid email host.
 */
export const SOM_LOGIN_DOMAIN = "som.rolsplus.app";

/** login id → the synthetic email used for Firebase Auth. */
export function loginIdToAuthEmail(loginId: string): string {
  return `${loginId.trim().toLowerCase()}@${SOM_LOGIN_DOMAIN}`;
}

/** Normalise a sign-in input: emails pass through, bare login ids get the domain. */
export function resolveSignInIdentifier(input: string): string {
  const v = input.trim();
  return v.includes("@") ? v : loginIdToAuthEmail(v);
}

/**
 * Deprecated alias. The old top role. Retained only so migration/backfill code
 * and the auth-read shim can refer to the legacy stored value. Do not gate UI
 * on this — use ROLES.FOUNDER.
 */
export const LEGACY_SUPER_ADMIN_ROLE = "super_admin";

/**
 * Wings — the two music schools that run on this app.
 *  - rol_plus         : ROL+ Music Academy (wing 1, the original)
 *  - school_of_music  : Rol's School of Music (wing 2)
 * Every wing-scoped document carries a `wing` field. Legacy documents that
 * predate this field are treated as "rol_plus" (see lib/wing.ts wingOf()).
 */
export const WINGS = {
  ROL_PLUS: "rol_plus",
  SCHOOL_OF_MUSIC: "school_of_music",
} as const;

export const DEFAULT_WING = WINGS.ROL_PLUS;

/** Human-readable wing names for headers, switchers, PDFs. */
export const WING_LABELS: Record<string, string> = {
  [WINGS.ROL_PLUS]: "ROL+ Music Academy",
  [WINGS.SCHOOL_OF_MUSIC]: "Rol's School of Music",
};

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
  [ROLES.FOUNDER]: "/dashboard",
  [ROLES.ADMIN]: "/dashboard",
  [ROLES.DIRECTOR]: "/dashboard",
  [ROLES.CHIEF_TEACHER]: "/dashboard",
  [ROLES.TEACHER]: "/dashboard",
  [ROLES.STUDENT]: "/dashboard",
  [ROLES.PARENT]: "/dashboard/parent",
  [ROLES.MEMBER]: "/dashboard/account",
};

export const PUBLIC_ROUTES = ["/login", "/forgot-password"];
