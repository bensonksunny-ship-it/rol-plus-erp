"use client";

// ═══════════════════════════════════════════════════════════════════════════════
// ALL LOGIC BELOW IS UNCHANGED — only the `s` style object at the bottom
// has been updated to the gold/amber theme.
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/useIsMobile";
import { signOut } from "@/services/firebase/auth.service";
import { ROLES } from "@/config/constants";

// ─── Alert count hook ──────────────────────────────────────────────────────────
function useAlertCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  // Capture enabled in a ref so the interval callback always uses the latest
  // value without being listed as an effect dependency — prevents re-subscribing
  // the interval every time the admin/super_admin role check changes.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    // Only start the polling loop once (on mount). The ref keeps it current.
    async function fetchAlerts() {
      if (!enabledRef.current) { setCount(0); return; }
      try {
        const snap = await getDocs(
          query(collection(db, "alerts"), where("status", "==", "active"))
        );
        setCount(snap.size);
      } catch { /* silent */ }
    }
    fetchAlerts();
    const id = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);   // ← intentionally empty: interval starts once, ref tracks enabled
  return count;
}

// ─── Nav config ───────────────────────────────────────────────────────────────
interface NavItem {
  label:        string;
  icon:         string;
  href:         string | ((uid: string, role: string) => string);
  matchPrefix?: string;
  roles:        string[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "Center Suite",  icon: "⊞",  href: "/dashboard",               roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.STUDENT] },
  { label: "Centers",      icon: "🏫", href: "/dashboard/centers",        roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Teachers",     icon: "👥", href: "/dashboard/teachers",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Admins",       icon: "👤", href: "/dashboard/admins",         roles: [ROLES.SUPER_ADMIN] },
  { label: "Students",     icon: "🎓", href: "/dashboard/students",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Attendance",   icon: "✓",  href: "/dashboard/attendance",     roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.STUDENT] },
  { label: "Finance",      icon: "₹",  href: "/dashboard/finance",        roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  {
    label: "Syllabus", icon: "📚",
    href:  (uid, role) =>
      role === ROLES.STUDENT
        ? `/dashboard/student-syllabus/${uid}`
        : "/dashboard/syllabus",
    matchPrefix: "/dashboard/syllabus,/dashboard/student-syllabus",
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.STUDENT],
  },
  { label: "Alerts",       icon: "🔔", href: "/dashboard/alerts",         roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Audit Logs",   icon: "📋", href: "/dashboard/audit-logs",     roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Leaderboards", icon: "🏆", href: "/dashboard/leaderboards",   roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "My Score",     icon: "⭐", href: "/dashboard/teacher-score",  roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Faculty Suite",icon: "🎓", href: "/dashboard/teacher",        roles: [ROLES.TEACHER], matchPrefix: "/dashboard/teacher" },
];

const BOTTOM_NAV_LABELS = ["Center Suite", "Attendance", "Syllabus", "Students", "Faculty Suite"];

// ─── Layout ───────────────────────────────────────────────────────────────────
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router            = useRouter();
  const pathname          = usePathname();
  const isMobile          = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const redirectingRef    = useRef(false);

  const canSeeAlerts = user?.role === ROLES.SUPER_ADMIN || user?.role === ROLES.ADMIN;
  const alertCount   = useAlertCount(canSeeAlerts);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
      router.replace("/login");
      return;
    }
    if (user.role === ROLES.TEACHER && pathname === "/dashboard") {
      router.replace("/dashboard/teacher");
    }
  }, [loading, user, pathname, router]);

  async function handleSignOut() {
    await signOut();
    document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
    router.replace("/login");
  }

  if (loading) {
    return (
      <div style={{ height: "100dvh", background: "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={s.loadingPulse} />
      </div>
    );
  }

  if (!user) {
    return <div style={{ height: "100dvh", background: "var(--color-bg)" }} />;
  }

  const visibleNav = NAV_ITEMS
    .filter(item => item.roles.includes(user.role))
    .map(item => ({
      ...item,
      resolvedHref: typeof item.href === "function"
        ? item.href(user.uid, user.role)
        : item.href,
    }));

  function isActive(item: (typeof visibleNav)[number]): boolean {
    if (pathname === item.resolvedHref) return true;
    const prefixes = (item.matchPrefix ?? item.resolvedHref).split(",");
    return prefixes.some(p => p !== "/dashboard" && pathname.startsWith(p));
  }

  const pageTitle = visibleNav.find(isActive)?.label ?? "Dashboard";
  const initials  = user.displayName.charAt(0).toUpperCase();
  const roleLabel = user.role.replace(/_/g, " ");

  const bottomNav = BOTTOM_NAV_LABELS
    .map(label => visibleNav.find(i => i.label === label))
    .filter((i): i is (typeof visibleNav)[number] => i !== undefined);

  // ── Shared nav links ───────────────────────────────────────────────────────
  function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
    return (
      <>
        {visibleNav.map(item => {
          const active = isActive(item);
          return (
            <a
              key={item.resolvedHref}
              href={item.resolvedHref}
              onClick={onNavigate}
              style={{ ...s.navItem, ...(active ? s.navItemActive : {}) }}
            >
              <span style={{ ...s.navIcon, ...(active ? s.navIconActive : {}) }}>
                {item.icon}
              </span>
              <span style={s.navLabel}>{item.label}</span>
              {item.label === "Alerts" && alertCount > 0 && (
                <span style={s.navBadge}>{alertCount}</span>
              )}
              {active && <span style={s.navActivePip} />}
            </a>
          );
        })}
      </>
    );
  }

  // ── MOBILE ─────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div style={s.mobileShell}>
        <header style={s.mobileTopbar}>
          <button onClick={() => setDrawerOpen(true)} style={s.hamburger} aria-label="Open menu">
            <span style={s.hLine} /><span style={s.hLine} /><span style={s.hLine} />
          </button>
          <div style={s.mobileCenter}>
            <span style={s.mobileLogo}>ROL<span style={{ color: "var(--color-accent)" }}>·</span>Plus</span>
            <span style={s.mobilePageTitle}>{pageTitle}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {canSeeAlerts && alertCount > 0 && (
              <a href="/dashboard/alerts" style={s.alertBubble}>
                🔔<span style={s.alertBadge}>{alertCount}</span>
              </a>
            )}
            <div style={s.avatar}>{initials}</div>
          </div>
        </header>

        {drawerOpen && <div style={s.overlay} onClick={() => setDrawerOpen(false)} />}

        <aside style={{ ...s.drawer, transform: drawerOpen ? "translateX(0)" : "translateX(-110%)" }}>
          <div style={s.drawerHead}>
            <div style={s.brandRow}>
              <div style={s.logoBox}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M9 18V5l12-2v13" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="6" cy="18" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
                  <circle cx="18" cy="16" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
                </svg>
              </div>
              <div>
                <div style={s.logoText}>ROL's Plus</div>
                <div style={s.roleTag}>{roleLabel}</div>
              </div>
            </div>
            <button onClick={() => setDrawerOpen(false)} style={s.closeBtn}>✕</button>
          </div>
          <nav style={s.drawerNav}><NavLinks onNavigate={() => setDrawerOpen(false)} /></nav>
          <div style={s.drawerFoot}>
            <div style={s.userRow}>
              <div style={s.avatarLg}>{initials}</div>
              <div style={s.userMeta}>
                <div style={s.userName}>{user.displayName}</div>
                <div style={s.userEmail}>{user.email}</div>
              </div>
            </div>
            <button onClick={handleSignOut} style={s.signOutBtn}>
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                <path d="M7 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M13 14l4-4-4-4M17 10H7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Sign out
            </button>
          </div>
        </aside>

        <main style={s.mobileMain}>{children}</main>

        {bottomNav.length > 0 && (
          <nav style={s.bottomNav}>
            {bottomNav.map(item => {
              const active = isActive(item);
              return (
                <a
                  key={item.resolvedHref}
                  href={item.resolvedHref}
                  style={{ ...s.bnItem, ...(active ? s.bnItemActive : {}) }}
                >
                  <span style={{ ...s.bnIcon, ...(active ? s.bnIconActive : {}) }}>{item.icon}</span>
                  <span style={s.bnLabel}>{item.label}</span>
                  {active && <span style={s.bnPip} />}
                </a>
              );
            })}
          </nav>
        )}
      </div>
    );
  }

  // ── DESKTOP ────────────────────────────────────────────────────────────────
  return (
    <div style={s.shell}>
      <aside style={s.sidebar}>
        <div style={s.sidebarAccent} />
        <div style={s.sidebarHead}>
          <div style={s.logoBox}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 18V5l12-2v13" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="6" cy="18" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
              <circle cx="18" cy="16" r="3" stroke="#f59e0b" strokeWidth="1.8"/>
            </svg>
          </div>
          <div>
            <div style={s.logoText}>ROL's Plus</div>
            <div style={s.roleTag}>{roleLabel}</div>
          </div>
        </div>

        <div style={s.navSectionLabel}>Menu</div>
        <nav style={s.nav}><NavLinks /></nav>

        <div style={s.sidebarFoot}>
          <div style={s.userRow}>
            <div style={s.avatarLg}>{initials}</div>
            <div style={s.userMeta}>
              <div style={s.userName}>{user.displayName}</div>
              <div style={s.userEmail}>{user.email}</div>
            </div>
          </div>
          <button onClick={handleSignOut} style={s.signOutBtn}>
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
              <path d="M7 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M13 14l4-4-4-4M17 10H7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      <div style={s.rightPanel}>
        <header style={s.topbar}>
          <div style={s.topbarBread}>
            <span style={s.breadRoot}>ROL's Plus</span>
            <span style={s.breadSep}>/</span>
            <span style={s.breadPage}>{pageTitle}</span>
          </div>
          <div style={s.topbarRight}>
            {canSeeAlerts && (
              <a href="/dashboard/alerts" style={s.alertBubble} aria-label={`${alertCount} alerts`}>
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                  <path d="M10 2a6 6 0 0 0-6 6v3l-1.5 2.5h15L16 11V8a6 6 0 0 0-6-6z" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M8 16a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
                {alertCount > 0 && <span style={s.alertBadge}>{alertCount}</span>}
              </a>
            )}
            <div style={s.topbarUser}>
              <div style={s.avatar}>{initials}</div>
              <div>
                <div style={s.topbarName}>{user.displayName}</div>
                <div style={s.topbarRole}>{roleLabel}</div>
              </div>
            </div>
          </div>
        </header>
        <main style={s.main}>{children}</main>
      </div>
    </div>
  );
}

// ─── Styles — gold/amber theme ────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {

  loadingPulse: {
    width: 10, height: 10, borderRadius: "50%",
    background: "var(--color-accent)",
    boxShadow: "0 0 16px 4px var(--color-accent-glow)",
    animation: "goldPulse 1.6s ease infinite",
  },

  shell:   { display: "flex", height: "100vh", overflow: "hidden", background: "var(--color-bg)" },
  sidebar: {
    width: 220, flexShrink: 0,
    display: "flex", flexDirection: "column",
    background: "var(--color-surface)",
    borderRight: "1px solid var(--color-border)",
    position: "relative",
  },
  sidebarAccent: {
    position: "absolute", top: 0, left: 0, right: 0, height: 2,
    background: "linear-gradient(90deg, #f59e0b, #d97706, transparent)",
  },
  sidebarHead: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "20px 14px 14px",
    borderBottom: "1px solid var(--color-border-subtle)",
  },
  navSectionLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "var(--color-text-muted)",
    padding: "14px 16px 5px",
  },
  nav:         { flex: 1, padding: "0 7px", display: "flex", flexDirection: "column", gap: 1, overflowY: "auto" },
  sidebarFoot: { padding: "12px 9px", borderTop: "1px solid var(--color-border-subtle)", marginTop: "auto" },

  navItem: {
    display: "flex", alignItems: "center", gap: 9,
    padding: "8px 9px", borderRadius: 8,
    fontSize: 13, fontWeight: 400,
    color: "var(--color-text-secondary)",
    textDecoration: "none",
    transition: "background 0.15s, color 0.15s",
    position: "relative",
  },
  navItemActive: {
    background: "var(--color-accent-dim)",
    color: "var(--color-accent)",
    fontWeight: 600,
    boxShadow: "inset 0 0 0 1px var(--color-accent-border)",
  },
  navIcon:      { fontSize: 14, width: 20, textAlign: "center", flexShrink: 0, opacity: 0.65 },
  navIconActive:{ opacity: 1 },
  navLabel:     { flex: 1 },
  navBadge: {
    minWidth: 18, height: 18, borderRadius: 99,
    background: "var(--color-danger)", color: "#fff",
    fontSize: 10, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", padding: "0 5px",
  },
  navActivePip: {
    position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
    width: 3, height: 16, borderRadius: "0 3px 3px 0",
    background: "var(--color-accent)",
    boxShadow: "2px 0 8px var(--color-accent-glow)",
  },

  rightPanel: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  topbar: {
    height: 52, flexShrink: 0,
    background: "var(--color-surface)",
    borderBottom: "1px solid var(--color-border)",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0 24px",
  },
  topbarBread: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 },
  breadRoot:   { color: "var(--color-text-muted)" },
  breadSep:    { color: "var(--color-text-muted)", opacity: 0.4 },
  breadPage:   { color: "var(--color-text-primary)", fontWeight: 700 },
  topbarRight: { display: "flex", alignItems: "center", gap: 12 },
  topbarUser:  { display: "flex", alignItems: "center", gap: 9 },
  topbarName:  { fontSize: 12.5, fontWeight: 600, color: "var(--color-text-primary)", lineHeight: 1.2 },
  topbarRole:  { fontSize: 10.5, color: "var(--color-text-muted)", textTransform: "capitalize", lineHeight: 1.2 },
  main:        { flex: 1, overflowY: "auto", padding: "28px 32px", background: "var(--color-bg)" },

  logoBox: {
    width: 32, height: 32, borderRadius: 9,
    background: "rgba(245,158,11,0.10)",
    border: "1px solid rgba(245,158,11,0.25)",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  logoText: { fontSize: 13.5, fontWeight: 800, color: "var(--color-text-primary)", letterSpacing: "-0.3px", lineHeight: 1.2 },
  roleTag:  { fontSize: 9.5, fontWeight: 700, textTransform: "capitalize", color: "var(--color-accent)", letterSpacing: "0.05em", marginTop: 2 },
  brandRow: { display: "flex", alignItems: "center", gap: 10 },

  userRow:  { display: "flex", alignItems: "center", gap: 9, marginBottom: 10 },
  avatarLg: {
    width: 32, height: 32, borderRadius: "50%",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    color: "#0a0a0a", fontSize: 13, fontWeight: 800,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, boxShadow: "0 0 10px rgba(245,158,11,0.25)",
  },
  userMeta:  { overflow: "hidden", flex: 1 },
  userName:  { fontSize: 12.5, fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  userEmail: { fontSize: 10.5, color: "var(--color-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  signOutBtn:{
    width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
    gap: 6, padding: "7px 0",
    background: "transparent", border: "1px solid var(--color-border)",
    borderRadius: 7, fontSize: 12,
    color: "var(--color-text-secondary)", cursor: "pointer",
    transition: "border-color 0.15s, color 0.15s",
  },

  alertBubble: {
    position: "relative", display: "inline-flex",
    alignItems: "center", justifyContent: "center",
    width: 34, height: 34, borderRadius: "50%",
    background: "var(--color-surface-2)",
    border: "1px solid var(--color-border)",
    color: "var(--color-text-secondary)",
    textDecoration: "none", cursor: "pointer", flexShrink: 0,
    transition: "border-color 0.15s",
  },
  alertBadge: {
    position: "absolute", top: -3, right: -3,
    minWidth: 16, height: 16, borderRadius: 99,
    background: "var(--color-danger)", color: "#fff",
    fontSize: 9, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "0 4px", border: "2px solid var(--color-surface)",
  },
  avatar: {
    width: 32, height: 32, borderRadius: "50%",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    color: "#0a0a0a", fontSize: 13, fontWeight: 800,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, boxShadow: "0 0 10px rgba(245,158,11,0.20)",
  },

  mobileShell:     { display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden", background: "var(--color-bg)" },
  mobileTopbar:    { height: 52, flexShrink: 0, background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", padding: "0 12px", gap: 10, zIndex: 100 },
  hamburger:       { background: "none", border: "none", cursor: "pointer", padding: "6px 4px", display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 },
  hLine:           { display: "block", width: 20, height: 2, background: "var(--color-text-secondary)", borderRadius: 99 },
  mobileCenter:    { flex: 1, display: "flex", flexDirection: "column", gap: 1 },
  mobileLogo:      { fontSize: 9.5, fontWeight: 700, color: "var(--color-text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", lineHeight: 1 },
  mobilePageTitle: { fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.2 },
  mobileMain:      { flex: 1, overflowY: "auto", padding: "16px 14px 76px", background: "var(--color-bg)" },

  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", zIndex: 200 },
  drawer: {
    position: "fixed", top: 0, left: 0, bottom: 0, width: 264,
    background: "var(--color-surface)", borderRight: "1px solid var(--color-border)",
    zIndex: 300, display: "flex", flexDirection: "column",
    transition: "transform 0.26s cubic-bezier(0.4,0,0.2,1)",
    boxShadow: "8px 0 40px rgba(0,0,0,0.5)",
  },
  drawerHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 14px 14px", borderBottom: "1px solid var(--color-border-subtle)" },
  closeBtn:   { background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "var(--color-text-muted)", padding: 4, lineHeight: 1, borderRadius: 6 },
  drawerNav:  { flex: 1, padding: "10px 7px", display: "flex", flexDirection: "column", gap: 1, overflowY: "auto" },
  drawerFoot: { padding: "12px 9px", borderTop: "1px solid var(--color-border-subtle)" },

  bottomNav:    { position: "fixed", bottom: 0, left: 0, right: 0, height: 60, background: "var(--color-surface)", borderTop: "1px solid var(--color-border)", display: "flex", zIndex: 100 },
  bnItem:       { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, textDecoration: "none", color: "var(--color-text-muted)", padding: "4px 0 6px", position: "relative", transition: "color 0.15s" },
  bnItemActive: { color: "var(--color-accent)" },
  bnIcon:       { fontSize: 18, lineHeight: 1, transition: "transform 0.15s" },
  bnIconActive: { transform: "scale(1.14)" },
  bnLabel:      { fontSize: 9, fontWeight: 600, letterSpacing: "0.03em", textAlign: "center" },
  bnPip:        { position: "absolute", top: 5, width: 4, height: 4, borderRadius: "50%", background: "var(--color-accent)", boxShadow: "0 0 6px var(--color-accent-glow)" },
};
