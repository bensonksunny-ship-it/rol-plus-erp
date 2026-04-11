"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { ROLE_ROUTES } from "@/config/constants";

export default function RootPage() {
  const { user, loading } = useAuth();
  const redirectedRef     = useRef(false);

  useEffect(() => {
    if (loading) return;
    if (redirectedRef.current) return;
    redirectedRef.current = true;

    // Check localStorage as backup if auth context doesn't have user yet
    // (especially on mobile where cookies may not persist)
    const hasSession = typeof window !== "undefined" && Boolean(localStorage.getItem("rol_session"));
    const expires = typeof window !== "undefined" ? Number(localStorage.getItem("rol_session_expires") || 0) : 0;
    const isExpired = expires < Date.now();

    if (hasSession && !isExpired && !user) {
      // Session exists in localStorage — user is authenticated, just waiting for auth context
      // The AuthContext will resolve shortly, no need to redirect yet
      return;
    }

    // Use window.location.replace so the root "/" is not added to history,
    // and the middleware edge runtime sees the cookie on the very first request.
    if (!user) {
      window.location.replace("/login");
      return;
    }
    window.location.replace(ROLE_ROUTES[user.role] ?? "/dashboard");
  }, [user, loading]);

  // Show a blank screen while auth resolves — no flash of content.
  return <div style={{ height: "100vh", background: "var(--color-bg)" }} />;
}