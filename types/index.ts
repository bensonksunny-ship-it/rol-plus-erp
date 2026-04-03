import type {
  ROLES,
  USER_STATUS,
  STUDENT_STATUS,
  CENTER_STATUS,
  APPROVAL_STATUS,
  ATTENDANCE_MODE,
} from "@/config/constants";

// ─── Primitives ───────────────────────────────────────────────────────────────

export type Role = (typeof ROLES)[keyof typeof ROLES];
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
export type StudentStatus = (typeof STUDENT_STATUS)[keyof typeof STUDENT_STATUS];
export type CenterStatus = (typeof CENTER_STATUS)[keyof typeof CENTER_STATUS];
export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];
export type AttendanceMode = (typeof ATTENDANCE_MODE)[keyof typeof ATTENDANCE_MODE];

export type AuditTargetType =
  | "student"
  | "teacher"
  | "center"
  | "finance"
  | "attendance";

// ─── User base (shared fields across all roles) ───────────────────────────────

interface UserBase {
  uid: string;
  email: string;
  displayName: string;
  status: UserStatus;
  lastActivity: string | null;   // ISO — last login or action timestamp
  qrCodeURL: string | null;      // generated QR for identity / attendance scanning
  createdAt: string;
  updatedAt: string;
}

// ─── Role-discriminated User variants ────────────────────────────────────────

/**
 * StudentUser — centerId and currentBalance are required (non-null).
 * Enforces the 1 student → 1 center rule at the type level.
 */
export interface StudentUser extends UserBase {
  role: typeof ROLES.STUDENT;
  centerId: string;              // required — cannot be null for a student
  currentBalance: number;        // finance source of truth — required
  studentID: string;             // auto-generated: ROL20260001 — system identifier
  admissionNo: string | null;    // optional external/legacy admission number
  studentStatus: StudentStatus;
  deactivationReason: string | null;
  deactivationRequestedBy: string | null;  // uid of requesting teacher
  deactivationApprovalStatus: ApprovalStatus | null;
  // Teacher-specific fields excluded entirely
  centerIds?: never;
}

/**
 * TeacherUser — centerIds is required (non-null, managed via centers module).
 */
export interface TeacherUser extends UserBase {
  role: typeof ROLES.TEACHER;
  centerIds: string[];           // required — managed exclusively via centers module
  // Student-specific fields excluded entirely
  centerId?: never;
  currentBalance?: never;
  studentStatus?: never;
  deactivationReason?: never;
  deactivationRequestedBy?: never;
  deactivationApprovalStatus?: never;
}

/**
 * AdminUser / SuperAdminUser — no center or student fields.
 */
export interface AdminUser extends UserBase {
  role: typeof ROLES.ADMIN | typeof ROLES.SUPER_ADMIN;
  centerId?: never;
  currentBalance?: never;
  studentStatus?: never;
  deactivationReason?: never;
  deactivationRequestedBy?: never;
  deactivationApprovalStatus?: never;
  centerIds?: never;
}

/**
 * Discriminated union — use this as the canonical User type everywhere.
 * TypeScript narrows fields automatically on role check:
 *   if (user.role === "student") → user.centerId is string (not null)
 */
export type User = StudentUser | TeacherUser | AdminUser;

// ─── Center (atomic unit: location + time slot) ───────────────────────────────

export interface Center {
  id: string;
  centerCode: string;            // auto-generated: CTR001, CTR002… — never user-entered
  name: string;
  location: string;
  timeSlot: string;              // e.g. "Mon/Wed/Fri 17:00–18:30"
  teacherUid: string;            // exactly one teacher per center
  studentUids: string[];         // fast lookup — mirrors User.centerId assignments
  status: CenterStatus;
  createdAt: string;
  updatedAt: string;
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export interface AttendanceRecord {
  id: string;
  centerId: string;
  studentUid: string;            // references StudentUser.uid
  date: string;                  // ISO date string
  present: boolean;
  mode: AttendanceMode;          // "manual" entries are flagged automatically
  markedBy: string;              // uid of teacher or admin
  flagReason: "manual" | "late" | "suspicious" | null;  // null = no flag
  createdAt: string;
}

// ─── Finance ──────────────────────────────────────────────────────────────────

export interface FinanceRecord {
  id: string;
  studentUid: string;            // references StudentUser.uid
  centerId: string;
  amount: number;
  dueDate: string;
  paidDate: string | null;
  lastPaymentDate: string | null; // last successful payment — separate from paidDate
  status: "paid" | "unpaid" | "overdue";
  alertSent: boolean;            // finance is flexible: alerts only, no blocking
  createdAt: string;
}

// ─── Syllabus ─────────────────────────────────────────────────────────────────

export interface SyllabusItem {
  id: string;
  centerId: string;
  order: number;                 // sequence is strictly enforced — no skipping
  title: string;
  completedAt: string | null;
  adminOverride: boolean;        // only admin/super_admin may set true to skip
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  action: string;
  performedBy: string;           // uid
  initiatorRole: Role;           // role of the user who triggered the action
  targetType: AuditTargetType;   // strict union — no arbitrary strings
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ─── Auth Session ─────────────────────────────────────────────────────────────

export interface AuthSession {
  user: User;
  token: string;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isStudent(user: User): user is StudentUser {
  return user.role === "student";
}

export function isTeacher(user: User): user is TeacherUser {
  return user.role === "teacher";
}

export function isAdmin(user: User): user is AdminUser {
  return user.role === "admin" || user.role === "super_admin";
}