"use client";

// Route-level error boundary for every /dashboard page. It renders inside the
// dashboard layout, so a crashing page shows an inline error panel while the
// sidebar / navigation keep working (instead of the root boundary replacing
// the whole app). Navigating to another page clears it.

import { useEffect, useState } from "react";
import ErrorPanel from "@/components/ErrorPanel";
import { captureError, isChunkLoadError, reloadOnceForChunkError, type CapturedError } from "@/lib/errorReporting";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [captured, setCaptured] = useState<CapturedError | null>(null);

  useEffect(() => {
    // Stale build after a deploy — one hard reload fetches the new chunks.
    if (isChunkLoadError(error) && reloadOnceForChunkError()) return;
    setCaptured(captureError(error, "dashboard/error"));
  }, [error]);

  return <ErrorPanel error={captured} onRetry={reset} />;
}
