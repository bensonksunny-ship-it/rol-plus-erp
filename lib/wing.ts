// =============================================================================
// Wing helpers — the two music schools share collections, partitioned by `wing`.
// =============================================================================

import { where, type QueryConstraint } from "firebase/firestore";
import { DEFAULT_WING, WINGS } from "@/config/constants";
import type { Role, User, Wing } from "@/types";

export { WINGS, DEFAULT_WING };

/** All valid wing values. */
export const WING_VALUES: Wing[] = Object.values(WINGS);

export function isWing(v: unknown): v is Wing {
  return typeof v === "string" && (WING_VALUES as string[]).includes(v);
}

/**
 * The wing a document belongs to. Documents created before wings existed have
 * no `wing` field — treat them as the original wing.
 */
export function wingOf(doc: { wing?: unknown } | null | undefined): Wing {
  return isWing(doc?.wing) ? doc!.wing as Wing : DEFAULT_WING;
}

/** True when `doc` belongs to `wing` (legacy docs count as DEFAULT_WING). */
export function inWing(doc: { wing?: unknown } | null | undefined, wing: Wing): boolean {
  return wingOf(doc) === wing;
}

/**
 * True for Rol's School of Music (wing 2). Its fee model is fixed — every student
 * is a group batch, prepaid, billed monthly (no personal classes, no per-class
 * billing). UI paths branch on this to hide the ROL+ options.
 */
export function isSchoolOfMusic(wing: string | undefined | null): boolean {
  return wing === WINGS.SCHOOL_OF_MUSIC;
}

/**
 * Firestore constraint for the active wing.
 *
 * NOTE: an equality filter on `wing` will NOT return legacy docs that lack the
 * field. Only use this for the SCHOOL_OF_MUSIC wing (all its docs are new and
 * always stamped). For the ROL+ wing, fetch without the constraint and filter
 * client-side with `inWing(doc, wing)` so legacy docs are still included.
 */
export function wingConstraint(wing: Wing): QueryConstraint {
  return where("wing", "==", wing);
}

/**
 * Whether a server-side `where("wing","==",…)` filter is safe for this wing.
 * False for ROL+ (legacy docs have no field) — filter client-side instead.
 */
export function canFilterWingServerSide(wing: Wing): boolean {
  return wing !== DEFAULT_WING;
}

/**
 * Every role this user holds in `wing` — their explicit per-wing assignment
 * (`user.roles[wing]`), which may be one role or several at once (e.g. Admin
 * and Teacher together — each grants its own hub/capabilities). A value
 * written before multi-role support was a bare Role string; read as a
 * single-role list. Falls back to the legacy scalar `role` if `wing` happens
 * to be their home wing, else empty (no access in that wing).
 */
export function getRolesForWing(user: User | null | undefined, wing: Wing): Role[] {
  if (!user) return [];
  const explicit = user.roles?.[wing];
  if (explicit) return Array.isArray(explicit) ? explicit : [explicit];
  return wingOf(user) === wing && user.role ? [user.role] : [];
}

/**
 * This user's primary role in `wing` — the first of getRolesForWing(), or
 * null with no access in that wing. Use this where only a single role is
 * needed (sorting, a legacy single-role display); use getRolesForWing() when
 * every hub a user can switch into matters.
 */
export function getRoleForWing(user: User | null | undefined, wing: Wing): Role | null {
  return getRolesForWing(user, wing)[0] ?? null;
}

/** Every wing this user holds a role in (their home wing always counts). */
export function getUserWings(user: User | null | undefined): Wing[] {
  if (!user) return [];
  const explicit = Object.keys(user.roles ?? {}) as Wing[];
  const home = wingOf(user);
  return explicit.includes(home) ? explicit : [...explicit, home];
}
