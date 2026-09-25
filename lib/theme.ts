// Day / Night / Auto (follow the device) theme preference.
// The resolved theme lives on <html data-theme="light|dark">, which every
// theme rule in app/globals.css keys off. app/layout.tsx applies it before
// first paint (THEME_INIT_SCRIPT) so there's no flash of the wrong theme.

export type ThemePref = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "rol_theme";

/** Inline <head> script — must stay dependency-free and in sync with applyTheme(). */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="light"||p==="dark"?p:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",d);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export function getThemePref(): ThemePref {
  try {
    const p = localStorage.getItem(THEME_STORAGE_KEY);
    return p === "light" || p === "dark" ? p : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch { /* storage blocked — still apply for this session */ }
  applyTheme(pref);
}
