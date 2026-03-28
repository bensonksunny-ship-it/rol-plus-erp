// Canonical Center type lives in @/types (types/index.ts).
// This file only exports utility input types derived from it.
import type { Center } from "@/types";

export type { Center };
export type CreateCenterInput = Omit<Center, "id" | "createdAt" | "updatedAt">;
export type UpdateCenterInput = Partial<Omit<Center, "id" | "createdAt">>;
