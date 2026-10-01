import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/services/firebase/firebase-admin";
import { isWing } from "@/lib/wing";
import { DEFAULT_SCHOOL_INFO, sanitizeSchoolInfo, schoolInfoDocId } from "@/lib/schoolInfo";

// Public (no login): a wing's School Info for the post-enquiry screen.
//   GET ?wing=school_of_music → SchoolInfo (defaults when not set up yet)

export async function GET(req: NextRequest) {
  const wing = req.nextUrl.searchParams.get("wing");
  if (!isWing(wing)) return NextResponse.json({ error: "Unknown wing." }, { status: 400 });
  try {
    const snap = await adminDb().collection("config").doc(schoolInfoDocId(wing)).get();
    const info = snap.exists ? sanitizeSchoolInfo(snap.data()) : DEFAULT_SCHOOL_INFO;
    return NextResponse.json({ info }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch {
    return NextResponse.json({ info: DEFAULT_SCHOOL_INFO });
  }
}
