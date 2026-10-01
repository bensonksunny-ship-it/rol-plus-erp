// Turns Firebase Storage upload errors into messages staff can act on.
// `storage/unknown` with a 404 body is what Firebase returns when the project
// has no Storage bucket (Storage never enabled in the Firebase console).

export function storageErrorMessage(err: unknown, what = "Upload"): string {
  const e = err as { code?: string; message?: string; customData?: { serverResponse?: string }; status_?: number } | null;
  const code = e?.code ?? "";
  const body = `${e?.customData?.serverResponse ?? ""} ${e?.message ?? ""}`;
  if (code === "storage/unknown" && (/404|not found/i.test(body) || e?.status_ === 404)) {
    return `${what} failed — photo storage isn't set up yet. Enable Storage in the Firebase console (Build → Storage → Get started).`;
  }
  if (code === "storage/unknown" || code === "storage/bucket-not-found" || code === "storage/project-not-found") {
    return `${what} failed — photo storage isn't reachable. Check that Storage is enabled for this Firebase project.`;
  }
  if (code === "storage/unauthorized" || code === "storage/unauthenticated") {
    return `${what} failed — not allowed. Sign in again; images must be under 5 MB.`;
  }
  if (code === "storage/retry-limit-exceeded" || code === "storage/canceled") {
    return `${what} failed — the connection dropped. Try again.`;
  }
  return e?.message || `${what} failed. Try again.`;
}
