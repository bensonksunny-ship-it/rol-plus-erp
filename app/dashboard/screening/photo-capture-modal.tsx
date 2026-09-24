"use client";

// Staff-side candidate photo capture. Parents submitting via the QR /apply form
// no longer attach a photo — the application lands as "Photo Pending" and the
// teacher takes it here (live camera, or upload / phone camera fallback).

import { useEffect, useRef, useState } from "react";
import { updateAdmission } from "@/services/screening/screening.service";

const W = 320, H = 420;   // same portrait size the admission form compresses to

/** Centre-crop a source to 320×420 portrait and encode as JPEG. */
function toPortraitJpeg(src: CanvasImageSource, sw: number, sh: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return canvas.toDataURL("image/jpeg", 0.8);
}

function fileToPortrait(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(toPortraitJpeg(img, img.naturalWidth, img.naturalHeight)); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

export function PhotoCaptureModal({ admissionId, name, onClose, onSaved }: {
  admissionId: string;
  name: string;
  onClose: () => void;
  onSaved: (photo: string) => void;
}) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef   = useRef<HTMLInputElement>(null);
  const [camState, setCamState] = useState<"starting" | "live" | "unavailable">("starting");
  const [facing, setFacing]     = useState<"user" | "environment">("environment");
  const [photo, setPhoto]       = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState("");

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }

  // (Re)start the live camera while no photo is held.
  useEffect(() => {
    if (photo) { stopCamera(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setCamState("unavailable"); return; }
    let cancelled = false;
    setCamState("starting");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setCamState("live");
      })
      .catch(() => { if (!cancelled) setCamState("unavailable"); });
    return () => { cancelled = true; stopCamera(); };
  }, [facing, photo]);

  function snap() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setPhoto(toPortraitJpeg(v, v.videoWidth, v.videoHeight));
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    fileToPortrait(file).then(setPhoto).catch(er => setErr(er.message));
  }

  async function save() {
    if (!photo || saving) return;
    setSaving(true);
    setErr("");
    try {
      await updateAdmission(admissionId, {
        photo,
        photoStatus:     "completed",
        photoCapturedAt: new Date().toISOString(),
      });
      onSaved(photo);
      onClose();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "Could not save the photo.");
      setSaving(false);
    }
  }

  const btn: React.CSSProperties = {
    padding: "10px 16px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6, border: "none",
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="Take candidate photo"
        style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 400, maxHeight: "94vh", overflowY: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid #f3f4f6" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>📷 Candidate photo</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{name}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280" }}>✕</button>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{ width: "min(240px, 100%)", aspectRatio: `${W} / ${H}`, margin: "0 auto", borderRadius: 14, overflow: "hidden", background: "#111", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
            {photo ? (
              <img src={photo} alt="Captured" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <>
                <video ref={videoRef} playsInline muted
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: camState === "live" ? "block" : "none", transform: facing === "user" ? "scaleX(-1)" : "none" }} />
                {camState !== "live" && (
                  <div style={{ color: "#9ca3af", fontSize: 12, padding: 16, textAlign: "center" }}>
                    {camState === "starting" ? "Starting camera…" : "Camera not available — use Upload Photo below."}
                  </div>
                )}
              </>
            )}
          </div>

          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFile} />

          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
            {photo ? (
              <>
                <button onClick={() => setPhoto(null)} disabled={saving} style={{ ...btn, background: "#f3f4f6", color: "#374151" }}>↺ Retake</button>
                <button onClick={save} disabled={saving} style={{ ...btn, background: "#16a34a", color: "#fff", opacity: saving ? 0.7 : 1 }}>
                  {saving ? "Saving…" : "✓ Save photo"}
                </button>
              </>
            ) : (
              <>
                {camState === "live" && (
                  <button onClick={snap} style={{ ...btn, background: "#d97706", color: "#fff" }}>📸 Take Photo</button>
                )}
                {camState === "live" && (
                  <button onClick={() => setFacing(f => f === "user" ? "environment" : "user")} title="Switch camera"
                    style={{ ...btn, background: "#f3f4f6", color: "#374151" }}>🔄</button>
                )}
                <button onClick={() => fileRef.current?.click()} style={{ ...btn, background: "#fff", color: "#374151", border: "1px solid #e5e7eb" }}>
                  🖼️ Upload Photo
                </button>
              </>
            )}
          </div>

          {err && <div style={{ marginTop: 12, fontSize: 12.5, color: "#dc2626", textAlign: "center" }}>{err}</div>}
          <div style={{ marginTop: 12, fontSize: 11.5, color: "#9ca3af", textAlign: "center" }}>
            Saving marks the application Completed — ready for screening &amp; enrolment.
          </div>
        </div>
      </div>
    </div>
  );
}
