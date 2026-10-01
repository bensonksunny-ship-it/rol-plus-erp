import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { canLeadWing } from "@/lib/elevatedAccount";
import { isWing } from "@/lib/wing";
import { sanitizeSchoolInfo, schoolInfoDocId } from "@/lib/schoolInfo";

// =============================================================================
// Save a wing's School Info (shown to parents after a public enquiry).
// Same gate as the screening questions: wing leaders only.
//   POST { wing, info } → validate + store config/school_info_{wing}
// =============================================================================

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return NextResponse.json({ error: "Missing auth token." }, { status: 401 });

    const decoded = await adminAuth().verifyIdToken(idToken);
    const body = await req.json().catch(() => null) as { wing?: unknown; info?: unknown } | null;
    if (!body || !isWing(body.wing)) return NextResponse.json({ error: "Unknown wing." }, { status: 400 });

    const callerSnap = await adminDb().doc(`users/${decoded.uid}`).get();
    if (!callerSnap.exists || !canLeadWing(callerSnap.data(), body.wing)) {
      return NextResponse.json({ error: "Only this wing's leadership can edit School Info." }, { status: 403 });
    }

    const info = sanitizeSchoolInfo(body.info);
    await adminDb().collection("config").doc(schoolInfoDocId(body.wing))
      .set({ ...info, updatedAt: new Date().toISOString(), updatedBy: decoded.uid });
    return NextResponse.json({ success: true, info });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save School Info.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
