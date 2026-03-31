"use client";

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
  const redirectingRef    = useRef(false); // prevents double-redirect

  const [email,      setEmail]      = useState("");
  const [password,   setPassword]   = useState("");
  const [error,      setError]      = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If auth resolves and the user is already logged in, redirect once.
  // Guard with redirectingRef so a re-render during the navigation (which
  // can happen as React reconciles) does not fire a second window.location
  // assignment — that causes the one-second blink/refresh loop.
  useEffect(() => {
    if (loading) return;
    if (!user) return;
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    window.location.replace(ROLE_ROUTES[user.role] ?? "/dashboard");
  }, [user, loading]);

  // While auth is resolving, show a neutral full-screen placeholder instead
  // of the form. This prevents the form from flashing in then immediately
  // disappearing when a valid session is detected.
  if (loading) {
    return <div style={styles.loadingScreen} />;
  }

  // Auth resolved and user exists — redirect is in flight, show nothing.
  if (user) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const session = await signIn(email.trim(), password);

      // Set the session cookie BEFORE navigating so edge middleware sees it
      // on the very first request. window.location.replace (not href=) avoids
      // adding a /login history entry the user can navigate back to.
      //
      // SameSite=Lax (not Strict) is required for mobile Safari and PWA mode:
      // SameSite=Strict causes iOS Safari to drop the cookie on ANY navigation
      // that it considers "cross-site" (including PWA launch, in-app browser
      // redirects, and some same-domain navigations) → middleware sees no cookie
      // → redirects to /login → refresh loop on mobile.
      const maxAge = 60 * 60 * 24 * 7; // 7 days
      document.cookie = `rol_session=${session.token}; path=/; SameSite=Lax; max-age=${maxAge}`;

      window.location.replace(ROLE_ROUTES[session.user.role] ?? "/dashboard");
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : "unknown";
      setError(ERROR_MESSAGES[code] ?? "Something went wrong. Please try again.");
      setSubmitting(false);
    }
    // Do NOT setSubmitting(false) on success — the page is navigating away.
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>

        <div style={styles.header}>
          <div style={styles.logo}>ROL</div>
          <p style={styles.subtitle}>Plus ERP — sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
              style={styles.input}
            />
          </div>

          {error && (
            <div style={styles.error} role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              ...styles.button,
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loadingScreen: {
    minHeight: "100vh",
    background: "var(--color-bg)",
  },
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    background: "var(--color-bg)",
  },
  card: {
    width: "100%",
    maxWidth: 380,
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    padding: "36px 32px",
    boxShadow: "var(--shadow-sm)",
  },
  header: {
    marginBottom: 28,
    textAlign: "center",
  },
  logo: {
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: "-0.5px",
    color: "var(--color-accent)",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: "var(--color-text-secondary)",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--color-text-primary)",
  },
  input: {
    padding: "9px 12px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius)",
    fontSize: 14,
    outline: "none",
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
    transition: "border-color 0.15s",
  },
  error: {
    fontSize: 13,
    color: "var(--color-danger)",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "var(--radius)",
    padding: "9px 12px",
  },
  button: {
    marginTop: 4,
    padding: "10px 16px",
    background: "var(--color-accent)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius)",
    fontSize: 14,
    fontWeight: 600,
    transition: "background 0.15s",
    cursor: "pointer",
  },
};