import type { CenterBatch } from "@/types";

/**
 * Default-batch fallback.
 *
 * A centre with no explicit `batches` runs as a single block on its own
 * schedule (daysOfWeek / startTime / endTime). We treat that schedule as one
 * implicit "General Batch" so every student at the centre belongs to a batch
 * without anyone having to create one. The default batch is never persisted:
 * a student's `batchId` stays null and resolves to it at read time. Once a
 * centre gets real batches via "+ Add Batch", those replace the default.
 */

export const DEFAULT_BATCH_NAME = "General Batch";

const DEFAULT_PREFIX = "default_";

export function defaultBatchId(centerId: string): string {
  return `${DEFAULT_PREFIX}${centerId}`;
}

export function isDefaultBatchId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(DEFAULT_PREFIX);
}

/** Explicit batches stored on a centre doc (ignores malformed entries). */
export function explicitBatches(data: Record<string, unknown> | undefined): CenterBatch[] {
  const raw = data?.batches;
  return Array.isArray(raw) ? (raw.filter(b => b && typeof b === "object" && b.id) as CenterBatch[]) : [];
}

/** The implicit batch built from a centre's main schedule. */
export function defaultBatch(centerId: string, data: Record<string, unknown> | undefined): CenterBatch {
  return {
    id:         defaultBatchId(centerId),
    name:       DEFAULT_BATCH_NAME,
    daysOfWeek: Array.isArray(data?.daysOfWeek) ? (data.daysOfWeek as string[]) : [],
    startTime:  typeof data?.startTime === "string" ? data.startTime : "",
    endTime:    typeof data?.endTime === "string" ? data.endTime : "",
  };
}

/** Explicit batches if any exist, otherwise the single default batch. */
export function effectiveBatches(centerId: string, data: Record<string, unknown> | undefined): CenterBatch[] {
  const explicit = explicitBatches(data);
  return explicit.length > 0 ? explicit : [defaultBatch(centerId, data)];
}

/** "Mon/Wed 17:00–18:30" — empty string when the schedule is blank. */
export function batchSchedule(b: CenterBatch): string {
  const days = b.daysOfWeek.join("/");
  const time = b.startTime && b.endTime ? `${b.startTime}–${b.endTime}` : "";
  return [days, time].filter(Boolean).join(" ");
}

/** Value to persist on the student: default batches are stored as null. */
export function storedBatchId(id: string | null | undefined): string | null {
  return id && !isDefaultBatchId(id) ? id : null;
}

/**
 * Batch id to persist for a student at a centre: only a real batch that still
 * exists there. Default batches and ids of deleted batches become null. When
 * the centre's batches aren't known (not loaded), the id is kept as-is.
 */
export function batchIdToStore(centreBatches: CenterBatch[] | undefined, id: string | null | undefined): string | null {
  const stored = storedBatchId(id);
  if (!stored || !centreBatches) return stored;
  return centreBatches.some(b => b.id === stored) ? stored : null;
}
