import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/services/firebase/firebase";
import {
  DEFAULT_FAST_TRACK_TESTS, SCREENING_QUESTIONS_VERSION, sanitizeFastTrackTests, screeningQuestionsDocId,
  type FastTrackTest,
} from "@/lib/screeningQuestions";

export interface FastTrackTestsDoc {
  tests: FastTrackTest[];
  /** false → nothing saved for this wing yet; `tests` are the defaults. */
  customised: boolean;
  updatedAt?: string;
}

/** A wing's Fast Track questions — the saved set, or the defaults. */
export async function getFastTrackTests(wing: string): Promise<FastTrackTestsDoc> {
  const snap = await getDoc(doc(db, "config", screeningQuestionsDocId(wing)));
  const data = snap.exists() ? snap.data() : null;
  // Missing, or saved for an older set of sections → current defaults.
  if (!data || data.version !== SCREENING_QUESTIONS_VERSION) return { tests: DEFAULT_FAST_TRACK_TESTS, customised: false };
  return {
    tests: sanitizeFastTrackTests(data.tests),
    customised: true,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
  };
}

async function post(body: Record<string, unknown>): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  const res = await fetch("/api/admin/screening-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Failed to save screening questions.");
}

/** Save a wing's questions (server-checked: leadership roles only). */
export function saveFastTrackTests(wing: string, tests: FastTrackTest[]): Promise<void> {
  return post({ wing, tests });
}

/** Drop a wing's saved questions so it uses the defaults again. */
export function resetFastTrackTests(wing: string): Promise<void> {
  return post({ wing, reset: true });
}
