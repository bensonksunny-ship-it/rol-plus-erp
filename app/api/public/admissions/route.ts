import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/services/firebase/firebase-admin";
import { isWing, wingOf } from "@/lib/wing";

// =============================================================================
// Public (unauthenticated) admission intake — backs the /apply page that
// parents reach by scanning the QR code on the Admissions dashboard.
//
// Writes go through the Admin SDK so Firestore rules stay closed to anonymous
// clients; this route is the only public door and it only ever creates a new
// `admissions` doc with a fixed, whitelisted shape.
//
//   GET  ?wing=<wing>  → active centres of that wing (id + name) for the picker
//   POST {…form}       → creates the application; it shows up in that wing's
//                        Admissions list as a pending application
// =============================================================================

export const dynamic = "force-dynamic";

const MAX_PHOTO_CHARS = 400_000;   // the client compresses to ~320×420 JPEG (≈30–60 KB)
const RATE_WINDOW_MS  = 10 * 60_000;
const RATE_MAX        = 5;          // submissions per IP per window (best-effort, per instance)
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strArr = (v: unknown, allowed: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && allowed.includes(x)) : [];

const INSTRUMENTS  = ["Piano", "Keyboard", "Guitar", "Drums", "Violin", "Vocal"];
const EXPERIENCE   = ["Well-Trained", "Average", "No Previous Experience"];

export async function GET(req: NextRequest) {
  const wing = req.nextUrl.searchParams.get("wing");
  if (!isWing(wing)) return NextResponse.json({ error: "Unknown wing." }, { status: 400 });
  try {
    const snap = await adminDb().collection("centers").where("status", "==", "active").get();
    const centres = snap.docs
      .filter(d => wingOf(d.data()) === wing)
      .map(d => ({ id: d.id, name: String(d.data().name ?? d.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ centres });
  } catch (err) {
    console.error("[public/admissions] GET error:", err);
    return NextResponse.json({ error: "Could not load centres." }, { status: 500 });
  }
}

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

  // Honeypot — a hidden field real parents never see or fill.
  if (str(body.website)) return NextResponse.json({ id: "ok" });

  const wing = body.wing;
  if (!isWing(wing)) return NextResponse.json({ error: "Unknown wing." }, { status: 400 });

  const firstName = str(body.firstName, 80);
  const lastName  = str(body.lastName, 80);
  const phone     = str(body.phone, 30);
  const dob       = str(body.dob, 10);
  if (!firstName || !lastName) return NextResponse.json({ error: "First and last name are required." }, { status: 400 });
  if (phone.replace(/\D/g, "").length < 7) return NextResponse.json({ error: "A valid phone number is required." }, { status: 400 });
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) return NextResponse.json({ error: "Date of birth is required." }, { status: 400 });

  let photo: string | null = null;
  if (typeof body.photo === "string" && body.photo) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.photo) || body.photo.length > MAX_PHOTO_CHARS) {
      return NextResponse.json({ error: "Photo is too large or not an image." }, { status: 400 });
    }
    photo = body.photo;
  }

  const middleName = str(body.middleName, 80);
  try {
    const ref = adminDb().collection("admissions").doc();
    // Same shape the in-app AdmissionFormContent (minimal) saves.
    await ref.set({
      id:                   ref.id,
      wing,
      fullName:             [firstName, middleName, lastName].filter(Boolean).join(" "),
      firstName,
      middleName,
      lastName,
      age:                  str(body.age, 3),
      dob,
      parentName:           str(body.parentName, 120),
      workingStatus:        "",
      schoolCompany:        "",
      phone,
      email:                str(body.email, 120),
      address1:             str(body.address1, 300),
      address2:             "",
      centre:               str(body.centre, 120),
      purposeOfLearning:    "",
      instrumentsToLearn:   strArr(body.instrumentsToLearn, INSTRUMENTS),
      previousExperience:   EXPERIENCE.includes(str(body.previousExperience)) ? str(body.previousExperience) : "",
      instrumentsPlayed:    [],
      musicalSkill:         "",
      howHeardAboutUs:      "",
      initialExperience:    null,
      parentPartnerProgram: "",
      photo,
      submittedBy:          "",
      source:               "public_qr",
      submittedAt:          new Date().toISOString(),
    });
    return NextResponse.json({ id: ref.id });
  } catch (err) {
    console.error("[public/admissions] POST error:", err);
    return NextResponse.json({ error: "Could not submit the application. Please try again." }, { status: 500 });
  }
}
