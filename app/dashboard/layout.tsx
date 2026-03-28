"use client";

import { type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { signOut } from "@/services/firebase/auth.service";
import { ROLES } from "@/config/constants";

interface NavItem {
  label:   string;
  // href can be a static string or a function that receives (uid, role) and returns a string
  href:    string | ((uid: string, role: string) => string);
  // matchPrefix is used for active-link detection when href is dynamic
  matchPrefix?: string;
  roles:   string[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",    href: "/dashboard",                     roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT] },
  { label: "Centers",      href: "/dashboard/centers",             roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Students",     href: "/dashboard/students",            roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER] },
  { label: "Attendance",   href: "/dashboard/attendance",          roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT] },
  { label: "Finance",      href: "/dashboard/finance",             roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  // Syllabus: Admin/Teacher → master syllabus manager; Student → their own lesson progress
  {
    label: "Syllabus",
    href:  (uid, role) =>
      role === ROLES.STUDENT
        ? `/dashboard/student-syllabus/${uid}`
        : "/dashboard/syllabus",
    matchPrefix: "/dashboard/syllabus",
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT],
  },
  { label: "Alerts",       href: "/dashboard/alerts",              roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Audit Logs",   href: "/dashboard/audit-logs",          roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "Leaderboards", href: "/dashboard/leaderboards",        roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  { label: "My Score",     href: "/dashboard/teacher-score",       roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER] },
  { label: "Super Admin",  href: "/dashboard/super-admin",         roles: [ROLES.SUPER_ADMIN] },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  async function handleSignOut() {
    await signOut();
    document.cookie = "rol_session=; path=/; max-age=0";
    router.replace("/login");
  }

  if (loading) return null;

  if (!user) {
    router.replace("/login");
    return null;
  }

  const visibleNav = NAV_ITEMS
    .filter(item => item.roles.includes(user.role))
    .map(item => ({
      ...item,
      resolvedHref: typeof item.href === "function"
        ? item.href(user.uid, user.role)
        : item.href,
    }));

  return (
    <div style={styles.shell}>

      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.sidebarTop}>
          <div style={styles.logo}>ROL</div>
          <div style={styles.roleTag}>{user.role.replace("_", " ")}</div>
        </div>

        <nav style={styles.nav}>
          {visibleNav.map(item => {
            const checkPrefix = item.matchPrefix ?? item.resolvedHref;
            const active =
              pathname === item.resolvedHref ||
              (checkPrefix !== "/dashboard" && pathname.startsWith(checkPrefix));
            return (
              <a
                key={item.resolvedHref}
                href={item.resolvedHref}
                style={{
                  ...styles.navItem,
                  ...(active ? styles.navItemActive : {}),
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div style={styles.sidebarBottom}>
          <div style={styles.userInfo}>
            <div style={styles.userAvatar}>
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={styles.userName}>{user.displayName}</div>
              <div style={styles.userEmail}>{user.email}</div>
            </div>
          </div>
          <button onClick={handleSignOut} style={styles.signOutBtn}>
            Sign out
          </button>
        </div>
      </aside>

      {/* Right panel: topbar + content */}
      <div style={styles.rightPanel}>

        {/* Topbar */}
        <header style={styles.topbar}>
          <div style={styles.topbarTitle}>
            {visibleNav.find(item => {
              const checkPrefix = item.matchPrefix ?? item.resolvedHref;
              return item.resolvedHref === pathname ||
                (checkPrefix !== "/dashboard" && pathname.startsWith(checkPrefix));
            })?.label ?? "Dashboard"}
          </div>
          <div style={styles.topbarRight}>
            <span style={styles.topbarUser}>{user.email}</span>
          </div>
        </header>

        {/* Main content */}
        <main style={styles.main}>
          {children}
        </main>

      </div>

    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: "flex",
    height: "100vh",
    overflow: "hidden",
  },
  sidebar: {
    width: 220,
    flexShrink: 0,
    borderRight: "1px solid var(--color-border)",
    background: "var(--color-surface)",
    display: "flex",
    flexDirection: "column",
    padding: "20px 0",
  },
  sidebarTop: {
    padding: "0 20px 20px",
    borderBottom: "1px solid var(--color-border)",
    marginBottom: 12,
  },
  logo: {
    fontSize: 20,
    fontWeight: 700,
    color: "var(--color-accent)",
    letterSpacing: "-0.5px",
    marginBottom: 4,
  },
  roleTag: {
    fontSize: 11,
    fontWeight: 500,
    textTransform: "capitalize",
    color: "var(--color-text-secondary)",
    background: "#f3f4f6",
    borderRadius: 4,
    padding: "2px 7px",
    display: "inline-block",
  },
  nav: {
    flex: 1,
    padding: "0 12px",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    overflowY: "auto",
  },
  navItem: {
    display: "block",
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 400,
    color: "var(--color-text-secondary)",
    transition: "background 0.1s, color 0.1s",
  },
  navItemActive: {
    background: "#ede9fe",
    color: "var(--color-accent)",
    fontWeight: 500,
  },
  sidebarBottom: {
    padding: "16px 16px 0",
    borderTop: "1px solid var(--color-border)",
    marginTop: "auto",
  },
  userInfo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  userAvatar: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: "var(--color-accent)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  userName: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 120,
  },
  userEmail: {
    fontSize: 11,
    color: "var(--color-text-secondary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 120,
  },
  signOutBtn: {
    width: "100%",
    padding: "8px 0",
    background: "transparent",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    fontSize: 12,
    color: "var(--color-text-secondary)",
    cursor: "pointer",
  },
  rightPanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  topbar: {
    height: 52,
    flexShrink: 0,
    borderBottom: "1px solid var(--color-border)",
    background: "var(--color-surface)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 24px",
  },
  topbarTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    textTransform: "capitalize",
  },
  topbarRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  topbarUser: {
    fontSize: 12,
    color: "var(--color-text-secondary)",
  },
  main: {
    flex: 1,
    overflowY: "auto",
    padding: "32px",
  },
};