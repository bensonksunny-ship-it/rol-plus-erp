"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { ROLE_ROUTES } from "@/config/constants";

export default function RootPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const redirectedRef     = useRef(false);

  useEffect(() => {
    if (loading) return;
    if (redirectedRef.current) return;

    // Check localStorage as backup if auth context doesn't have user yet
    // (especially on mobile where cookies may not persist)
    let hasSession = false;
    let expires = 0;
    try {
      hasSession = typeof window !== "undefined" && Boolean(localStorage.getItem("rol_session"));
      expires = typeof window !== "undefined" ? Number(localStorage.getItem("rol_session_expires") || 0) : 0;
    } catch {
      // localStorage can throw in hardened/private browsing modes.
      hasSession = false;
      expires = 0;
    }
    const isExpired = expires < Date.now();

    if (hasSession && !isExpired && !user) {
      // Session token exists in localStorage — Firebase is still resolving the
      // user from IndexedDB. Keep the blank screen and wait for the next render
      // when auth context emits the real user. Do NOT set redirectedRef here,
      // otherwise the redirect below will never fire on the next render.
      return;
    }

    // From this point we are committed to navigating — set the guard.
    redirectedRef.current = true;

    // Client-side navigation avoids hard refresh loops on constrained devices.
    if (!user) {
      router.replace("/login");
      return;
    }
    router.replace(ROLE_ROUTES[user.role] ?? "/dashboard");
  }, [user, loading, router]);

  // Show a blank screen while auth resolves — no flash of content.
  return <div style={{ height: "100vh", background: "var(--color-bg)" }} />;
}