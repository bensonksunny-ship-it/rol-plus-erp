import { redirect } from "next/navigation";

// Teacher centre assignment, performance stats, and profiles now live on the
// Enrollments page's Teachers tab.
export default function TeachersPage() {
  redirect("/dashboard/enrollments?view=teachers");
}
