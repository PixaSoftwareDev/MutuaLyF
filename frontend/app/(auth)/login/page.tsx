"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api, type LookupTenantMatch } from "@/lib/api";
import { toSlug } from "@/lib/utils";
import { DEFAULT_PRIMARY, pickReadableTextColor } from "@/lib/use-tenant-branding";
import { Loader2, AlertTriangle, Shield, Eye, EyeOff, ChevronLeft } from "lucide-react";

const PLATFORM_NAME = "IA Inteligent";
const PLATFORM_ACCENT = DEFAULT_PRIMARY;
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

function fullLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

// El login email-first es un stepper de 2-3 pasos:
//  Step 1 — Email. Tras submit hacemos lookup-tenant en el backend.
//  Step 2a — Tenant unico encontrado → branding del tenant + password.
//  Step 2b — Multiples tenants → selector con cards (logo + nombre + rol).
//  Step 2c — Ningun tenant (Gmail no cargado, o super-admin) → pedir organizacion.
type Step = "email" | "password" | "select" | "fallback";

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();

  const isSuperAdmin                = searchParams.get("platform") === "1";

  const [step, setStep]             = useState<Step>(isSuperAdmin ? "fallback" : "email");
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [showPwd, setShowPwd]       = useState(false);
  const [tenantInput, setTenantInput] = useState("");
  const [matches, setMatches]       = useState<LookupTenantMatch[]>([]);
  const [selected, setSelected]     = useState<LookupTenantMatch | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);

  // Branding aplicado a la UI: si seleccionamos un tenant, sus colores. Sino
  // los neutros de la plataforma. Asi el form de password ya pinta con el
  // color institucional del cliente antes de que confirme.
  const accent = selected?.primary_color || PLATFORM_ACCENT;
  const accentFg = pickReadableTextColor(accent);

  // ── Step 1: email → lookup ────────────────────────────────────────────────
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await api.auth.lookupTenant(email);
      if (data.matches.length === 1) {
        setSelected(data.matches[0]);
        setMatches(data.matches);
        setStep("password");
      } else if (data.matches.length > 1) {
        setMatches(data.matches);
        setStep("select");
      } else {
        // Gmail, dominio no cargado, email no existente. Pedimos organizacion
        // para no diferenciar "no existe" vs "no encontramos por dominio" —
        // anti enumeracion.
        setStep("fallback");
      }
    } catch {
      // Backend caido o rate limit → fallback con organizacion
      setStep("fallback");
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2 (cualquier camino): ejecutar login real ────────────────────────
  const doLogin = async (effectiveTenant: string) => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.auth.login(email, password, effectiveTenant);
      const payload = JSON.parse(atob(data.access_token.split(".")[1]));
      const role = payload.role as string;
      const resolvedTenant = payload.tenant_id as string;

      setAuth(data.access_token, resolvedTenant, email, role);
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

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tenant = isSuperAdmin
      ? ""                                          // super_admin: sin tenant
      : selected?.tenant_id                          // step 2a o 2b
      ?? toSlug(tenantInput);                        // step 2c (fallback)
    await doLogin(tenant);
  };

  const goBackToEmail = () => {
    setStep("email");
    setSelected(null);
    setMatches([]);
    setPassword("");
    setError(null);
  };

  const pickTenant = (m: LookupTenantMatch) => {
    setSelected(m);
    setStep("password");
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-50">
      {/* LEFT hero — siempre brand de la plataforma para no confundir */}
      <aside
        className="hidden lg:flex lg:w-1/2 relative overflow-hidden text-white"
        style={{
          background: `linear-gradient(135deg, ${PLATFORM_ACCENT} 0%, ${shade(PLATFORM_ACCENT, -30)} 100%)`,
        }}
      >
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_top_right,white_0%,transparent_50%)]" />
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div className="flex items-center gap-3">
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

      {/* RIGHT form */}
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          {/* Mobile brand */}
          <div className="lg:hidden flex items-center justify-center gap-2 mb-8">
            <span className="font-semibold text-lg">{PLATFORM_NAME}</span>
          </div>

          {/* ── Step 1: solo email ─────────────────────────────────────────── */}
          {step === "email" && (
            <>
              <div className="space-y-1 mb-6">
                <h2 className="text-2xl font-bold tracking-tight">Iniciar sesión</h2>
                <p className="text-sm text-muted-foreground">
                  Ingresá tu email corporativo
                </p>
              </div>
              <form onSubmit={handleEmailSubmit} className="space-y-4">
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
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full h-10 font-medium"
                  style={{ backgroundColor: PLATFORM_ACCENT }}
                  disabled={loading || !email.trim()}
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {loading ? "Verificando..." : "Continuar"}
                </Button>
              </form>
              <p className="text-[11px] text-center text-muted-foreground/70 mt-8">
                ¿Problemas para ingresar? Contactá al administrador de tu organización.
              </p>
            </>
          )}

          {/* ── Step 2b: selector de tenant ─────────────────────────────────── */}
          {step === "select" && (
            <>
              <button
                type="button"
                onClick={goBackToEmail}
                className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-4"
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Cambiar email
              </button>
              <div className="space-y-1 mb-6">
                <h2 className="text-xl font-bold tracking-tight">Elegí tu organización</h2>
                <p className="text-sm text-muted-foreground break-all">
                  {email} tiene acceso a:
                </p>
              </div>
              <div className="space-y-2">
                {matches.map((m) => {
                  const logo = fullLogoUrl(m.logo_url);
                  const color = m.primary_color || PLATFORM_ACCENT;
                  return (
                    <button
                      key={m.tenant_id}
                      type="button"
                      onClick={() => pickTenant(m)}
                      className="w-full flex items-center gap-3 rounded-md border bg-card hover:bg-accent/50 px-3 py-2.5 text-left transition"
                    >
                      <div
                        className="flex items-center justify-center h-9 w-9 rounded-md shrink-0 overflow-hidden"
                        style={{ backgroundColor: logo ? "transparent" : color }}
                      >
                        {logo ? (
                          <img src={logo} alt="" className="h-full w-full object-contain" />
                        ) : (
                          <span className="text-white font-semibold text-sm">
                            {m.display_name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{m.display_name}</div>
                        <div className="text-xs text-muted-foreground capitalize">
                          {m.role === "admin" ? "Administrador" : m.role === "operator" ? "Operador" : m.role}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Step 2a / 2c: password (con o sin branding) ─────────────────── */}
          {step === "password" && (
            <>
              <button
                type="button"
                onClick={goBackToEmail}
                className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-4"
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Cambiar email
              </button>
              {selected && (
                <div className="flex items-center gap-3 mb-6">
                  <div
                    className="flex items-center justify-center h-12 w-12 rounded-md shrink-0 overflow-hidden border"
                    style={{ backgroundColor: fullLogoUrl(selected.logo_url) ? "white" : accent }}
                  >
                    {fullLogoUrl(selected.logo_url) ? (
                      <img src={fullLogoUrl(selected.logo_url)!} alt="" className="h-full w-full object-contain p-1" />
                    ) : (
                      <span className="text-white font-bold">
                        {selected.display_name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">Bienvenido a</div>
                    <div className="font-semibold truncate">{selected.display_name}</div>
                  </div>
                </div>
              )}
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Email</Label>
                  <div className="text-sm rounded-md bg-muted/40 border px-3 py-2 truncate">{email}</div>
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
                      autoFocus
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
                  style={{ backgroundColor: accent, color: accentFg }}
                  disabled={loading || !password}
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {loading ? "Ingresando..." : "Ingresar"}
                </Button>
              </form>
            </>
          )}

          {/* ── Step 2c: fallback con campo organizacion ────────────────────── */}
          {step === "fallback" && (
            <>
              {!isSuperAdmin && (
                <button
                  type="button"
                  onClick={goBackToEmail}
                  className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-4"
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Cambiar email
                </button>
              )}
              <div className="space-y-1 mb-6">
                <h2 className="text-2xl font-bold tracking-tight">
                  {isSuperAdmin ? "Acceso de plataforma" : "Iniciar sesión"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {isSuperAdmin ? "Ingresá con tu cuenta de super administrador" : "Confirmanos tu organización para continuar"}
                </p>
              </div>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                {!isSuperAdmin && (
                  <div className="space-y-1.5">
                    <Label htmlFor="tenant" className="text-xs font-medium">Organización</Label>
                    <Input
                      id="tenant"
                      placeholder="mi-empresa"
                      value={tenantInput}
                      onChange={(e) => setTenantInput(e.target.value)}
                      required
                      autoComplete="organization"
                      className="h-10"
                      autoFocus
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
                  <Label htmlFor="email-fb" className="text-xs font-medium">Email</Label>
                  <Input
                    id="email-fb"
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
                  <Label htmlFor="password-fb" className="text-xs font-medium">Contraseña</Label>
                  <div className="relative">
                    <Input
                      id="password-fb"
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
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
