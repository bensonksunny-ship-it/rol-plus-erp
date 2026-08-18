// This route's implementation lives in ./_shared.tsx (a plain module, not a
// Next.js special file) because StudentSyllabusContent is also embedded as the
// "Syllabus" tab on the student detail page at ../../students/[id]/page.tsx —
// and Next.js's page.tsx export contract only permits `default` (plus a few
// route-config exports).
export { default } from "./_shared";
