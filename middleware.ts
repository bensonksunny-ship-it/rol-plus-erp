import { NextRequest, NextResponse } from "next/server";
import { PUBLIC_ROUTES } from "@/config/constants";

/**
 * Edge middleware — runs before any page renders.
 * Only checks for the presence of the session cookie (no token verification).
 *
 * Mobile-safe loop prevention:
 *  - On mobile (especially iOS Safari), SameSite=Strict cookies can be
 *    silently dropped on PWA launches or navigations the browser classifies
 *    as cross-site, causing a /login → /dashboard → /login redirect loop.
 *  - We use SameSite=Lax on the session cookie to prevent this.
 *  - The middleware does NOT redirect /login → /dashboard when a session
 *    cookie exists because the cookie may be stale (token revoked, profile
 *    deleted). The client-side AuthContext is the authoritative checker.
 *    If the cookie is valid the login page will redirect away client-side.
 *  - Protected routes with no cookie are still redirected to /login — this
 *    is safe because unauthenticated users genuinely have no cookie.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // "/" — always pass through; app/page.tsx handles client-side redirect.
  if (pathname === "/") return NextResponse.next();

  const isPublic = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );

  const hasSession = Boolean(request.cookies.get("rol_session")?.value);

  // Protected route with no session cookie → send to login.
  // This is the only server-side redirect we make. The reverse redirect
  // (/login with cookie → /dashboard) is intentionally handled client-side
  // only, to avoid server loops on mobile where the cookie may be stale.
  if (!isPublic && !hasSession) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};