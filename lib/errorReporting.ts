// Client-side error capture — logs full details to the console and keeps the
// most recent one in sessionStorage so the error screen can show / copy it
// (production builds otherwise only show a generic message).

export interface CapturedError {
  message: string;
  stack: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  at: string;
  source: string;
}

const KEY = "rol_last_error";

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /Loading chunk [\w-]+ failed/i.test(error.message) ||
    /loading css chunk/i.test(error.message) ||
    /Failed to fetch dynamically imported module/i.test(error.message) ||
    /Importing a module script failed/i.test(error.message)
  );
}

export function captureError(error: unknown, source: string, componentStack?: string): CapturedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const entry: CapturedError = {
    message:   err.message || err.name || "Unknown error",
    stack:     err.stack ?? "",
    componentStack,
    url:       typeof window !== "undefined" ? window.location.href : "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    at:        new Date().toISOString(),
    source,
  };
  console.error(`[${source}]`, err, componentStack ?? "");
  try { sessionStorage.setItem(KEY, JSON.stringify(entry)); } catch { /* storage blocked */ }
  return entry;
}

export function formatErrorReport(e: CapturedError): string {
  return [
    `Error: ${e.message}`,
    `Page: ${e.url}`,
    `When: ${e.at}`,
    `Device: ${e.userAgent}`,
    `Source: ${e.source}`,
    "",
    e.stack,
    e.componentStack ? `\nComponent stack:${e.componentStack}` : "",
  ].join("\n");
}

/**
 * One hard reload to recover from a stale-build chunk 404, at most once per
 * 30 s (a localStorage timestamp guards against reload loops). Returns false
 * when the guard blocks it or storage is unavailable.
 */
export function reloadOnceForChunkError(): boolean {
  const RELOAD_KEY = "__chunk_reload_at__";
  try {
    const last = parseInt(localStorage.getItem(RELOAD_KEY) ?? "0", 10);
    if (Date.now() - last < 30_000) return false;
    localStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

let installed = false;
/** Logs errors that never reach a React boundary (event handlers, promises). */
export function installGlobalErrorLogging(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", e => {
    if (e.error) captureError(e.error, "window.onerror");
  });
  window.addEventListener("unhandledrejection", e => {
    captureError(e.reason, "unhandledrejection");
  });
}
