import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { LEGACY_SUPER_ADMIN_ROLE, ROLES } from "@/config/constants";

const FOUNDER_ROLE_NAMES = new Set([ROLES.FOUNDER, LEGACY_SUPER_ADMIN_ROLE].map(r => r.toLowerCase()));
const isFounderRole = (r: unknown) => typeof r === "string" && FOUNDER_ROLE_NAMES.has(r.trim().toLowerCase());

/**
 * Founder check on the caller's user doc — mirrors the client's reading of it:
 * the legacy "super_admin" value counts as founder (the client auth shim maps
 * it the same way for docs the backfill hasn't migrated yet), role strings are
 * compared case-insensitively, and a founder grant in the per-wing `roles` map
 * counts too.
 */
function isFounder(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (isFounderRole(data.role)) return true;
  const roles = data.roles;
  if (roles && typeof roles === "object") {
    return Object.values(roles as Record<string, unknown>).some(v =>
      Array.isArray(v) ? v.some(isFounderRole) : isFounderRole(v));
  }
  return false;
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing auth token." }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(idToken);

    const callerSnap = await adminDb().doc(`users/${decoded.uid}`).get();
    if (!callerSnap.exists || !isFounder(callerSnap.data())) {
      return NextResponse.json({ error: "Only the Founder can reset a login's password." }, { status: 403 });
    }

    const body = await req.json().catch(() => null) as { targetUid?: string; newPassword?: string } | null;
    const targetUid   = body?.targetUid;
    const newPassword = body?.newPassword;

    if (!targetUid || !newPassword) {
      return NextResponse.json({ error: "targetUid and newPassword are required." }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    const targetSnap = await adminDb().doc(`users/${targetUid}`).get();
    if (!targetSnap.exists) {
      return NextResponse.json({ error: "Target user not found." }, { status: 404 });
    }
    if (!targetSnap.data()?.hasLogin) {
      return NextResponse.json({ error: "This account has no login to reset." }, { status: 400 });
    }

    await adminAuth().updateUser(targetUid, { password: newPassword });

    // Keep the Founder Users page in sync with the live credential.
    await adminDb().doc(`users/${targetUid}`).set(
      { plainPassword: newPassword, updatedAt: new Date().toISOString() },
      { merge: true },
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to change password.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
