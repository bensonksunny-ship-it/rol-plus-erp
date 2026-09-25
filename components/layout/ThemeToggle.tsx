"use client";

import { useEffect, useState } from "react";
import { applyTheme, getThemePref, setThemePref, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; icon: string; label: string; title: string }[] = [
  { value: "light",  icon: "☀️", label: "Day",   title: "Day view (light)" },
  { value: "dark",   icon: "🌙", label: "Night", title: "Night view (dark)" },
  { value: "system", icon: "🖥️", label: "Auto",  title: "Follow this device's setting" },
];

/** Day / Night / Auto switch for the sidebar footer. */
export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => { setPref(getThemePref()); }, []);

  // In Auto, follow the device live (e.g. phone switching to dark at sunset).
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function choose(p: ThemePref) {
    setPref(p);
    setThemePref(p);
  }

  return (
    <div role="radiogroup" aria-label="Theme" style={{
      display: "flex", gap: 2, padding: 3, marginBottom: 8,
      background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8,
    }}>
      {OPTIONS.map(o => {
        const on = pref === o.value;
        return (
          <button key={o.value} role="radio" aria-checked={on} title={o.title} onClick={() => choose(o.value)} style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            padding: "5px 0", borderRadius: 6, border: "none", cursor: "pointer",
            fontSize: 11.5, fontWeight: on ? 700 : 500,
            background: on ? "var(--color-surface)" : "transparent",
            color: on ? "var(--color-text-primary)" : "var(--color-text-muted)",
            boxShadow: on ? "var(--shadow-sm)" : "none",
            transition: "background 0.15s, color 0.15s",
          }}>
            <span aria-hidden style={{ fontSize: 12 }}>{o.icon}</span>{o.label}
          </button>
        );
      })}
    </div>
  );
}
