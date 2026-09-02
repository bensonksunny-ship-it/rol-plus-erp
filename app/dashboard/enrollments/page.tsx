"use client";

// Unified Enrollments view — merges the former Centers and Students pages into
// one screen with a top tab switcher. The two halves still live in their own
// modules (../centers/_shared, ../students/_shared); this file only hosts them.

import { Suspense, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import CentersPage from "../centers/_shared";
import StudentsPage from "../students/_shared";

type View = "centers" | "students";

export default function EnrollmentsPage() {
  return (
    <ProtectedRoute
      allowedRoles={[ROLES.FOUNDER, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CHIEF_TEACHER, ROLES.TEACHER]}
    >
      <Suspense fallback={<div style={{ height: "60vh" }} />}>
        <Enrollments />
      </Suspense>
    </ProtectedRoute>
  );
}

function Enrollments() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const tabs = useMemo(() => {
    const list: { key: View; label: string; icon: string }[] = [];
    if (can(CAPABILITIES.CENTRES_MANAGE) || can(CAPABILITIES.CENTRES_EDIT_SCHEDULE)) {
      list.push({ key: "centers", label: "Centers", icon: "🏫" });
    }
    if (can(CAPABILITIES.STUDENTS_MANAGE) || can(CAPABILITIES.STUDENTS_VIEW_ALL)) {
      list.push({ key: "students", label: "Students", icon: "🎓" });
    }
    return list;
  }, [can]);

  const requested = params.get("view") as View | null;
  const view: View =
    requested && tabs.some(t => t.key === requested) ? requested : (tabs[0]?.key ?? "students");

  function setView(v: View) {
    const q = new URLSearchParams(Array.from(params.entries()));
    q.set("view", v);
    router.replace(`${pathname}?${q.toString()}`);
  }

  if (tabs.length === 0) {
    return <div style={s.empty}>You don&apos;t have access to Enrollments.</div>;
  }

  return (
    <div>
      <div style={s.tabs}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            style={{ ...s.tab, ...(t.key === view ? s.tabActive : {}) }}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Each half keeps its own header, data loading and "+ Add …" action. */}
      {view === "centers" ? <CentersPage /> : <StudentsPage />}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  tabs: { display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" },
  tab: {
    display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10,
    border: "1px solid var(--color-border)", background: "var(--color-surface-2)",
    color: "var(--color-text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
  tabActive: { background: "#ede9fe", borderColor: "#4f46e5", color: "#4338ca" },
  empty: { textAlign: "center", padding: "60px 24px", color: "var(--color-text-secondary)", fontSize: 14 },
};
