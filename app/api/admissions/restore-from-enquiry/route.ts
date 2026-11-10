import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { canLeadWing } from "@/lib/elevatedAccount";
import { wingOf } from "@/lib/wing";
import { MOVED_TO_ENQUIRY } from "@/lib/enquiry";

// =============================================================================
// Bring an application moved to Enquiries back into the admissions pipeline.
//   POST { enquiryId } → { admissionId }
//
// Same gate as /api/admissions/move-to-enquiry. The application's own fields
// were never touched, so it returns with its form answers, photo, screening
// link and fee record exactly as they were. The enquiry is closed as converted.
// =============================================================================

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return NextResponse.json({ error: "Missing auth token." }, { status: 401 });
    const decoded = await adminAuth().verifyIdToken(idToken);

    const body = await req.json().catch(() => null) as { enquiryId?: unknown } | null;
    const enquiryId = str(body?.enquiryId);
    if (!enquiryId) return NextResponse.json({ error: "Missing enquiry." }, { status: 400 });

    const db = adminDb();
    const callerSnap = await db.doc(`users/${decoded.uid}`).get();
    const enqRef = db.collection("enquiries").doc(enquiryId);
    const now = new Date().toISOString();

    const result = await db.runTransaction(async tx => {
      const enqSnap = await tx.get(enqRef);
      if (!enqSnap.exists) return { status: 404, error: "Enquiry not found." };
      const e = enqSnap.data() ?? {};
      const admissionId = str(e.admissionId);
      if (!admissionId || e.source !== "admission") {
        return { status: 409, error: "This enquiry has no archived application to restore." };
      }
      const admRef = db.collection("admissions").doc(admissionId);
      const admSnap = await tx.get(admRef);
      if (!admSnap.exists) return { status: 404, error: "The archived application no longer exists." };
      const a = admSnap.data() ?? {};
      if (!callerSnap.exists || !canLeadWing(callerSnap.data(), wingOf(a))) {
        return { status: 403, error: "Only this wing's leadership can restore applications." };
      }
      if (a.status !== MOVED_TO_ENQUIRY) return { status: 409, error: "This application is already back in Admissions." };

      const prev = a.statusBeforeEnquiry;
      tx.update(admRef, {
        status:               typeof prev === "string" && prev ? prev : FieldValue.delete(),
        statusBeforeEnquiry:  FieldValue.delete(),
        restoredFromEnquiryAt: now,
        restoredFromEnquiryBy: decoded.uid,
        enquiryHistory:       FieldValue.arrayUnion({ action: "restored", at: now, by: decoded.uid }),
        updatedAt:            now,
      });
      tx.update(enqRef, { status: "converted", convertedAt: now, restoredAt: now, restoredBy: decoded.uid });
      return { status: 200, admissionId };
    });

    if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ success: true, admissionId: result.admissionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to restore the application.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
