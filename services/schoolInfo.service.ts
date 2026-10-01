// School Info (post-enquiry "about us") — load through the public route, save
// through the leaders-only admin route. Shape + defaults in lib/schoolInfo.ts.

import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { auth, storage } from "@/services/firebase/firebase";
import { storageErrorMessage } from "@/lib/storageError";
import { DEFAULT_SCHOOL_INFO, sanitizeSchoolInfo, type SchoolInfo, type SchoolPhoto } from "@/lib/schoolInfo";

export async function loadSchoolInfo(wing: string): Promise<SchoolInfo> {
  const res = await fetch(`/api/public/school-info?wing=${encodeURIComponent(wing)}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return res.ok ? sanitizeSchoolInfo(data.info) : DEFAULT_SCHOOL_INFO;
}

export async function saveSchoolInfo(wing: string, info: SchoolInfo): Promise<SchoolInfo> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  const res = await fetch("/api/admin/school-info", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify({ wing, info }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Failed to save School Info.");
  return sanitizeSchoolInfo(data.info);
}

// ─── Gallery photos (Firebase Storage: school-info/{wing}/{id}.jpg) ──────────

export const SCHOOL_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Shrink to ≤1600px on the long side as JPEG — quick to load on a parent's phone. */
function shrinkImage(file: File, max = 1600, quality = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * r); canvas.height = Math.round(img.height * r);
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(src); reject(new Error("Can't read this image.")); return; }
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);   // PNG transparency → white
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(src);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Can't read this image."))), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error(`${file.name} isn't a readable image.`)); };
    img.src = src;
  });
}

export async function uploadSchoolPhoto(wing: string, file: File): Promise<SchoolPhoto> {
  if (!SCHOOL_PHOTO_TYPES.includes(file.type)) throw new Error(`${file.name}: use a PNG, JPEG or WebP image.`);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const path = `school-info/${wing}/${id}.jpg`;
  const r = ref(storage, path);
  const blob = await shrinkImage(file);
  try {
    await uploadBytes(r, blob, { contentType: "image/jpeg", cacheControl: "public, max-age=31536000" });
    return { id, path, url: await getDownloadURL(r), caption: "" };
  } catch (err) {
    console.error("[schoolInfo] photo upload:", err);
    throw new Error(storageErrorMessage(err, "Photo upload"));
  }
}

/** Best-effort: a missing file is fine. */
export async function deleteSchoolPhoto(path: string): Promise<void> {
  if (!path.startsWith("school-info/")) return;
  await deleteObject(ref(storage, path)).catch(() => {});
}
