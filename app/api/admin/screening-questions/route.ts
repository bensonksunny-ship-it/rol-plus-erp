import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/services/firebase/firebase-admin";
import { isElevatedAccount } from "@/lib/elevatedAccount";
import { isWing } from "@/lib/wing";
import { SCREENING_QUESTIONS_VERSION, sanitizeFastTrackTests, screeningQuestionsDocId } from "@/lib/screeningQuestions";

// =============================================================================
// Save / reset a wing's Fast Track screening questions.
// Only Founder / Admin / Director / Chief Teacher (isElevatedAccount) may call
// this — teachers conduct screenings with the questions but can't change them.
//
//   POST { wing, tests }        → validate + store config/screening_questions_{wing}
//   POST { wing, reset: true }  → delete it (wing falls back to the defaults)
// =============================================================================

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return NextResponse.json({ error: "Missing auth token." }, { status: 401 });

    const decoded = await adminAuth().verifyIdToken(idToken);
    const callerSnap = await adminDb().doc(`users/${decoded.uid}`).get();
    if (!callerSnap.exists || !isElevatedAccount(callerSnap.data())) {
      return NextResponse.json(
        { error: "Only the Founder, an Admin, Director or Chief Teacher can edit screening questions." },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => null) as { wing?: unknown; tests?: unknown; reset?: unknown } | null;
    if (!body || !isWing(body.wing)) return NextResponse.json({ error: "Unknown wing." }, { status: 400 });

    const ref = adminDb().collection("config").doc(screeningQuestionsDocId(body.wing));
    if (body.reset === true) {
      await ref.delete();
      return NextResponse.json({ success: true });
    }

    const tests = sanitizeFastTrackTests(body.tests);
    await ref.set({ tests, version: SCREENING_QUESTIONS_VERSION, updatedAt: new Date().toISOString(), updatedBy: decoded.uid });
    return NextResponse.json({ success: true, tests });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save screening questions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
