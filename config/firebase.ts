// Single source of truth → services/firebase/firebase.ts
// This file re-exports to avoid breaking any stale imports.
export { auth, db, default } from "@/services/firebase/firebase";