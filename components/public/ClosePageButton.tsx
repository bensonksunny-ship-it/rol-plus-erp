"use client";

// "Close" for the public parent pages (/enquiry, /apply) once they're done.
// Browsers only let a script close a tab the script itself opened, so a page
// reached by scanning a QR code usually can't close itself. Try anyway; if the
// tab is still open a moment later, tell the parent they can close it.

import { useState } from "react";

export default function ClosePageButton({ style }: { style?: React.CSSProperties }) {
  const [blocked, setBlocked] = useState(false);

  function close() {
    window.close();
    setTimeout(() => { if (!window.closed) setBlocked(true); }, 300);
  }

  if (blocked) {
    return (
      <div role="status" style={{ fontSize: 14, fontWeight: 600, color: "#15803d", padding: "10px 0", ...style }}>
        ✓ All done — you can now safely close this tab.
      </div>
    );
  }
  return (
    <button type="button" onClick={close} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
      padding: "11px 22px", borderRadius: 12, border: "1px solid #e5e7eb", background: "#f3f4f6",
      color: "#374151", fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", ...style,
    }}>
      <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>✕</span> Close
    </button>
  );
}
