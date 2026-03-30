"use client";

import { useState, useEffect } from "react";
import { signIn } from "@/services/firebase/auth.service";
import { useAuth } from "@/hooks/useAuth";
import { ROLE_ROUTES } from "@/config/constants";

const ERROR_MESSAGES: Record<string, string> = {
  "AUTH/USER_NOT_FOUND":    "Account not found. Contact your administrator.",
  "AUTH/ACCOUNT_INACTIVE":  "Your account is inactive. Contact your administrator.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/too-many-requests":  "Too many attempts. Try again later.",
};

export default function LoginPage() {
  const { user, loading } = useAuth();

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If already authenticated, redirect immediately via hard nav
  // so middleware sees the existing cookie on the very first request.
  useEffect(() => {
    if (!loading && user) {
      window.location.href = ROLE_ROUTES[user.role] ?? "/dashboard";
    }
  }, [user, loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const session = await signIn(email.trim(), password);

      // Set session cookie for middleware.
      // We use a hard navigation (window.location) instead of router.replace()
      // so that the browser flushes the cookie BEFORE the next request is made.
      // With router.replace() (client-side nav), Next.js edge middleware runs
      // before the cookie is visible — causing a redirect loop to /login.
      const maxAge = 60 * 60 * 24 * 7; // 7 days
      document.cookie = `rol_session=${session.token}; path=/; SameSite=Strict; max-age=${maxAge}`;

      const destination = ROLE_ROUTES[session.user.role] ?? "/dashboard";
      window.location.href = destination;
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : "unknown";
      setError(ERROR_MESSAGES[code] ?? "Something went wrong. Please try again.");
      setSubmitting(false);
    }
    // NOTE: do not setSubmitting(false) on success — the page is navigating away.
  }

  if (loading || user) return null;

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