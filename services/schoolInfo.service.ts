// School Info (post-enquiry "about us") — load through the public route, save
// through the leaders-only admin route. Shape + defaults in lib/schoolInfo.ts.

import { auth } from "@/services/firebase/firebase";
import { DEFAULT_SCHOOL_INFO, sanitizeSchoolInfo, type SchoolInfo } from "@/lib/schoolInfo";

export async function loadSchoolInfo(wing: string): Promise<SchoolInfo> {
  const res = await fetch(`/api/public/school-info?wing=${encodeURIComponent(wing)}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return res.ok ? sanitizeSchoolInfo(data.info) : DEFAULT_SCHOOL_INFO;
}

export async function saveSchoolInfo(wing: string, info: SchoolInfo): Promise<SchoolInfo> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  const res = await fetch("/api/admin/school-info", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify({ wing, info }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Failed to save School Info.");
  return sanitizeSchoolInfo(data.info);
}
