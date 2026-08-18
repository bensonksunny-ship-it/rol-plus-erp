// This route's implementation lives in ./_shared.tsx (a plain module, not a
// Next.js special file) because the page also needs to export shared
// components/styles (StudentRow, LedgerEditor, EditModal, etc.) for reuse by
// the student detail page at ./[id]/page.tsx — and Next.js's page.tsx export
// contract only permits `default` (plus a few route-config exports).
export { default } from "./_shared";
