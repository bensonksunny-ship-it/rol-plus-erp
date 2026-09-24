// =============================================================================
// Enquiries — lightweight prospect leads captured before a full admission.
//
// Written by staff from /dashboard/admissions and by parents from the public
// /enquiry page (reached via the QR code). "Convert to admission" hands the
// lead to the full admission form; the enquiry is then marked converted.
// =============================================================================

import { collection, addDoc, doc, updateDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { normalizePhone } from "@/lib/enquiry";

export type EnquiryStatus = "new" | "contacted" | "converted";
export type EnquirySource = "staff" | "qr";

export interface Enquiry {
  id: string;
  parentName: string;
  studentName: string;
  /** 10-digit Indian mobile number, digits only. */
  phone: string;
  place: string;
  /** Preferred instrument, "" when not given. */
  instrument: string;
  wing: string;
  status: EnquiryStatus;
  source: EnquirySource;
  createdAt: string;
  contactedAt?: string;
  convertedAt?: string;
  admissionId?: string;
}

export type NewEnquiry = Pick<Enquiry, "parentName" | "studentName" | "phone" | "place" | "instrument" | "wing" | "source">;

export async function createEnquiry(data: NewEnquiry): Promise<string> {
  const ref = await addDoc(collection(db, "enquiries"), {
    parentName:  data.parentName.trim(),
    studentName: data.studentName.trim(),
    phone:       normalizePhone(data.phone),
    place:       data.place.trim(),
    instrument:  data.instrument,
    wing:        data.wing,
    source:      data.source,
    status:      "new",
    createdAt:   new Date().toISOString(),
  });
  return ref.id;
}

export async function getEnquiries(wing: string): Promise<Enquiry[]> {
  const snap = await getDocs(query(collection(db, "enquiries"), where("wing", "==", wing)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }) as Enquiry)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export async function markEnquiryContacted(id: string): Promise<void> {
  await updateDoc(doc(db, "enquiries", id), { status: "contacted", contactedAt: new Date().toISOString() });
}

export async function markEnquiryConverted(id: string, admissionId: string): Promise<void> {
  await updateDoc(doc(db, "enquiries", id), {
    status: "converted", admissionId, convertedAt: new Date().toISOString(),
  });
}
