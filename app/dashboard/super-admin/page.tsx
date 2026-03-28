"use client";

import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";

export default function SuperAdminPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN]}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Super Admin
      </h1>
      <p style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
        Deactivation approvals and system-wide controls will live here.
      </p>
    </ProtectedRoute>
  );
}