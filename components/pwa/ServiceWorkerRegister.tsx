"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js in production only.
 * Broadcasts SKIP_WAITING to activate a waiting SW immediately,
 * then reloads once so users get the new version without a manual refresh.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      process.env.NODE_ENV !== "production"
    ) {
      return;
    }

    let refreshing = false;

    // When a new SW takes control, do ONE hard reload to pick up fresh assets.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        console.log("[SW] registered, scope:", reg.scope);

        // If there's a waiting worker already, activate it now.
        if (reg.waiting) {
          reg.waiting.postMessage("SKIP_WAITING");
        }

        // Watch for future updates
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener("statechange", () => {
            if (
              newWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // New SW is ready — activate it
              newWorker.postMessage("SKIP_WAITING");
            }
          });
        });
      })
      .catch((err) => {
        console.warn("[SW] registration failed:", err);
      });
  }, []);

  return null;
}
