import { redirect } from "next/navigation";

// Admin accounts are now created and managed on the unified Users page.
export default function AdminsPage() {
  redirect("/dashboard/users");
}
