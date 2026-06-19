import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ⚠️ SEGURIDAD: este middleware es GATING DE UX, NO la barrera de seguridad.
// El rol sale de la cookie `ia_role`, que es NO firmada y la setea el cliente
// (document.cookie en el login) → un usuario puede editarla. La autoridad real es
// el BACKEND: cada endpoint valida el JWT FIRMADO (rol incluido) y devuelve 401/403;
// la firma no se puede falsificar sin el JWT_SECRET, que no vive en el front.
// Manipular esta cookie solo deja ver el CASCARÓN de una UI que queda VACÍA (las
// APIs fallan) — nunca datos de otro rol o tenant. No mover NINGUNA decisión de
// seguridad de datos a este middleware ni al AuthGuard/store (también client-side).

// Routes accessible by each role — strictly separated, no overlap
const ROLE_PREFIXES: Record<string, string[]> = {
  super_admin: ["/superadmin"],
  admin:       ["/admin", "/operator"],
  operator:    ["/operator"],
};

// Nota: /api/ entero es público porque la auth de las APIs vive en el backend
// (JWT Bearer header). Si el middleware bloqueara /api/v1/auth/login el frontend
// nunca podría loguearse en una sesión nueva sin cookie todavía.
const PUBLIC_PREFIXES = ["/login", "/loginSuperadmin", "/chat", "/forbidden", "/forgot-password", "/reset-password", "/styleguide", "/_next", "/favicon", "/api/"];

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
