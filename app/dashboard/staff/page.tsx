"use client";

// The Staff page has been retired — its functionality was fully absorbed
// elsewhere: leadership/director/admin/general staff accounts and roles are
// managed on the Users page (/dashboard/users, including "Manage roles" and
// linked-children for parent accounts), and teaching staff live on
// Enrollments → Teachers (/dashboard/enrollments?view=teachers). This route
// just forwards any lingering links/bookmarks.
//
// The Users page's ProtectedRoute is hardcoded to Founder only (it shows
// stored plaintext credentials) — even though Chief Teacher separately holds
// the USERS_MANAGE capability in config/permissions.ts, so checking the
// capability alone isn't a reliable stand-in for "can reach that route".
// Staff was also open to Admin/Director/Chief Teacher, so route by the exact
// same role check /dashboard/users itself uses, not a single fixed target.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { ROLES } from "@/config/constants";

export default function StaffPage() {
  const router = useRouter();
  const { loading, role } = useAuth();

  useEffect(() => {
    if (loading) return;
    router.replace(role === ROLES.FOUNDER ? "/dashboard/users" : "/dashboard/enrollments?view=teachers");
  }, [loading, role, router]);

  return null;
}
