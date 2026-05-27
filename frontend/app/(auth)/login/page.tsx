"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { toSlug } from "@/lib/utils";
import { GENERIC_BRANDING, DEFAULT_PRIMARY } from "@/lib/use-tenant-branding";
import { Loader2, AlertTriangle, Shield, Eye, EyeOff, Sparkles } from "lucide-react";

// El login NUNCA muestra branding del tenant. Es la cara de la plataforma:
// los colores y el nombre son siempre los mismos sin importar desde donde
// se acceda (IP, subdominio, query param). El branding del cliente aparece
// despues del login en navbar, sidebar y chatbot.
const PLATFORM_NAME = GENERIC_BRANDING.display_name;
const PLATFORM_ACCENT = DEFAULT_PRIMARY;

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();

  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [showPwd, setShowPwd]           = useState(false);
  const [tenantInput, setTenantInput]   = useState("");
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);

  const doLogin = async (em: string, pw: string, tenant: string, superAdmin: boolean) => {
    setError(null);
    setLoading(true);
    try {
      const effectiveTenant = superAdmin ? "" : toSlug(tenant);
      const data = await api.auth.login(em, pw, effectiveTenant);
      const payload = JSON.parse(atob(data.access_token.split(".")[1]));
      const role = payload.role as string;
      const resolvedTenant = payload.tenant_id as string;

      setAuth(data.access_token, resolvedTenant, em, role);
      document.cookie = `ia_role=${role}; path=/; SameSite=strict`;
      document.cookie = `ia_tenant=${resolvedTenant}; path=/; SameSite=strict`;

      if (role === "super_admin")      router.push("/superadmin");
      else if (role === "operator")    router.push("/operator");
      else                             router.push("/admin/documents");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Credenciales incorrectas. Verificá email y contraseña.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await doLogin(email, password, tenantInput, isSuperAdmin);
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-50">
      {/* ── LEFT: hero / brand ─────────────────────────────────────────────── */}
      <aside
        className="hidden lg:flex lg:w-1/2 relative overflow-hidden text-white"
        style={{
          background: `linear-gradient(135deg, ${PLATFORM_ACCENT} 0%, ${shade(PLATFORM_ACCENT, -30)} 100%)`,
        }}
      >
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_top_right,white_0%,transparent_50%)]" />
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div className="flex items-center gap-3">
            <PlatformLogo size="lg" />
            <span className="font-semibold text-lg">{PLATFORM_NAME}</span>
          </div>

          <div className="space-y-4 max-w-md">
            <h1 className="text-4xl font-bold leading-tight">
              Tu conocimiento, listo para responder.
            </h1>
            <p className="text-white/80 text-base leading-relaxed">
              Documentos, consultas y conversaciones en un solo lugar.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-white/60">
            <Shield className="h-3.5 w-3.5" />
            <span>Conexión cifrada · Datos aislados por organización</span>
          </div>
        </div>
      </aside>

      {/* ── RIGHT: form ────────────────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center justify-center gap-2 mb-8">
            <PlatformLogo size="md" accent={PLATFORM_ACCENT} />
            <span className="font-semibold text-lg">{PLATFORM_NAME}</span>
          </div>

          <div className="space-y-1 mb-6">
            <h2 className="text-2xl font-bold tracking-tight">Iniciar sesión</h2>
            <p className="text-sm text-muted-foreground">
              {isSuperAdmin
                ? "Acceso de plataforma"
                : "Ingresá con la cuenta de tu organización"}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isSuperAdmin && (
              <div className="space-y-1.5">
                <Label htmlFor="tenant" className="text-xs font-medium">
                  Organización
                </Label>
                <Input
                  id="tenant"
                  placeholder="mi-empresa"
                  value={tenantInput}
                  onChange={(e) => setTenantInput(e.target.value)}
                  required
                  autoComplete="organization"
                  className="h-10"
                />
              </div>
            )}

            {isSuperAdmin && (
              <div className="flex items-center gap-2 rounded-md bg-violet-50 border border-violet-200 px-3 py-2.5">
                <Shield className="h-4 w-4 text-violet-600 shrink-0" />
                <span className="text-sm text-violet-700 font-medium">Modo super administrador</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-medium">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="tu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-medium">Contraseña</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPwd ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="h-10 pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPwd ? "Ocultar contraseña" : "Mostrar contraseña"}
                  tabIndex={-1}
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              className="w-full h-10 font-medium"
              style={{ backgroundColor: PLATFORM_ACCENT }}
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Ingresando..." : "Ingresar"}
            </Button>

            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => {
                  setEmail("pixs@platform.local");
                  setPassword("pixs1234!");
                  setError(null);
                }}
                className="w-full text-xs text-violet-600 hover:text-violet-800 transition-colors text-center border border-violet-200 rounded-md py-2 bg-violet-50 hover:bg-violet-100"
              >
                Rellenar credenciales de prueba
              </button>
            )}

            <button
              type="button"
              onClick={() => { setIsSuperAdmin(v => !v); setError(null); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors text-center pt-1"
            >
              {isSuperAdmin ? "← Volver al login de organización" : "Soy administrador de la plataforma"}
            </button>
          </form>

          <p className="text-[11px] text-center text-muted-foreground/70 mt-8">
            ¿Problemas para ingresar? Contactá al administrador de tu organización.
          </p>
        </div>
      </main>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Logo fijo de la plataforma — nunca el del tenant. Ese aparece post-login. */
function PlatformLogo({ size, accent }: { size: "md" | "lg"; accent?: string }) {
  const px = size === "lg" ? 56 : 36;
  return (
    <div
      className="rounded-2xl flex items-center justify-center shrink-0"
      style={{
        width: px,
        height: px,
        background: accent ?? "rgba(255,255,255,0.15)",
        color: "white",
      }}
    >
      <Sparkles className={size === "lg" ? "h-7 w-7" : "h-5 w-5"} />
    </div>
  );
}

/** Darken (negative) or lighten (positive) a hex color by `pct` percent. */
function shade(hex: string, pct: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const num = parseInt(h, 16);
  let r = (num >> 16) + Math.round(2.55 * pct);
  let g = ((num >> 8) & 0xff) + Math.round(2.55 * pct);
  let b = (num & 0xff) + Math.round(2.55 * pct);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
