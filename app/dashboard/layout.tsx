"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/useIsMobile";
import { signOut } from "@/services/firebase/auth.service";
import { ROLES } from "@/config/constants";

// ─── Nav config ───────────────────────────────────────────────────────────────

interface NavItem {
  label:        string;
  icon:         string;
  href:         string | ((uid: string, role: string) => string);
  matchPrefix?: string;
  roles:        string[];
}

const NAV_ITEMS: NavItem[] = [
  // ── Admin / Super Admin / Student nav ──────────────────────────────────────
  { label: "Dashboard",    icon: "⊞",  href: "/dashboard",               roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.STUDENT] },
  { label: "Centers",      icon: "🏫", href: "/dashboard/centers",        roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Teachers",     icon: "👥", href: "/dashboard/teachers",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Admins",       icon: "👤", href: "/dashboard/admins",         roles: [ROLES.SUPER_ADMIN] },
  { label: "Students",     icon: "👥", href: "/dashboard/students",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Attendance",   icon: "✓",  href: "/dashboard/attendance",     roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.STUDENT] },
  { label: "Finance",      icon: "₹",  href: "/dashboard/finance",        roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  {
    label: "Syllabus",     icon: "📚",
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
  { label: "Super Admin",  icon: "⚙",  href: "/dashboard/super-admin",   roles: [ROLES.SUPER_ADMIN] },

  // ── Teacher: single entry point — all navigation is inside Faculty Suite ──
  { label: "Faculty Suite", icon: "🎓", href: "/dashboard/teacher",       roles: [ROLES.TEACHER], matchPrefix: "/dashboard/teacher" },
];

// Mobile bottom nav per role
const BOTTOM_NAV_LABELS = ["Dashboard", "Attendance", "Syllabus", "Students", "My Score", "Faculty Suite"];

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router            = useRouter();
  const pathname          = usePathname();
  const isMobile          = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const redirectingRef    = useRef(false);

  // CRITICAL: Never call router.replace() during render — it triggers a
  // navigation on every render cycle, causing an infinite reload loop on mobile.
  // Always redirect inside useEffect which runs only once after paint.
  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
      router.replace("/login");
      return;
    }
    // Teachers have a single entry point — redirect /dashboard → /dashboard/teacher
    if (user.role === ROLES.TEACHER && pathname === "/dashboard") {
      router.replace("/dashboard/teacher");
    }
  }, [loading, user, pathname, router]);

  async function handleSignOut() {
    await signOut();
    document.cookie = "rol_session=; path=/; max-age=0; SameSite=Lax";
    router.replace("/login");
  }

  // Show a stable loading screen while auth resolves.
  // Returning null here causes a blank flash on every render — on mobile
  // this appears as a white blink between every navigation.
  if (loading) {
    return (
      <div style={{
        height: "100dvh",
        background: "var(--color-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }} />
    );
  }

  // Auth resolved but no user — redirect is queued in useEffect above.
  // Return the same loading screen so there's no flash of content.
  if (!user) {
    return (
      <div style={{
        height: "100dvh",
        background: "var(--color-bg)",
      }} />
    );
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

  const bottomNav = BOTTOM_NAV_LABELS
    .map(label => visibleNav.find(i => i.label === label))
    .filter((i): i is (typeof visibleNav)[number] => i !== undefined);

  function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
    return (
      <>
        {visibleNav.map(item => (
          <a
            key={item.resolvedHref}
            href={item.resolvedHref}
            onClick={onNavigate}
            style={{ ...s.navItem, ...(isActive(item) ? s.navItemActive : {}) }}
          >
            <span style={s.navIcon}>{item.icon}</span>
            <span>{item.label}</span>
          </a>
        ))}
      </>
    );
  }

  // ── MOBILE ─────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div style={s.mobileShell}>

        <header style={s.mobileTopbar}>
          <button onClick={() => setDrawerOpen(true)} style={s.hamburger} aria-label="Open menu">☰</button>
          <div style={s.mobileTopbarCenter}>
            <span style={s.mobileLogo}>ROL</span>
            <span style={s.mobilePageTitle}>{pageTitle}</span>
          </div>
          <div style={s.mobileAvatar}>{initials}</div>
        </header>

        {drawerOpen && <div style={s.drawerOverlay} onClick={() => setDrawerOpen(false)} />}

        <aside style={{ ...s.drawer, transform: drawerOpen ? "translateX(0)" : "translateX(-100%)" }}>
          <div style={s.drawerHeader}>
            <div>
              <div style={s.logo}>ROL's Plus</div>
              <div style={s.roleTag}>{user.role.replace(/_/g, " ")}</div>
            </div>
            <button onClick={() => setDrawerOpen(false)} style={s.drawerClose}>✕</button>
          </div>
          <nav style={s.drawerNav}>
            <NavLinks onNavigate={() => setDrawerOpen(false)} />
          </nav>
          <div style={s.drawerFooter}>
            <div style={s.userInfo}>
              <div style={s.userAvatar}>{initials}</div>
              <div style={s.userMeta}>
                <div style={s.userName}>{user.displayName}</div>
                <div style={s.userEmail}>{user.email}</div>
              </div>
            </div>
            <button onClick={handleSignOut} style={s.signOutBtn}>Sign out</button>
          </div>
        </aside>

        <main style={s.mobileMain}>{children}</main>

        {bottomNav.length > 0 && (
          <nav style={s.bottomNav}>
            {bottomNav.map(item => (
              <a
                key={item.resolvedHref}
                href={item.resolvedHref}
                style={{ ...s.bottomNavItem, ...(isActive(item) ? s.bottomNavItemActive : {}) }}
              >
                <span style={s.bottomNavIcon}>{item.icon}</span>
                <span style={s.bottomNavLabel}>{item.label}</span>
              </a>
            ))}
          </nav>
        )}
      </div>
    );
  }

  // ── DESKTOP ────────────────────────────────────────────────────────────────
  return (
    <div style={s.shell}>
      <aside style={s.sidebar}>
        <div style={s.sidebarTop}>
          <div style={s.logo}>ROL</div>
          <div style={s.roleTag}>{user.role.replace(/_/g, " ")}</div>
        </div>
        <nav style={s.nav}><NavLinks /></nav>
        <div style={s.sidebarBottom}>
          <div style={s.userInfo}>
            <div style={s.userAvatar}>{initials}</div>
            <div style={s.userMeta}>
              <div style={s.userName}>{user.displayName}</div>
              <div style={s.userEmail}>{user.email}</div>
            </div>
          </div>
          <button onClick={handleSignOut} style={s.signOutBtn}>Sign out</button>
        </div>
      </aside>
      <div style={s.rightPanel}>
        <header style={s.topbar}>
          <div style={s.topbarTitle}>{pageTitle}</div>
          <span style={s.topbarUser}>{user.email}</span>
        </header>
        <main style={s.main}>{children}</main>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  // Desktop
  shell:               { display: "flex", height: "100vh", overflow: "hidden" },
  sidebar:             { width: 220, flexShrink: 0, borderRight: "1px solid var(--color-border)", background: "var(--color-surface)", display: "flex", flexDirection: "column", padding: "20px 0" },
  sidebarTop:          { padding: "0 20px 16px", borderBottom: "1px solid var(--color-border)", marginBottom: 12 },
  nav:                 { flex: 1, padding: "0 10px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" },
  sidebarBottom:       { padding: "14px 14px 0", borderTop: "1px solid var(--color-border)", marginTop: "auto" },
  rightPanel:          { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  topbar:              { height: 52, flexShrink: 0, borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px" },
  topbarTitle:         { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" },
  topbarUser:          { fontSize: 12, color: "var(--color-text-secondary)" },
  main:                { flex: 1, overflowY: "auto", padding: "28px 32px" },

  // Shared nav
  navItem:             { display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 7, fontSize: 13, fontWeight: 400, color: "var(--color-text-secondary)", textDecoration: "none", transition: "background 0.12s" },
  navItemActive:       { background: "#ede9fe", color: "var(--color-accent)", fontWeight: 600 },
  navIcon:             { fontSize: 14, width: 18, textAlign: "center", flexShrink: 0 },

  // Shared identity
  logo:                { fontSize: 18, fontWeight: 700, color: "var(--color-accent)", letterSpacing: "-0.5px", marginBottom: 4 },
  roleTag:             { fontSize: 11, fontWeight: 500, textTransform: "capitalize", color: "var(--color-text-secondary)", background: "#f3f4f6", borderRadius: 4, padding: "2px 7px", display: "inline-block" },
  userInfo:            { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  userAvatar:          { width: 32, height: 32, borderRadius: "50%", background: "var(--color-accent)", color: "#fff", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  userMeta:            { overflow: "hidden", flex: 1 },
  userName:            { fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  userEmail:           { fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  signOutBtn:          { width: "100%", padding: "8px 0", background: "transparent", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" },

  // Mobile shell
  mobileShell:         { display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden", background: "var(--color-background)" },
  mobileTopbar:        { height: 52, flexShrink: 0, background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", padding: "0 12px", gap: 10, zIndex: 100 },
  hamburger:           { background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "var(--color-text-primary)", padding: "2px 4px", flexShrink: 0, lineHeight: 1 },
  mobileTopbarCenter:  { flex: 1, display: "flex", flexDirection: "column", gap: 1 },
  mobileLogo:          { fontSize: 9, fontWeight: 700, color: "var(--color-accent)", textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: 1 },
  mobilePageTitle:     { fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", lineHeight: 1.2 },
  mobileAvatar:        { width: 32, height: 32, borderRadius: "50%", background: "var(--color-accent)", color: "#fff", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  mobileMain:          { flex: 1, overflowY: "auto", padding: "16px 14px 80px" },

  // Drawer
  drawerOverlay:       { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200 },
  drawer:              { position: "fixed", top: 0, left: 0, bottom: 0, width: 260, background: "var(--color-surface)", zIndex: 300, display: "flex", flexDirection: "column", transition: "transform 0.24s ease", boxShadow: "4px 0 20px rgba(0,0,0,0.18)" },
  drawerHeader:        { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "20px 16px 16px", borderBottom: "1px solid var(--color-border)" },
  drawerClose:         { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--color-text-secondary)", padding: 0, lineHeight: 1 },
  drawerNav:           { flex: 1, padding: "10px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" },
  drawerFooter:        { padding: "14px", borderTop: "1px solid var(--color-border)" },

  // Bottom nav
  bottomNav:           { position: "fixed", bottom: 0, left: 0, right: 0, height: 60, background: "var(--color-surface)", borderTop: "1px solid var(--color-border)", display: "flex", zIndex: 100 },
  bottomNavItem:       { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, textDecoration: "none", color: "var(--color-text-secondary)", padding: "4px 0" },
  bottomNavItemActive: { color: "var(--color-accent)" },
  bottomNavIcon:       { fontSize: 18, lineHeight: 1 },
  bottomNavLabel:      { fontSize: 9, fontWeight: 600, letterSpacing: "0.02em", textAlign: "center", lineHeight: 1 },
};
