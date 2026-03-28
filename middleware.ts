import { NextRequest, NextResponse } from "next/server";
import { PUBLIC_ROUTES } from "@/config/constants";

/**
 * Middleware runs on the edge before any page renders.
 * It checks for the Firebase session cookie set during login.
 *
 * Full token verification (via Firebase Admin SDK) happens in
 * individual API route handlers — middleware only gates the UI.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Root path is handled by app/page.tsx which redirects based on auth state
  if (pathname === "/") return NextResponse.next();

  const isPublic = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );

  const sessionCookie = request.cookies.get("rol_session")?.value;

  // Redirect unauthenticated users away from protected pages
  if (!isPublic && !sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from login page
  if (isPublic && sessionCookie && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
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