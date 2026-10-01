// =============================================================================
// School info — the "about us" shown to parents right after they send a public
// enquiry (/enquiry). One doc per wing: config/school_info_{wing}. Wing leaders
// edit it from Admissions (ℹ School Info); the public page reads it through
// /api/public/school-info. Blank sections are hidden — never placeholder fees.
// =============================================================================

export interface SchoolLeader { role: string; name: string; bio: string }
export interface SchoolCourse { level: string; tagline: string; detail: string }
/** A gallery photo in Firebase Storage (school-info/{wing}/{id}.jpg). */
export interface SchoolPhoto { id: string; url: string; path: string; caption: string }

export interface SchoolInfo {
  established:    string;   // e.g. "2005"
  background:     string;
  photos:         SchoolPhoto[];
  leaders:        SchoolLeader[];
  courses:        SchoolCourse[];
  instruments:    string[];
  classFrequency: string;   // free text, one option per line
  tuitionFee:     string;   // free text, e.g. "₹2,500 per month"
  admissionFee:   string;   // free text, e.g. "₹1,000 one-time"
  kit:            string[];
  phone:          string;   // "+91 99218 74088"
}

export const MAX_SCHOOL_PHOTOS = 24;
const STORAGE_URL_PREFIX = "https://firebasestorage.googleapis.com/v0/b/rol-plus-erp.firebasestorage.app/";

export const schoolInfoDocId = (wing: string) => `school_info_${wing}`;

/** Starting point: only what the brief gave — course tiers, instruments, phone. */
export const DEFAULT_SCHOOL_INFO: SchoolInfo = {
  established: "",
  background: "",
  photos: [],
  leaders: [
    { role: "Founder", name: "", bio: "" },
    { role: "Director", name: "", bio: "" },
  ],
  courses: [
    { level: "Introduction", tagline: "Foundation", detail: "" },
    { level: "Intermediate", tagline: "Skill Development", detail: "" },
    { level: "Advanced", tagline: "Mastery", detail: "" },
  ],
  instruments: ["Keyboard", "Piano", "Guitar", "Drums", "Violin", "Vocal"],
  classFrequency: "",
  tuitionFee: "",
  admissionFee: "",
  kit: [],
  phone: "+91 99218 74088",
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = <T,>(v: unknown, max: number, map: (x: unknown) => T | null): T[] =>
  (Array.isArray(v) ? v : []).map(map).filter((x): x is T => x !== null).slice(0, max);

/** Clean untrusted input (API body or stored doc) into a SchoolInfo. */
export function sanitizeSchoolInfo(raw: unknown): SchoolInfo {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    established: text(r.established, 40),
    background:  text(r.background, 1500),
    // Only images in this project's Storage bucket — never arbitrary links.
    photos: list(r.photos, MAX_SCHOOL_PHOTOS, x => {
      const o = (x ?? {}) as Record<string, unknown>;
      const url = text(o.url, 1000), path = text(o.path, 200);
      if (!url.startsWith(STORAGE_URL_PREFIX) || !path.startsWith("school-info/")) return null;
      return { id: text(o.id, 40) || path, url, path, caption: text(o.caption, 80) };
    }),
    leaders: list(r.leaders, 6, x => {
      const o = (x ?? {}) as Record<string, unknown>;
      const l = { role: text(o.role, 40), name: text(o.name, 80), bio: text(o.bio, 600) };
      return l.role || l.name || l.bio ? l : null;
    }),
    courses: list(r.courses, 8, x => {
      const o = (x ?? {}) as Record<string, unknown>;
      const c = { level: text(o.level, 40), tagline: text(o.tagline, 60), detail: text(o.detail, 600) };
      return c.level ? c : null;
    }),
    instruments:    list(r.instruments, 20, x => text(x, 40) || null),
    classFrequency: text(r.classFrequency, 800),
    tuitionFee:     text(r.tuitionFee, 800),
    admissionFee:   text(r.admissionFee, 400),
    kit:            list(r.kit, 20, x => text(x, 120) || null),
    phone:          text(r.phone, 24),
  };
}

/** tel: link for a display number ("+91 99218 74088" → "tel:+919921874088"). */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;
