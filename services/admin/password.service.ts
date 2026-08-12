import { auth } from "@/services/firebase/firebase";

export interface ChangePasswordResult {
  success: boolean;
  error?:  string;
}

/**
 * Directly sets a new password for another admin's Firebase Auth account.
 * Requires the caller to be signed in as a super admin — enforced server-side
 * in /api/admin/change-password (Admin SDK; client SDK can't set another
 * user's password).
 */
export async function changeAdminPassword(
  targetUid:   string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) return { success: false, error: "Not authenticated." };

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/api/admin/change-password", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body:    JSON.stringify({ targetUid, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, error: data.error ?? "Failed to change password." };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
