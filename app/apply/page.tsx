import type { Metadata } from "next";
import { WINGS, WING_LABELS } from "@/config/constants";
import { isWing } from "@/lib/wing";
import PublicAdmissionForm from "./PublicAdmissionForm";

// Public admission form — parents reach it by scanning the QR code shown on
// /dashboard/admissions. No login; submissions go through /api/public/admissions.

export const metadata: Metadata = {
  title: "Online Admission Form",
  robots: { index: false, follow: false },
};

export default function ApplyPage({ searchParams }: { searchParams: { wing?: string } }) {
  const wing = isWing(searchParams.wing) ? searchParams.wing : WINGS.SCHOOL_OF_MUSIC;
  return <PublicAdmissionForm wing={wing} wingLabel={WING_LABELS[wing]} />;
}
