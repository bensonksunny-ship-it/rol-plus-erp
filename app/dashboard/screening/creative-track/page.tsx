"use client";

import { Suspense } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { CreativeTrackContent } from "./CreativeTrackContent";

export default function CreativeTrackPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.TEACHER]}>
      <Suspense fallback={<div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>Loading…</div>}>
        <CreativeTrackContent />
      </Suspense>
    </ProtectedRoute>
  );
}
