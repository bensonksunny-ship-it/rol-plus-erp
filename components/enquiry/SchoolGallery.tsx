"use client";

// School Gallery / Campus Highlights on the parents' post-enquiry screen:
// a 2-col (phone) / 3-col grid of the leader-uploaded photos; tapping one
// opens a full-screen lightbox (swipe, ‹ ›, arrow keys, Esc / ✕ to close).
// Rendered only when there are photos (see SchoolInfoView).

import { useCallback, useEffect, useRef, useState } from "react";
import type { SchoolPhoto } from "@/lib/schoolInfo";

export default function SchoolGallery({ photos }: { photos: SchoolPhoto[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (photos.length === 0) return null;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {photos.map((ph, i) => (
          <button key={ph.id} type="button" onClick={() => setOpen(i)}
            aria-label={`Open photo ${i + 1}${ph.caption ? `: ${ph.caption}` : ""}`}
            style={{ padding: 0, border: "none", background: "#f3f4f6", borderRadius: 12, overflow: "hidden", cursor: "zoom-in", position: "relative", aspectRatio: "4 / 3", display: "block", width: "100%" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={ph.url} alt={ph.caption || `School photo ${i + 1}`} loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            {ph.caption && (
              <span style={{
                position: "absolute", left: 0, right: 0, bottom: 0, padding: "18px 8px 6px", textAlign: "left",
                background: "linear-gradient(transparent, rgba(0,0,0,0.65))", color: "#fff", fontSize: 11.5, fontWeight: 600,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{ph.caption}</span>
            )}
          </button>
        ))}
      </div>
      {open !== null && <Lightbox photos={photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function Lightbox({ photos, index, onIndex, onClose }: {
  photos: SchoolPhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void;
}) {
  const n = photos.length;
  const go = useCallback((d: number) => onIndex((index + d + n) % n), [index, n, onIndex]);
  const touchX = useRef<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";   // no page scroll behind the lightbox
    closeRef.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, [go, onClose]);

  const ph = photos[index];
  const navBtn: React.CSSProperties = {
    position: "absolute", top: "50%", transform: "translateY(-50%)", width: 44, height: 44, borderRadius: "50%",
    border: "none", background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 26, lineHeight: 1, cursor: "pointer",
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Photo viewer"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={e => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40 && n > 1) go(dx < 0 ? 1 : -1);
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.92)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "56px 12px 24px" }}>
      <button ref={closeRef} type="button" onClick={onClose} aria-label="Close"
        style={{ position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: "50%", border: "none", background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 18, cursor: "pointer" }}>
        ✕
      </button>
      <div style={{ position: "absolute", top: 20, left: 16, color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: 600 }}>
        {index + 1} / {n}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={ph.url} alt={ph.caption || `School photo ${index + 1}`}
        style={{ maxWidth: "100%", maxHeight: "calc(100dvh - 140px)", objectFit: "contain", borderRadius: 8, userSelect: "none" }} />
      {ph.caption && <div style={{ color: "#fff", fontSize: 14, fontWeight: 600, marginTop: 12, textAlign: "center", maxWidth: 560 }}>{ph.caption}</div>}
      {n > 1 && (
        <>
          <button type="button" aria-label="Previous photo" onClick={() => go(-1)} style={{ ...navBtn, left: 10 }}>‹</button>
          <button type="button" aria-label="Next photo" onClick={() => go(1)} style={{ ...navBtn, right: 10 }}>›</button>
        </>
      )}
    </div>
  );
}
