"use client";

import { Suspense } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { DrumScreeningContent } from "./DrumScreeningContent";

export default function DrumScreeningPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <DrumScreeningContent />
      </Suspense>
    </ProtectedRoute>
  );
}
