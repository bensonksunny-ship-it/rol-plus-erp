// =============================================================================
// ROL Plus ERP — Firestore Database Schema
// Phase 1 · Step 3
// =============================================================================
//
// Conventions:
//   - Document IDs are noted explicitly where they differ from auto-ID
//   - Timestamps stored as Firestore Timestamp, represented as string in types
//   - All collections are top-level (no subcollections) for query flexibility
//   - centerId is present on every record that belongs to a center
// =============================================================================


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: users
// Path: /users/{uid}
// Document ID: Firebase Auth UID (set explicitly on creation)
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers all roles: student | teacher | admin | super_admin
// Role-specific fields are null / absent for non-applicable roles.
//
// {
//   uid:                    string          — mirrors document ID
//   email:                  string
//   displayName:            string
//   role:                   "student" | "teacher" | "admin" | "super_admin"
//   status:                 "active" | "inactive" | "pending"
//   lastActivity:           Timestamp | null
//   qrCodeURL:              string | null   — Storage URL
//
//   // Student-only (non-null when role === "student")
//   centerId:               string | null   — ref → centers/{id}
//   currentBalance:         number | null   — finance source of truth
//   studentStatus:          "active" | "inactive" | "deactivation_requested" | null
//   deactivationReason:     string | null
//   deactivationRequestedBy: string | null  — uid ref → users/{uid}
//   deactivationApprovalStatus: "pending" | "approved" | "rejected" | null
//
//   // Teacher-only (non-null when role === "teacher")
//   centerIds:              string[] | null — refs → centers/{id}
//
//   createdAt:              Timestamp
//   updatedAt:              Timestamp
// }
//
// Indexes:
//   [role, status]                          — list active students / teachers
//   [role, centerId]                        — all students in a center
//   [role, studentStatus]                   — deactivation queue
//   [centerId, studentStatus]               — center-scoped deactivation review
//   [status, lastActivity DESC]             — inactive / dormant user reports


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: centers
// Path: /centers/{centerId}
// Document ID: auto-ID
// ─────────────────────────────────────────────────────────────────────────────
//
// Atomic unit of the system. Every student, class, attendance record,
// finance record, and syllabus item links back to a centerId.
//
// {
//   id:           string          — mirrors document ID
//   name:         string
//   location:     string
//   timeSlot:     string          — e.g. "Mon/Wed/Fri 17:00–18:30"
//   teacherUid:   string          — single source of truth → users/{uid}
//   studentUids:  string[]        — denormalized for fast dashboard reads
//                                   kept in sync on student enroll/transfer/deactivate
//   status:       "active" | "inactive"
//   createdAt:    Timestamp
//   updatedAt:    Timestamp
// }
//
// Justification for studentUids denormalization:
//   Dashboard queries like "show all students in this center" would otherwise
//   require a collection-group query on users filtered by centerId. Storing
//   studentUids on the center document makes this a single document read.
//   Write cost: one array update on enroll/deactivate — acceptable.
//
// Indexes:
//   [status]                                — list active centers
//   [teacherUid, status]                    — centers assigned to a teacher
//   [location, status]                      — centers by location


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: classes
// Path: /classes/{classId}
// Document ID: auto-ID
// ─────────────────────────────────────────────────────────────────────────────
//
// Represents a single scheduled session for a center.
// Attendance records are children of a class session (linked via classId).
// Separating classes from attendance avoids one mega-document per center.
//
// {
//   id:               string
//   centerId:         string          — ref → centers/{id}
//   teacherUid:       string          — denormalized from center for query speed
//   scheduledDate:    Timestamp       — the date/time of the session
//   status:           "scheduled" | "completed" | "cancelled"
//   syllabusItemId:   string | null   — ref → syllabus/{id}, links session to topic
//   notes:            string | null
//   createdAt:        Timestamp
//   updatedAt:        Timestamp
// }
//
// Indexes:
//   [centerId, scheduledDate DESC]          — class history per center
//   [centerId, status]                      — upcoming / completed per center
//   [teacherUid, scheduledDate DESC]        — teacher's session history
//   [syllabusItemId]                        — coverage check per syllabus item


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: attendance_records
// Path: /attendance_records/{recordId}
// Document ID: auto-ID
// ─────────────────────────────────────────────────────────────────────────────
//
// One document per student per class session.
// Never store all students' attendance inside the class document —
// that would hit Firestore's 1MB document limit for large centers.
//
// {
//   id:           string
//   classId:      string          — ref → classes/{id}
//   centerId:     string          — denormalized for direct center queries
//   studentUid:   string          — ref → users/{uid} (role === "student")
//   date:         Timestamp       — denormalized from class.scheduledDate
//   present:      boolean
//   mode:         "system" | "manual"
//   markedBy:     string          — uid ref → users/{uid}
//   flagReason:   "manual" | "late" | "suspicious" | null
//   createdAt:    Timestamp
// }
//
// Indexes:
//   [centerId, date DESC]                   — attendance sheet per center per date
//   [studentUid, date DESC]                 — attendance history per student
//   [classId, studentUid]                   — unique constraint proxy (enforce in rules)
//   [centerId, flagReason]                  — flagged records review
//   [markedBy, date DESC]                   — audit: who marked what and when


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: finance_records
// Path: /finance_records/{recordId}
// Document ID: auto-ID
// ─────────────────────────────────────────────────────────────────────────────
//
// Individual fee / payment records per student.
// currentBalance lives on users/{uid} as source of truth.
// finance_records is the ledger — immutable append-only log of transactions.
//
// {
//   id:                string
//   studentUid:        string      — ref → users/{uid}
//   centerId:          string      — ref → centers/{id}
//   amount:            number      — positive = charge, negative = payment/credit
//   dueDate:           Timestamp
//   paidDate:          Timestamp | null
//   lastPaymentDate:   Timestamp | null   — updated on each partial payment
//   status:            "paid" | "unpaid" | "overdue"
//   alertSent:         boolean
//   createdAt:         Timestamp
// }
//
// Note: finance records are never deleted or updated after creation.
// Corrections are made via new records with negative amounts.
//
// Indexes:
//   [centerId, status]                      — center-level fee overview
//   [studentUid, status]                    — per-student balance view
//   [studentUid, dueDate DESC]              — payment history
//   [status, dueDate ASC]                   — overdue alerts job
//   [centerId, dueDate DESC]                — center finance report


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: syllabus
// Path: /syllabus/{itemId}
// Document ID: auto-ID
// ─────────────────────────────────────────────────────────────────────────────
//
// Ordered syllabus items per center. Sequence enforced at application layer
// (and optionally Firestore rules). adminOverride is the only bypass.
//
// {
//   id:             string
//   centerId:       string        — ref → centers/{id}
//   order:          number        — 1-based, strictly sequential
//   title:          string
//   completedAt:    Timestamp | null
//   adminOverride:  boolean       — true only if admin/super_admin skipped this item
//   createdAt:      Timestamp
//   updatedAt:      Timestamp
// }
//
// Indexes:
//   [centerId, order ASC]                   — ordered syllabus for a center (primary)
//   [centerId, completedAt]                 — progress tracking


// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION: audit_logs
// Path: /audit_logs/{logId}
// Document ID: auto-ID
// ─────────────────────────────────────────────────────────────────────────────
//
// Append-only. Never updated or deleted.
// Written by a server-side Cloud Function or API route — never by the client.
//
// {
//   id:             string
//   action:         string        — e.g. "student.deactivate", "syllabus.override"
//   performedBy:    string        — uid ref → users/{uid}
//   initiatorRole:  "student" | "teacher" | "admin" | "super_admin"
//   targetType:     "student" | "teacher" | "center" | "finance" | "attendance"
//   targetId:       string        — ID of the affected document
//   metadata:       map           — arbitrary context (reason, old value, new value)
//   createdAt:      Timestamp
// }
//
// Indexes:
//   [targetType, targetId, createdAt DESC]  — full history for any entity
//   [performedBy, createdAt DESC]           — actions by a specific user
//   [initiatorRole, createdAt DESC]         — role-level activity report
//   [targetType, createdAt DESC]            — global feed per entity type


// =============================================================================
// RELATIONSHIP MAP
// =============================================================================
//
//  users/{uid}
//    └── centerId ──────────────────→ centers/{id}          (student only)
//    └── centerIds[] ───────────────→ centers/{id}[]        (teacher only)
//
//  centers/{id}
//    └── teacherUid ────────────────→ users/{uid}           (single source of truth)
//    └── studentUids[] ─────────────→ users/{uid}[]         (denormalized, fast read)
//
//  classes/{id}
//    └── centerId ──────────────────→ centers/{id}
//    └── teacherUid ────────────────→ users/{uid}           (denormalized)
//    └── syllabusItemId ────────────→ syllabus/{id}
//
//  attendance_records/{id}
//    └── classId ───────────────────→ classes/{id}
//    └── centerId ──────────────────→ centers/{id}          (denormalized)
//    └── studentUid ────────────────→ users/{uid}
//    └── markedBy ──────────────────→ users/{uid}
//
//  finance_records/{id}
//    └── studentUid ────────────────→ users/{uid}
//    └── centerId ──────────────────→ centers/{id}
//
//  syllabus/{id}
//    └── centerId ──────────────────→ centers/{id}
//
//  audit_logs/{id}
//    └── performedBy ───────────────→ users/{uid}
//    └── targetId ──────────────────→ any collection document


// =============================================================================
// DENORMALIZATION DECISIONS
// =============================================================================
//
//  Field                         On              Reason
//  ─────────────────────────────────────────────────────────────────────────
//  studentUids[]                 centers         Dashboard: list students without
//                                                querying all users by centerId
//
//  teacherUid                    classes         Avoid join to centers on every
//                                                teacher schedule query
//
//  centerId                      attendance_     Direct center-scoped attendance
//                                records         queries without joining classes
//
//  date (from class)             attendance_     Date-range attendance queries
//                                records         without joining classes
//
//  currentBalance                users           Finance source of truth on user
//                                                doc; avoids summing finance_records
//                                                on every profile load