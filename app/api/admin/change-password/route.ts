import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { LEGACY_SUPER_ADMIN_ROLE, ROLES } from "@/config/constants";
import { isElevatedAccount } from "@/lib/elevatedAccount";

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

/** Chief Teacher in any wing — home role or the per-wing `roles` map. */
function isChiefTeacher(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const is = (r: unknown) => typeof r === "string" && r.trim().toLowerCase() === ROLES.CHIEF_TEACHER;
  if (is(data.role)) return true;
  const roles = data.roles;
  return !!roles && typeof roles === "object" && Object.values(roles as Record<string, unknown>).some(v =>
    Array.isArray(v) ? v.some(is) : is(v));
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
    const callerData = callerSnap.exists ? callerSnap.data() : undefined;
    const callerIsFounder = isFounder(callerData);
    if (!callerIsFounder && !isChiefTeacher(callerData)) {
      return NextResponse.json({ error: "Only the Founder or a Chief Teacher can reset a login's password." }, { status: 403 });
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
    // Chief Teachers may only manage lower-level accounts (teachers, staff,
    // parents, members, students) — never Founder/Admin/Director/Chief Teacher.
    // Same 404 as a missing user so hidden accounts can't be probed.
    if (!callerIsFounder && isElevatedAccount(targetSnap.data())) {
      return NextResponse.json({ error: "Target user not found." }, { status: 404 });
    }
    // Firebase Auth is the source of truth for "has a login", not the doc's
    // `hasLogin` flag — records predating that field (most older staff/teacher
    // accounts) lack it but do have a real Auth account at the same uid.
    try {
      await adminAuth().getUser(targetUid);
    } catch (e) {
      if ((e as { code?: string })?.code === "auth/user-not-found") {
        return NextResponse.json(
          { error: "This account has no login yet — use \"Create login\" on the Users page instead." },
          { status: 400 },
        );
      }
      throw e;
    }

    await adminAuth().updateUser(targetUid, { password: newPassword });

    // Keep the Founder Users page in sync with the live credential, and
    // backfill `hasLogin` for legacy docs that never had it set.
    await adminDb().doc(`users/${targetUid}`).set(
      { plainPassword: newPassword, hasLogin: true, updatedAt: new Date().toISOString() },
      { merge: true },
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to change password.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
