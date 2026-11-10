import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { canLeadWing } from "@/lib/elevatedAccount";
import { wingOf } from "@/lib/wing";
import { FOLLOW_UP_STATUS, MOVED_TO_ENQUIRY, TRANSFER_NOTE_MAX, normalizePhone } from "@/lib/enquiry";

// =============================================================================
// Move a stale admission application into the Enquiries pipeline.
//   POST { admissionId, note? } → { enquiryId }
//
// Wing leaders only (ROL+ → Founder / Admin; School of Music → also Director /
// Chief Teacher), same gate as the screening questions. One transaction:
//   • a new enquiry, status "follow_up", linked back by admissionId;
//   • the application keeps every field (form, photo, screening link) and is
//     only flagged status "moved_to_enquiry" so the admissions list hides it.
// /api/admissions/restore-from-enquiry undoes it.
// =============================================================================

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return NextResponse.json({ error: "Missing auth token." }, { status: 401 });
    const decoded = await adminAuth().verifyIdToken(idToken);

    const body = await req.json().catch(() => null) as { admissionId?: unknown; note?: unknown } | null;
    const admissionId = str(body?.admissionId);
    if (!admissionId) return NextResponse.json({ error: "Missing application." }, { status: 400 });
    const note = str(body?.note).slice(0, TRANSFER_NOTE_MAX);

    const db = adminDb();
    const callerSnap = await db.doc(`users/${decoded.uid}`).get();
    const caller = callerSnap.data();
    const admRef = db.collection("admissions").doc(admissionId);
    const enqRef = db.collection("enquiries").doc();
    const now = new Date().toISOString();

    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(admRef);
      if (!snap.exists) return { status: 404, error: "Application not found." };
      const a = snap.data() ?? {};
      const wing = wingOf(a);
      if (!callerSnap.exists || !canLeadWing(caller, wing)) {
        return { status: 403, error: "Only this wing's leadership can move applications to Enquiries." };
      }
      if (a.status === MOVED_TO_ENQUIRY) return { status: 409, error: "This application is already in Enquiries." };
      if (a.status === "enrolled" || str(a.enrolledStudentId)) {
        return { status: 409, error: "An enrolled application can't be moved to Enquiries." };
      }
      const instruments = Array.isArray(a.instrumentsToLearn) ? a.instrumentsToLearn.map(String) : [];
      const movedByName = str(caller?.displayName) || str(caller?.name);

      tx.set(enqRef, {
        parentName:  str(a.parentName),
        studentName: str(a.fullName),
        phone:       normalizePhone(str(a.phone)),
        place:       str(a.address1) || str(a.address2),
        instrument:  instruments[0] ?? "",
        wing,
        source:      "admission",
        status:      FOLLOW_UP_STATUS,
        createdAt:   now,
        // Link back to the archived application — its full record stays there.
        admissionId,
        applicationRef:  str(a.applicationRef),
        applicationDate: str(a.submittedAt),
        // A short summary so the follow-up caller sees context without opening it.
        applicationSummary: {
          age:        str(a.age),
          course:     str(a.course),
          centre:     str(a.centre),
          instruments,
          screened:   !!str(a.screeningId),
          hasPhoto:   !!str(a.photo),
          feePaid:    a.admissionFeePaid === true,
        },
        transferNote: note,
        movedAt:      now,
        movedBy:      decoded.uid,
        movedByName,
      });
      tx.update(admRef, {
        status:                MOVED_TO_ENQUIRY,
        statusBeforeEnquiry:   a.status === undefined ? null : a.status,
        enquiryId:             enqRef.id,
        movedToEnquiryAt:      now,
        movedToEnquiryBy:      decoded.uid,
        movedToEnquiryByName:  movedByName,
        movedToEnquiryNote:    note,
        enquiryHistory:        FieldValue.arrayUnion({ action: "moved", at: now, by: decoded.uid, note }),
        updatedAt:             now,
      });
      return { status: 200, enquiryId: enqRef.id };
    });

    if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ success: true, enquiryId: result.enquiryId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to move the application.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
