import { useState, useEffect } from "react";

// Use matchMedia instead of window.innerWidth + resize listener.
// On mobile, the "resize" event fires whenever the soft keyboard opens
// (the visible viewport shrinks). This causes state updates that re-render
// the entire layout on every keypress — triggering auth re-checks and
// visible flickers. matchMedia only fires when the breakpoint is crossed,
// never on keyboard open/close.
const QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    // Initialise synchronously on client to avoid a SSR→client flash.
    if (typeof window === "undefined") return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mql     = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);

    // Use addEventListener if available (modern), fall back to addListener.
    if (mql.addEventListener) {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    } else {
      // Safari < 14 fallback
      mql.addListener(handler);
      return () => mql.removeListener(handler);
    }
  }, []);

  return isMobile;
}
