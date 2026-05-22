import { NextResponse } from "next/server";

/**
 * Temporary stable middleware.
 *
 * We are disabling cookie-based auth checks because Firebase Auth
 * and middleware session cookies were going out of sync during refresh,
 * causing blank screens and redirect instability.
 *
 * Authentication will now be handled entirely client-side
 * through Firebase Auth + AuthContext.
 */

export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static
     * - _next/image
     * - favicon.ico
     * - image files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};