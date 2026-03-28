"use client";

import { useEffect, useState } from "react";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ToastType = "success" | "error";

export interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
}

// ─── Single toast item ─────────────────────────────────────────────────────────

function ToastItem({
  toast,
  onRemove,
}: {
  toast: ToastMessage;
  onRemove: (id: number) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Slight delay so CSS transition runs on mount
    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onRemove(toast.id), 300);
    }, 3500);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, [toast.id, onRemove]);

  const bg    = toast.type === "success" ? "#16a34a" : "#dc2626";
  const icon  = toast.type === "success" ? "✓" : "✕";

  return (
    <div
      style={{
        ...toastStyles.item,
        background: bg,
        opacity:    visible ? 1 : 0,
        transform:  visible ? "translateY(0)" : "translateY(-12px)",
      }}
    >
      <span style={toastStyles.icon}>{icon}</span>
      <span style={toastStyles.message}>{toast.message}</span>
      <button
        onClick={() => onRemove(toast.id)}
        style={toastStyles.close}
      >
        ×
      </button>
    </div>
  );
}

// ─── Toast container ───────────────────────────────────────────────────────────

export function ToastContainer({ toasts, onRemove }: {
  toasts: ToastMessage[];
  onRemove: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div style={toastStyles.container}>
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const toastStyles: Record<string, React.CSSProperties> = {
  container: {
    position:      "fixed",
    top:           20,
    right:         20,
    zIndex:        9999,
    display:       "flex",
    flexDirection: "column",
    gap:           10,
    pointerEvents: "none",
  },
  item: {
    display:        "flex",
    alignItems:     "center",
    gap:            10,
    padding:        "10px 14px",
    borderRadius:   8,
    color:          "#fff",
    fontSize:       13,
    fontWeight:     500,
    boxShadow:      "0 4px 12px rgba(0,0,0,0.15)",
    minWidth:       240,
    maxWidth:       340,
    transition:     "opacity 0.3s ease, transform 0.3s ease",
    pointerEvents:  "all",
  },
  icon: {
    fontWeight: 700,
    fontSize:   14,
    flexShrink: 0,
  },
  message: {
    flex: 1,
  },
  close: {
    background:  "transparent",
    border:      "none",
    color:       "rgba(255,255,255,0.8)",
    fontSize:    18,
    cursor:      "pointer",
    lineHeight:  1,
    padding:     0,
    flexShrink:  0,
  },
};
