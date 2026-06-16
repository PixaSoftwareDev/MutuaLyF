"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api, type LookupTenantMatch } from "@/lib/api";
import { toSlug } from "@/lib/utils";
import { Loader2, AlertTriangle, Shield, Eye, EyeOff, ChevronLeft, Lock } from "lucide-react";

const PLATFORM_NAME = "Intellix";
// Paleta basada en el logo de marca: gradient hexagonal cyan→violet.
const BRAND_CYAN     = "#4FC3F7";
const BRAND_INDIGO   = "#5B5BFF";
const BRAND_VIOLET   = "#7A2DFF";
const BRAND_GRADIENT = `linear-gradient(135deg, ${BRAND_CYAN} 0%, ${BRAND_INDIGO} 50%, ${BRAND_VIOLET} 100%)`;

// El login es 100% identidad Intellix. NO usa logo ni color del tenant: el
// branding del cliente solo aparece de cara al afiliado, nunca en el panel.
// El botón y los focus rings siempre llevan el gradient/índigo de la marca.
const BTN_STYLE = { backgroundImage: BRAND_GRADIENT, color: "#fff" };

// Pantalla única (credentials). Los casos raros se ramifican: "select" cuando
// un email pertenece a varias organizaciones, "org" cuando no reconocemos el
// dominio y hay que pedir la organización a mano.
type Step = "credentials" | "select" | "org";

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();

  // isSuperAdmin se deriva de ?platform=1 pero NO en render: el server (sin
  // params) y el client (con el param) renderizarían JSX distinto → hydration
  // mismatch. Se inicializa en false y se setea en useEffect tras el mount.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [step, setStep]               = useState<Step>("credentials");
  const [email, setEmail]             = useState("");
  const [password, setPassword]       = useState("");
  const [showPwd, setShowPwd]         = useState(false);
  const [tenantInput, setTenantInput] = useState("");
  const [matches, setMatches]         = useState<LookupTenantMatch[]>([]);
  const [error, setError]             = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);

  // Leer ?platform=1 solo en el cliente para no crear mismatch con el SSR.
  useEffect(() => {
    if (searchParams.get("platform") === "1") setIsSuperAdmin(true);
  }, [searchParams]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  // Validacion minima de email. No usamos zod ni regex pesada — el patron de
  // navegador (type=email) cubre la mayoria. Acá solo nos aseguramos de que
  // haya algo razonable antes de hacer el roundtrip al backend.
  const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

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
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      let msg: string;
      if (status === 401) {
        // Genérico a propósito: no revela si el email existe (anti-enumeración).
        // No usamos el detail crudo del backend ("Invalid credentials", en inglés).
        msg = "Email o contraseña incorrectos. Revisá los datos e intentá de nuevo.";
      } else if (status === 429) {
        // El backend manda el tiempo de espera ("…en N segundos"), en español.
        msg = typeof detail === "string" ? detail : "Demasiados intentos. Esperá un momento y volvé a intentar.";
      } else if (!err?.response) {
        // Sin respuesta = el server no contestó (red caída, server abajo).
        msg = "No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.";
      } else {
        msg = "No pudimos iniciar sesión. Probá de nuevo en unos minutos.";
      }
      setError(msg);
      setLoading(false);
    }
    // Sin finally: en el camino feliz navegamos a otra ruta y desmontamos, así
    // que dejamos el spinner hasta el redirect. El error sí resetea loading.
  };

  // Pantalla principal: email + contraseña juntos. Al enviar resolvemos el
  // tenant por el email y ramificamos según cuántas organizaciones matcheen.
  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim())          { setError("Ingresá tu email para continuar."); return; }
    if (!isValidEmail(email))   { setError("Revisá el email — falta el dominio o el @."); return; }
    if (!password)              { setError("Ingresá tu contraseña."); return; }

    // Super admin: no hay tenant que resolver, login directo de plataforma.
    if (isSuperAdmin) { await doLogin(""); return; }

    setLoading(true);
    try {
      const data = await api.auth.lookupTenant(email);
      if (data.matches.length === 1) {
        await doLogin(data.matches[0].tenant_id);
      } else if (data.matches.length > 1) {
        setMatches(data.matches);
        setStep("select");
        setLoading(false);
      } else {
        setStep("org");
        setLoading(false);
      }
    } catch {
      setStep("org");
      setLoading(false);
    }
  };

  // Multi-org: ya tenemos email + contraseña, al elegir entramos directo.
  const pickTenant = async (m: LookupTenantMatch) => {
    await doLogin(m.tenant_id);
  };

  // Dominio no reconocido: el email y la contraseña ya están cargados, solo
  // falta el slug de la organización.
  const handleOrgSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!tenantInput.trim()) { setError("Decinos a qué organización pertenecés."); return; }
    await doLogin(toSlug(tenantInput));
  };

  const goBack = () => {
    setStep("credentials");
    setMatches([]);
    setError(null);
  };

  // ── Layout ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center p-4 sm:p-6 overflow-hidden bg-slate-50">

      {/* Gradient mesh con la paleta de marca — cyan / indigo / violet en
          puntos opuestos del viewport. Opacity ~12% para que se note pero
          no compita con el contenido. Tres blobs grandes que se solapan. */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          backgroundImage: `
            radial-gradient(circle at 12% 18%, ${BRAND_CYAN}26 0%, transparent 42%),
            radial-gradient(circle at 88% 12%, ${BRAND_VIOLET}20 0%, transparent 45%),
            radial-gradient(circle at 50% 95%, ${BRAND_INDIGO}1f 0%, transparent 50%),
            radial-gradient(circle at 92% 88%, ${BRAND_CYAN}18 0%, transparent 40%)
          `,
        }}
      />

      {/* Grid pattern ultra-sutil de fondo. Suma textura tech sin recargar.
          Mask con radial-gradient para que se desvanezca hacia los bordes. */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.04]"
        aria-hidden="true"
        style={{
          backgroundImage: `linear-gradient(to right, #000 1px, transparent 1px),
                            linear-gradient(to bottom, #000 1px, transparent 1px)`,
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(ellipse 80% 80% at center, black 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 80% at center, black 30%, transparent 80%)",
        }}
      />

      {/* Wordmark oficial. Escala con el viewport: 170/200/220/240 px. */}
      <div className="relative z-10 mb-8 lg:mb-10">
        <Image
          src="/brand/intellix-wordmark-white.png"
          alt={PLATFORM_NAME}
          width={520}
          height={170}
          priority
          className="w-[170px] sm:w-[200px] lg:w-[220px] xl:w-[240px] h-auto"
        />
      </div>

      {/* Card. El ancho casi no cambia — mantenemos forma vertical proporcionada.
          Lo que escala fuerte es la altura interna (padding vertical, gaps
          entre elementos, altura de inputs). Asi en monitor grande el form se
          siente sustancial sin volverse "pancarta horizontal". */}
      <main className="relative z-10 w-full max-w-[400px] sm:max-w-[420px] lg:max-w-[440px]">
        <div className="relative bg-white rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.06),0_24px_64px_rgba(15,23,42,0.08)] border border-slate-200/70 overflow-hidden">

          {/* Padding asimetrico: horizontal moderado, vertical mas grande en
              breakpoints superiores. Eso hace que el card "respire" hacia
              arriba/abajo en vez de hacia los costados. */}
          <div className="px-6 py-7 sm:px-8 sm:py-9 lg:px-9 lg:py-11 xl:py-12">

            {/* ── Step: credentials (pantalla principal) ──────────────────── */}
            {step === "credentials" && (
              <>
                <div className="text-center space-y-2 mb-7 lg:mb-8 xl:mb-10">
                  <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">
                    {isSuperAdmin ? "Acceso de plataforma" : "Bienvenido"}
                  </h1>
                  <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed">
                    {isSuperAdmin
                      ? "Ingresá con tu cuenta de super administrador."
                      : "Ingresá tus credenciales para acceder a la plataforma."}
                  </p>
                </div>
                <form onSubmit={handleCredentialsSubmit} className="space-y-4 lg:space-y-5 xl:space-y-6" noValidate>
                  {isSuperAdmin && (
                    <div className="flex items-center gap-2 rounded-lg bg-violet-50 border border-violet-200 px-3 py-2.5">
                      <Shield className="h-4 w-4 text-violet-600 shrink-0" />
                      <span className="text-[13px] text-violet-700 font-medium">Modo super administrador</span>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="email" className="text-[13px] font-medium text-slate-700">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="tu@empresa.com"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
                      autoComplete="email"
                      autoFocus
                      className="h-11 lg:h-12 xl:h-[52px] text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password" className="text-[13px] font-medium text-slate-700">Contraseña</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPwd ? "text" : "password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
                        autoComplete="current-password"
                        className="h-11 lg:h-12 xl:h-[52px] pr-10 text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPwd(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 transition-colors"
                        aria-label={showPwd ? "Ocultar contraseña" : "Mostrar contraseña"}
                        tabIndex={-1}
                      >
                        {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  {!isSuperAdmin && (
                    <div className="flex justify-end -mt-1">
                      <a href="/forgot-password" className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors">
                        ¿Olvidaste tu contraseña?
                      </a>
                    </div>
                  )}
                  {error && <ErrorBox text={error} />}
                  <Button
                    type="submit"
                    className="w-full h-11 lg:h-12 xl:h-[52px] font-medium text-[15px] shadow-md hover:shadow-lg transition-shadow border-0"
                    style={BTN_STYLE}
                    disabled={loading}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingresar"}
                  </Button>
                </form>
              </>
            )}

            {/* ── Step: select multi-tenant ───────────────────────────────── */}
            {step === "select" && (
              <>
                <BackBtn onClick={goBack} />
                <div className="text-center space-y-2 mb-6 lg:mb-7 xl:mb-8">
                  <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">
                    Elegí tu organización
                  </h1>
                  <p className="text-[14px] lg:text-[15px] text-slate-500 break-all">
                    <span className="font-medium text-slate-700">{email}</span> tiene acceso a:
                  </p>
                </div>
                <div className="space-y-2">
                  {matches.map((m) => (
                    <button
                      key={m.tenant_id}
                      type="button"
                      onClick={() => pickTenant(m)}
                      disabled={loading}
                      className="w-full group flex items-center gap-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 px-3.5 py-3 text-left transition-all hover:shadow-sm disabled:opacity-60"
                    >
                      {/* Avatar neutro: inicial sobre el gradient Intellix. Sin
                          logo del tenant — el login es identidad de plataforma. */}
                      <div
                        className="flex items-center justify-center h-10 w-10 rounded-lg shrink-0 ring-1 ring-slate-200/70"
                        style={{ backgroundImage: BRAND_GRADIENT }}
                      >
                        <span className="text-white font-semibold text-sm">
                          {m.display_name.slice(0, 1).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-[14px] text-slate-900 truncate">{m.display_name}</div>
                        <div className="text-xs text-slate-500 capitalize">
                          {m.role === "admin" ? "Administrador" : m.role === "operator" ? "Operador" : m.role}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ── Step: org (dominio no reconocido) ───────────────────────── */}
            {step === "org" && (
              <>
                <BackBtn onClick={goBack} />
                <div className="text-center space-y-2 mb-6 lg:mb-7 xl:mb-8">
                  <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">
                    Confirmá tu organización
                  </h1>
                  <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed">
                    No reconocemos tu dominio. Decinos a qué organización pertenecés.
                  </p>
                </div>
                <form onSubmit={handleOrgSubmit} className="space-y-4 lg:space-y-5 xl:space-y-6" noValidate>
                  <div className="space-y-1.5">
                    <Label htmlFor="tenant" className="text-[13px] font-medium text-slate-700">Organización</Label>
                    <Input
                      id="tenant"
                      placeholder="mi-empresa"
                      value={tenantInput}
                      onChange={(e) => { setTenantInput(e.target.value); if (error) setError(null); }}
                      autoComplete="organization"
                      autoFocus
                      className="h-11 lg:h-12 xl:h-[52px] text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[13px] font-medium text-slate-700">Email</Label>
                    <div className="text-sm rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 truncate text-slate-600">
                      {email}
                    </div>
                  </div>
                  {error && <ErrorBox text={error} />}
                  <Button
                    type="submit"
                    className="w-full h-11 lg:h-12 xl:h-[52px] font-medium text-[15px] shadow-md hover:shadow-lg transition-shadow border-0"
                    style={BTN_STYLE}
                    disabled={loading}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingresar"}
                  </Button>
                </form>
              </>
            )}
          </div>

          {/* Footer interno del card — trust signals */}
          <div className="border-t border-slate-100 bg-slate-50/60 px-6 sm:px-8 lg:px-9 py-3 lg:py-3.5 xl:py-4 flex items-center justify-center gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <Lock className="h-3 w-3" />
              TLS 1.3
            </span>
            <span className="text-slate-300">·</span>
            <span className="inline-flex items-center gap-1">
              <Shield className="h-3 w-3" />
              Datos aislados
            </span>
            <span className="text-slate-300">·</span>
            <span>SOC-ready</span>
          </div>
        </div>

        <p className="text-center text-[11px] text-slate-400 mt-4">
          ¿Problemas para ingresar?{" "}
          <span className="text-slate-600 font-medium">Contactá al administrador de tu organización.</span>
        </p>
      </main>

      <footer className="relative z-10 mt-10 text-center text-[11px] text-slate-400">
        © {new Date().getFullYear()} {PLATFORM_NAME} · Plataforma de conocimiento institucional
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
      className="inline-flex items-center text-[12px] text-slate-500 hover:text-slate-900 mb-5 transition-colors"
    >
      <ChevronLeft className="h-3.5 w-3.5 mr-0.5" />
      Volver
    </button>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-[13px] text-destructive flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}
