// Legacy route — Students is now a tab on the unified Enrollments page.
// The implementation still lives in ./_shared.tsx (imported by the Enrollments
// page and by the student detail page ./[id]/page.tsx).
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function StudentsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/dashboard/enrollments?view=students"); }, [router]);
  return <div style={{ height: "100dvh", background: "var(--color-bg)" }} />;
}
