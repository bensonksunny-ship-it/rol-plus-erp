import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/services/firebase/firebase-admin";
import { isWing } from "@/lib/wing";
import { ENQUIRY_INSTRUMENTS, isValidPhone, normalizePhone } from "@/lib/enquiry";
import { checkDuplicatesServer } from "@/services/dedup/dedup.server";

// =============================================================================
// Public (unauthenticated) quick enquiry — backs the /enquiry page parents
// reach by scanning the QR code on the Admissions dashboard's Enquiries tab.
// Same pattern as /api/public/admissions: Admin SDK write, whitelisted shape,
// honeypot + best-effort per-IP rate limit.
// =============================================================================

export const dynamic = "force-dynamic";

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX       = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many submissions. Please try again later." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (str(body.website)) return NextResponse.json({ id: "ok" });   // honeypot

  const wing = body.wing;
  if (!isWing(wing)) return NextResponse.json({ error: "Unknown wing." }, { status: 400 });

  const parentName  = str(body.parentName);
  const studentName = str(body.studentName);
  const place       = str(body.place, 200);
  const phone       = str(body.phone, 30);
  if (!parentName || !studentName || !place) {
    return NextResponse.json({ error: "Please fill in all the required fields." }, { status: 400 });
  }
  if (!isValidPhone(phone)) return NextResponse.json({ error: "Enter a valid 10-digit mobile number." }, { status: 400 });
  const instrument = ENQUIRY_INSTRUMENTS.includes(str(body.instrument)) ? str(body.instrument) : "";

  try {
    // Duplicate guard — generic message only (public caller); sibling / parent
    // matches on the same phone are accepted and flagged for staff.
    const matches = await checkDuplicatesServer({ name: studentName, phone }, { enquiries: true });
    if (matches.some(m => m.level === "same")) {
      return NextResponse.json({
        error: "We already have an enquiry for this student — our team will call you back soon.",
      }, { status: 409 });
    }
    const ref = adminDb().collection("enquiries").doc();
    await ref.set({
      parentName, studentName, place, instrument, wing,
      phone:     normalizePhone(phone),
      status:    "new",
      source:    "qr",
      createdAt: new Date().toISOString(),
      ...(matches.length ? { possibleDuplicateOf: matches.map(m => m.candidate.id) } : {}),
    });
    return NextResponse.json({ id: ref.id });
  } catch (err) {
    console.error("[public/enquiries] POST error:", err);
    return NextResponse.json({ error: "Could not send the enquiry. Please try again." }, { status: 500 });
  }
}
