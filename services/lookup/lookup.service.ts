/**
 * lookup.service.ts
 * Lightweight in-memory name resolvers.
 * Cache is per-request; call invalidate() after mutations.
 */

import { collection, getDocs } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";

// ─── Internal caches ─────────────────────────────────────────────────────────

let centerCache: Map<string, { name: string; centerCode: string }> | null = null;
let studentCache: Map<string, { name: string; studentID: string; admissionNo: string | null }> | null = null;

// ─── Center lookup ────────────────────────────────────────────────────────────

export async function loadCenterMap(): Promise<Map<string, { name: string; centerCode: string }>> {
  if (centerCache) return centerCache;
  const snap = await getDocs(collection(db, "centers"));
  centerCache = new Map();
  for (const d of snap.docs) {
    const data = d.data();
    centerCache.set(d.id, {
      name:       data.name       ?? "—",
      centerCode: data.centerCode ?? "—",
    });
  }
  return centerCache;
}

export function getCenterName(id: string): string {
  return centerCache?.get(id)?.name ?? id;
}

export function getCenterCode(id: string): string {
  return centerCache?.get(id)?.centerCode ?? "—";
}

// ─── Student lookup ───────────────────────────────────────────────────────────

export async function loadStudentMap(): Promise<Map<string, { name: string; studentID: string; admissionNo: string | null }>> {
  if (studentCache) return studentCache;
  const snap = await getDocs(collection(db, "users"));
  studentCache = new Map();
  for (const d of snap.docs) {
    const data = d.data();
    if (data.role !== "student") continue;
    studentCache.set(d.id, {
      name:        data.displayName ?? data.name ?? "—",
      studentID:   data.studentID   ?? "—",
      admissionNo: data.admissionNo ?? null,
    });
  }
  return studentCache;
}

export function getStudentName(uid: string): string {
  return studentCache?.get(uid)?.name ?? uid;
}

export function getStudentID(uid: string): string {
  return studentCache?.get(uid)?.studentID ?? "—";
}

// ─── Cache control ────────────────────────────────────────────────────────────

export function invalidateLookupCache() {
  centerCache  = null;
  studentCache = null;
}
