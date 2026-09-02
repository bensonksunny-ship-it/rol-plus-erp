import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { ROLES } from "@/config/constants";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing auth token." }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(idToken);

    const callerSnap = await adminDb().doc(`users/${decoded.uid}`).get();
    const callerRole = callerSnap.exists ? (callerSnap.data()?.role as string | undefined) : undefined;
    if (callerRole !== ROLES.SUPER_ADMIN) {
      return NextResponse.json({ error: "Only super admins can change admin passwords." }, { status: 403 });
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
    const targetRole = targetSnap.data()?.role as string | undefined;
    if (targetRole !== ROLES.ADMIN && targetRole !== ROLES.SUPER_ADMIN) {
      return NextResponse.json({ error: "Target user is not an admin." }, { status: 400 });
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
