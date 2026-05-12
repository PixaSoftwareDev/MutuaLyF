import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes accessible by each role — strictly separated, no overlap
const ROLE_PREFIXES: Record<string, string[]> = {
  super_admin: ["/superadmin"],
  admin:       ["/admin", "/operator"],
  operator:    ["/operator"],
};

const PUBLIC_PREFIXES = ["/login", "/chat", "/forbidden", "/_next", "/favicon", "/api/auth"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow public routes
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Root handled by page.tsx — allow
  if (pathname === "/") return NextResponse.next();

  const role = request.cookies.get("ia_role")?.value;

  if (!role) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const allowed = ROLE_PREFIXES[role] ?? [];
  if (!allowed.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.redirect(new URL("/forbidden", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Skip Next internals and any path that looks like a static file (contains a dot)
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
