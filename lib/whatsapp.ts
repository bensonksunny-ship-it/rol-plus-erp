// WhatsApp click-to-chat: opens WhatsApp (app or web) with a pre-written
// message to a number. Nothing is sent until the user presses Send there.

/** "+91 98765 43210" / "098765 43210" / "9876543210" → "919876543210"; "" if unusable. */
export function waNumber(phone: string | null | undefined): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;          // Indian mobile without country code
  return d.length >= 11 && d.length <= 15 ? d : "";
}

export function waLink(phone: string | null | undefined, text: string): string | null {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}
