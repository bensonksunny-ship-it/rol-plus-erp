// =============================================================================
// A tiny in-memory cache for page-level Firestore fetches, so navigating back
// to a heavy dashboard page (Users, Registry, Staff, Enrollments) renders the
// last-known data instantly instead of a blank "Loading…" while it re-reads
// a large collection. Not a general data layer — just enough to make sidebar
// navigation feel instant; each page still refetches in the background every
// time to stay fresh (this is a cache-then-revalidate pattern, not SWR).
// =============================================================================

const cache = new Map<string, unknown>();

/** Runs `fetcher()` and caches the result under `key` for next time. */
export async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const result = await fetcher();
  cache.set(key, result);
  return result;
}

/** The last cached value for `key`, or undefined if nothing's been fetched yet. */
export function getCached<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

/** Writes a value directly, for callers that derive it without an async fetcher. */
export function setCached<T>(key: string, value: T): void {
  cache.set(key, value);
}

/** Drops a cached value — call after a write that makes it stale. */
export function invalidateCache(key: string): void {
  cache.delete(key);
}
