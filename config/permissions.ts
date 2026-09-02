// =============================================================================
// Capability model
// =============================================================================
//
// Roles no longer gate features directly. Each role maps to a set of
// capabilities (verbs). UI and route guards check `can(user, capability)`
// (see lib/permissions.ts). The default map below is the source of truth; a
// Firestore doc `config/permissions/{wing}` can override any role's set at
// runtime (merged at login) so the split can be retuned without a deploy.
// The override doc lives at `config/permissions_{wing}` (see AuthContext).
//
// Keep capability names stable — they are persisted in the override doc.
// =============================================================================

import { ROLES } from "@/config/constants";
import type { Role } from "@/types";

export const CAPABILITIES = {
  // Dashboard / overview
  DASHBOARD_VIEW: "dashboard.view",

  // Centres
  CENTRES_MANAGE: "centres.manage",           // create / edit / delete centres
  CENTRES_EDIT_SCHEDULE: "centres.editSchedule", // edit schedule & assignments only

  // Students
  STUDENTS_MANAGE: "students.manage",          // enroll / edit / transfer
  STUDENTS_VIEW_ALL: "students.viewAll",       // see every student in the wing
  STUDENTS_DELETE: "students.delete",          // hard delete

  // Attendance
  ATTENDANCE_MANAGE: "attendance.manage",
  ATTENDANCE_VIEW_ALL: "attendance.viewAll",

  // Syllabus
  SYLLABUS_MANAGE: "syllabus.manage",
  SYLLABUS_OVERRIDE: "syllabus.override",      // skip strict order

  // Screening & admissions
  SCREENING_MANAGE: "screening.manage",

  // Lessons library
  LESSONS_VIEW: "lessons.view",
  LESSONS_MANAGE: "lessons.manage",

  // Finance
  FINANCE_VIEW: "finance.view",
  FINANCE_MANAGE: "finance.manage",

  // Insights
  ANALYTICS_VIEW: "analytics.view",
  REPORTS_VIEW: "reports.view",
  LEADERBOARDS_VIEW: "leaderboards.view",
  TEACHER_SCORE_VIEW_ALL: "teacherScore.viewAll",

  // System
  EXPORT_DATA: "export.data",
  AUDIT_VIEW: "audit.view",
  ALERTS_VIEW: "alerts.view",
  APPROVALS_MANAGE: "approvals.manage",        // approve deactivation / break

  // Staff administration
  STAFF_VIEW: "staff.view",
  USERS_MANAGE: "users.manage",   // School of Music generic user accounts
  STAFF_CREATE_ADMIN: "staff.create.admin",
  STAFF_CREATE_DIRECTOR: "staff.create.director",
  STAFF_CREATE_CHIEF_TEACHER: "staff.create.chiefTeacher",
  STAFF_CREATE_TEACHER: "staff.create.teacher",
  STAFF_CREATE_PARENT: "staff.create.parent",

  // Wings
  WING_SWITCH: "wing.switch",                  // operate across both wings

  // Parent portal
  PARENT_VIEW_CHILD: "parent.viewChild",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const ALL_CAPABILITIES: Capability[] = Object.values(CAPABILITIES);

const C = CAPABILITIES;

// Everything except cross-wing switching and the parent-only view.
const WING_ADMIN_FULL: Capability[] = ALL_CAPABILITIES.filter(
  (c) => c !== C.WING_SWITCH && c !== C.PARENT_VIEW_CHILD,
);

/**
 * ROL+ `admin` — unchanged effective power. Same as a full wing admin minus the
 * School-of-Music-only staff creation verbs (admins are still created only by
 * the founder, matching today's "Admins page = super_admin only" rule).
 */
const ADMIN_CAPS: Capability[] = WING_ADMIN_FULL.filter(
  (c) =>
    c !== C.STAFF_CREATE_ADMIN &&
    c !== C.STAFF_CREATE_DIRECTOR &&
    c !== C.STAFF_CREATE_CHIEF_TEACHER,
);

/** School of Music Director — full wing control, cannot mint peer Directors. */
const DIRECTOR_CAPS: Capability[] = WING_ADMIN_FULL.filter(
  (c) => c !== C.STAFF_CREATE_ADMIN && c !== C.STAFF_CREATE_DIRECTOR,
);

/**
 * School of Music Chief Teacher — broad academic + operational + full finance,
 * plus staff creation for teachers / parents / other chief teachers. Excludes
 * the sensitive items reserved to the Director.
 */
const CHIEF_TEACHER_CAPS: Capability[] = [
  C.DASHBOARD_VIEW,
  C.CENTRES_EDIT_SCHEDULE,
  C.STUDENTS_MANAGE,
  C.STUDENTS_VIEW_ALL,
  C.ATTENDANCE_MANAGE,
  C.ATTENDANCE_VIEW_ALL,
  C.SYLLABUS_MANAGE,
  C.SCREENING_MANAGE,
  C.LESSONS_VIEW,
  C.LESSONS_MANAGE,
  C.FINANCE_VIEW,
  C.FINANCE_MANAGE,
  C.ANALYTICS_VIEW,
  C.REPORTS_VIEW,
  C.LEADERBOARDS_VIEW,
  C.TEACHER_SCORE_VIEW_ALL,
  C.ALERTS_VIEW,
  C.STAFF_VIEW,
  C.STAFF_CREATE_CHIEF_TEACHER,
  C.STAFF_CREATE_TEACHER,
  C.STAFF_CREATE_PARENT,
  C.USERS_MANAGE,
];

/** Teacher — assigned students / classes only (centre scope enforced separately). */
const TEACHER_CAPS: Capability[] = [
  C.STUDENTS_MANAGE,
  C.ATTENDANCE_MANAGE,
  C.SCREENING_MANAGE,
  C.LESSONS_VIEW,
];

export const DEFAULT_ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  [ROLES.FOUNDER]: ALL_CAPABILITIES,
  [ROLES.ADMIN]: ADMIN_CAPS,
  [ROLES.DIRECTOR]: DIRECTOR_CAPS,
  [ROLES.CHIEF_TEACHER]: CHIEF_TEACHER_CAPS,
  [ROLES.TEACHER]: TEACHER_CAPS,
  [ROLES.STUDENT]: [],
  [ROLES.PARENT]: [C.PARENT_VIEW_CHILD],
  [ROLES.MEMBER]: [],
};

/**
 * Shape of the Firestore override doc `config/permissions_{wing}`.
 * `grant` / `revoke` are applied on top of the default set for that role.
 * Example:
 *   { chief_teacher: { revoke: ["finance.manage"] }, teacher: { grant: ["lessons.manage"] } }
 */
export interface PermissionOverrideDoc {
  [role: string]: { grant?: string[]; revoke?: string[] } | undefined;
}

/** Resolve the effective capability set for a role given an optional override. */
export function resolveCapabilities(
  role: Role,
  override?: PermissionOverrideDoc | null,
): Set<Capability> {
  const base = new Set<Capability>(DEFAULT_ROLE_CAPABILITIES[role] ?? []);
  const ov = override?.[role];
  if (ov) {
    for (const g of ov.grant ?? []) base.add(g as Capability);
    for (const r of ov.revoke ?? []) base.delete(r as Capability);
  }
  return base;
}
