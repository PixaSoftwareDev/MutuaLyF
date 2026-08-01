"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api, type LookupTenantMatch } from "@/lib/api";
import { decodeJwtPayload } from "@/lib/jwt";
import { toSlug } from "@/lib/utils";
import { Loader2, AlertTriangle, Shield, Eye, EyeOff, ChevronLeft, ChevronDown, Lock, ShieldCheck, User, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";

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

// Vida de las cookies de gating UX (ia_role/ia_tenant) — igual al max_age del
// refresh_token que setea el backend en el login.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// Pantalla única (credentials). Los casos raros se ramifican: "select" cuando
// un email pertenece a varias organizaciones, "org" cuando no reconocemos el
// dominio y hay que pedir la organización a mano.
type Step = "credentials" | "select" | "org" | "forgot";

// ── Acceso rápido (solo dev/local) ─────────────────────────────────────────
// Panel de conveniencia para no tipear credenciales en desarrollo. Doble gate:
// 1. BUILD-TIME: NODE_ENV === "development" — Next SIEMPRE inlinea NODE_ENV,
//    así que en `next build` (staging/prod) la condición se resuelve a false
//    en compilación y el minificador ELIMINA la lista de usuarios del bundle:
//    los emails ni siquiera viajan al navegador. En `next dev` (local) queda
//    habilitado. OJO: no usar una var NEXT_PUBLIC_* acá — si la var no existe
//    en el build, Next NO la inlinea, la condición queda para runtime y el
//    array sobrevive en el bundle (verificado en staging).
// 2. RUNTIME: hostname localhost/127.0.0.1 (isLocal) — segunda capa.
// Los passwords están reseteados a DEV_PASSWORD en la DB local (ver
// scripts/dev-local.sh + seed). tenant "" = super admin (platform_users).
// La contraseña vive en .env.local (DEV_QUICK_PASSWORD) → compose →
// NEXT_PUBLIC_DEV_QUICK_PASSWORD. Fallback a "local1234" si no está seteada.
// Habilitado en dev (next dev) O en un build local de producción cuando se pasa
// NEXT_PUBLIC_ENABLE_DEV_LOGIN=true al `next build` (para probar el build prod en
// localhost). SEGURIDAD: en el VPS NO seteés este flag en "true" — y además el
// gate runtime `isLocal` (hostname localhost) impide que aparezca en producción
// real aunque el flag quedara activo. Para stripear también los emails del bundle
// del VPS, ese build debe setear NEXT_PUBLIC_ENABLE_DEV_LOGIN="false".
const DEV_LOGIN_ENABLED =
  process.env.NODE_ENV === "development" ||
  process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === "true";
const DEV_PASSWORD = process.env.NEXT_PUBLIC_DEV_QUICK_PASSWORD || "local1234";
type DevUser = { org: string; label: string; email: string; tenant: string; role: string; password?: string };
// Usuarios que EXISTEN en la base local (recreada 2026-07-22: solo tenant
// intellix + super admin de plataforma). `password` pisa a DEV_PASSWORD cuando
// el usuario no usa la clave rápida compartida.
const DEV_USERS: DevUser[] = DEV_LOGIN_ENABLED ? [
  { org: "Plataforma", label: "Super Admin", email: "pixs@platform.local", tenant: "",         role: "super_admin", password: "pixs1234!" },
  { org: "Intellix",   label: "Admin",       email: "admin@intellix.com",  tenant: "intellix", role: "admin",       password: "intellix1234!" },
] : [];

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
  // isLocal se setea en useEffect (no en render) para evitar hydration mismatch:
  // el SSR no conoce el hostname. Gatea el panel de acceso rápido de dev.
  const [isLocal, setIsLocal]         = useState(false);
  const [step, setStep]               = useState<Step>("credentials");
  const [email, setEmail]             = useState("");
  const [password, setPassword]       = useState("");
  const [showPwd, setShowPwd]         = useState(false);
  const [tenantInput, setTenantInput] = useState("");
  const [matches, setMatches]         = useState<LookupTenantMatch[]>([]);
  const [error, setError]             = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  // Dirección de la animación entre pasos: 1 = avanza (slide desde la derecha),
  // -1 = vuelve (slide desde la izquierda). forgotSent = pantalla de "enviado".
  const [dir, setDir]                 = useState(1);
  const [forgotSent, setForgotSent]   = useState(false);

  // Cambia de paso seteando la dirección de la animación (para que el wrapper
  // keyed anime hacia el lado correcto).
  const goStep = (next: Step, direction: 1 | -1 = 1) => {
    setDir(direction);
    setError(null);
    setStep(next);
  };

  // Leer ?platform=1 solo en el cliente para no crear mismatch con el SSR.
  useEffect(() => {
    if (searchParams.get("platform") === "1") setIsSuperAdmin(true);
    // /forgot-password redirige acá con ?forgot=1 para abrir el paso directo.
    if (searchParams.get("forgot") === "1") setStep("forgot");
  }, [searchParams]);

  // Detectar entorno local en el cliente para habilitar el acceso rápido de dev.
  // DEV_LOGIN_ENABLED es el gate de build-time; sin él, isLocal queda false.
  useEffect(() => {
    const h = window.location.hostname;
    setIsLocal(DEV_LOGIN_ENABLED && (h === "localhost" || h === "127.0.0.1"));
  }, []);

  // Rescate de la ventana pre-hidratación: lo que el usuario tipeó (o el
  // autofill llenó) antes de que React montara vive solo en el DOM — el estado
  // controlado arranca vacío y lo pisaría. Al montar: DOM → estado, y si el
  // script del layout (auth) tragó un submit en esa ventana, se reenvía acá
  // con los valores del DOM (el estado recién seteado aún no es visible).
  useEffect(() => {
    const emailDom = domValue("email");
    const pwdDom = domValue("password");
    if (emailDom) setEmail(emailDom);
    if (pwdDom) setPassword(pwdDom);
    const w = window as unknown as { __iaHydrated?: boolean; __iaPendingSubmit?: boolean };
    w.__iaHydrated = true;
    if (w.__iaPendingSubmit) {
      w.__iaPendingSubmit = false;
      // isSuperAdmin todavía no reflejó el ?platform=1 (setState del efecto de
      // arriba, mismo commit) — se lee el param directo para no perderlo.
      const asPlatform = new URLSearchParams(window.location.search).get("platform") === "1";
      if (emailDom && pwdDom) void submitCredentials(emailDom, pwdDom, asPlatform);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Login de un clic para el panel de dev: setea el form (feedback visual) y
  // dispara doLogin con credenciales explícitas (no espera al setState).
  const quickLogin = (u: DevUser) => {
    if (loading) return;
    const pwd = u.password ?? DEV_PASSWORD;
    setEmail(u.email);
    setPassword(pwd);
    setError(null);
    doLogin(u.tenant, { email: u.email, password: pwd });
  };

  // ── Handlers ─────────────────────────────────────────────────────────────

  // Validacion minima de email. No usamos zod ni regex pesada — el patron de
  // navegador (type=email) cubre la mayoria. Acá solo nos aseguramos de que
  // haya algo razonable antes de hacer el roundtrip al backend.
  const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

  // Valor actual del input en el DOM. Necesario porque el autofill de Chrome
  // (y el tipeo pre-hidratación) llenan el DOM sin disparar onChange: el
  // estado controlado queda atrás y validaríamos contra "".
  const domValue = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";

  const doLogin = async (effectiveTenant: string, creds?: { email: string; password: string }) => {
    const loginEmail = creds?.email ?? email;
    const loginPassword = creds?.password ?? password;
    setError(null);
    setLoading(true);
    try {
      const data = await api.auth.login(loginEmail, loginPassword, effectiveTenant);
      const payload = decodeJwtPayload<{ role?: string; tenant_id?: string }>(data.access_token);
      if (!payload?.role || !payload?.tenant_id) throw new Error("Token de sesión inválido");
      const role = payload.role;
      const resolvedTenant = payload.tenant_id;

      setAuth(data.access_token, resolvedTenant, loginEmail, role);
      // max-age alineado al refresh_token del backend (30 días): sin él son
      // cookies de sesión que mueren al cerrar el navegador mientras el store
      // persiste en localStorage → al reabrir, el root redirige a /admin, el
      // middleware no ve cookie y rebota a /login (baile de redirects).
      document.cookie = `ia_role=${role}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=strict`;
      document.cookie = `ia_tenant=${resolvedTenant}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=strict`;

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

  // Núcleo del envío de credenciales: resuelve el tenant por email y ramifica
  // según cuántas organizaciones matcheen. Recibe los valores explícitos (no
  // lee el estado) para que el replay pre-hidratación y el fallback de autofill
  // puedan pasar lo que realmente hay en el DOM.
  const submitCredentials = async (emailVal: string, pwdVal: string, asPlatform: boolean = isSuperAdmin) => {
    setError(null);
    if (!emailVal.trim())        { setError("Ingresá tu email para continuar."); return; }
    if (!isValidEmail(emailVal)) { setError("Revisá el email — falta el dominio o el @."); return; }
    if (!pwdVal)                 { setError("Ingresá tu contraseña."); return; }

    const creds = { email: emailVal, password: pwdVal };

    // Super admin: no hay tenant que resolver, login directo de plataforma.
    if (asPlatform) { await doLogin("", creds); return; }

    setLoading(true);
    try {
      const data = await api.auth.lookupTenant(emailVal);
      if (data.matches.length === 1) {
        await doLogin(data.matches[0].tenant_id, creds);
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

  // Pantalla principal: email + contraseña juntos. Si el estado quedó atrás
  // del DOM (autofill sin eventos), el DOM manda y se re-sincroniza.
  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const emailVal = email || domValue("email");
    const pwdVal   = password || domValue("password");
    if (emailVal !== email)  setEmail(emailVal);
    if (pwdVal !== password) setPassword(pwdVal);
    await submitCredentials(emailVal, pwdVal);
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
    setDir(-1);
    setStep("credentials");
    setMatches([]);
    setForgotSent(false);
    setError(null);
  };

  // Recuperar contraseña (mismo comportamiento anti-enumeración que la página
  // previa): siempre muestra "enviado", falle o no.
  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!isValidEmail(email)) { setError("Ingresá un email válido."); return; }
    setError(null);
    setLoading(true);
    try {
      await api.auth.forgotPassword(email.trim());
    } catch {
      // Silencioso a propósito (no revelar si el email existe).
    }
    setForgotSent(true);
    setLoading(false);
  };

  // ── Layout ───────────────────────────────────────────────────────────────

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-slate-50 p-4 sm:p-6">

      {/* ── Fondo premium CLARO, con volumen (sin color de marca): base con
          degradé + juego cálido/frío en tonos NEUTROS (un blob apenas frío y otro
          apenas cálido, muy difusos) + highlight tras la card + viñeta + grano.
          El warm/cool da dimensión sin recurrir al celeste/violeta. ── */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{ background: "radial-gradient(125% 95% at 50% -6%, #ffffff 0%, #f2f4f8 52%, #e8ecf2 100%)" }}
      />
      {/* Toque de marca MUY sutil y discreto: un velo cyan arriba-izquierda y uno
          violeta arriba-derecha, apenas perceptibles (heavy blur, ~7%). */}
      <div className="pointer-events-none absolute -left-48 -top-44 h-[44rem] w-[44rem] rounded-full blur-[160px]" aria-hidden="true" style={{ background: BRAND_CYAN, opacity: 0.08 }} />
      <div className="pointer-events-none absolute -right-48 -top-40 h-[42rem] w-[42rem] rounded-full blur-[160px]" aria-hidden="true" style={{ background: BRAND_VIOLET, opacity: 0.07 }} />
      {/* Velo índigo casi imperceptible detrás de la card, para que el blanco no
          quede como una isla plana y se integre al fondo. */}
      <div className="pointer-events-none absolute left-1/2 top-[46%] h-[600px] w-[860px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] blur-[150px]" aria-hidden="true" style={{ background: BRAND_INDIGO, opacity: 0.05 }} />
      {/* Viñeta sutil para enmarcar. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{ background: "radial-gradient(118% 118% at 50% 42%, transparent 55%, rgba(15,23,42,0.06) 100%)" }}
      />
      {/* Grano (textura premium) — presente pero no invasivo. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.09] mix-blend-multiply"
        aria-hidden="true"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" }}
      />

      {/* Logo: ícono + wordmark (versión oscura). Va EN FLUJO centrado arriba
          de la card hasta lg: en 640–1023px el absoluto de la esquina no tiene
          lugar y pisaba la card (logo llega a x≈242; la card centrada de 420px
          recién arranca después de eso con viewport ≥1024). */}
      <div className="relative z-20 mb-7 flex items-center gap-2.5 lg:absolute lg:left-20 lg:top-16 lg:mb-0">
        <Image
          src="/brand/intellix-mark.png"
          alt=""
          width={160}
          height={160}
          priority
          className="h-8 w-8 sm:h-9 sm:w-9"
        />
        <Image
          src="/brand/intellix-wordmark.png"
          alt={PLATFORM_NAME}
          width={520}
          height={170}
          priority
          className="h-auto w-[118px] sm:w-[132px]"
        />
      </div>

      {/* Card centrada única — moderna, sobria. */}
      <main className="relative z-10 w-full max-w-[420px]">
        <div className="relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_rgba(15,23,42,0.06),0_30px_70px_rgba(15,23,42,0.09)]">

          <div className="px-6 py-11 sm:px-8 sm:py-14">
          {/* Wrapper keyed por paso: al cambiar de paso, remonta y anima el slide.
              El min-height mantiene la card del MISMO alto entre pasos (login ↔
              forgot) — solo desliza el contenido, el contenedor no cambia. */}
          <div key={step} className={`min-h-[356px] ${dir >= 0 ? "animate-slide-in-right" : "animate-slide-in-left"}`}>

            {/* ── Step: credentials (pantalla principal) ──────────────────── */}
            {step === "credentials" && (
              <>
                <div className="text-center space-y-1.5 mb-7">
                  <h1 className="text-[21px] font-semibold tracking-tight text-slate-900">
                    {isSuperAdmin ? "Acceso de plataforma" : "Bienvenido"}
                  </h1>
                  <p className="text-[13px] text-slate-500 leading-relaxed">
                    {isSuperAdmin
                      ? "Ingresá con tu cuenta de super administrador."
                      : "Ingresá tus credenciales para acceder a la plataforma."}
                  </p>
                </div>
                <form onSubmit={handleCredentialsSubmit} className="space-y-5" noValidate>
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
                      className="h-11 text-[14px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
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
                        className="h-11 pr-10 text-[14px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
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
                      <button
                        type="button"
                        onClick={() => goStep("forgot", 1)}
                        className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors"
                      >
                        ¿Olvidaste tu contraseña?
                      </button>
                    </div>
                  )}
                  {error && <ErrorBox text={error} />}
                  <Button
                    type="submit"
                    className="w-full h-11 font-medium text-[14px] shadow-md hover:shadow-lg transition-shadow border-0"
                    style={BTN_STYLE}
                    disabled={loading}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingresar"}
                  </Button>
                </form>

                {/* ── Acceso rápido (solo local/dev) ──────────────────────── */}
                {isLocal && <DevQuickAccess onPick={quickLogin} disabled={loading} />}
              </>
            )}

            {/* ── Step: select multi-tenant ───────────────────────────────── */}
            {step === "select" && (
              <>
                <BackBtn onClick={goBack} />
                <div className="text-center space-y-1.5 mb-7">
                  <h1 className="text-[21px] font-semibold tracking-tight text-slate-900">
                    Elegí tu organización
                  </h1>
                  <p className="text-[13px] text-slate-500 break-all">
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
                <div className="text-center space-y-1.5 mb-7">
                  <h1 className="text-[21px] font-semibold tracking-tight text-slate-900">
                    Confirmá tu organización
                  </h1>
                  <p className="text-[13px] text-slate-500 leading-relaxed">
                    No reconocemos tu dominio. Decinos a qué organización pertenecés.
                  </p>
                </div>
                <form onSubmit={handleOrgSubmit} className="space-y-3.5" noValidate>
                  <div className="space-y-1.5">
                    <Label htmlFor="tenant" className="text-[13px] font-medium text-slate-700">Organización</Label>
                    <Input
                      id="tenant"
                      placeholder="mi-empresa"
                      value={tenantInput}
                      onChange={(e) => { setTenantInput(e.target.value); if (error) setError(null); }}
                      autoComplete="organization"
                      autoFocus
                      className="h-11 text-[14px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
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
                    className="w-full h-11 font-medium text-[14px] shadow-md hover:shadow-lg transition-shadow border-0"
                    style={BTN_STYLE}
                    disabled={loading}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingresar"}
                  </Button>
                </form>
              </>
            )}

            {/* ── Step: forgot (recuperar contraseña) — misma shell y tamaños ── */}
            {step === "forgot" && (
              forgotSent ? (
                <div className="text-center space-y-3">
                  <CheckCircle2 className="mx-auto h-11 w-11 text-emerald-500" />
                  <h1 className="text-[21px] font-semibold tracking-tight text-slate-900">Revisá tu correo</h1>
                  <p className="text-[13px] text-slate-500 leading-relaxed">
                    Si ese email tiene una cuenta, te enviamos un enlace para restablecer tu contraseña. Vence en 1 hora.
                  </p>
                  <div className="pt-2">
                    <button type="button" onClick={goBack} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
                      <ArrowLeft className="h-4 w-4" /> Volver al inicio
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="text-center space-y-1.5 mb-7">
                    <h1 className="text-[21px] font-semibold tracking-tight text-slate-900">¿Olvidaste tu contraseña?</h1>
                    <p className="text-[13px] text-slate-500 leading-relaxed">
                      Ingresá tu email y te enviamos un enlace para crear una nueva.
                    </p>
                  </div>
                  <form onSubmit={submitForgot} className="space-y-5" noValidate>
                    <div className="space-y-1.5">
                      <Label htmlFor="fp-email" className="text-[13px] font-medium text-slate-700">Email</Label>
                      <div className="relative">
                        <Mail className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <Input
                          id="fp-email"
                          type="email"
                          value={email}
                          onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
                          placeholder="tu@empresa.com"
                          className="h-11 pl-9 text-[14px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                          autoFocus
                          aria-label="Email"
                        />
                      </div>
                    </div>
                    {error && <ErrorBox text={error} />}
                    <Button
                      type="submit"
                      className="w-full h-11 font-medium text-[14px] shadow-md hover:shadow-lg transition-shadow border-0"
                      style={BTN_STYLE}
                      disabled={loading || !email.trim()}
                    >
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enviar enlace"}
                    </Button>
                  </form>
                  <div className="mt-6 text-center">
                    <button type="button" onClick={goBack} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
                      <ArrowLeft className="h-4 w-4" /> Volver al inicio
                    </button>
                  </div>
                </>
              )
            )}
          </div>
          </div>

          {/* Footer del card — señales de confianza. */}
          <div className="flex items-center justify-center gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3 text-[11px] text-slate-500 sm:px-8 lg:px-9 lg:py-3.5 xl:py-4">
            <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />TLS 1.3</span>
            <span className="text-slate-300">·</span>
            <span className="inline-flex items-center gap-1"><Shield className="h-3 w-3" />Datos aislados</span>
            <span className="text-slate-300">·</span>
            <span>SOC-ready</span>
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          ¿Problemas para ingresar?{" "}
          <span className="font-medium text-slate-600">Contactá al administrador de tu organización.</span>
        </p>
      </main>

      <footer className="relative z-10 mt-9 text-center text-[11px] text-slate-400">
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

// Panel de acceso rápido de desarrollo. Solo se renderiza en localhost (ver
// gate isLocal). Desplegable colapsado por defecto: un único trigger que abre
// una lista compacta de usuarios y loguea de un clic. Va inline (no flotante)
// porque el card padre tiene overflow-hidden y recortaría un dropdown absoluto.
// NUNCA se muestra en producción — no filtra credenciales reales.
function DevQuickAccess({ onPick, disabled }: { onPick: (u: DevUser) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6 pt-5 border-t border-slate-100">
      {/* Trigger del desplegable */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 px-3 py-2.5 transition-colors"
      >
        <span className="flex-1 text-left min-w-0">
          <span className="block text-[13px] font-medium text-slate-700 leading-tight">Acceso rápido</span>
          <span className="block text-[11px] text-slate-400 leading-tight">Solo desarrollo · {DEV_USERS.length} usuarios</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Panel desplegado — altura máxima con scroll para no estirar el card */}
      {open && (
        <div className="mt-2 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="max-h-[220px] overflow-y-auto divide-y divide-slate-100">
          {DEV_USERS.map(u => {
            const Icon = u.role === "super_admin" ? ShieldCheck : u.role === "admin" ? Shield : User;
            const roleLabel = u.role === "super_admin" ? "Super Admin" : u.role === "admin" ? "Admin" : "Operador";
            const iconColor = u.role === "super_admin" ? "text-violet-500" : u.role === "admin" ? "text-indigo-500" : "text-slate-400";
            return (
              <button
                key={u.email + u.tenant}
                type="button"
                onClick={() => onPick(u)}
                disabled={disabled}
                title={u.email}
                className="w-full group flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] font-medium text-slate-800 leading-tight truncate">
                    {u.org} <span className="text-slate-400 font-normal">· {roleLabel}</span>
                  </span>
                  <span className="block text-[10.5px] text-slate-400 truncate">{u.email}</span>
                </span>
                <span className="text-[10px] text-slate-300 group-hover:text-indigo-500 transition-colors shrink-0">Entrar →</span>
              </button>
            );
          })}
          </div>
          <div className="px-3 py-1.5 bg-slate-50/60 border-t border-slate-100 text-[10.5px] text-slate-400 text-center">
            Contraseña <code className="text-slate-500">{DEV_PASSWORD}</code>
          </div>
        </div>
      )}
    </div>
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
