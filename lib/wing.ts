// =============================================================================
// Wing helpers — the two music schools share collections, partitioned by `wing`.
// =============================================================================

import { where, type QueryConstraint } from "firebase/firestore";
import { DEFAULT_WING, WINGS } from "@/config/constants";
import type { Wing } from "@/types";

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
