"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/useIsMobile";
import { clearPersistedSession, signOut } from "@/services/firebase/auth.service";
import { ROLES } from "@/config/constants";

// ─── Alert count hook ──────────────────────────────────────────────────────────
function useAlertCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
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
  }, []);
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

interface NavGroup {
  label: string;
  icon:  string;
  items: NavItem[];
}

const NAV_TOP: NavItem[] = [
  { label: "Center Suite",    icon: "⊞",  href: "/dashboard",         roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Learner's Suite", icon: "🎓", href: "/dashboard/student", roles: [ROLES.STUDENT] },
  {
    label: "My Quest", icon: "📚",
    href: (uid) => `/dashboard/student-syllabus/${uid}`,
    matchPrefix: "/dashboard/student-syllabus",
    roles: [ROLES.STUDENT],
  },
  { label: "My Fees",         icon: "₹",  href: "/dashboard/my-fees",         roles: [ROLES.STUDENT] },
  { label: "My Streak",  icon: "🔥", href: "/dashboard/my-attendance",   roles: [ROLES.STUDENT] },
  { label: "My Badges", icon: "🏅", href: "/dashboard/my-achievements", roles: [ROLES.STUDENT] },
];

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Academic Suite", icon: "🎓",
    items: [
      { label: "Centers",       icon: "🏫", href: "/dashboard/centers",        roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Teachers",      icon: "👥", href: "/dashboard/teachers",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Admins",        icon: "👤", href: "/dashboard/admins",         roles: [ROLES.SUPER_ADMIN] },
      { label: "Students",      icon: "🎓", href: "/dashboard/students",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Attendance",    icon: "✓",  href: "/dashboard/attendance",     roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Syllabus",      icon: "📚", href: "/dashboard/syllabus",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Faculty Suite", icon: "🎓", href: "/dashboard/teacher",        roles: [ROLES.TEACHER], matchPrefix: "/dashboard/teacher" },
      { label: "Screening",     icon: "🎹", href: "/dashboard/screening",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER], matchPrefix: "/dashboard/screening,/dashboard/screening/fast-track" },
    ],
  },
  {
    label: "Finance", icon: "₹",
    items: [
      { label: "Finance", icon: "₹", href: "/dashboard/finance", roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
    ],
  },
  {
    label: "Insights & Reports", icon: "📊",
    items: [
      { label: "Analytics",    icon: "📊", href: "/dashboard/analytics",      roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Leaderboards", icon: "🏆", href: "/dashboard/leaderboards",   roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "My Score",     icon: "⭐", href: "/dashboard/teacher-score",  roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Export",       icon: "⬇", href: "/dashboard/export",          roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
    ],
  },
  {
    label: "System Admin", icon: "⚙️",
    items: [
      { label: "Alerts",     icon: "🔔", href: "/dashboard/alerts",     roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "Audit Logs", icon: "📋", href: "/dashboard/audit-logs", roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
      { label: "History",    icon: "🕐", href: "/dashboard/history",    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
    ],
  },
];

const BOTTOM_NAV_LABELS = ["Center Suite", "Learner's Suite", "My Quest", "My Fees", "My Streak", "My Badges", "Attendance", "Students", "Faculty Suite"];

// ─── Layout ───────────────────────────────────────────────────────────────────
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router            = useRouter();
  const pathname          = usePathname();
  const isMobile          = useIsMobile();
  const [drawerOpen,  setDrawerOpen]  = useState(false);
  const [openGroups,  setOpenGroups]  = useState<Set<string>>(new Set());
  const redirectingRef  = useRef(false);
  const hasRestoredRef  = useRef(false);

  const canSeeAlerts = user?.role === ROLES.SUPER_ADMIN || user?.role === ROLES.ADMIN;
  const alertCount   = useAlertCount(canSeeAlerts);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      clearPersistedSession();
      router.replace("/login");
      return;
    }
    if (user.role === ROLES.TEACHER && pathname === "/dashboard") {
      router.replace("/dashboard/teacher");
    }
  }, [loading, user, pathname, router]);

  // Save current path so admin/super_admin can resume after reopening
  useEffect(() => {
    if (!user) return;
    if (user.role !== ROLES.ADMIN && user.role !== ROLES.SUPER_ADMIN) return;
    if (pathname === "/dashboard") return;
    const save = () => localStorage.setItem("rol_nav", JSON.stringify({ path: pathname, ts: Date.now() }));
    save();
    const onHide = () => { if (document.visibilityState === "hidden") save(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [pathname, user]);

  // Restore last path if app reopened within 5 minutes
  useEffect(() => {
    if (hasRestoredRef.current || loading || !user) return;
    if (user.role !== ROLES.ADMIN && user.role !== ROLES.SUPER_ADMIN) return;
    if (pathname !== "/dashboard") return;
    hasRestoredRef.current = true;
    try {
      const raw = localStorage.getItem("rol_nav");
      if (!raw) return;
      const { path, ts } = JSON.parse(raw) as { path: string; ts: number };
      if (path && path !== "/dashboard" && Date.now() - ts < 300_000) {
        router.replace(path);
      }
    } catch { /* ignore */ }
  }, [loading, user, pathname, router]);

  // Auto-open the group containing the active item whenever pathname changes
  useEffect(() => {
    if (!user) return;
    const { role, uid } = user;
    for (const group of NAV_GROUPS) {
      const hasActive = group.items
        .filter(item => item.roles.includes(role))
        .some(item => {
          const href = typeof item.href === "function" ? item.href(uid, role) : item.href;
          if (pathname === href) return true;
          const prefixes = (item.matchPrefix ?? href).split(",");
          return prefixes.some(p => p !== "/dashboard" && pathname.startsWith(p));
        });
      if (hasActive) {
        setOpenGroups(prev => prev.has(group.label) ? prev : new Set([...prev, group.label]));
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, user?.uid, user?.role]);

  async function handleSignOut() {
    await signOut();
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

  // ── Derived nav data ────────────────────────────────────────────────────────

  // Flat list — used for pageTitle, bottomNav, isActive
  const visibleNav = [...NAV_TOP, ...NAV_GROUPS.flatMap(g => g.items)]
    .filter(item => item.roles.includes(user.role))
    .map(item => ({
      ...item,
      resolvedHref: typeof item.href === "function"
        ? item.href(user.uid, user.role)
        : item.href,
    }));

  // Top-level standalone items (rendered above accordion groups)
  const topNavItems = NAV_TOP
    .filter(item => item.roles.includes(user.role))
    .map(item => ({
      ...item,
      resolvedHref: typeof item.href === "function"
        ? item.href(user.uid, user.role)
        : item.href,
    }));

  // Grouped list — used for the accordion sidebar
  const visibleGroups = NAV_GROUPS
    .map(group => ({
      ...group,
      visibleItems: group.items
        .filter(item => item.roles.includes(user.role))
        .map(item => ({
          ...item,
          resolvedHref: typeof item.href === "function"
            ? item.href(user.uid, user.role)
            : item.href,
        })),
    }))
    .filter(g => g.visibleItems.length > 0);

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

  // ── Accordion nav groups ────────────────────────────────────────────────────
  function NavGroups({ onNavigate }: { onNavigate?: () => void }) {
    return (
      <>
        {topNavItems.map(item => {
          const active = isActive(item);
          return (
            <Link
              key={item.resolvedHref}
              href={item.resolvedHref}
              onClick={onNavigate}
              style={{ ...s.navItem, ...(active ? s.navItemActive : {}), marginBottom: 4 }}
            >
              <span style={{ ...s.navIcon, ...(active ? s.navIconActive : {}) }}>{item.icon}</span>
              <span style={s.navLabel}>{item.label}</span>
              {active && <span style={s.navActivePip} />}
            </Link>
          );
        })}
        {visibleGroups.map((group) => {
          const isOpen    = openGroups.has(group.label);
          const hasActive = group.visibleItems.some(item => isActive(item));

          return (
            <div key={group.label} style={s.groupWrap}>
              {/* Group header toggle */}
              <button
                onClick={() =>
                  setOpenGroups(prev => {
                    const next = new Set(prev);
                    next.has(group.label) ? next.delete(group.label) : next.add(group.label);
                    return next;
                  })
                }
                style={{ ...s.groupBtn, ...(hasActive ? s.groupBtnActive : {}) }}
              >
                <span style={s.groupIcon}>{group.icon}</span>
                <span style={{ ...s.groupLabel, ...(hasActive ? s.groupLabelActive : {}) }}>
                  {group.label}
                </span>
                <span style={{ ...s.groupChevron, ...(isOpen ? s.groupChevronOpen : {}) }}>
                  ›
                </span>
              </button>

              {/* Collapsible items */}
              {isOpen && (
                <div style={s.groupItems}>
                  {group.visibleItems.map(item => {
                    const active = isActive(item);
                    return (
                      <Link
                        key={item.resolvedHref}
                        href={item.resolvedHref}
                        onClick={onNavigate}
                        style={{ ...s.navItem, ...s.navItemSub, ...(active ? s.navItemActive : {}) }}
                      >
                        <span style={{ ...s.navIcon, ...(active ? s.navIconActive : {}) }}>
                          {item.icon}
                        </span>
                        <span style={s.navLabel}>{item.label}</span>
                        {item.label === "Alerts" && alertCount > 0 && (
                          <span style={s.navBadge}>{alertCount}</span>
                        )}
                        {active && <span style={s.navActivePip} />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
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
              <Link href="/dashboard/alerts" style={s.alertBubble}>
                🔔<span style={s.alertBadge}>{alertCount}</span>
              </Link>
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
          <nav style={s.drawerNav}>
            <NavGroups onNavigate={() => setDrawerOpen(false)} />
          </nav>
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
          <nav className="rl-bn">
            {bottomNav.map(item => {
              const active = isActive(item);
              return (
                <Link
                  key={item.resolvedHref}
                  href={item.resolvedHref}
                  className={`rl-bn-item${active ? " rl-active" : ""}`}
                >
                  <span className="rl-bn-icon">{item.icon}</span>
                  <span className="rl-bn-label">{item.label}</span>
                  {active && <span className="rl-bn-pip" />}
                </Link>
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

        <nav style={s.nav}>
          <NavGroups />
        </nav>

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
              <Link href="/dashboard/alerts" style={s.alertBubble} aria-label={`${alertCount} alerts`}>
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                  <path d="M10 2a6 6 0 0 0-6 6v3l-1.5 2.5h15L16 11V8a6 6 0 0 0-6-6z" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M8 16a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
                {alertCount > 0 && <span style={s.alertBadge}>{alertCount}</span>}
              </Link>
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

  shell:   { display: "flex", height: "100dvh", overflow: "hidden", background: "var(--color-bg)" },
  sidebar: {
    width: 224, flexShrink: 0,
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

  // ── Accordion groups ─────────────────────────────────────────────────────
  nav: { flex: 1, padding: "10px 7px 6px", overflowY: "auto" },

  groupWrap: {
    marginBottom: 2,
  },
  groupBtn: {
    width: "100%", display: "flex", alignItems: "center", gap: 6,
    padding: "7px 9px 7px", background: "none", border: "none",
    borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
    transition: "background 0.15s",
  },
  groupBtnActive: {
    background: "var(--color-accent-dim)",
  },
  groupIcon: {
    fontSize: 12, width: 18, textAlign: "center", flexShrink: 0, opacity: 0.55,
  },
  groupLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.07em",
    textTransform: "uppercase", color: "var(--color-text-muted)",
    flex: 1, textAlign: "left",
  },
  groupLabelActive: {
    color: "var(--color-accent)",
  },
  groupChevron: {
    fontSize: 14, color: "var(--color-text-muted)", lineHeight: 1,
    opacity: 0.45, transition: "transform 0.18s", display: "inline-block",
  },
  groupChevronOpen: {
    transform: "rotate(90deg)",
  },
  groupItems: {
    paddingBottom: 6,
  },

  // ── Nav items ─────────────────────────────────────────────────────────────
  navItem: {
    display: "flex", alignItems: "center", gap: 9,
    padding: "7px 9px", borderRadius: 8,
    fontSize: 13, fontWeight: 400,
    color: "var(--color-text-secondary)",
    textDecoration: "none",
    transition: "background 0.15s, color 0.15s",
    position: "relative",
  },
  navItemSub: {
    paddingLeft: 13,
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

  sidebarFoot: { padding: "12px 9px", borderTop: "1px solid var(--color-border-subtle)", marginTop: "auto" },

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
  mobileTopbar:    { flexShrink: 0, background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", paddingTop: "max(14px, env(safe-area-inset-top, 14px))", paddingBottom: 10, paddingLeft: "max(12px, env(safe-area-inset-left, 12px))", paddingRight: "max(12px, env(safe-area-inset-right, 12px))", gap: 10, zIndex: 100 },
  hamburger:       { background: "none", border: "none", cursor: "pointer", padding: "6px 4px", display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 },
  hLine:           { display: "block", width: 20, height: 2, background: "var(--color-text-secondary)", borderRadius: 99 },
  mobileCenter:    { flex: 1, display: "flex", flexDirection: "column", gap: 1 },
  mobileLogo:      { fontSize: 9.5, fontWeight: 700, color: "var(--color-text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", lineHeight: 1 },
  mobilePageTitle: { fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.2 },
  mobileMain:      { flex: 1, overflowY: "auto", padding: "16px 14px max(80px, calc(env(safe-area-inset-bottom, 0px) + 74px))", background: "var(--color-bg)" },

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
  drawerNav:  { flex: 1, padding: "10px 7px 6px", overflowY: "auto" },
  drawerFoot: { padding: "12px 9px", borderTop: "1px solid var(--color-border-subtle)" },

};
