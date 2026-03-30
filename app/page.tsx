"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { ROLE_ROUTES } from "@/config/constants";

export default function RootPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    // Hard navigation so the middleware edge runtime sees the cookie
    // on the very first request, preventing a redirect loop.
    if (!user) {
      window.location.href = "/login";
      return;
    }
    window.location.href = ROLE_ROUTES[user.role] ?? "/dashboard";
  }, [user, loading]);

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--color-text-secondary)",
      fontSize: 13,
    }}>
      Welcome to ROL Plus ERP!!!
    </div>
  );
}