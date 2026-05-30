"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api, type LookupTenantMatch } from "@/lib/api";
import { toSlug } from "@/lib/utils";
import { DEFAULT_PRIMARY, pickReadableTextColor } from "@/lib/use-tenant-branding";
import { Loader2, AlertTriangle, Shield, Eye, EyeOff, ChevronLeft, ArrowRight } from "lucide-react";

const PLATFORM_NAME = "Intellix";
const PLATFORM_ACCENT = DEFAULT_PRIMARY;
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

function fullLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

// Stepper email-first.
//  email     → tipear email + continuar
//  password  → tras lookup OK con 1 tenant
//  select    → tras lookup OK con >1 tenants
//  fallback  → tras lookup vacio (gmail, no encontrado) → form clasico
type Step = "email" | "password" | "select" | "fallback";

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();

  const isSuperAdmin                  = searchParams.get("platform") === "1";
  const [step, setStep]               = useState<Step>(isSuperAdmin ? "fallback" : "email");
  const [email, setEmail]             = useState("");
  const [password, setPassword]       = useState("");
  const [showPwd, setShowPwd]         = useState(false);
  const [tenantInput, setTenantInput] = useState("");
  const [matches, setMatches]         = useState<LookupTenantMatch[]>([]);
  const [selected, setSelected]       = useState<LookupTenantMatch | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);

  const accent   = selected?.primary_color || PLATFORM_ACCENT;
  const accentFg = pickReadableTextColor(accent);

  // ── Handlers ─────────────────────────────────────────────────────────────

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
        setStep("fallback");
      }
    } catch {
      setStep("fallback");
    } finally {
      setLoading(false);
    }
  };

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
    const tenant = isSuperAdmin ? "" : (selected?.tenant_id ?? toSlug(tenantInput));
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

  // ── Layout: centered minimal ─────────────────────────────────────────────

  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center p-4 sm:p-6 bg-[#fafafa]">
      {/* Gradient mesh ultra-sutil de fondo. Usamos radial-gradients CSS
          (sin SVG/imagen) para zero bytes adicionales y renderizado nativo.
          Opacidad baja a propósito — está para dar profundidad, no para
          competir con el contenido. */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          backgroundImage: `
            radial-gradient(circle at 15% 20%, rgba(153, 50, 61, 0.08) 0%, transparent 40%),
            radial-gradient(circle at 85% 75%, rgba(29, 78, 216, 0.06) 0%, transparent 45%),
            radial-gradient(circle at 50% 100%, rgba(168, 85, 247, 0.05) 0%, transparent 50%)
          `,
        }}
      />

      {/* Logo arriba del card — la marca vive afuera, no dentro */}
      <div className="relative z-10 mb-8 flex items-center gap-2.5">
        <Image
          src="/Logo.png"
          alt={PLATFORM_NAME}
          width={32}
          height={32}
          className="rounded-md"
          priority
        />
        <span className="font-semibold text-lg tracking-tight text-foreground">
          {PLATFORM_NAME}
        </span>
      </div>

      {/* Card centrado */}
      <main className="relative z-10 w-full max-w-[400px]">
        <div className="bg-white rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_8px_32px_rgba(0,0,0,0.06)] border border-slate-200/60 p-6 sm:p-8">

          {/* ── Step: email ─────────────────────────────────────────────── */}
          {step === "email" && (
            <>
              <div className="space-y-1.5 mb-6">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                  Iniciar sesión
                </h1>
                <p className="text-sm text-muted-foreground">
                  Ingresá tu email corporativo para continuar
                </p>
              </div>
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-[13px] font-medium">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="tu@empresa.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                    className="h-11 text-[15px]"
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full h-11 font-medium text-[15px] group"
                  style={{ backgroundColor: PLATFORM_ACCENT }}
                  disabled={loading || !email.trim()}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      Continuar
                      <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                    </>
                  )}
                </Button>
              </form>
            </>
          )}

          {/* ── Step: select multi-tenant ───────────────────────────────── */}
          {step === "select" && (
            <>
              <BackBtn onClick={goBackToEmail} />
              <div className="space-y-1.5 mb-6">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                  Elegí tu organización
                </h1>
                <p className="text-sm text-muted-foreground break-all">
                  <span className="font-medium text-foreground">{email}</span> tiene acceso a:
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
                      className="w-full group flex items-center gap-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 px-3.5 py-3 text-left transition-all"
                    >
                      <div
                        className="flex items-center justify-center h-10 w-10 rounded-lg shrink-0 overflow-hidden ring-1 ring-slate-100"
                        style={{ backgroundColor: logo ? "white" : color }}
                      >
                        {logo ? (
                          <img src={logo} alt="" className="h-full w-full object-contain p-1" />
                        ) : (
                          <span className="text-white font-semibold text-sm">
                            {m.display_name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-[14px] text-foreground truncate">{m.display_name}</div>
                        <div className="text-xs text-muted-foreground capitalize">
                          {m.role === "admin" ? "Administrador" : m.role === "operator" ? "Operador" : m.role}
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Step: password con branding ──────────────────────────────── */}
          {step === "password" && (
            <>
              <BackBtn onClick={goBackToEmail} />
              {selected && (
                <div className="flex items-center gap-3 mb-6 pb-5 border-b border-slate-100">
                  <div
                    className="flex items-center justify-center h-12 w-12 rounded-xl shrink-0 overflow-hidden ring-1 ring-slate-100"
                    style={{ backgroundColor: fullLogoUrl(selected.logo_url) ? "white" : accent }}
                  >
                    {fullLogoUrl(selected.logo_url) ? (
                      <img src={fullLogoUrl(selected.logo_url)!} alt="" className="h-full w-full object-contain p-1.5" />
                    ) : (
                      <span className="text-white font-bold text-lg">
                        {selected.display_name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Ingresando a</div>
                    <div className="font-semibold text-[15px] text-foreground truncate">{selected.display_name}</div>
                  </div>
                </div>
              )}
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-[13px] font-medium">Email</Label>
                  <div className="text-sm rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 truncate text-muted-foreground">
                    {email}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-[13px] font-medium">Contraseña</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPwd ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      autoFocus
                      className="h-11 pr-10 text-[15px]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPwd(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                      aria-label={showPwd ? "Ocultar contraseña" : "Mostrar contraseña"}
                      tabIndex={-1}
                    >
                      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                {error && <ErrorBox text={error} />}
                <Button
                  type="submit"
                  className="w-full h-11 font-medium text-[15px]"
                  style={{ backgroundColor: accent, color: accentFg }}
                  disabled={loading || !password}
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingresar"}
                </Button>
              </form>
            </>
          )}

          {/* ── Step: fallback (organización + email + password) ─────────── */}
          {step === "fallback" && (
            <>
              {!isSuperAdmin && <BackBtn onClick={goBackToEmail} />}
              <div className="space-y-1.5 mb-6">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                  {isSuperAdmin ? "Acceso de plataforma" : "Iniciar sesión"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {isSuperAdmin
                    ? "Ingresá con tu cuenta de super administrador"
                    : "Confirmanos tu organización para continuar"}
                </p>
              </div>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                {!isSuperAdmin && (
                  <div className="space-y-1.5">
                    <Label htmlFor="tenant" className="text-[13px] font-medium">Organización</Label>
                    <Input
                      id="tenant"
                      placeholder="mi-empresa"
                      value={tenantInput}
                      onChange={(e) => setTenantInput(e.target.value)}
                      required
                      autoComplete="organization"
                      autoFocus
                      className="h-11 text-[15px]"
                    />
                  </div>
                )}
                {isSuperAdmin && (
                  <div className="flex items-center gap-2 rounded-lg bg-violet-50 border border-violet-200 px-3 py-2.5">
                    <Shield className="h-4 w-4 text-violet-600 shrink-0" />
                    <span className="text-[13px] text-violet-700 font-medium">Modo super administrador</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="email-fb" className="text-[13px] font-medium">Email</Label>
                  <Input
                    id="email-fb"
                    type="email"
                    placeholder="tu@empresa.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className="h-11 text-[15px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-fb" className="text-[13px] font-medium">Contraseña</Label>
                  <div className="relative">
                    <Input
                      id="password-fb"
                      type={showPwd ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      className="h-11 pr-10 text-[15px]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPwd(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                      aria-label={showPwd ? "Ocultar contraseña" : "Mostrar contraseña"}
                      tabIndex={-1}
                    >
                      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                {error && <ErrorBox text={error} />}
                <Button
                  type="submit"
                  className="w-full h-11 font-medium text-[15px]"
                  style={{ backgroundColor: PLATFORM_ACCENT }}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingresar"}
                </Button>
              </form>
            </>
          )}
        </div>

        {/* Footer minimal afuera del card */}
        <p className="text-center text-[11px] text-muted-foreground/70 mt-6">
          <Shield className="inline h-3 w-3 mr-1 -translate-y-px" />
          Conexión cifrada · Datos aislados por organización
        </p>
      </main>

      {/* Footer absoluto en la parte inferior */}
      <footer className="relative z-10 mt-8 text-center text-[11px] text-muted-foreground/60">
        © {new Date().getFullYear()} {PLATFORM_NAME}
      </footer>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center text-[12px] text-muted-foreground hover:text-foreground mb-5 transition-colors"
    >
      <ChevronLeft className="h-3.5 w-3.5 mr-0.5" />
      Cambiar email
    </button>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-[13px] text-red-700 flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}
