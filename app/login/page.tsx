"use client";

// ─── ALL AUTH LOGIC UNCHANGED ─────────────────────────────────────────────────
import { useState, useEffect, useRef } from "react";
import { signIn } from "@/services/firebase/auth.service";
import { useAuth } from "@/hooks/useAuth";
import { ROLE_ROUTES } from "@/config/constants";

const ERROR_MESSAGES: Record<string, string> = {
  "AUTH/USER_NOT_FOUND":     "Account not found. Contact your administrator.",
  "AUTH/ACCOUNT_INACTIVE":   "Your account is inactive. Contact your administrator.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/too-many-requests":  "Too many attempts. Try again later.",
};

export default function LoginPage() {
  const { user, loading } = useAuth();
  const redirectingRef    = useRef(false);

  const [email,      setEmail]      = useState("");
  const [password,   setPassword]   = useState("");
  const [showPwd,    setShowPwd]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focused,    setFocused]    = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) return;
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    window.location.replace(ROLE_ROUTES[user.role] ?? "/dashboard");
  }, [user, loading]);

  if (loading) return <div style={s.loadingScreen} />;
  if (user)    return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await signIn(email.trim(), password);
      const maxAge  = 60 * 60 * 24 * 7;
      document.cookie = `rol_session=${session.token}; path=/; SameSite=Lax; max-age=${maxAge}`;
      window.location.replace(ROLE_ROUTES[session.user.role] ?? "/dashboard");
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : "unknown";
      setError(ERROR_MESSAGES[code] ?? "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      {/* Dot-grid background */}
      <div style={s.gridBg} aria-hidden />

      {/* Glow orbs */}
      <div style={s.orb1} aria-hidden />
      <div style={s.orb2} aria-hidden />

      <div style={s.card} className="animate-scaleIn">
        {/* Gold top accent line */}
        <div style={s.topAccent} />

        {/* Brand */}
        <div style={s.brand} className="animate-fadeIn">
          <div style={s.logoMark}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M9 18V5l12-2v13" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="6" cy="18" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
              <circle cx="18" cy="16" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
            </svg>
          </div>
          <div>
            <div style={s.logoText}>ROL's Plus</div>
            <div style={s.logoSub}>Music School ERP</div>
          </div>
        </div>

        {/* Divider */}
        <div style={s.divider} />

        {/* Heading */}
        <div style={s.heading} className="animate-fadeIn delay-50">
          <h1 style={s.h1}>Welcome back</h1>
          <p style={s.h1Sub}>Sign in to your account to continue</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={s.form} noValidate className="animate-fadeIn delay-100">

          {/* Email */}
          <div style={s.field}>
            <label style={s.label} htmlFor="email">Email address</label>
            <div style={{ position: "relative" }}>
              <span style={s.inputIcon}>
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M2 5l8 6 8-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <rect x="1" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              </span>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onFocus={() => setFocused("email")}
                onBlur={() => setFocused(null)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                style={{ ...s.input, ...(focused === "email" ? s.inputFocused : {}) }}
              />
            </div>
          </div>

          {/* Password */}
          <div style={s.field}>
            <label style={s.label} htmlFor="password">Password</label>
            <div style={{ position: "relative" }}>
              <span style={s.inputIcon}>
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <rect x="3" y="9" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M6 9V6a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="10" cy="14" r="1.5" fill="currentColor"/>
                </svg>
              </span>
              <input
                id="password"
                type={showPwd ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onFocus={() => setFocused("password")}
                onBlur={() => setFocused(null)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
                style={{ ...s.input, paddingRight: 44, ...(focused === "password" ? s.inputFocused : {}) }}
              />
              <button
                type="button"
                onClick={() => setShowPwd(v => !v)}
                style={s.eyeBtn}
                tabIndex={-1}
                aria-label={showPwd ? "Hide password" : "Show password"}
              >
                {showPwd ? (
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                    <path d="M3 3l14 14M8.5 8.6A3 3 0 0 0 11.4 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M6.1 5.1C4.2 6.2 2.7 8 2 10c1.5 4 5 6 8 6 1.7 0 3.3-.6 4.7-1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M17.3 13.3C17.7 12.3 18 11.2 18 10c-1.5-4-5-6-8-6-.9 0-1.7.1-2.5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                    <path d="M2 10c1.5-4 5-6 8-6s6.5 2 8 6c-1.5 4-5 6-8 6s-6.5-2-8-6z" stroke="currentColor" strokeWidth="1.5"/>
                    <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div style={s.errorBox} role="alert" className="animate-fadeIn">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
                <circle cx="10" cy="10" r="8.5" stroke="var(--color-danger)" strokeWidth="1.5"/>
                <path d="M10 6v5M10 13.5v.5" stroke="var(--color-danger)" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              {error}
            </div>
          )}

          {/* Gold submit button */}
          <button
            type="submit"
            disabled={submitting}
            style={{
              ...s.submitBtn,
              opacity: submitting ? 0.72 : 1,
              cursor:  submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting && <span style={s.spinner} />}
            {submitting ? "Signing in…" : "Sign in"}
            {!submitting && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            )}
          </button>
        </form>

        {/* Footer note */}
        <p style={s.footerNote} className="animate-fadeIn delay-150">
          Access is managed by your administrator.
        </p>
      </div>

      {/* Version tag */}
      <div style={s.versionTag}>ROL's Plus v2 · Music School ERP</div>
    </div>
  );
}

/* ─── Styles ──────────────────────────────────────────────────────────────── */
const s: Record<string, React.CSSProperties> = {
  loadingScreen: { minHeight: "100vh", background: "var(--color-bg)" },

  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px 16px",
    background: "var(--color-bg)",
    position: "relative",
    overflow: "hidden",
  },

  gridBg: {
    position: "absolute",
    inset: 0,
    backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.035) 1px, transparent 1px)",
    backgroundSize: "28px 28px",
    pointerEvents: "none",
  },

  orb1: {
    position: "absolute", top: "-8%", right: "-5%",
    width: 500, height: 500, borderRadius: "50%",
    background: "radial-gradient(circle, rgba(245,158,11,0.10) 0%, transparent 70%)",
    filter: "blur(40px)", pointerEvents: "none",
  },
  orb2: {
    position: "absolute", bottom: "-12%", left: "-8%",
    width: 560, height: 560, borderRadius: "50%",
    background: "radial-gradient(circle, rgba(139,92,246,0.07) 0%, transparent 70%)",
    filter: "blur(50px)", pointerEvents: "none",
  },

  card: {
    position: "relative", zIndex: 1,
    width: "100%", maxWidth: 400,
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 20,
    padding: "36px 30px 28px",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(245,158,11,0.06) inset",
  },

  topAccent: {
    position: "absolute", top: 0, left: "20%", right: "20%",
    height: 2, borderRadius: "0 0 4px 4px",
    background: "linear-gradient(90deg, transparent, #f59e0b, transparent)",
  },

  brand: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
  logoMark: {
    width: 46, height: 46, borderRadius: 12,
    background: "rgba(245,158,11,0.10)",
    border: "1px solid rgba(245,158,11,0.25)",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, boxShadow: "0 0 16px rgba(245,158,11,0.12)",
  },
  logoText: {
    fontSize: 17, fontWeight: 800,
    color: "var(--color-text-primary)",
    letterSpacing: "-0.4px", lineHeight: 1.2,
  },
  logoSub: {
    fontSize: 10.5, color: "var(--color-text-muted)",
    letterSpacing: "0.06em", textTransform: "uppercase",
    marginTop: 2, fontWeight: 600,
  },

  divider: { height: 1, background: "var(--color-border)", marginBottom: 22 },

  heading: { marginBottom: 22 },
  h1: {
    fontSize: 21, fontWeight: 800,
    color: "var(--color-text-primary)",
    letterSpacing: "-0.5px", marginBottom: 4,
  },
  h1Sub: { fontSize: 13, color: "var(--color-text-secondary)" },

  form: { display: "flex", flexDirection: "column", gap: 16 },
  field: { display: "flex", flexDirection: "column", gap: 7 },

  label: {
    fontSize: 11.5, fontWeight: 700,
    color: "var(--color-text-secondary)",
    textTransform: "uppercase", letterSpacing: "0.06em",
  },

  inputIcon: {
    position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
    color: "var(--color-text-muted)", display: "flex",
    alignItems: "center", pointerEvents: "none",
  },

  input: {
    width: "100%", padding: "10px 12px 10px 38px",
    background: "var(--color-surface-2)",
    border: "1px solid var(--color-border)",
    borderRadius: 10, fontSize: 13.5,
    color: "var(--color-text-primary)",
    transition: "border-color 0.18s, box-shadow 0.18s",
  },
  inputFocused: {
    borderColor: "var(--color-accent)",
    boxShadow: "0 0 0 3px var(--color-accent-glow)",
  },

  eyeBtn: {
    position: "absolute", right: 10, top: "50%",
    transform: "translateY(-50%)",
    background: "none", border: "none", padding: 4,
    color: "var(--color-text-muted)", cursor: "pointer",
    display: "flex", alignItems: "center",
    borderRadius: 4, transition: "color 0.15s",
  },

  errorBox: {
    display: "flex", alignItems: "flex-start", gap: 8,
    fontSize: 12.5, color: "var(--color-danger)",
    background: "var(--color-danger-dim)",
    border: "1px solid var(--color-danger-border)",
    borderRadius: 9, padding: "10px 12px", lineHeight: 1.5,
  },

  submitBtn: {
    marginTop: 4,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    padding: "12px 16px",
    background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
    color: "#0a0a0a",
    border: "none", borderRadius: 10,
    fontSize: 14, fontWeight: 800, letterSpacing: "0.01em",
    transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
    boxShadow: "0 4px 18px rgba(245,158,11,0.30)",
  },

  spinner: {
    display: "inline-block", width: 14, height: 14,
    border: "2px solid rgba(0,0,0,0.18)",
    borderTopColor: "#0a0a0a", borderRadius: "50%",
    animation: "spin 0.7s linear infinite",
  },

  footerNote: {
    marginTop: 20, textAlign: "center",
    fontSize: 11.5, color: "var(--color-text-muted)", lineHeight: 1.5,
  },

  versionTag: {
    position: "fixed", bottom: 14, left: "50%", transform: "translateX(-50%)",
    fontSize: 10.5, color: "var(--color-text-muted)",
    letterSpacing: "0.04em", whiteSpace: "nowrap",
    userSelect: "none", zIndex: 0,
  },
};
