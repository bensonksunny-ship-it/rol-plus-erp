"use client";

import { useState, useEffect, type FormEvent } from "react";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  collection,
  setDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
  doc,
  getDoc,
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signOut as fbSignOut,
} from "firebase/auth";
import { deleteApp } from "firebase/app";
import { db } from "@/services/firebase/firebase";
import { logAction } from "@/services/audit/audit.service";
import type { Center } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminRow {
  uid:         string;
  displayName: string;
  email:       string;
  adminCode:   string;
  status:      string;
  _createdAt:  number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Atomic counter — center-scoped, year-aware, Firestore transaction */
async function getNextAdminSeq(): Promise<number> {
  const ref = doc(db, "counters", "admin_global");
  const snap = await getDoc(ref);
  const current = snap.exists() ? (snap.data().seq as number) : 0;
  const next = current + 1;
  const { setDoc } = await import("firebase/firestore");
  await setDoc(ref, { seq: next }, { merge: true });
  return next;
}

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminsPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN]}>
      <AdminsContent />
    </ProtectedRoute>
  );
}

function AdminsContent() {
  const { user } = useAuth();

  const [admins, setAdmins]     = useState<AdminRow[]>([]);
  const [centers, setCenters]   = useState<Center[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form fields
  const [name, setName]           = useState("");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  // ── Load admins + centers ─────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const [adminSnap, centerSnap] = await Promise.all([
          getDocs(query(
            collection(db, "users"),
            where("role", "in", [ROLES.ADMIN, ROLES.SUPER_ADMIN]),
          )),
          getDocs(collection(db, "centers")),
        ]);

        setAdmins(adminSnap.docs.map(d => {
          const data = d.data();
          return {
            uid:         d.id,
            displayName: data.displayName ?? data.name ?? "—",
            email:       data.email ?? "—",
            adminCode:   data.adminCode ?? "—",
            status:      data.status ?? "active",
            _createdAt:  data.createdAt?.seconds ?? 0,
          };
        }).sort((a, b) => b._createdAt - a._createdAt));

        setCenters(centerSnap.docs.map(d => ({
          id: d.id,
          ...d.data(),
        } as Center)));
      } catch (err) {
        console.error("Failed to load admins:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ── Create admin ─────────────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSuccessMsg(null);
    setErrorMsg(null);

    if (!name.trim())       return setErrorMsg("Name is required.");
    if (!email.trim())      return setErrorMsg("Email is required.");
    if (password.length < 6) return setErrorMsg("Password must be at least 6 characters.");

    setSubmitting(true);
    try {
      // 1. Check duplicate email in Firestore
      const dupSnap = await getDocs(query(
        collection(db, "users"),
        where("email", "==", email.trim().toLowerCase()),
      ));
      if (!dupSnap.empty) {
        setErrorMsg(`Email already in use: "${email.trim()}"`);
        return;
      }

      // 2. Create Firebase Auth user using a secondary app instance
      //    so the super admin's own session is never displaced.
      const { initializeApp } = await import("firebase/app");
      const { default: primaryApp } = await import("@/services/firebase/firebase");
      const secondaryApp  = initializeApp(primaryApp.options, `admin-create-${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      let uid: string;
      try {
        const cred = await createUserWithEmailAndPassword(
          secondaryAuth, email.trim().toLowerCase(), password
        );
        uid = cred.user.uid;
      } finally {
        // Always sign out + delete secondary app — password no longer needed
        await fbSignOut(secondaryAuth).catch(() => {});
        await deleteApp(secondaryApp).catch(() => {});
      }

      // 3. Generate adminCode (ADM001, ADM002…)
      const seq       = await getNextAdminSeq();
      const adminCode = `ADM${pad(seq, 3)}`;

      // 4. Write Firestore user doc (doc ID = Firebase Auth UID) — password NEVER stored
      await setDoc(doc(db, "users", uid), {
        uid,
        email:           email.trim().toLowerCase(),
        displayName:     name.trim(),
        role:            ROLES.ADMIN,
        adminCode,
        status:          "active",
        mustResetPassword: false,
        currentBalance:  0,
        lastActivity:    null,
        qrCodeURL:       null,
        createdBy:       user?.uid ?? "unknown",
        createdAt:       serverTimestamp(),
        updatedAt:       serverTimestamp(),
      });

      // 5. Audit log — password never included in metadata
      await logAction({
        action:        "ADMIN_CREATED",
        initiatorId:   user?.uid ?? "unknown",
        initiatorRole: ROLES.SUPER_ADMIN,
        approverId:    null,
        approverRole:  null,
        reason:        "Super admin created new admin",
        metadata:      { adminCode, email: email.trim().toLowerCase() },
      });

      // 6. Refresh admin list (no orderBy — sort client-side to avoid index requirement)
      const fresh = await getDocs(query(
        collection(db, "users"),
        where("role", "in", [ROLES.ADMIN, ROLES.SUPER_ADMIN]),
      ));
      setAdmins(fresh.docs.map(d => {
        const data = d.data();
        return {
          uid:          d.id,
          displayName:  data.displayName ?? data.name ?? "—",
          email:        data.email ?? "—",
          adminCode:    data.adminCode ?? "—",
          status:       data.status ?? "active",
          _createdAt:   (data.createdAt?.seconds ?? 0) * 1000,
        };
      }));

      setSuccessMsg(`Admin created successfully. Code: ${adminCode}`);
      setName(""); setEmail(""); setPassword("");
      setShowForm(false);

    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/email-already-in-use") {
        setErrorMsg("This email is already registered in Firebase Auth.");
      } else {
        setErrorMsg(err instanceof Error ? err.message : "Creation failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Header row */}
      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>Admins</h1>
          <p style={s.subtitle}>Manage center administrators</p>
        </div>
        <button
          style={showForm ? s.btnGhost : s.btnPrimary}
          onClick={() => { setShowForm(v => !v); setSuccessMsg(null); setErrorMsg(null); }}
        >
          {showForm ? "✕ Cancel" : "+ Add Admin"}
        </button>
      </div>

      {/* Banners */}
      {successMsg && <div style={s.bannerSuccess}>{successMsg}</div>}
      {errorMsg   && <div style={s.bannerError}>{errorMsg}</div>}

      {/* ── Create Admin Form ── */}
      {showForm && (
        <div style={s.card}>
          <p style={s.cardTitle}>New Admin Details</p>
          <form onSubmit={handleSubmit}>
            <div style={s.grid2}>

              <div style={s.field}>
                <label style={s.label}>Full Name</label>
                <input
                  style={s.input}
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Rahul Sharma"
                  required
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Email Address</label>
                <input
                  style={s.input}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="admin@rolsplus.com"
                  required
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Password</label>
                <div style={{ position: "relative" }}>
                  <input
                    style={{ ...s.input, paddingRight: 52 }}
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 6 characters"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPw(v => !v)}
                    style={s.showHide}
                  >
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              {/* Spacer on right column */}
              <div />

              <div style={{ ...s.field, gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
                <button type="button" style={s.btnGhost} onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ ...s.btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? "not-allowed" : "pointer", minWidth: 130 }}
                  disabled={submitting}
                >
                  {submitting ? "Creating…" : "Create Admin"}
                </button>
              </div>

            </div>
          </form>
        </div>
      )}

      {/* ── Admin List ── */}
      <div style={s.card}>
        <p style={s.cardTitle}>
          All Admins{" "}
          <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>
            ({admins.length})
          </span>
        </p>

        {loading ? (
          <div style={s.emptyState}>Loading…</div>
        ) : admins.length === 0 ? (
          <div style={s.emptyState}>No admins yet. Click "+ Add Admin" to create one.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["Name", "Email", "Code", "Status"].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {admins.map(a => (
                  <tr key={a.uid} style={s.tr}>
                    <td style={{ ...s.td, color: "var(--color-text-primary)", fontWeight: 500 }}>
                      {a.displayName}
                    </td>
                    <td style={s.td}>{a.email}</td>
                    <td style={s.td}>
                      <span style={s.code}>{a.adminCode}</span>
                    </td>
                    <td style={s.td}>
                      <span style={a.status === "active" ? s.badgeActive : s.badgeInactive}>
                        {a.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  headerRow:     { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  title:         { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", margin: 0 },
  subtitle:      { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 },

  btnPrimary:    { padding: "9px 18px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnGhost:      { padding: "9px 18px", background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },

  bannerSuccess: { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
  bannerError:   { borderRadius: 8, padding: "10px 16px", fontSize: 13, marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },

  card:          { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24, marginBottom: 24 },
  cardTitle:     { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 20, marginTop: 0 },

  grid2:         { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" },
  field:         { display: "flex", flexDirection: "column", gap: 6 },
  label:         { fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" },
  input:         { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 12px", fontSize: 14, color: "var(--color-text-primary)", outline: "none", width: "100%", boxSizing: "border-box" },
  showHide:      { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer", padding: 0 },

  table:         { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:            { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" },
  tr:            { borderBottom: "1px solid var(--color-border)" },
  td:            { padding: "12px", color: "var(--color-text-secondary)", verticalAlign: "middle" },

  code:          { fontFamily: "monospace", fontSize: 12, background: "#ede9fe", color: "#6d28d9", padding: "2px 8px", borderRadius: 4 },
  badgeActive:   { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f0fdf4", color: "#166534" },
  badgeInactive: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#f3f4f6", color: "#6b7280" },

  emptyState:    { textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 14 },
};
