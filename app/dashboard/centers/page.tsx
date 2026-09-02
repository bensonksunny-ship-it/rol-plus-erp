// Legacy route — Centers is now a tab on the unified Enrollments page.
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CentersRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/dashboard/enrollments?view=centers"); }, [router]);
  return <div style={{ height: "100dvh", background: "var(--color-bg)" }} />;
}
