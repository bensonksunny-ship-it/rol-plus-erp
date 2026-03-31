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